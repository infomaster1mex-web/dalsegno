/**
 * ╔══════════════════════════════════════════════════════════════╗
 *  DALSEGNO — Bot WhatsApp v3
 *  - Mensajes de texto ✅
 *  - Audio (transcripción Whisper) ✅
 *  - Imágenes (visión GPT-4o-mini) ✅  ← NUEVO
 *  - CRUD completo: alumnos, clases, pagos, materias
 *  - Consultas libres con IA + SQL dinámico desde bot.php
 *  - Menú interactivo con opciones
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Variables de entorno:
 *   ADMIN_PHONES      Números autorizados separados por coma (sin +)
 *   ADMIN_TOKEN       Token para endpoints HTTP de administración
 *   BOT_SECRET_TOKEN  Token compartido con api/bot.php
 *   DALSEGNO_API_URL  URL de api/bot.php en Hostinger
 *   OPENAI_API_KEY    API Key de OpenAI (GPT-4o-mini + Whisper)
 *   SESSION_DIR       Carpeta de sesión WhatsApp (default: ./session)
 *   PORT              Puerto HTTP
 */

'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const express  = require('express');
const fs       = require('fs');
const https    = require('https');
const http     = require('http');
const FormData = require('form-data');

// ── Variables de entorno ──────────────────────────────────────────────────────
const ADMIN_PHONES     = (process.env.ADMIN_PHONES || '').split(',').map(p => p.trim()).filter(Boolean);
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN      || '';
const BOT_SECRET_TOKEN = process.env.BOT_SECRET_TOKEN || '';
const DALSEGNO_API_URL = process.env.DALSEGNO_API_URL || '';
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || '';
const SESSION_DIR      = process.env.SESSION_DIR      || './session';
const PORT             = process.env.PORT             || 3000;

// ── OpenAI: chat completion (solo texto) ──────────────────────────────────────
function openaiChat(messages, maxTokens = 500, temperature = 0) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ model: 'gpt-4o-mini', max_tokens: maxTokens, temperature, messages });
        const req = https.request({
            hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content?.trim() || ''); }
                catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

// ── OpenAI: visión de imágenes (GPT-4o-mini Vision) ──────────────────────────
// Analiza la imagen y extrae información relevante para el negocio
function analizarImagen(base64Data, mimeType, caption) {
    return new Promise((resolve, reject) => {
        const imageUrl = `data:${mimeType || 'image/jpeg'};base64,${base64Data}`;

        const userContent = [
            {
                type: 'image_url',
                image_url: { url: imageUrl, detail: 'high' }
            },
            {
                type: 'text',
                text: `Eres el asistente de Dalsegno, escuela de música en México.
El dueño te mandó esta imagen por WhatsApp${caption ? ` con el mensaje: "${caption}"` : ''}.

Analiza la imagen y extrae TODA la información relevante para el negocio:
- Si es un comprobante de pago/transferencia: nombre del alumno (si se ve), monto, fecha, banco/método
- Si es una lista o nota con nombres y montos: extrae todos los registros
- Si es un horario, calendario o agenda: extrae fechas, horas, alumnos
- Si es una fotografía de documento con datos de alumno: nombre, teléfono, etc.
- Cualquier dato útil para registrar en el sistema

Responde en español con un resumen claro y natural de lo que ves, como si le hablaras al dueño.
Ejemplo: "Veo un comprobante de transferencia de $500 a nombre de Ana García del 15 de marzo, banco BBVA."
Si no hay información útil para el negocio, describe brevemente qué ves.`
            }
        ];

        const body = JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 600,
            temperature: 0,
            messages: [{ role: 'user', content: userContent }]
        });

        const req = https.request({
            hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content?.trim() || ''); }
                catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

// ── Whisper: transcribir audio ────────────────────────────────────────────────
function transcribirAudio(audioBuffer, mimeType) {
    return new Promise((resolve, reject) => {
        const tmpFile = `/tmp/wa_audio_${Date.now()}.ogg`;
        fs.writeFileSync(tmpFile, audioBuffer);

        const form = new FormData();
        form.append('file', fs.createReadStream(tmpFile), { filename: 'audio.ogg', contentType: mimeType || 'audio/ogg' });
        form.append('model', 'whisper-1');
        form.append('language', 'es');

        const req = https.request({
            hostname: 'api.openai.com', path: '/v1/audio/transcriptions', method: 'POST',
            headers: { ...form.getHeaders(), 'Authorization': 'Bearer ' + OPENAI_API_KEY }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                fs.unlink(tmpFile, () => {});
                try { resolve(JSON.parse(data)?.text || ''); }
                catch(e) { reject(e); }
            });
        });
        req.on('error', err => { fs.unlink(tmpFile, () => {}); reject(err); });
        form.pipe(req);
    });
}

