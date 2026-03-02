/**
 * DALSEGNO — Bot WhatsApp v5
 * - Contexto rico: recuerda último alumno/clase/pago trabajado
 * - Pronombres (la, lo, el, ella) resueltos por contexto
 * - Sin email automático raro
 * - Sistema de sesión robusto con historial de mensajes
 * - Texto + Audio (Whisper) + Imágenes (GPT-4o Vision)
 */
'use strict';
const { Client, LocalAuth } = require('whatsapp-web.js');
const express  = require('express');
const fs       = require('fs');
const https    = require('https');
const http     = require('http');
const FormData = require('form-data');

const ADMIN_PHONES     = (process.env.ADMIN_PHONES || '').split(',').map(p=>p.trim()).filter(Boolean);
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN      || '';
const BOT_SECRET_TOKEN = process.env.BOT_SECRET_TOKEN || '';
const DALSEGNO_API_URL = process.env.DALSEGNO_API_URL || '';
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || '';
const SESSION_DIR      = process.env.SESSION_DIR      || './session';
const PORT             = process.env.PORT             || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXTO DE CONVERSACIÓN
// Guarda los últimos N turnos + entidad activa (último alumno/clase mencionado)
// ─────────────────────────────────────────────────────────────────────────────
const convContexts = new Map(); // numero → { history, lastEntity, ts }
const CTX_TTL     = 10 * 60 * 1000; // 10 min inactividad
const MAX_HISTORY = 8; // máximo de turnos guardados

function getCtx(numero) {
    const c = convContexts.get(numero);
    if (!c) return { history: [], lastEntity: null };
    if (Date.now() - c.ts > CTX_TTL) { convContexts.delete(numero); return { history: [], lastEntity: null }; }
    c.ts = Date.now();
    return c;
}
function saveCtx(numero, history, lastEntity) {
    convContexts.set(numero, { history: history.slice(-MAX_HISTORY), lastEntity, ts: Date.now() });
}
function clearCtx(numero) { convContexts.delete(numero); }

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI helpers
// ─────────────────────────────────────────────────────────────────────────────
function openaiChat(messages, maxTokens = 600, temperature = 0) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ model:'gpt-4o-mini', max_tokens:maxTokens, temperature, messages });
        const req = https.request({
            hostname:'api.openai.com', path:'/v1/chat/completions', method:'POST',
            headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+OPENAI_API_KEY, 'Content-Length':Buffer.byteLength(body) }
        }, res => {
            let data = '';
            res.on('data', d => data+=d);
            res.on('end', () => { try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content?.trim()||''); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

function analizarImagen(base64Data, mimeType, caption) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model:'gpt-4o-mini', max_tokens:700, temperature:0,
            messages:[{ role:'user', content:[
                { type:'image_url', image_url:{ url:`data:${mimeType||'image/jpeg'};base64,${base64Data}`, detail:'high' } },
                { type:'text', text:`Eres asistente de Dalsegno, escuela de música en México.${caption?` El dueño escribió: "${caption}".`:''}
Extrae toda la información útil: comprobantes de pago (nombre del alumno, monto exacto, fecha, banco/método), listas con nombres y montos, horarios, datos de contacto.
Si es comprobante: indica claramente nombre, monto y método (transferencia/efectivo/tarjeta).
Responde en español natural y específico.` }
            ]}]
        });
        const req = https.request({
            hostname:'api.openai.com', path:'/v1/chat/completions', method:'POST',
            headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+OPENAI_API_KEY, 'Content-Length':Buffer.byteLength(body) }
        }, res => {
            let data=''; res.on('data',d=>data+=d);
            res.on('end',()=>{ try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content?.trim()||''); } catch(e){reject(e);} });
        });
        req.on('error',reject); req.write(body); req.end();
    });
}

