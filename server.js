/**
 * DALSEGNO — Bot WhatsApp v4
 * - Memoria de conversación (sesiones)
 * - Sin mensajes temporales
 * - Texto + Audio (Whisper) + Imágenes (GPT-4o Vision)
 * - CRUD completo: alumnos, profesores, clases, pagos
 */
'use strict';
const { Client, LocalAuth } = require('whatsapp-web.js');
const express  = require('express');
const fs       = require('fs');
const https    = require('https');
const http     = require('http');
const FormData = require('form-data');

const ADMIN_PHONES     = (process.env.ADMIN_PHONES || '').split(',').map(p => p.trim()).filter(Boolean);
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN      || '';
const BOT_SECRET_TOKEN = process.env.BOT_SECRET_TOKEN || '';
const DALSEGNO_API_URL = process.env.DALSEGNO_API_URL || '';
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || '';
const SESSION_DIR      = process.env.SESSION_DIR      || './session';
const PORT             = process.env.PORT             || 3000;

// ── Sesiones de conversación ──────────────────────────────────────────────────
const convSessions = new Map();
const CONV_TTL = 8 * 60 * 1000;
function getConvSession(n) {
    const s = convSessions.get(n);
    if (!s) return null;
    if (Date.now() - s.ts > CONV_TTL) { convSessions.delete(n); return null; }
    s.ts = Date.now(); return s;
}
function setConvSession(n, action, data) { convSessions.set(n, { action, data, ts: Date.now() }); }
function clearConvSession(n) { convSessions.delete(n); }

// ── OpenAI chat ───────────────────────────────────────────────────────────────
function openaiChat(messages, maxTokens = 500, temperature = 0) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ model: 'gpt-4o-mini', max_tokens: maxTokens, temperature, messages });
        const req = https.request({
            hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => { try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content?.trim() || ''); } catch(e) { reject(e); } });
        });
        req.on('error', reject); req.write(body); req.end();
    });
}

// ── OpenAI Vision ─────────────────────────────────────────────────────────────
function analizarImagen(base64Data, mimeType, caption) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model: 'gpt-4o-mini', max_tokens: 600, temperature: 0,
            messages: [{ role: 'user', content: [
                { type: 'image_url', image_url: { url: `data:${mimeType||'image/jpeg'};base64,${base64Data}`, detail: 'high' } },
                { type: 'text', text: `Eres asistente de Dalsegno, escuela de música en México.${caption?` El dueño escribió: "${caption}".`:''} Extrae info útil para el negocio: comprobantes (nombre, monto, fecha, banco), listas de alumnos, horarios, datos de contacto. Responde en español natural y específico.` }
            ]}]
        });
        const req = https.request({
            hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => { try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content?.trim() || ''); } catch(e) { reject(e); } });
        });
        req.on('error', reject); req.write(body); req.end();
    });
}

// ── Whisper ───────────────────────────────────────────────────────────────────
function transcribirAudio(audioBuffer, mimeType) {
    return new Promise((resolve, reject) => {
        const tmpFile = `/tmp/wa_audio_${Date.now()}.ogg`;
        fs.writeFileSync(tmpFile, audioBuffer);
        const form = new FormData();
        form.append('file', fs.createReadStream(tmpFile), { filename: 'audio.ogg', contentType: mimeType || 'audio/ogg' });
        form.append('model', 'whisper-1'); form.append('language', 'es');
        const req = https.request({
            hostname: 'api.openai.com', path: '/v1/audio/transcriptions', method: 'POST',
            headers: { ...form.getHeaders(), 'Authorization': 'Bearer ' + OPENAI_API_KEY }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => { fs.unlink(tmpFile, ()=>{}); try { resolve(JSON.parse(data)?.text || ''); } catch(e) { reject(e); } });
        });
        req.on('error', err => { fs.unlink(tmpFile, ()=>{}); reject(err); });
        form.pipe(req);
    });
}

// ── bot.php ───────────────────────────────────────────────────────────────────
function llamarDalsegno(comando) {
    return new Promise((resolve, reject) => {
        if (!DALSEGNO_API_URL) return reject(new Error('DALSEGNO_API_URL no configurada'));
        const body = JSON.stringify(comando);
        const url  = new URL(DALSEGNO_API_URL);
        const mod  = url.protocol === 'https:' ? https : http;
        const req  = mod.request({
            hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bot-Token': BOT_SECRET_TOKEN, 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`API error ${res.statusCode}: ${data.slice(0,200)}`));
                try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Respuesta inválida')); }
            });
        });
        req.on('error', reject); req.write(body); req.end();
    });
}

