/**
 * DALSEGNO — Bot WhatsApp v7 (Baileys)
 * Migrado de whatsapp-web.js a @whiskeysockets/baileys
 * - Selección por número cuando hay varios alumnos
 * - create_teacher como acción válida
 * - No pregunta email (es opcional y se genera automático)
 * - "cancelar" bien diferenciado de "eliminar"
 * - Contexto/historial completo de conversación
 * - Audio (Whisper) + Imagen (GPT-4o Vision)
 */
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';

import express from 'express';
import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import qrcode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const ADMIN_PHONES     = (process.env.ADMIN_PHONES || '').split(',').map(p=>p.trim()).filter(Boolean);
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN      || '';
const BOT_SECRET_TOKEN = process.env.BOT_SECRET_TOKEN || '';
const DALSEGNO_API_URL = process.env.DALSEGNO_API_URL || '';
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || '';
const AUTH_DIR         = process.env.SESSION_DIR       || './auth_info';
const PORT             = process.env.PORT             || 3000;

// ── Estado global del bot ────────────────────────────────────────────────────
let sock      = null;
let qrDataUrl = null;
let botReady  = false;
let botNumber = null;

// ── Contexto de conversación ─────────────────────────────────────────────────
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

// ── Safe JSON parser (limpia backticks, texto extra, etc.) ───────────────────
function safeParseJSON(raw) {
    if (!raw || typeof raw !== 'string') throw new Error('Respuesta vacía');
    let clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const firstBrace = clean.indexOf('{');
    const lastBrace  = clean.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        clean = clean.substring(firstBrace, lastBrace + 1);
    }
    return JSON.parse(clean);
}

// ── OpenAI helpers ───────────────────────────────────────────────────────────
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

        // Construir multipart form manualmente (sin dependencia de form-data)
        const boundary = '----FormBoundary' + Date.now().toString(36);
        const fileData = fs.readFileSync(tmpFile);

        const parts = [];
        // file part
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.ogg"\r\nContent-Type: ${mimeType||'audio/ogg'}\r\n\r\n`));
        parts.push(fileData);
        parts.push(Buffer.from('\r\n'));
        // model part
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`));
        // language part
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nes\r\n`));
        // closing
        parts.push(Buffer.from(`--${boundary}--\r\n`));

        const bodyBuffer = Buffer.concat(parts);

        const req = https.request({
            hostname:'api.openai.com', path:'/v1/audio/transcriptions', method:'POST',
            headers:{
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Authorization':'Bearer '+OPENAI_API_KEY,
                'Content-Length': bodyBuffer.length
            }
        }, res => {
            let data=''; res.on('data',d=>data+=d);
            res.on('end',()=>{ fs.unlink(tmpFile,()=>{}); try{resolve(JSON.parse(data)?.text||'');}catch(e){reject(e);} });
        });
        req.on('error',err=>{ fs.unlink(tmpFile,()=>{}); reject(err); });
        req.write(bodyBuffer);
        req.end();
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
                try{resolve(JSON.parse(data));}catch(e){
                    resolve({success:false, message: data.slice(0,500) || 'Respuesta inválida del servidor'});
                }
            });
        });
        req.on('error',reject); req.write(body); req.end();
    });
}

