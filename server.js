/**
 * =====================================================
 *  DALSEGNO — Bot WhatsApp (whatsapp-web.js + Express)
 *  Deploy: Railway / cualquier VPS con Node.js 18+
 * =====================================================
 *
 *  ENDPOINTS:
 *   GET  /              → estado del bot
 *   GET  /qr            → imagen del QR para escanear (PNG base64)
 *   GET  /status        → {"ready": true/false, "state": "..."}
 *   GET  /send?phone=521234567890&text=Hola → envía mensaje
 *   POST /send          → body JSON: { "phone": "521234567890", "text": "Hola" }
 *
 *  VARIABLES DE ENTORNO (Railway → Variables):
 *   PORT            (Railway lo pone automáticamente)
 *   ADMIN_TOKEN     Token secreto para proteger /send  (opcional pero recomendado)
 *   SESSION_DIR     Carpeta donde guardar la sesión   (por defecto: ./session)
 */

'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode');
const express = require('express');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Configuración ─────────────────────────────────────────────────────────────
const PORT         = process.env.PORT         || 3000;
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN  || '';   // si está vacío, no pide token
const SESSION_DIR  = process.env.SESSION_DIR  || './session';

// ── Estado global ─────────────────────────────────────────────────────────────
let qrDataUrl   = null;   // base64 del QR actual
let clientReady = false;  // true cuando WhatsApp está conectado
let clientState = 'STARTING';

// ── Cliente WhatsApp ──────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
        ],
    },
});

client.on('qr', async (qr) => {
    clientState = 'QR_READY';
    clientReady = false;
    // Convertir a imagen para poder mostrarla en el navegador
    qrDataUrl = await qrcode.toDataURL(qr);
    console.log('[QR] Nuevo QR generado — visita /qr para escanearlo');
    // También mostrar en consola por si se prefiere
    require('qrcode-terminal').generate(qr, { small: true });
});

client.on('ready', () => {
    clientReady = true;
    clientState = 'READY';
    qrDataUrl   = null;
    console.log('[WA] ✅ Cliente listo y conectado');
});

client.on('authenticated', () => {
    clientState = 'AUTHENTICATED';
    console.log('[WA] Autenticado correctamente');
});

client.on('auth_failure', (msg) => {
    clientState = 'AUTH_FAILURE';
    clientReady = false;
    console.error('[WA] ❌ Error de autenticación:', msg);
});

client.on('disconnected', (reason) => {
    clientState = 'DISCONNECTED';
    clientReady = false;
    console.warn('[WA] Desconectado:', reason);
    // Reintentar conexión después de 5 segundos
    setTimeout(() => {
        console.log('[WA] Intentando reconectar...');
        client.initialize().catch(console.error);
    }, 5000);
});

// ── Middleware de autenticación (opcional) ────────────────────────────────────
function authMiddleware(req, res, next) {
    if (!ADMIN_TOKEN) return next(); // sin token configurado → libre acceso

    const token =
        req.headers['x-admin-token'] ||
        req.query.token              ||
        (req.body && req.body.token);

    if (token === ADMIN_TOKEN) return next();
    return res.status(401).json({ ok: false, error: 'Token inválido' });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Normaliza un número de teléfono a formato E.164 sin '+'.
 * Acepta: 52XXXXXXXXXX, 0XXXXXXXXXX, XXXXXXXXXX (10 dígitos MX)
 */
function normalizePhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (/^52\d{10}$/.test(digits)) return digits;          // ya completo
    if (/^\d{10}$/.test(digits))   return '52' + digits;   // agregar 52
    return digits;                                          // pasar tal cual
}

async function sendMessage(phone, text) {
    if (!clientReady) {
        throw new Error(`El cliente WhatsApp no está listo (estado: ${clientState})`);
    }
    const chatId = `${phone}@c.us`;
    const info   = await client.sendMessage(chatId, text);
    return { messageId: info.id._serialized };
}

// ── Rutas ─────────────────────────────────────────────────────────────────────