const DB_SCHEMA = `
users: id, name, email, phone, user_type(student/teacher/admin), status(active/inactive)
subjects: id, teacher_id->users, name, level, status(active/inactive)
classes: id, student_id->users, teacher_id->users, student_name, teacher_name, subject, date(DATE), time(TIME), duration(min), price, status(scheduled/completed/cancelled), payment_status(pending/paid), type(online/presencial), notes
payments: id, class_id->classes, student_id->users, amount, payment_method(cash/transfer/card), status(pending/paid/cancelled), payment_date, concept
reminders: id, student_id, student_name, phone_e164, amount, due_at(DATETIME), status(pending/sent/failed/cancelled)
payment_reminders: id, student_id->users, student_name, phone, amount, due_date(DATE), status(active/completed/cancelled)`.trim();

async function interpretarMensaje(texto, sesion) {
    const hoy    = new Date().toLocaleDateString('es-MX', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
    const mes    = new Date().toISOString().slice(0, 7);
    const manana = new Date(Date.now()+86400000).toISOString().slice(0,10);
    const hoyISO = new Date().toISOString().slice(0,10);

    const mensajeUsuario = sesion
        ? `[CONTEXTO SESION: accion_pendiente="${sesion.action}" datos_ya_recopilados=${JSON.stringify(sesion.data)}]\nRespuesta del usuario ahora: "${texto}"`
        : texto;

    const raw = await openaiChat([
        { role: 'system', content: `Eres el asistente de Dalsegno, escuela de música en México.
El dueño administra su negocio por WhatsApp. SOLO responde JSON válido, sin markdown ni backticks.

Hoy: ${hoy} | Mes: ${mes} | hoyISO: ${hoyISO} | mañanaISO: ${manana}

ESQUEMA BD:
${DB_SCHEMA}

ACCIONES DISPONIBLES:

── CONSULTAS ─────────────────────────────────────────────────────
query:            { "action":"query", "question":"..." }

── PAGOS ─────────────────────────────────────────────────────────
register_payment: { "action":"register_payment", "student_name":"", "amount":0, "subject":"Música", "month":"${mes}", "method":"cash|transfer|card" }

── ALUMNOS ───────────────────────────────────────────────────────
create_student:   { "action":"create_student", "name":"", "phone":"", "email":"" }
update_student:   { "action":"update_student", "student_name":"", "field":"phone|email|status|name", "value":"" }
delete_by_name:   { "action":"delete_by_name", "name":"", "user_type":"student" }

── PROFESORES ────────────────────────────────────────────────────
create_teacher:   { "action":"create_teacher", "name":"", "phone":"", "email":"", "subject":"" }
update_teacher:   { "action":"update_teacher", "teacher_name":"", "field":"phone|email|status|name", "value":"" }
delete_by_name:   { "action":"delete_by_name", "name":"", "user_type":"teacher" }

── CLASES ────────────────────────────────────────────────────────
create_class:     { "action":"create_class", "student_name":"", "subject":"", "date":"YYYY-MM-DD", "time":"HH:MM", "duration":60, "price":0, "type":"presencial|online", "notes":"" }
update_class:     { "action":"update_class", "class_id":0, "field":"status|payment_status|date|time|notes|price|subject|duration|type", "value":"" }
delete_record:    { "action":"delete_record", "type":"class|payment", "id":0 }

── SISTEMA ───────────────────────────────────────────────────────
menu:             { "action":"menu" }
none:             { "action":"none", "reply":"..." }
ask:              { "action":"ask", "message":"pregunta corta", "pending_action":"create_student", "partial_data":{} }

REGLAS CRÍTICAS:
1. Si hay CONTEXTO SESION → combina datos_ya_recopilados + respuesta actual → ejecuta si tienes todo
2. Para BORRAR POR NOMBRE (alumno/profe) → SIEMPRE usa delete_by_name, NUNCA delete_record con id=0
3. Para REACTIVAR → usar update_student/update_teacher con field="status" value="active"
4. Datos obligatorios mínimos:
   - create_student: solo name (phone/email opcionales, dejar vacío "")
   - create_teacher: solo name (phone/email/subject opcionales)
   - register_payment: student_name + amount
   - create_class: student_name + subject + date + time
5. "mañana"=${manana} | "hoy"=${hoyISO} | sin método de pago→"cash" | sin duración→60 | sin precio→0
6. Infiere nombres con typos (noe v → Noe V, noé vázquez, etc.)
7. Para consultas SIEMPRE "query"
8. "dar de baja", "desactivar", "borrar" → delete_by_name con status o delete_by_name
9. "reactivar", "activar de nuevo" → update_student/teacher field="status" value="active"
10. Comprobante en imagen → register_payment con method="transfer"` },
        { role: 'user', content: mensajeUsuario }
    ], 500, 0);

    return JSON.parse(raw);
}

// ── Menú completo ─────────────────────────────────────────────────────────────
const MENU_TEXT = `🎵 *Dalsegno Bot — Todo lo que puedo hacer*

━━━━━━━━━━━━━━━━━━━━━━
💰 *REGISTRAR PAGOS*
• _"Ana pagó 500 de guitarra"_
• _"registrar pago cristian 800 transferencia"_
• _"pago de Juan 600 con tarjeta"_

━━━━━━━━━━━━━━━━━━━━━━
👥 *ALUMNOS*
• _"agregar nuevo alumno"_
• _"nuevo alumno Juan García 4961234567"_
• _"cambiar teléfono de Ana a 4961234567"_
• _"cambiar email de Roberto"_
• _"dar de baja a Noe V"_ / _"borrar alumno X"_
• _"reactivar alumno Juan"_

━━━━━━━━━━━━━━━━━━━━━━
👨‍🏫 *PROFESORES*
• _"agregar profesor Miguel, guitarra"_
• _"cambiar teléfono del profe Miguel"_
• _"dar de baja al profe Noe"_

━━━━━━━━━━━━━━━━━━━━━━
📅 *CLASES*
• _"programar clase piano con Ana mañana 4pm"_
• _"clase guitarra con Juan el viernes 5pm"_
• _"cancelar clase #45"_
• _"marcar como pagada clase #50"_
• _"cambiar fecha de clase #32 al lunes"_
• _"agregar nota a clase #28: trajo su guitarra"_
• _"eliminar clase #23"_

━━━━━━━━━━━━━━━━━━━━━━
📊 *CONSULTAS Y REPORTES*
• _"lista de alumnos activos"_
• _"lista de profesores"_
• _"clases de esta semana"_
• _"clases de hoy"_
• _"quién debe este mes"_
• _"historial de pagos de Ana"_
• _"cuánto cobré este mes"_
• _"clases pendientes de pago"_
• _"resumen de marzo"_
• _"pagos de Ana en febrero"_

━━━━━━━━━━━━━━━━━━━━━━
🎙️ *Audios* — habla directo, te entiendo
🖼️ *Fotos* — comprobantes, listas, horarios
   (registro automático desde imagen)`;

// ── WhatsApp Client ───────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process'] }
});