// ── Resolver selección cuando hay múltiples alumnos ──────────────────────────
function resolverSeleccion(texto, opciones) {
    const t = texto.trim().toLowerCase();
    const numMap = { 'primero':1,'primera':1,'primer':1,'first':1,'uno':1,'1':1,
                     'segundo':2,'segunda':2,'two':2,'dos':2,'2':2,
                     'tercero':3,'tercera':3,'three':3,'tres':3,'3':3 };
    for (const [word, idx] of Object.entries(numMap)) {
        if (t === word || t === `el ${word}` || t === `la ${word}` || t === `#${idx}`) {
            if (opciones[idx-1]) return opciones[idx-1];
        }
    }
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
3. Si dice "registrala/registralo con tel X" → update_student del LAST_ENTITY con field=phone
4. "y con correo X", "también su email X", "y su correo X", "ponle el correo X" → update_student LAST_ENTITY field=email
5. "y su tel X", "también ponle el tel X", "y con número X" → update_student LAST_ENTITY field=phone
6. Cualquier mensaje que empiece con "y " o "también " con LAST_ENTITY activo → continuar editando ese registro
7. Si dice "cancelar" una clase → update_class status=cancelled (NO delete_record)
8. "dar de baja"/"desactivar" → update_student status=inactive | "reactivar" → status=active
9. Si bot.php devolvió "Varios alumnos: X, Y" → esperar selección del usuario
10. NUNCA inventar emails. NUNCA responder "none" cuando hay un LAST_ENTITY y el mensaje da un dato como correo o teléfono
11. Comprobante en imagen → register_payment con method="transfer"
12. "profesor"/"maestro"/"teacher" → create_teacher (NO create_student)
13. Mes actual: "este mes"="${mes}"
14. REGLA CRÍTICA DE ENCADENAMIENTO:
    usuario: "nuevo alumno marybel" → crea alumno → LAST_ENTITY={name:marybel}
    usuario: "pero agregale este numero 4961587988" → update_student marybel phone=4961587988
    usuario: "y con correo marybel@gmail.com" → update_student marybel email=marybel@gmail.com ✅ (NO "none")

LAST_ENTITY activo: ${ctx.lastEntity ? JSON.stringify(ctx.lastEntity) : 'ninguno'}

15. IDs REALES: Las listas muestran IDs reales como (#ID). Cuando el usuario dice "borrame el 4" o "elimina el #8", BUSCA en el historial de esta conversación el ID real (#N) del registro. Si la lista decía "4. *Cristian* (#8)", y el usuario dice "borrame el 4", el ID real es 8 NO 4. Siempre usa el número entre paréntesis (#). Si no hay ID claro en el historial, primero haz un query para encontrar el ID.` },
        ...ctx.history,
        { role:'user', content: textoActual }
    ];

    const raw = await openaiChat(messages, 600, 0);
    try {
        return safeParseJSON(raw);
    } catch(e) {
        console.log(`[BOT] JSON inválido, reintentando... raw="${raw.substring(0,150)}"`);
        const raw2 = await openaiChat([
            ...messages,
            { role:'user', content: 'ERROR: Tu respuesta anterior no fue JSON válido. Analiza de nuevo el mensaje del usuario y responde ÚNICAMENTE con el objeto JSON de la acción. Sin texto, sin backticks, sin explicaciones. Solo el JSON.' }
        ], 600, 0);
        return safeParseJSON(raw2);
    }
}