// ── Llamar a bot.php en Hostinger ─────────────────────────────────────────────
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
                if (res.statusCode !== 200) return reject(new Error(`Dalsegno API error ${res.statusCode}: ${data.slice(0, 200)}`));
                try { resolve(JSON.parse(data)); }
                catch(e) { reject(new Error('Respuesta inválida del servidor')); }
            });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

// ── Esquema de BD ─────────────────────────────────────────────────────────────
const DB_SCHEMA = `
users: id, name, email, phone, user_type(student/teacher/admin), status(active/inactive)
subjects: id, teacher_id→users, name, level, status(active/inactive)
classes: id, student_id→users, teacher_id→users, student_name, teacher_name, subject, date(DATE), time(TIME), duration(min), price, status(scheduled/completed/cancelled), payment_status(pending/paid), type(online/presencial), notes
payments: id, class_id→classes, student_id→users, amount, payment_method(cash/transfer/card), status(pending/paid/cancelled), payment_date, concept
reminders: id, student_id, student_name, phone_e164, amount, due_at(DATETIME), status(pending/sent/failed/cancelled)
payment_reminders: id, student_id→users, student_name, phone, amount, due_date(DATE), status(active/completed/cancelled)
`.trim();

// ── Interpretar mensaje con IA ────────────────────────────────────────────────
async function interpretarMensaje(texto) {
    const hoy = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const mes  = new Date().toISOString().slice(0, 7);

    const raw = await openaiChat([
        { role: 'system', content: `Eres el asistente de gestión de Dalsegno, escuela de música en México.
El dueño te habla por WhatsApp en español coloquial para administrar su negocio.
Responde SOLO con JSON válido. Sin markdown, sin backticks.

Hoy: ${hoy} | Mes: ${mes}

ESQUEMA DE BASE DE DATOS:
${DB_SCHEMA}

ACCIONES DISPONIBLES:

1. query — Cualquier consulta de información
   { "action": "query", "question": "pregunta específica en español" }
   → SIEMPRE usar para: ver alumnos, pagos, clases, estadísticas, reportes, historial
   → Si dicen un nombre solo → query "ver pagos y clases de [nombre]"

2. register_payment — Registrar pago de mensualidad
   { "action": "register_payment", "student_name": "", "amount": 0, "subject": "Música", "month": "${mes}", "method": "cash" }
   → Si viene de imagen/comprobante y dice transferencia → method: "transfer"
   → Si se ve tarjeta → method: "card"

3. create_student — Nuevo alumno
   { "action": "create_student", "name": "", "phone": "", "email": "" }
   → email puede ser vacío si no lo mencionan

4. create_class — Programar clase
   { "action": "create_class", "student_name": "", "subject": "", "date": "YYYY-MM-DD", "time": "HH:MM", "duration": 60, "price": 0, "type": "presencial" }
   → Infiere fecha de frases como "mañana", "el lunes", "el 5"

5. update_student — Actualizar datos de alumno
   { "action": "update_student", "student_name": "", "field": "phone|email|status|name", "value": "" }

6. update_class — Actualizar clase
   { "action": "update_class", "class_id": 0, "field": "status|payment_status|date|time|notes", "value": "" }

7. delete_record — Eliminar registro (solo si piden explícitamente borrar/eliminar)
   { "action": "delete_record", "type": "student|class|payment", "id": 0 }

8. menu — Mostrar opciones disponibles
   { "action": "menu" }
   → "menú", "opciones", "ayuda", "qué puedes hacer", "help"

9. none — Fuera de contexto del negocio
   { "action": "none", "reply": "respuesta corta amigable" }

10. ask — Solo si falta un dato imprescindible que no se puede asumir
    { "action": "ask", "message": "pregunta concreta y corta" }
    → PROHIBIDO preguntar cosas genéricas como "¿qué deseas hacer?"
    → Solo para: crear clase sin fecha, registrar pago sin nombre, etc.

REGLAS IMPORTANTES:
- Para consultas de información SIEMPRE usa "query", nunca "none"
- Infiere nombres aunque tengan typos
- "mañana" = ${new Date(Date.now()+86400000).toISOString().slice(0,10)}
- "hoy" = ${new Date().toISOString().slice(0,10)}
- Para pagos sin método → asumir "cash"
- Para clases sin duración → asumir 60 min
- Para clases sin precio → asumir 0 (se actualizará después)
- Si el texto viene de análisis de imagen y describe un comprobante de pago → usar register_payment` },
        { role: 'user', content: texto }
    ], 400, 0);

    return JSON.parse(raw);
}