/** Página de inicio con estado y QR */
app.get('/', (req, res) => {
    const html = clientReady
        ? `<!DOCTYPE html><html lang="es"><body style="font-family:sans-serif;padding:2rem">
           <h1>✅ Bot WhatsApp – Conectado</h1>
           <p>Estado: <strong>${clientState}</strong></p>
           <p>El bot está listo para enviar mensajes.</p>
           <hr/>
           <h3>Prueba de envío</h3>
           <form method="GET" action="/send">
             <input name="phone" placeholder="521234567890" style="padding:.5rem;width:200px"/>
             <input name="text"  placeholder="Mensaje de prueba" style="padding:.5rem;width:300px"/>
             <button type="submit" style="padding:.5rem 1rem">Enviar</button>
           </form>
           </body></html>`
        : `<!DOCTYPE html><html lang="es"><body style="font-family:sans-serif;padding:2rem">
           <h1>📱 Bot WhatsApp – Pendiente de conexión</h1>
           <p>Estado: <strong>${clientState}</strong></p>
           ${qrDataUrl
             ? `<p>Escanea este QR con tu WhatsApp:</p>
                <img src="${qrDataUrl}" style="width:300px;height:300px"/>`
             : `<p>Generando QR... recarga en unos segundos o visita <a href="/qr">/qr</a></p>`}
           <script>setTimeout(()=>location.reload(), 5000)</script>
           </body></html>`;
    res.send(html);
});

/** QR como imagen PNG */
app.get('/qr', (req, res) => {
    if (clientReady) {
        return res.json({ ok: true, message: 'Ya conectado, no necesitas QR' });
    }
    if (!qrDataUrl) {
        return res.status(202).json({ ok: false, message: 'QR aún no disponible, espera unos segundos' });
    }
    // Devolver como imagen
    const base64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from(base64, 'base64'));
});

/** Estado JSON */
app.get('/status', (req, res) => {
    res.json({ ok: true, ready: clientReady, state: clientState });
});

/** Envío de mensaje — GET ?phone=&text= */
app.get('/send', authMiddleware, async (req, res) => {
    const phone = normalizePhone(req.query.phone);
    const text  = req.query.text || '';

    if (!phone || phone.length < 10) {
        return res.status(400).json({ ok: false, error: 'Teléfono inválido' });
    }
    if (!text.trim()) {
        return res.status(400).json({ ok: false, error: 'El texto no puede estar vacío' });
    }

    try {
        const result = await sendMessage(phone, text);
        console.log(`[SEND] ✅ ${phone} — "${text.substring(0, 40)}..."`);
        res.json({ ok: true, phone, ...result });
    } catch (err) {
        console.error(`[SEND] ❌ ${phone} — ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/** Envío de mensaje — POST { phone, text, token? } */
app.post('/send', authMiddleware, async (req, res) => {
    const phone = normalizePhone(req.body.phone || req.body.to);
    const text  = req.body.text || req.body.message || '';

    if (!phone || phone.length < 10) {
        return res.status(400).json({ ok: false, error: 'Teléfono inválido' });
    }
    if (!text.trim()) {
        return res.status(400).json({ ok: false, error: 'El texto no puede estar vacío' });
    }

    try {
        const result = await sendMessage(phone, text);
        console.log(`[SEND] ✅ ${phone} — "${text.substring(0, 40)}..."`);
        res.json({ ok: true, phone, ...result });
    } catch (err) {
        console.error(`[SEND] ❌ ${phone} — ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/** Webhook de WhatsApp (para recibir mensajes entrantes, opcional) */
client.on('message', (msg) => {
    const body = msg.body.toLowerCase().trim();
    // Respuesta automática simple (puedes personalizar o deshabilitar)
    if (body === 'hola' || body === 'hello') {
        msg.reply('¡Hola! Soy el asistente de Dalsegno 🎵. Para consultas sobre tus clases contacta a tu maestro.');
    }
});

// ── Inicio ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[SERVER] 🚀 Servidor escuchando en puerto ${PORT}`);
    console.log(`[SERVER] Abre http://localhost:${PORT} en tu navegador para ver el QR`);
    if (ADMIN_TOKEN) {
        console.log('[SERVER] 🔒 ADMIN_TOKEN configurado — rutas /send protegidas');
    } else {
        console.log('[SERVER] ⚠️  Sin ADMIN_TOKEN — cualquiera puede enviar mensajes');
    }
});

client.initialize().catch((err) => {
    console.error('[WA] Error al inicializar cliente:', err.message);
    process.exit(1);
});