const MENU_TEXT = `🎵 *Dalsegno Bot v7*

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

// ── Helper: extraer número limpio de un JID ──────────────────────────────────
function jidToNumber(jid) {
    return (jid || '').replace('@s.whatsapp.net','').replace('@lid','').replace(/\D/g,'');
}

// ── Helper: reply ────────────────────────────────────────────────────────────
async function reply(remoteJid, text) {
    if (!sock) return;
    try { await sock.sendMessage(remoteJid, { text }); } catch(e) { console.error('[REPLY]', e.message); }
}

// ── Conectar Baileys ─────────────────────────────────────────────────────────
async function conectar() {
    const authDir = path.join(__dirname, AUTH_DIR);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version }          = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Dalsegno Bot', 'Chrome', '131.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('[WA] QR generado');
            try { qrDataUrl = await qrcode.toDataURL(qr); } catch(e) {}
            botReady = false;
        }

        if (connection === 'open') {
            botReady  = true;
            qrDataUrl = null;
            botNumber = sock.user?.id?.split(':')[0] || null;
            console.log(`[WA] ✅ Conectado: ${botNumber}`);
        }

        if (connection === 'close') {
            botReady = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`[WA] Desconectado. Código: ${code}`);
            if (code === DisconnectReason.loggedOut) {
                try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
                setTimeout(conectar, 3000);
            } else {
                setTimeout(conectar, 5000);
            }
        }
    });

    // ── Handler de mensajes ──────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
        if (type !== 'notify') return;

        for (const msg of msgs) {
            if (msg.key.fromMe) continue;
            if (!msg.message) continue;

            const remoteJid = msg.key.remoteJid || '';
            if (remoteJid.includes('@g.us') || remoteJid.includes('status@')) continue;

            const numero = jidToNumber(remoteJid);
            if (!numero) continue;

            // Determinar tipo de mensaje
            const msgContent = msg.message;
            const isAudio = !!(msgContent.audioMessage);
            const isImage = !!(msgContent.imageMessage);
            const isText  = !!(msgContent.conversation || msgContent.extendedTextMessage);

            if (!isAudio && !isText && !isImage) continue;

            console.log(`[MSG] from="${numero}" type="${isAudio?'audio':isImage?'image':'text'}" body="${(msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '').substring(0,70)}"`);

            if (!ADMIN_PHONES.includes(numero)) continue;
            if (!OPENAI_API_KEY) { await reply(remoteJid, '⚠️ Sin OPENAI_API_KEY'); continue; }

            let texto = '', textoHist = '';

            // ── Audio → Whisper ──────────────────────────────────────────────
            if (isAudio) {
                try {
                    const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    });
                    const mime = msgContent.audioMessage?.mimetype || 'audio/ogg';
                    texto = await transcribirAudio(audioBuffer, mime);
                    console.log(`[AUDIO] "${texto.substring(0,100)}"`);
                    await reply(remoteJid, `🎙️ _"${texto}"_`);
                    textoHist = texto;
                } catch(e) { await reply(remoteJid, '❌ Error en audio: '+e.message); continue; }
            }
            // ── Imagen → Vision ──────────────────────────────────────────────
            else if (isImage) {
                const caption = (msgContent.imageMessage?.caption || '').trim();
                try {
                    const imgBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    });
                    if (imgBuffer.length > 5_500_000) { await reply(remoteJid, '⚠️ Imagen muy grande.'); continue; }
                    const base64Data = imgBuffer.toString('base64');
                    const mime = msgContent.imageMessage?.mimetype || 'image/jpeg';
                    const desc = await analizarImagen(base64Data, mime, caption);
                    console.log(`[IMAGE] "${desc.substring(0,150)}"`);
                    await reply(remoteJid, `🖼️ *Veo:* ${desc}`);
                    texto = caption ? `${caption}. Imagen: ${desc}` : desc;
                    textoHist = texto;
                } catch(e) { await reply(remoteJid, '❌ Error imagen: '+e.message); continue; }
            }
            // ── Texto ────────────────────────────────────────────────────────
            else {
                texto = (msgContent.conversation || msgContent.extendedTextMessage?.text || '').trim();
                textoHist = texto;
            }

            if (!texto || texto.length < 2) continue;

            const ctx = getCtx(numero);

            // ── Manejar selección pendiente ──────────────────────────────────
            if (ctx.pendingSelection) {
                const { originalCmd, opciones } = ctx.pendingSelection;
                const seleccionado = resolverSeleccion(texto, opciones);
                if (seleccionado) {
                    console.log(`[SELECT] Seleccionado: ${seleccionado.name}`);
                    const cmdCorregido = { ...originalCmd, student_name: seleccionado.name };
                    try {
                        const result = await llamarDalsegno(cmdCorregido);
                        const respMsg = result.message || (result.success ? '✅ Listo' : '❌ '+(result.error||'Error'));
                        const newHist = [...ctx.history,
                            { role:'user', content: textoHist },
                            { role:'assistant', content: respMsg }
                        ];
                        saveCtx(numero, newHist, { type: originalCmd.action, name: seleccionado.name }, null);
                        await reply(remoteJid, respMsg);
                    } catch(e) {
                        saveCtx(numero, ctx.history, ctx.lastEntity, null);
                        await reply(remoteJid, '❌ '+e.message);
                    }
                    continue;
                }
                saveCtx(numero, ctx.history, ctx.lastEntity, null);
            }

            try {
                const cmd = await interpretarMensaje(texto, ctx);
                console.log(`[BOT] cmd:`, JSON.stringify(cmd));

                const newHistory = [...ctx.history, { role:'user', content: textoHist }];
                let newLastEntity = ctx.lastEntity;

                if (cmd.action==='menu') {
                    saveCtx(numero, newHistory, newLastEntity);
                    await reply(remoteJid, MENU_TEXT); continue;
                }
                if (cmd.action==='none') {
                    saveCtx(numero, newHistory, newLastEntity);
                    await reply(remoteJid, cmd.reply||'¡Hola! Escribe *menú* para ver opciones.'); continue;
                }
                if (cmd.action==='ask') {
                    const botMsg = `🤔 ${cmd.message}`;
                    newHistory.push({ role:'assistant', content: `[esperando: ${cmd.pending_action}] [datos: ${JSON.stringify(cmd.partial_data||{})}] ${botMsg}` });
                    if (cmd.partial_data?.student_name||cmd.partial_data?.name) {
                        newLastEntity = { type: cmd.pending_action, name: cmd.partial_data.student_name||cmd.partial_data.name };
                    }
                    saveCtx(numero, newHistory, newLastEntity, null);
                    await reply(remoteJid, botMsg); continue;
                }

                // Ejecutar en bot.php
                const result = await llamarDalsegno(cmd);
                const respMsg = result.message||(result.success?'✅ Listo':'❌ '+(result.error||'Error'));

                // Varios alumnos → selección pendiente
                if (!result.success && result.message && result.message.includes('Varios alumnos') && result.students) {
                    console.log(`[SELECT] Varios alumnos, guardando selección pendiente`);
                    const listaNum = result.students.map((s,i)=>`${i+1}. ${s.name}`).join('\n');
                    const pregunta = `${result.message}\n\n${listaNum}\n\nEscribe el número o el nombre completo:`;
                    newHistory.push({ role:'assistant', content: pregunta });
                    saveCtx(numero, newHistory, newLastEntity, { originalCmd: cmd, opciones: result.students });
                    await reply(remoteJid, pregunta); continue;
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
                await reply(remoteJid, respMsg);

            } catch(e) {
                console.error('[BOT] Error:', e.message);
                const newHistory = [...ctx.history, { role:'user', content: textoHist }];
                saveCtx(numero, newHistory, ctx.lastEntity, null);
                if (e.message.includes('JSON') || e.message.includes('vacía')) {
                    await reply(remoteJid, '❓ No entendí tu mensaje. Intenta escribirlo de otra forma o escribe *menú* para ver opciones.');
                } else {
                    await reply(remoteJid, '❌ '+e.message);
                }
            }
        }
    });
}

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    if (qrDataUrl) {
        res.send(`<!DOCTYPE html><html><head><title>Dalsegno QR</title></head>