client.on('qr',           qr => { console.log('[WA] QR listo — visita http://localhost:'+PORT); global.__QR__=qr; });
client.on('authenticated',() => console.log('[WA] Autenticado'));
client.on('auth_failure', m  => console.error('[WA] Auth failure:', m));
client.on('ready',        () => { console.log('[WA] Listo y conectado'); global.__QR__=null; });
client.on('disconnected', r  => console.log('[WA] Desconectado:', r));

client.on('message', async (msg) => {
    const isAudio = msg.type === 'audio' || msg.type === 'ptt';
    const isText  = msg.type === 'chat';
    const isImage = msg.type === 'image';
    const isDoc   = msg.type === 'document' && (msg.mimetype||'').startsWith('image/');

    if (!isAudio && !isText && !isImage && !isDoc) return;
    if (msg.from.includes('@g.us')) return;

    let numero = msg.from.replace(/@c\.us|@s\.whatsapp\.net/, '');
    if (msg.from.includes('@lid') || !/^\d+$/.test(numero)) {
        try { const c = await msg.getContact(); numero = c.number || c.id.user; } catch(e) { return; }
    }

    console.log(`[MSG] from="${numero}" type="${msg.type}" body="${(msg.body||'').substring(0,60)}"`);
    if (!ADMIN_PHONES.includes(numero)) return;
    if (!OPENAI_API_KEY) { await msg.reply('⚠️ Sin OPENAI_API_KEY'); return; }

    let texto = '';

    if (isAudio) {
        try {
            const media = await msg.downloadMedia();
            texto = await transcribirAudio(Buffer.from(media.data, 'base64'), media.mimetype);
            console.log(`[AUDIO] "${texto.substring(0,100)}"`);
            await msg.reply(`🎙️ _"${texto}"_`);
        } catch(e) { await msg.reply('❌ Error en audio: ' + e.message); return; }
    }
    else if (isImage || isDoc) {
        const caption = (msg.body||'').trim();
        try {
            const media = await msg.downloadMedia();
            if (media.data && media.data.length > 5_500_000) { await msg.reply('⚠️ Imagen muy grande.'); return; }
            const desc = await analizarImagen(media.data, media.mimetype, caption);
            console.log(`[IMAGE] "${desc.substring(0,150)}"`);
            await msg.reply(`🖼️ *Veo:* ${desc}`);
            texto = caption ? `${caption}. Imagen muestra: ${desc}` : desc;
        } catch(e) { await msg.reply('❌ Error en imagen: ' + e.message); return; }
    }
    else {
        texto = msg.body.trim();
    }

    if (!texto || texto.length < 2) return;

    const sesion = getConvSession(numero);
    if (sesion) console.log(`[SESSION] activa: "${sesion.action}" ${JSON.stringify(sesion.data)}`);

    try {
        const cmd = await interpretarMensaje(texto, sesion);
        console.log(`[BOT] cmd:`, JSON.stringify(cmd));

        if (cmd.action !== 'ask') clearConvSession(numero);

        if (cmd.action === 'menu') { await msg.reply(MENU_TEXT); return; }
        if (cmd.action === 'none') { await msg.reply(cmd.reply || '¡Hola! Escribe *menú* para ver todo lo que puedo hacer.'); return; }

        if (cmd.action === 'ask') {
            const pa = cmd.pending_action || sesion?.action || 'unknown';
            const pd = cmd.partial_data   || sesion?.data   || {};
            setConvSession(numero, pa, pd);
            console.log(`[SESSION] guardada: "${pa}" ${JSON.stringify(pd)}`);
            await msg.reply(`🤔 ${cmd.message}`);
            return;
        }

        const result = await llamarDalsegno(cmd);
        await msg.reply(result.message || (result.success ? '✅ Listo' : '❌ ' + (result.error || 'Error desconocido')));

    } catch(e) {
        console.error('[BOT] Error:', e.message);
        await msg.reply(e.message.includes('JSON') ? '❓ No entendí bien. Intenta de nuevo o escribe *menú*.' : '❌ ' + e.message);
    }
});

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    if (global.__QR__) {
        res.send(`<!DOCTYPE html><html><head><title>Dalsegno QR</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head>
<body style="background:#111;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh">
<h2>📱 Escanea con WhatsApp</h2><div id="qr"></div>
<p style="opacity:.6">WhatsApp → ⋮ → Dispositivos vinculados → Vincular dispositivo</p>
<script>new QRCode(document.getElementById('qr'),{text:"${global.__QR__}",width:300,height:300})</script></body></html>`);
    } else {
        res.send(`<html><body style="background:#111;color:#0f0;font-family:monospace;padding:40px"><h2>✅ WhatsApp conectado</h2><p>Sesiones activas: ${convSessions.size}</p></body></html>`);
    }
});