// ── Menú ──────────────────────────────────────────────────────────────────────
const MENU_TEXT = `🎵 *Dalsegno Bot — Comandos disponibles*

💰 *PAGOS*
_"cristian pagó 500 de guitarra"_
_"quién debe este mes"_
_"próximos vencimientos"_
_"historial de pagos de Ana"_

👥 *ALUMNOS*
_"lista de alumnos"_
_"nuevo alumno: Juan García, tel 4961234567"_
_"cambiar teléfono de Ana a 496-000-0000"_
_"desactivar alumno Roberto"_

📅 *CLASES*
_"qué clases hay esta semana"_
_"programar clase piano con Cristian mañana 4pm"_
_"cancelar clase #45"_
_"marcar como pagada clase #50"_

📊 *REPORTES*
_"cuánto cobré este mes"_
_"resumen de pagos de marzo"_
_"clases pendientes de pago"_

🎙️ *AUDIO* — Mándame un audio con tu instrucción

🖼️ *IMÁGENES* — Mándame una foto de:
  • Comprobante de transferencia/pago
  • Lista de alumnos o apuntes
  • Horario o agenda manuscrita
  El bot extrae la info y la registra automáticamente`;

// ── WhatsApp Client ───────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
               '--disable-gpu','--no-first-run','--no-zygote','--single-process']
    }
});

client.on('qr', qr => {
    console.log('[WA] 📱 QR listo — visita http://localhost:' + PORT);
    global.__QR__ = qr;
});
client.on('authenticated',  () => console.log('[WA] Autenticado correctamente'));
client.on('auth_failure',   m  => console.error('[WA] Auth failure:', m));
client.on('ready',          () => { console.log('[WA] ✅ Cliente listo y conectado'); global.__QR__ = null; });
client.on('disconnected',   r  => console.log('[WA] Desconectado:', r));