<body style="background:#111;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh">
<h2>📱 Escanea con WhatsApp</h2>
<img src="${qrDataUrl}" style="width:300px;height:300px;border-radius:12px" />
<p style="opacity:.6;margin-top:20px">WhatsApp → ⋮ → Dispositivos vinculados → Vincular dispositivo</p>
</body></html>`);
    } else {
        res.send(`<html><body style="background:#111;color:#0f0;font-family:monospace;padding:40px"><h2>✅ WhatsApp conectado</h2><p>Número: ${botNumber || '...'}</p><p>Conversaciones activas: ${convContexts.size}</p></body></html>`);
    }
});

app.get('/status', (req, res) => res.json({
    ok: true,
    connected: botReady,
    number: botNumber,
    admins: ADMIN_PHONES.length,
    sessions: convContexts.size,
    ts: new Date().toISOString()
}));

app.post('/send', async (req, res) => {
    if (ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(401).json({ok:false});
    const { phone, text } = req.body;
    if (!phone || !text) return res.status(400).json({ok:false, error:'Faltan phone o text'});
    try {
        const jid = phone.replace(/\D/g,'') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text });
        res.json({ok:true});
    } catch(e) { res.status(500).json({ok:false, error:e.message}); }
});

app.listen(PORT, () => {
    console.log(`[SERVER] 🚀 Puerto ${PORT}`);
    if (OPENAI_API_KEY) console.log('[SERVER] 🤖 OpenAI (Vision+Whisper)');
    if (ADMIN_PHONES.length > 0) console.log(`[SERVER] 📱 Admins: ${ADMIN_PHONES.join(', ')}`);
    if (!DALSEGNO_API_URL) console.log('[SERVER] ⚠️ Sin DALSEGNO_API_URL');
});

// ── Arrancar ─────────────────────────────────────────────────────────────────
setTimeout(() => {
    console.log('[WA] 🚀 Iniciando Baileys...');
    conectar().catch(err => {
        console.error('[WA] ❌', err.message);
        setTimeout(() => conectar().catch(e2 => { console.error('[WA] Fallo:', e2.message); process.exit(1); }), 3000);
    });
}, 1000);
