/**
 * DALSEGNO — Bot WhatsApp v6
 * - Selección por número cuando hay varios alumnos ("1", "el primero", etc)
 * - create_teacher como acción válida
 * - No pregunta email (es opcional y se genera automático)
 * - "cancelar" bien diferenciado de "eliminar"
 * - Contexto/historial completo de conversación
 * - Audio (Whisper) + Imagen (GPT-4o Vision)
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

// ── Contexto de conversación ──────────────────────────────────────────────────
const convContexts = new Map();
const CTX_TTL      = 12 * 60 * 1000; // 12 min
const MAX_HISTORY  = 10;

function getCtx(n) {
    const c = convContexts.get(n);
    if (!c) return { history: [], lastEntity: null, pendingSelection: null };
    if (Date.now() - c.ts > CTX_TTL) { convContexts.delete(n); return { history: [], lastEntity: null, pendingSelection: null }; }
    c.ts = Date.now(); return c;
}
function saveCtx(n, history, lastEntity, pendingSelection = null) {
    convContexts.set(n, { history: history.slice(-MAX_HISTORY), lastEntity, pendingSelection, ts: Date.now() });
}

// ── OpenAI helpers ────────────────────────────────────────────────────────────
function openaiChat(messages, maxTokens = 600, temperature = 0) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ model:'gpt-4o-mini', max_tokens:maxTokens, temperature, messages });
        const req = https.request({
            hostname:'api.openai.com', path:'/v1/chat/completions', method:'POST',
            headers:{ 'Content-Type':'application/json','Authorization':'Bearer '+OPENAI_API_KEY,'Content-Length':Buffer.byteLength(body) }
        }, res => {
            let data=''; res.on('data',d=>data+=d);
            res.on('end',()=>{ try{resolve(JSON.parse(data)?.choices?.[0]?.message?.content?.trim()||'');}catch(e){reject(e);} });
        });
        req.on('error',reject); req.write(body); req.end();
    });
}

function analizarImagen(base64Data, mimeType, caption) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model:'gpt-4o-mini', max_tokens:700, temperature:0,
            messages:[{ role:'user', content:[
                { type:'image_url', image_url:{ url:`data:${mimeType||'image/jpeg'};base64,${base64Data}`, detail:'high' } },
                { type:'text', text:`Eres asistente de Dalsegno, escuela de música México.${caption?` El dueño escribió: "${caption}".`:''}
Extrae información útil: comprobantes de pago (nombre alumno, monto EXACTO, fecha, banco/método), listas de nombres y montos, horarios, datos de contacto.
Responde en español específico y natural.` }
            ]}]
        });
        const req = https.request({
            hostname:'api.openai.com', path:'/v1/chat/completions', method:'POST',
            headers:{ 'Content-Type':'application/json','Authorization':'Bearer '+OPENAI_API_KEY,'Content-Length':Buffer.byteLength(body) }
        }, res => {
            let data=''; res.on('data',d=>data+=d);
            res.on('end',()=>{ try{resolve(JSON.parse(data)?.choices?.[0]?.message?.content?.trim()||'');}catch(e){reject(e);} });
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

function llamarDalsegno(comando) {
    return new Promise((resolve, reject) => {
        if (!DALSEGNO_API_URL) return reject(new Error('DALSEGNO_API_URL no configurada'));
        const body = JSON.stringify(comando);
        const url  = new URL(DALSEGNO_API_URL);
        const mod  = url.protocol==='https:' ? https : http;
        const req  = mod.request({
            hostname:url.hostname, path:url.pathname+url.search, method:'POST',
            headers:{ 'Content-Type':'application/json','X-Bot-Token':BOT_SECRET_TOKEN,'Content-Length':Buffer.byteLength(body) }
        }, res => {
            let data=''; res.on('data',d=>data+=d);
            res.on('end',()=>{
                if (res.statusCode!==200) return reject(new Error(`API error ${res.statusCode}: ${data.slice(0,200)}`));
                try{resolve(JSON.parse(data));}catch(e){reject(new Error('Respuesta inválida'));}
            });
        });
        req.on('error',reject); req.write(body); req.end();
    });
}

// ── Resolver selección cuando hay múltiples alumnos ───────────────────────────
// Ej: usuario responde "1", "el primero", "Ana García", "el segundo"
function resolverSeleccion(texto, opciones) {
    const t = texto.trim().toLowerCase();
    // Por número directo: "1", "2", "el 1", "primero", "el primero"
    const numMap = { 'primero':1,'primera':1,'primer':1,'first':1,'uno':1,'1':1,
                     'segundo':2,'segunda':2,'two':2,'dos':2,'2':2,
                     'tercero':3,'tercera':3,'three':3,'tres':3,'3':3 };
    for (const [word, idx] of Object.entries(numMap)) {
        if (t === word || t === `el ${word}` || t === `la ${word}` || t === `#${idx}`) {
            if (opciones[idx-1]) return opciones[idx-1];
        }
    }
    // Por nombre parcial
    const match = opciones.find(o => o.name.toLowerCase().includes(t) || t.includes(o.name.toLowerCase().split(' ')[0]));
    if (match) return match;
    return null;
}

const DB_SCHEMA = `
users: id, name, email, phone, user_type(student/teacher/admin), status(active/inactive)
subjects: id, teacher_id, name, level, status
classes: id, student_id, teacher_id, student_name, teacher_name, subject, date(DATE), time(TIME), duration(min), price, status(scheduled/completed/cancelled), payment_status(pending/paid), type(online/presencial), notes
payments: id, class_id, student_id, amount, payment_method(cash/transfer/card), status(pending/paid/cancelled), payment_date, concept
reminders: id, student_id, student_name, phone_e164, amount, due_at(DATETIME), status
payment_reminders: id, student_id, student_name, phone, amount, due_date(DATE), status`.trim();

async function interpretarMensaje(textoActual, ctx) {
    const hoy    = new Date().toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    const mes    = new Date().toISOString().slice(0,7);
    const hoyISO = new Date().toISOString().slice(0,10);
    const manana = new Date(Date.now()+86400000).toISOString().slice(0,10);
    const pasado = new Date(Date.now()+172800000).toISOString().slice(0,10);

    const messages = [
        { role:'system', content:`Eres el asistente de gestión de Dalsegno, escuela de música en México.
El dueño gestiona todo desde WhatsApp. Eres inteligente y entiendes contexto conversacional en español coloquial.

HOY: ${hoy} | hoyISO: ${hoyISO} | mañana: ${manana} | pasado: ${pasado} | mes: ${mes}

${DB_SCHEMA}

════════ RESPONDE SIEMPRE JSON VÁLIDO. SIN MARKDOWN. SIN BACKTICKS. ════════

ACCIONES:

{ "action": "query", "question": "pregunta detallada" }
→ Para VER o CONSULTAR cualquier dato

{ "action": "register_payment", "student_name": "", "amount": 0, "subject": "Música", "month": "${mes}", "method": "cash" }
→ method: cash|transfer|card. Obligatorio: student_name + amount

{ "action": "create_student", "name": "", "phone": "", "email": "" }
→ SOLO name es obligatorio. phone y email siempre "" si no se dicen. NUNCA preguntar email.

{ "action": "create_teacher", "name": "", "phone": "", "email": "" }
→ Para registrar profesores/maestros. SOLO name obligatorio.

{ "action": "update_student", "student_name": "", "field": "phone|email|status|name", "value": "" }
→ Para EDITAR datos de alumno o profesor existente

{ "action": "create_class", "student_name": "", "subject": "", "date": "${hoyISO}", "time": "10:00", "duration": 60, "price": 0, "type": "presencial" }
→ Obligatorio: student_name + subject + date + time

{ "action": "update_class", "class_id": 0, "field": "status|payment_status|date|time|notes|price|subject", "value": "" }
→ Para CANCELAR una clase: field="status", value="cancelled"
→ Para marcar pagada: field="payment_status", value="paid"

{ "action": "delete_record", "type": "student|class|payment", "id": 0 }
→ SOLO cuando dicen EXPLÍCITAMENTE "eliminar" o "borrar" con un ID

{ "action": "menu" }

{ "action": "none", "reply": "respuesta corta" }
→ Solo para saludos o cosas sin relación al negocio

{ "action": "ask", "message": "pregunta MUY concreta", "pending_action": "...", "partial_data": {} }
→ Solo cuando falta dato IMPRESCINDIBLE
→ NUNCA preguntar email, es opcional
→ NUNCA preguntar teléfono, es opcional
→ Para crear alumno: si falta el nombre → preguntar. Si ya está el nombre → ejecutar.
→ Para pago: si falta nombre O monto → preguntar solo lo que falta.
→ Para clase: si falta alumno O materia O fecha O hora → preguntar solo lo que falta.

════════ REGLAS DE CONTEXTO (MUY IMPORTANTES) ════════
1. PRONOMBRES: "la","lo","el alumno","ella","él" → ÚLTIMA persona del historial
2. Si historial muestra que se creó/mencionó a "Mariana" y dice "ponle el tel..." → update_student Mariana
3. Si dice "registrala/registralo con tel X" después de crear alumno → update_student del último alumno con field=phone
4. Si dice "cancelar" una clase (no pago) → update_class status=cancelled (NO delete_record)
5. Si dice "cancelar el pago" → update tiene que cambiar payment status
6. "dar de baja"/"desactivar" → update_student status=inactive
7. "reactivar"/"dar de alta" → update_student status=active
8. Si bot.php devolvió "Varios alumnos: X, Y ¿Cuál?" Y el usuario responde con nombre o número → pasar el nombre correcto al campo student_name de la acción pendiente
9. NUNCA inventar emails
10. Comprobante en imagen → register_payment con method="transfer"
11. "profesor"/"maestro"/"teacher" → create_teacher (NO create_student)
12. Mes actual: "este mes"="${mes}"

LAST_ENTITY activo: ${ctx.lastEntity ? JSON.stringify(ctx.lastEntity) : 'ninguno'}` },
        ...ctx.history,
        { role:'user', content: textoActual }
    ];

    const raw = await openaiChat(messages, 600, 0);
    return JSON.parse(raw);
}

const MENU_TEXT = `🎵 *Dalsegno Bot v6*

👥 *ALUMNOS*
• _"nuevo alumno: Juan García 4961234567"_
• _"registrar nuevo profesor: Pedro López"_
• _"lista de alumnos activos"_
• _"cambiar teléfono de Ana a 4961234567"_
• _"dar de baja a Roberto"_
• _"reactivar a Pedro"_

💰 *PAGOS*
• _"Ana pagó 500 de piano"_
• _"cristian pagó 800 con transferencia"_
• _"quién debe este mes"_
• _"historial de pagos de Ana"_

📅 *CLASES*
• _"programar clase de piano con Ana mañana 4pm"_
• _"clases de esta semana"_
• _"cancelar clase #45"_
• _"marcar pagada clase #50"_
• _"cambiar fecha clase #30 al viernes"_

📊 *REPORTES*
• _"cuánto cobré este mes"_
• _"alumnos sin pago este mes"_
• _"clases pendientes de pago"_

🎙️ *Audios* — habla directo
🖼️ *Fotos* — comprobantes, listas, horarios`;

// ── WhatsApp Client ───────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: { headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process'] }
});

client.on('qr',           qr=>{ console.log('[WA] QR listo'); global.__QR__=qr; });
client.on('authenticated',()=>console.log('[WA] Autenticado'));
client.on('auth_failure', m=>console.error('[WA] Auth failure:',m));
client.on('ready',        ()=>{ console.log('[WA] ✅ Listo'); global.__QR__=null; });
client.on('disconnected', r=>console.log('[WA] Desconectado:',r));

// ── Handler de mensajes ───────────────────────────────────────────────────────
client.on('message', async (msg) => {
    const isAudio = msg.type==='audio'||msg.type==='ptt';
    const isText  = msg.type==='chat';
    const isImage = msg.type==='image';
    const isDoc   = msg.type==='document'&&(msg.mimetype||'').startsWith('image/');
    if (!isAudio&&!isText&&!isImage&&!isDoc) return;
    if (msg.from.includes('@g.us')) return;

    let numero = msg.from.replace(/@c\.us|@s\.whatsapp\.net/,'');
    if (msg.from.includes('@lid')||!/^\d+$/.test(numero)) {
        try { const c=await msg.getContact(); numero=c.number||c.id.user; } catch(e){ return; }
    }
    console.log(`[MSG] from="${numero}" type="${msg.type}" body="${(msg.body||'').substring(0,70)}"`);
    if (!ADMIN_PHONES.includes(numero)) return;
    if (!OPENAI_API_KEY) { await msg.reply('⚠️ Sin OPENAI_API_KEY'); return; }

    let texto='', textoHist='';

    if (isAudio) {
        try {
            const media = await msg.downloadMedia();
            texto = await transcribirAudio(Buffer.from(media.data,'base64'), media.mimetype);
            console.log(`[AUDIO] "${texto.substring(0,100)}"`);
            await msg.reply(`🎙️ _"${texto}"_`);
            textoHist = texto;
        } catch(e) { await msg.reply('❌ Error en audio: '+e.message); return; }
    }
    else if (isImage||isDoc) {
        const caption=(msg.body||'').trim();
        try {
            const media = await msg.downloadMedia();
            if (media.data&&media.data.length>5_500_000) { await msg.reply('⚠️ Imagen muy grande.'); return; }
            const desc = await analizarImagen(media.data, media.mimetype, caption);
            console.log(`[IMAGE] "${desc.substring(0,150)}"`);
            await msg.reply(`🖼️ *Veo:* ${desc}`);
            texto = caption ? `${caption}. Imagen: ${desc}` : desc;
            textoHist = texto;
        } catch(e) { await msg.reply('❌ Error imagen: '+e.message); return; }
    }
    else { texto=msg.body.trim(); textoHist=texto; }

    if (!texto||texto.length<2) return;

    const ctx = getCtx(numero);

    // ── Manejar selección cuando hay "pendingSelection" ───────────────────────
    // Si bot.php devolvió "Varios alumnos: X, Y" y guardamos la acción pendiente
    if (ctx.pendingSelection) {
        const { originalCmd, opciones } = ctx.pendingSelection;
        const seleccionado = resolverSeleccion(texto, opciones);
        if (seleccionado) {
            console.log(`[SELECT] Seleccionado: ${seleccionado.name}`);
            // Reejecutar el comando original con el nombre exacto
            const cmdCorregido = { ...originalCmd, student_name: seleccionado.name };
            try {
                const result = await llamarDalsegno(cmdCorregido);
                const respMsg = result.message || (result.success ? '✅ Listo' : '❌ '+(result.error||'Error'));
                const newHist = [...ctx.history,
                    { role:'user', content: textoHist },
                    { role:'assistant', content: respMsg }
                ];
                saveCtx(numero, newHist, { type: originalCmd.action, name: seleccionado.name }, null);
                await msg.reply(respMsg);
            } catch(e) {
                saveCtx(numero, ctx.history, ctx.lastEntity, null);
                await msg.reply('❌ '+e.message);
            }
            return;
        }
        // Si no reconoció selección, continuar flujo normal (puede ser nuevo comando)
        saveCtx(numero, ctx.history, ctx.lastEntity, null);
    }

    try {
        const cmd = await interpretarMensaje(texto, ctx);
        console.log(`[BOT] cmd:`, JSON.stringify(cmd));

        const newHistory = [...ctx.history, { role:'user', content: textoHist }];
        let newLastEntity = ctx.lastEntity;

        if (cmd.action==='menu') {
            saveCtx(numero, newHistory, newLastEntity);
            await msg.reply(MENU_TEXT); return;
        }
        if (cmd.action==='none') {
            saveCtx(numero, newHistory, newLastEntity);
            await msg.reply(cmd.reply||'¡Hola! Escribe *menú* para ver opciones.'); return;
        }
        if (cmd.action==='ask') {
            const botMsg = `🤔 ${cmd.message}`;
            newHistory.push({ role:'assistant', content: `[esperando: ${cmd.pending_action}] [datos: ${JSON.stringify(cmd.partial_data||{})}] ${botMsg}` });
            if (cmd.partial_data?.student_name||cmd.partial_data?.name) {
                newLastEntity = { type: cmd.pending_action, name: cmd.partial_data.student_name||cmd.partial_data.name };
            }
            saveCtx(numero, newHistory, newLastEntity, null);
            await msg.reply(botMsg); return;
        }

        // Ejecutar en bot.php
        const result = await llamarDalsegno(cmd);
        const respMsg = result.message||(result.success?'✅ Listo':'❌ '+(result.error||'Error'));

        // Si bot.php devuelve "Varios alumnos", guardar selección pendiente
        if (!result.success && result.message && result.message.includes('Varios alumnos') && result.students) {
            console.log(`[SELECT] Varios alumnos, guardando selección pendiente`);
            const listaNum = result.students.map((s,i)=>`${i+1}. ${s.name}`).join('\n');
            const pregunta = `${result.message}\n\n${listaNum}\n\nEscribe el número o el nombre completo:`;
            newHistory.push({ role:'assistant', content: pregunta });
            saveCtx(numero, newHistory, newLastEntity, { originalCmd: cmd, opciones: result.students });
            await msg.reply(pregunta); return;
        }

        // Actualizar lastEntity
        if (result.success) {
            if (['create_student','update_student'].includes(cmd.action)) newLastEntity={ type:'student', name:cmd.name||cmd.student_name };
            else if (cmd.action==='create_teacher') newLastEntity={ type:'teacher', name:cmd.name };
            else if (cmd.action==='create_class') newLastEntity={ type:'class', student_name:cmd.student_name };
            else if (cmd.action==='register_payment') newLastEntity={ type:'payment', student_name:cmd.student_name };
        }

        newHistory.push({ role:'assistant', content: respMsg });
        saveCtx(numero, newHistory, newLastEntity, null);
        await msg.reply(respMsg);

    } catch(e) {
        console.error('[BOT] Error:', e.message);
        const newHistory = [...ctx.history, { role:'user', content: textoHist }];
        saveCtx(numero, newHistory, ctx.lastEntity, null);
        await msg.reply(e.message.includes('JSON')?'❓ No entendí. Escribe *menú*.':'❌ '+e.message);
    }
});

// ── Express ───────────────────────────────────────────────────────────────────
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
        res.send(`<html><body style="background:#111;color:#0f0;font-family:monospace;padding:40px"><h2>✅ WhatsApp conectado</h2><p>Conversaciones activas: ${convContexts.size}</p></body></html>`);
    }
});
app.get('/status',(req,res)=>res.json({ok:true,connected:!global.__QR__,admins:ADMIN_PHONES.length,sessions:convContexts.size,ts:new Date().toISOString()}));
app.post('/send', async(req,res)=>{
    if (ADMIN_TOKEN&&req.headers['x-admin-token']!==ADMIN_TOKEN) return res.status(401).json({ok:false});
    const{phone,text}=req.body;
    if (!phone||!text) return res.status(400).json({ok:false,error:'Faltan phone o text'});
    try { await client.sendMessage(phone.includes('@')?phone:phone+'@c.us',text); res.json({ok:true}); }
    catch(e){res.status(500).json({ok:false,error:e.message});}
});

function cleanChromiumLocks() {
    const{execSync}=require('child_process');
    ['SingletonLock','SingletonCookie','SingletonSocket'].forEach(l=>{
        try{execSync(`find "${SESSION_DIR}" -name "${l}" -delete 2>/dev/null||true`);}catch(e){}
    });
    try{execSync('pkill -f chromium 2>/dev/null||true');execSync('pkill -f chrome 2>/dev/null||true');}catch(e){}
    console.log('[WA-CLEAN] ok');
}

app.listen(PORT,()=>{
    console.log(`[SERVER] 🚀 Puerto ${PORT}`);
    if (OPENAI_API_KEY) console.log('[SERVER] 🤖 OpenAI (Vision+Whisper)');
    if (ADMIN_PHONES.length>0) console.log(`[SERVER] 📱 Admins: ${ADMIN_PHONES.join(', ')}`);
    if (!DALSEGNO_API_URL) console.log('[SERVER] ⚠️ Sin DALSEGNO_API_URL');
});
cleanChromiumLocks();
setTimeout(()=>{
    console.log('[WA] 🚀 Iniciando...');
    client.initialize().catch(err=>{
        console.error('[WA] ❌',err.message);
        cleanChromiumLocks();
        setTimeout(()=>client.initialize().catch(e2=>{console.error('[WA] Fallo:',e2.message);process.exit(1);}),3000);
    });
},2000);