// ── Manejador de mensajes ─────────────────────────────────────────────────────
client.on('message', async (msg) => {
    const isAudio  = msg.type === 'audio' || msg.type === 'ptt';
    const isText   = msg.type === 'chat';
    const isImage  = msg.type === 'image';
    // sticker, document con imagen, etc. también pueden tener visión
    const isDoc    = msg.type === 'document' && (msg.mimetype || '').startsWith('image/');

    if (!isAudio && !isText && !isImage && !isDoc) return;
    if (msg.from.includes('@g.us')) return; // ignorar grupos

    // Obtener número real
    let numero = msg.from.replace(/@c\.us|@s\.whatsapp\.net/, '');
    if (msg.from.includes('@lid') || !/^\d+$/.test(numero)) {
        try { const c = await msg.getContact(); numero = c.number || c.id.user; }
        catch(e) { return; }
    }

    console.log(`[MSG] from="${numero}" type="${msg.type}" body="${(msg.body||'').substring(0,60)}"`);

    if (!ADMIN_PHONES.includes(numero)) {
        console.log(`[MSG] ⛔ No autorizado: ${numero}`);
        return;
    }
    console.log(`[MSG] ✅ Admin: ${numero}`);

    if (!OPENAI_API_KEY) {
        await msg.reply('⚠️ Bot sin OPENAI_API_KEY. No puedo procesar mensajes.');
        return;
    }

    let texto = '';

    // ── Audio: transcribir con Whisper ────────────────────────────────────────
    if (isAudio) {
        let proc;
        try { proc = await msg.reply('🎙️ _Transcribiendo audio..._'); } catch(_) {}
        try {
            const media = await msg.downloadMedia();
            const buf   = Buffer.from(media.data, 'base64');
            texto = await transcribirAudio(buf, media.mimetype);
            console.log(`[AUDIO] "${texto.substring(0, 100)}"`);
            if (proc) { try { await proc.delete(true); } catch(_) {} }
            await msg.reply(`🎙️ _"${texto}"_`);
        } catch(e) {
            if (proc) { try { await proc.delete(true); } catch(_) {} }
            await msg.reply('❌ Error transcribiendo audio: ' + e.message);
            return;
        }
    }

    // ── Imagen: analizar con GPT-4o-mini Vision ───────────────────────────────
    else if (isImage || isDoc) {
        const caption = (msg.body || '').trim(); // texto que acompaña a la imagen
        let proc;
        try { proc = await msg.reply('🖼️ _Analizando imagen..._'); } catch(_) {}
        try {
            const media = await msg.downloadMedia();
            // Validar tamaño (máx ~4 MB en base64 ≈ 3 MB de imagen)
            if (media.data && media.data.length > 5_500_000) {
                if (proc) { try { await proc.delete(true); } catch(_) {} }
                await msg.reply('⚠️ Imagen demasiado grande. Intenta con una foto más pequeña o comprimida.');
                return;
            }
            const descripcion = await analizarImagen(media.data, media.mimetype, caption);
            console.log(`[IMAGE] Descripción: "${descripcion.substring(0, 150)}"`);
            if (proc) { try { await proc.delete(true); } catch(_) {} }

            // Mostrar al admin qué vio el bot en la imagen
            await msg.reply(`🖼️ *Lo que veo en la imagen:*\n${descripcion}`);

            // Si hay descripción útil, intentar convertirla en acción
            texto = caption
                ? `${caption}. Información de la imagen: ${descripcion}`
                : descripcion;

        } catch(e) {
            if (proc) { try { await proc.delete(true); } catch(_) {} }
            await msg.reply('❌ Error analizando imagen: ' + e.message);
            return;
        }
    }

    // ── Texto plano ───────────────────────────────────────────────────────────
    else {
        texto = msg.body.trim();
    }

    if (!texto || texto.length < 2) return;

    // ── Interpretar texto/transcripción/descripción imagen y ejecutar ─────────
    let proc2;
    try { proc2 = await msg.reply('⏳ _Procesando..._'); } catch(_) {}

    const deleteProc = async () => { if (proc2) { try { await proc2.delete(true); } catch(_) {} } };

    try {
        const cmd = await interpretarMensaje(texto);
        console.log(`[BOT] Comando:`, JSON.stringify(cmd));
        await deleteProc();

        if (cmd.action === 'menu') {
            await msg.reply(MENU_TEXT);
            return;
        }

        if (cmd.action === 'none') {
            await msg.reply(cmd.reply || '¡Hola! Escribe *menú* para ver opciones.');
            return;
        }

        if (cmd.action === 'ask') {
            await msg.reply(`🤔 ${cmd.message}`);
            return;
        }

        // Todas las demás acciones van a bot.php
        const result = await llamarDalsegno(cmd);
        await msg.reply(result.message || (result.success ? '✅ Listo' : '❌ ' + (result.error || 'Error')));

    } catch(e) {
        await deleteProc();
        console.error('[BOT] Error:', e.message);
        if (e.message.includes('JSON')) {
            await msg.reply('❓ No entendí. Intenta de otra forma o escribe *menú*.');
        } else {
            await msg.reply('❌ ' + e.message);
        }
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
<p style="opacity:.6;margin-top:16px">WhatsApp → ⋮ → Dispositivos vinculados → Vincular dispositivo</p>
<script>new QRCode(document.getElementById('qr'),{text:"${global.__QR__}",width:300,height:300})</script>
</body></html>`);
    } else {
        res.send(`<html><body style="background:#111;color:#0f0;font-family:monospace;padding:40px"><h2>✅ WhatsApp conectado y activo</h2></body></html>`);
    }
});

app.get('/status', (req, res) => res.json({ ok: true, connected: !global.__QR__, admins: ADMIN_PHONES.length, ts: new Date().toISOString() }));

app.post('/send', async (req, res) => {
    const token = req.headers['x-admin-token'] || '';
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: 'No autorizado' });
    const { phone, text } = req.body;
    if (!phone || !text) return res.status(400).json({ ok: false, error: 'Faltan phone o text' });
    try {
        await client.sendMessage(phone.includes('@') ? phone : phone + '@c.us', text);
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Limpieza Chromium ─────────────────────────────────────────────────────────
function cleanChromiumLocks() {
    const { execSync } = require('child_process');
    console.log('[WA-CLEAN] ▶️  Limpiando locks en:', SESSION_DIR);
    ['SingletonLock','SingletonCookie','SingletonSocket'].forEach(lock => {
        try { execSync(`find "${SESSION_DIR}" -name "${lock}" -delete 2>/dev/null || true`); console.log(`[WA-CLEAN] 🧹 ${lock}`); }
        catch(e) {}
    });
    try { execSync('pkill -f chromium 2>/dev/null || true'); execSync('pkill -f chrome 2>/dev/null || true'); } catch(e) {}
    console.log('[WA-CLEAN] ✅ Limpieza completada');
}

// ── Inicio ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[SERVER] 🚀 Puerto ${PORT}`);
    if (ADMIN_TOKEN)             console.log('[SERVER] 🔒 ADMIN_TOKEN ok');
    if (OPENAI_API_KEY)          console.log('[SERVER] 🤖 OpenAI activado (GPT-4o-mini Vision + Whisper)');
    if (ADMIN_PHONES.length > 0) console.log(`[SERVER] 📱 Admins: ${ADMIN_PHONES.join(', ')}`);
    if (!DALSEGNO_API_URL)       console.log('[SERVER] ⚠️  Sin DALSEGNO_API_URL');
});

console.log('[WA] Preparando ambiente...');
cleanChromiumLocks();

setTimeout(() => {
    console.log('[WA] 🚀 Iniciando cliente WhatsApp...');
    client.initialize().catch(err => {
        console.error('[WA] ❌ Error al inicializar:', err.message);
        cleanChromiumLocks();
        setTimeout(() => client.initialize().catch(err2 => { console.error('[WA] ❌ Fallo definitivo:', err2.message); process.exit(1); }), 3000);
    });
}, 2000);