function transcribirAudio(audioBuffer, mimeType) {
    return new Promise((resolve, reject) => {
        const tmpFile = `/tmp/wa_audio_${Date.now()}.ogg`;
        fs.writeFileSync(tmpFile, audioBuffer);
        const form = new FormData();
        form.append('file', fs.createReadStream(tmpFile), { filename:'audio.ogg', contentType:mimeType||'audio/ogg' });
        form.append('model','whisper-1'); form.append('language','es');
        const req = https.request({
            hostname:'api.openai.com', path:'/v1/audio/transcriptions', method:'POST',
            headers:{ ...form.getHeaders(), 'Authorization':'Bearer '+OPENAI_API_KEY }
        }, res => {
            let data=''; res.on('data',d=>data+=d);
            res.on('end',()=>{ fs.unlink(tmpFile,()=>{}); try{resolve(JSON.parse(data)?.text||'');}catch(e){reject(e);} });
        });
        req.on('error',err=>{ fs.unlink(tmpFile,()=>{}); reject(err); });
        form.pipe(req);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// LLAMAR bot.php
// ─────────────────────────────────────────────────────────────────────────────
function llamarDalsegno(comando) {
    return new Promise((resolve, reject) => {
        if (!DALSEGNO_API_URL) return reject(new Error('DALSEGNO_API_URL no configurada'));
        const body = JSON.stringify(comando);
        const url  = new URL(DALSEGNO_API_URL);
        const mod  = url.protocol==='https:' ? https : http;
        const req  = mod.request({
            hostname:url.hostname, path:url.pathname+url.search, method:'POST',
            headers:{ 'Content-Type':'application/json', 'X-Bot-Token':BOT_SECRET_TOKEN, 'Content-Length':Buffer.byteLength(body) }
        }, res => {
            let data=''; res.on('data',d=>data+=d);
            res.on('end',()=>{
                if (res.statusCode!==200) return reject(new Error(`API error ${res.statusCode}: ${data.slice(0,200)}`));
                try{resolve(JSON.parse(data));}catch(e){reject(new Error('Respuesta inválida del servidor'));}
            });
        });
        req.on('error',reject); req.write(body); req.end();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERPRETAR MENSAJE — núcleo del bot
// Usa historial completo de la conversación para resolver contexto y pronombres
// ─────────────────────────────────────────────────────────────────────────────
const DB_SCHEMA = `
TABLAS:
- users: id, name, email, phone, user_type(student/teacher/admin), status(active/inactive)
- subjects: id, teacher_id, name, level, status(active/inactive)
- classes: id, student_id, teacher_id, student_name, teacher_name, subject, date(DATE), time(TIME), duration(min), price, status(scheduled/completed/cancelled), payment_status(pending/paid), type(online/presencial), notes
- payments: id, class_id, student_id, amount, payment_method(cash/transfer/card), status(pending/paid/cancelled), payment_date, concept
- reminders: id, student_id, student_name, phone_e164, amount, due_at(DATETIME), status(pending/sent/failed/cancelled)
- payment_reminders: id, student_id, student_name, phone, amount, due_date(DATE), status(active/completed/cancelled)`.trim();

async function interpretarMensaje(textoActual, ctx) {
    const hoy    = new Date().toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    const mes    = new Date().toISOString().slice(0,7);
    const hoyISO = new Date().toISOString().slice(0,10);
    const manana = new Date(Date.now()+86400000).toISOString().slice(0,10);

    // Construir mensajes con historial real de la conversación
    const messages = [
        { role:'system', content:`Eres el asistente de gestión de Dalsegno, escuela de música en México.
El dueño te habla desde WhatsApp. Eres inteligente, entiendes español coloquial y contexto conversacional.

FECHA: ${hoy} | hoyISO: ${hoyISO} | mañana: ${manana} | mes: ${mes}

${DB_SCHEMA}

════════════════════════════════════════
RESPONDE SIEMPRE CON JSON VÁLIDO. SIN MARKDOWN. SIN BACKTICKS.
════════════════════════════════════════

ACCIONES DISPONIBLES:

{ "action": "query", "question": "pregunta detallada en español" }
→ Para VER o CONSULTAR cualquier dato: alumnos, clases, pagos, reportes, estadísticas

{ "action": "register_payment", "student_name": "", "amount": 0, "subject": "Música", "month": "${mes}", "method": "cash" }
→ method: cash | transfer | card
→ Obligatorio: student_name + amount

{ "action": "create_student", "name": "", "phone": "", "email": "" }
→ SOLO name es obligatorio. phone y email dejar "" si no se mencionan. NO inventar emails.

{ "action": "update_student", "student_name": "", "field": "phone|email|status|name", "value": "" }
→ Para editar datos de un alumno existente

{ "action": "create_class", "student_name": "", "subject": "", "date": "${hoyISO}", "time": "10:00", "duration": 60, "price": 0, "type": "presencial" }
→ Obligatorio: student_name + subject + date + time

{ "action": "update_class", "class_id": 0, "field": "status|payment_status|date|time|notes|price|subject", "value": "" }
→ Para modificar una clase existente

{ "action": "delete_record", "type": "student|class|payment", "id": 0 }
→ Solo cuando explícitamente piden borrar/eliminar

{ "action": "menu" }
→ Cuando piden menú, ayuda, opciones, help

{ "action": "none", "reply": "respuesta corta amigable" }
→ Para charla que no es del negocio

{ "action": "ask", "message": "pregunta muy concreta", "pending_action": "...", "partial_data": {} }
→ SOLO cuando falta un dato que NO SE PUEDE asumir
→ PROHIBIDO preguntar datos opcionales (email, teléfono son opcionales para alumnos)
→ NUNCA preguntar cosas que ya están en el historial

════════════════════════════════════════
REGLAS CRÍTICAS DE CONTEXTO:
════════════════════════════════════════
1. PRONOMBRES: "la", "lo", "el alumno", "ella" → se refieren a la ÚLTIMA persona mencionada en la conversación
2. Si el historial muestra que se creó/mencionó a "Mariana" y el usuario dice "ponle el tel..." → update_student de Mariana
3. Si el historial muestra que se creó/mencionó a "Mariana" y dice "editalo/editala" → preguntar QUÉ campo editar
4. NUNCA crear un alumno que ya aparece en la conversación reciente como "ya existe"
5. Si dicen "registrala con este número" tras crear/mencionar un alumno → es update_student del último alumno
6. Para update_student: "ponle el teléfono X" → field="phone", value=número limpio sin espacios ni guiones
7. Para update_student de status: "dar de baja"/"desactivar" → value="inactive" | "activar"/"dar de alta" → value="active"
8. Si hay partial_data en el historial y el usuario responde → completar la acción con esos datos
9. Mes actual ${mes}: "este mes", "de este mes" → month="${mes}"
10. Si piden ver/listar/mostrar CUALQUIER cosa → "query", NUNCA "none"
11. Si el usuario manda solo un nombre como respuesta a "¿cuál es el nombre?" → eso ES el nombre, usarlo
12. "mañana"="${manana}" | "hoy"="${hoyISO}" | "pasado mañana"="${new Date(Date.now()+172800000).toISOString().slice(0,10)}"
13. Pagos: sin método → "cash" | sin materia → "Música"
14. Clases: sin duración → 60 | sin precio → 0 | sin tipo → "presencial"
15. NO inventar emails. Si no dan email → email: ""

LAST_ENTITY del contexto: ${ctx.lastEntity ? JSON.stringify(ctx.lastEntity) : 'ninguna'}
════════════════════════════════════════` },
        // Historial real de la conversación
        ...ctx.history,
        // Mensaje actual del usuario
        { role:'user', content: textoActual }
    ];

    const raw = await openaiChat(messages, 600, 0);
    return JSON.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// MENÚ
// ─────────────────────────────────────────────────────────────────────────────
const MENU_TEXT = `🎵 *Dalsegno Bot v5*

👥 *ALUMNOS*
• _"nuevo alumno: Juan García tel 4961234567"_
• _"lista de alumnos activos"_
• _"cambiar teléfono de Ana a 4961234567"_
• _"cambiar nombre de Mariana a Mariana Acepedo"_
• _"dar de baja a Roberto"_
• _"reactivar alumno Pedro"_

💰 *PAGOS*
• _"Ana pagó 500 de piano"_
• _"cristian pagó 800 de guitarra con transferencia"_
• _"quién debe este mes"_
• _"historial de pagos de Ana"_
• _"cuánto cobré en febrero"_

📅 *CLASES*
• _"programar clase de piano con Ana mañana 4pm"_
• _"clases de esta semana"_
• _"cancelar clase #45"_
• _"marcar como pagada la clase #50"_
• _"cambiar fecha de clase #30 al viernes"_

📊 *REPORTES*
• _"cuánto cobré este mes"_
• _"alumnos sin pago este mes"_
• _"clases pendientes de pago"_
• _"resumen del mes"_

🗑️ *ELIMINAR*
• _"eliminar clase #23"_
• _"eliminar pago #10"_

🎙️ *Audios* → habla directo, te escucho
🖼️ *Fotos* → comprobantes, listas, horarios`;

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP CLIENT
// ─────────────────────────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: { headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process'] }
});

client.on('qr',           qr => { console.log('[WA] QR listo'); global.__QR__=qr; });
client.on('authenticated',()  => console.log('[WA] Autenticado'));
client.on('auth_failure', m   => console.error('[WA] Auth failure:', m));
client.on('ready',        ()  => { console.log('[WA] ✅ Listo'); global.__QR__=null; });
client.on('disconnected', r   => console.log('[WA] Desconectado:', r));

// ─────────────────────────────────────────────────────────────────────────────
// MANEJADOR DE MENSAJES
// ─────────────────────────────────────────────────────────────────────────────
client.on('message', async (msg) => {
    const isAudio = msg.type==='audio' || msg.type==='ptt';
    const isText  = msg.type==='chat';
    const isImage = msg.type==='image';
    const isDoc   = msg.type==='document' && (msg.mimetype||'').startsWith('image/');

    if (!isAudio && !isText && !isImage && !isDoc) return;
    if (msg.from.includes('@g.us')) return; // ignorar grupos

    // Número real
    let numero = msg.from.replace(/@c\.us|@s\.whatsapp\.net/,'');
    if (msg.from.includes('@lid') || !/^\d+$/.test(numero)) {
        try { const c=await msg.getContact(); numero=c.number||c.id.user; } catch(e){ return; }
    }

    console.log(`[MSG] from="${numero}" type="${msg.type}" body="${(msg.body||'').substring(0,70)}"`);
    if (!ADMIN_PHONES.includes(numero)) return;
    if (!OPENAI_API_KEY) { await msg.reply('⚠️ Sin OPENAI_API_KEY'); return; }

    let texto = '';
    let textoParaHistorial = '';

    // ── Audio ─────────────────────────────────────────────────────────────────
    if (isAudio) {
        try {
            const media = await msg.downloadMedia();
            texto = await transcribirAudio(Buffer.from(media.data,'base64'), media.mimetype);
            console.log(`[AUDIO] "${texto.substring(0,100)}"`);
            await msg.reply(`🎙️ _"${texto}"_`);
            textoParaHistorial = texto;
        } catch(e) { await msg.reply('❌ Error en audio: '+e.message); return; }
    }
    // ── Imagen ────────────────────────────────────────────────────────────────
    else if (isImage || isDoc) {
        const caption = (msg.body||'').trim();
        try {
            const media = await msg.downloadMedia();
            if (media.data && media.data.length > 5_500_000) { await msg.reply('⚠️ Imagen muy grande, intenta con una más pequeña.'); return; }
            const desc = await analizarImagen(media.data, media.mimetype, caption);
            console.log(`[IMAGE] "${desc.substring(0,150)}"`);
            await msg.reply(`🖼️ *Veo:* ${desc}`);
            texto = caption ? `${caption}. Información de la imagen: ${desc}` : desc;
            textoParaHistorial = texto;
        } catch(e) { await msg.reply('❌ Error en imagen: '+e.message); return; }
    }
    // ── Texto ─────────────────────────────────────────────────────────────────
    else {
        texto = msg.body.trim();
        textoParaHistorial = texto;
    }

    if (!texto || texto.length < 2) return;

    // Obtener contexto actual
    const ctx = getCtx(numero);

    try {
        const cmd = await interpretarMensaje(texto, ctx);
        console.log(`[BOT] cmd:`, JSON.stringify(cmd));

        // Agregar turno al historial
        const newHistory = [
            ...ctx.history,
            { role:'user', content: textoParaHistorial }
        ];

        // Actualizar lastEntity según la acción
        let newLastEntity = ctx.lastEntity;

        if (cmd.action === 'menu') {
            saveCtx(numero, newHistory, newLastEntity);
            await msg.reply(MENU_TEXT);
            return;
        }

        if (cmd.action === 'none') {
            saveCtx(numero, newHistory, newLastEntity);
            await msg.reply(cmd.reply || '¡Hola! Escribe *menú* para ver opciones.');
            return;
        }

        if (cmd.action === 'ask') {
            // Guardar lo que el bot preguntó también en el historial
            const botMsg = `🤔 ${cmd.message}`;
            newHistory.push({ role:'assistant', content: `[pending: ${cmd.pending_action}] [partial: ${JSON.stringify(cmd.partial_data||{})}] ${botMsg}` });
            // Mantener lastEntity si hay partial_data con nombre
            if (cmd.partial_data?.student_name || cmd.partial_data?.name) {
                newLastEntity = { type: cmd.pending_action, name: cmd.partial_data.student_name || cmd.partial_data.name, data: cmd.partial_data };
            }
            saveCtx(numero, newHistory, newLastEntity);
            await msg.reply(botMsg);
            return;
        }

        // Acciones que van a bot.php
        const result = await llamarDalsegno(cmd);
        const respMsg = result.message || (result.success ? '✅ Listo' : '❌ '+(result.error||'Error'));

        // Actualizar lastEntity según resultado exitoso
        if (result.success) {
            if (cmd.action === 'create_student' || cmd.action === 'update_student') {
                newLastEntity = { type:'student', name: cmd.name || cmd.student_name };
            } else if (cmd.action === 'create_class') {
                newLastEntity = { type:'class', student_name: cmd.student_name, id: null };
            } else if (cmd.action === 'register_payment') {
                newLastEntity = { type:'payment', student_name: cmd.student_name };
            }
        }

        newHistory.push({ role:'assistant', content: respMsg });
        saveCtx(numero, newHistory, newLastEntity);

        await msg.reply(respMsg);

    } catch(e) {
        console.error('[BOT] Error:', e.message);
        // Aun en error, guardar el turno del usuario
        const newHistory = [...ctx.history, { role:'user', content: textoParaHistorial }];
        saveCtx(numero, newHistory, ctx.lastEntity);
        await msg.reply(e.message.includes('JSON') ? '❓ No entendí. Intenta de otra forma o escribe *menú*.' : '❌ '+e.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (req,res) => {
    if (global.__QR__) {
        res.send(`<!DOCTYPE html><html><head><title>Dalsegno QR</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head>
<body style="background:#111;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh">
<h2>📱 Escanea con WhatsApp</h2><div id="qr"></div>
<p style="opacity:.6">WhatsApp → ⋮ → Dispositivos vinculados → Vincular dispositivo</p>
<script>new QRCode(document.getElementById('qr'),{text:"${global.__QR__}",width:300,height:300})</script>
</body></html>`);
    } else {
        res.send(`<html><body style="background:#111;color:#0f0;font-family:monospace;padding:40px">
<h2>✅ WhatsApp conectado</h2>
<p>Conversaciones activas: ${convContexts.size}</p>
</body></html>`);
    }
});

app.get('/status', (req,res) => res.json({ ok:true, connected:!global.__QR__, admins:ADMIN_PHONES.length, sessions:convContexts.size, ts:new Date().toISOString() }));

app.post('/send', async (req,res) => {
    if (ADMIN_TOKEN && req.headers['x-admin-token']!==ADMIN_TOKEN) return res.status(401).json({ok:false});
    const {phone,text} = req.body;
    if (!phone||!text) return res.status(400).json({ok:false,error:'Faltan phone o text'});
    try { await client.sendMessage(phone.includes('@')?phone:phone+'@c.us',text); res.json({ok:true}); }
    catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ─────────────────────────────────────────────────────────────────────────────
// LIMPIEZA Y ARRANQUE
// ─────────────────────────────────────────────────────────────────────────────
function cleanChromiumLocks() {
    const {execSync} = require('child_process');
    ['SingletonLock','SingletonCookie','SingletonSocket'].forEach(lock => {
        try { execSync(`find "${SESSION_DIR}" -name "${lock}" -delete 2>/dev/null||true`); } catch(e) {}
    });
    try { execSync('pkill -f chromium 2>/dev/null||true'); execSync('pkill -f chrome 2>/dev/null||true'); } catch(e) {}
    console.log('[WA-CLEAN] ✅ ok');
}

app.listen(PORT, () => {
    console.log(`[SERVER] 🚀 Puerto ${PORT}`);
    if (OPENAI_API_KEY)          console.log('[SERVER] 🤖 OpenAI (Vision+Whisper)');
    if (ADMIN_PHONES.length > 0) console.log(`[SERVER] 📱 Admins: ${ADMIN_PHONES.join(', ')}`);
    if (!DALSEGNO_API_URL)       console.log('[SERVER] ⚠️  Sin DALSEGNO_API_URL');
});

cleanChromiumLocks();
setTimeout(() => {
    console.log('[WA] 🚀 Iniciando...');
    client.initialize().catch(err => {
        console.error('[WA] ❌', err.message);
        cleanChromiumLocks();
        setTimeout(()=>client.initialize().catch(e2=>{ console.error('[WA] Fallo definitivo:',e2.message); process.exit(1); }),3000);
    });
}, 2000);