app.get('/status', (req, res) => res.json({ ok:true, connected:!global.__QR__, admins:ADMIN_PHONES.length, sessions:convSessions.size, ts:new Date().toISOString() }));

app.post('/send', async (req, res) => {
    if (ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(401).json({ ok:false });
    const { phone, text } = req.body;
    if (!phone || !text) return res.status(400).json({ ok:false, error:'Faltan phone o text' });
    try { await client.sendMessage(phone.includes('@') ? phone : phone+'@c.us', text); res.json({ ok:true }); }
    catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

function cleanChromiumLocks() {
    const { execSync } = require('child_process');
    ['SingletonLock','SingletonCookie','SingletonSocket'].forEach(lock => {
        try { execSync(`find "${SESSION_DIR}" -name "${lock}" -delete 2>/dev/null || true`); } catch(e) {}
    });
    try { execSync('pkill -f chromium 2>/dev/null || true'); execSync('pkill -f chrome 2>/dev/null || true'); } catch(e) {}
    console.log('[WA-CLEAN] Limpieza ok');
}

app.listen(PORT, () => {
    console.log(`[SERVER] Puerto ${PORT}`);
    if (OPENAI_API_KEY)          console.log('[SERVER] OpenAI activo (Vision + Whisper)');
    if (ADMIN_PHONES.length > 0) console.log(`[SERVER] Admins: ${ADMIN_PHONES.join(', ')}`);
    if (!DALSEGNO_API_URL)       console.log('[SERVER] ADVERTENCIA: Sin DALSEGNO_API_URL');
});

cleanChromiumLocks();
setTimeout(() => {
    console.log('[WA] Iniciando...');
    client.initialize().catch(err => {
        console.error('[WA] Error:', err.message);
        cleanChromiumLocks();
        setTimeout(() => client.initialize().catch(e2 => { console.error('[WA] Fallo:', e2.message); process.exit(1); }), 3000);
    });
}, 2000);
