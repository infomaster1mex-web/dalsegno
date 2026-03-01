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
    // Verificar que el número existe en WhatsApp antes de enviar
    const numberId = await client.getNumberId(phone);
    if (!numberId) {
        throw new Error(`El número ${phone} no está registrado en WhatsApp`);
    }
    const info = await client.sendMessage(numberId._serialized, text);
    return { messageId: info.id._serialized };
}

// ── Rutas ─────────────────────────────────────────────────────────────────────

/** Página de inicio con estado y QR */
app.get('/', (req, res) => {
    const isReady = clientReady;
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Dalsegno — Bot WhatsApp</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --green:   #22c55e;
    --green2:  #16a34a;
    --amber:   #f59e0b;
    --red:     #ef4444;
    --bg:      #080d14;
    --surface: #0f1923;
    --surface2:#162130;
    --border:  rgba(255,255,255,.07);
    --text:    #e8f0fe;
    --muted:   #64748b;
  }

  body {
    font-family: 'Sora', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
    position: relative;
    overflow-x: hidden;
  }

  /* Fondo animado */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse 70% 50% at 20% 20%, rgba(34,197,94,.08) 0%, transparent 60%),
      radial-gradient(ellipse 50% 40% at 80% 80%, rgba(59,130,246,.07) 0%, transparent 60%);
    pointer-events: none;
    z-index: 0;
  }

  .card {
    position: relative;
    z-index: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 24px;
    padding: 3rem 2.5rem;
    width: 100%;
    max-width: 480px;
    box-shadow: 0 40px 80px rgba(0,0,0,.5);
    animation: slideUp .6s cubic-bezier(.16,1,.3,1) both;
  }

  @keyframes slideUp {
    from { opacity:0; transform: translateY(30px); }
    to   { opacity:1; transform: translateY(0);    }
  }

  /* Logo */
  .logo {
    display: flex;
    align-items: center;
    gap: .75rem;
    margin-bottom: 2.5rem;
  }
  .logo-icon {
    width: 44px; height: 44px;
    background: linear-gradient(135deg, #22c55e, #16a34a);
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 1.4rem;
    box-shadow: 0 0 20px rgba(34,197,94,.4);
  }
  .logo-text { font-size: 1.4rem; font-weight: 800; letter-spacing: -.02em; }
  .logo-sub  { font-size: .7rem; color: var(--muted); font-weight: 400; letter-spacing: .08em; text-transform: uppercase; margin-top: 1px; }

  /* Badge de estado */
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: .5rem;
    padding: .35rem .9rem;
    border-radius: 999px;
    font-size: .78rem;
    font-weight: 600;
    letter-spacing: .03em;
    margin-bottom: 2rem;
    border: 1px solid;
  }
  .status-badge.ready   { background: rgba(34,197,94,.1); color: var(--green);  border-color: rgba(34,197,94,.25); }
  .status-badge.waiting { background: rgba(245,158,11,.1); color: var(--amber); border-color: rgba(245,158,11,.25); }
  .status-badge.error   { background: rgba(239,68,68,.1);  color: var(--red);   border-color: rgba(239,68,68,.25); }

  .dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%,100% { opacity:1; transform:scale(1); }
    50%      { opacity:.5; transform:scale(.7); }
  }

  /* Título principal */
  h1 {
    font-size: 1.9rem;
    font-weight: 800;
    line-height: 1.15;
    letter-spacing: -.03em;
    margin-bottom: .6rem;
  }
  .subtitle {
    color: var(--muted);
    font-size: .9rem;
    line-height: 1.6;
    margin-bottom: 2rem;
  }

  /* Divider */
  .divider {
    height: 1px;
    background: var(--border);
    margin: 2rem 0;
  }

  /* QR Box */
  .qr-box {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 1.5rem;
    text-align: center;
    margin-bottom: 1.5rem;
  }
  .qr-box img {
    width: 220px; height: 220px;
    border-radius: 12px;
    display: block;
    margin: 0 auto 1rem;
    background: white;
    padding: 8px;
  }
  .qr-hint {
    font-size: .78rem;
    color: var(--muted);
    line-height: 1.5;
  }

  /* Formulario de prueba */
  .form-label {
    font-size: .75rem;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: .06em;
    text-transform: uppercase;
    margin-bottom: .6rem;
    display: block;
  }
  .form-row {
    display: flex;
    gap: .5rem;
    flex-wrap: wrap;
  }
  .input {
    flex: 1;
    min-width: 0;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: .82rem;
    padding: .65rem .9rem;
    outline: none;
    transition: border-color .2s;
  }
  .input:focus { border-color: rgba(34,197,94,.5); }
  .input::placeholder { color: var(--muted); }

  .btn {
    padding: .65rem 1.4rem;
    background: linear-gradient(135deg, var(--green), var(--green2));
    color: #fff;
    border: none;
    border-radius: 10px;
    font-family: 'Sora', sans-serif;
    font-size: .85rem;
    font-weight: 700;
    cursor: pointer;
    transition: opacity .2s, transform .15s;
    white-space: nowrap;
  }
  .btn:hover   { opacity: .9; transform: translateY(-1px); }
  .btn:active  { transform: translateY(0); }
  .btn:disabled { opacity: .4; cursor: not-allowed; }

  /* Token input */
  .token-row {
    display: flex;
    gap: .5rem;
    margin-bottom: 1rem;
  }

  /* Toast */
  #toast {
    position: fixed;
    bottom: 2rem;
    left: 50%;
    transform: translateX(-50%) translateY(20px);
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: .75rem 1.5rem;
    font-size: .85rem;
    font-weight: 600;
    opacity: 0;
    transition: all .3s;
    z-index: 99;
    pointer-events: none;
    white-space: nowrap;
  }
  #toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
  #toast.ok  { color: var(--green); border-color: rgba(34,197,94,.3); }
  #toast.err { color: var(--red);   border-color: rgba(239,68,68,.3); }

  /* Stats row */
  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: .75rem;
    margin-bottom: 2rem;
  }
  .stat {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: .9rem 1rem;
  }
  .stat-val { font-size: 1.3rem; font-weight: 800; letter-spacing: -.03em; }
  .stat-key { font-size: .7rem; color: var(--muted); font-weight: 500; letter-spacing: .05em; text-transform: uppercase; margin-top: 2px; }
</style>
</head>
<body>

<div class="card">
  <div class="logo">
    <div class="logo-icon">🎵</div>
    <div>
      <div class="logo-text">Dalsegno</div>
      <div class="logo-sub">Bot WhatsApp</div>
    </div>
  </div>

  ${isReady ? `
  <span class="status-badge ready"><span class="dot"></span>READY — Conectado</span>
  <h1>Bot activo<br/>y en línea</h1>
  <p class="subtitle">El servidor está procesando recordatorios y enviando mensajes a tus alumnos automáticamente.</p>

  <div class="stats">
    <div class="stat">
      <div class="stat-val" style="color:var(--green)">✓</div>
      <div class="stat-key">WhatsApp</div>
    </div>
    <div class="stat">
      <div class="stat-val" style="color:var(--green)">✓</div>
      <div class="stat-key">API activa</div>
    </div>
  </div>

  <div class="divider"></div>

  <label class="form-label">🔑 Token de acceso</label>
  <div class="token-row">
    <input id="tokenInput" class="input" type="password" placeholder="Tu ADMIN_TOKEN"/>
  </div>

  <label class="form-label">📤 Enviar mensaje de prueba</label>
  <div class="form-row" style="margin-bottom:.6rem">
    <input id="phoneInput" class="input" placeholder="521234567890" value=""/>
  </div>
  <div class="form-row">
    <input id="textInput" class="input" placeholder="Escribe un mensaje de prueba..."/>
    <button class="btn" onclick="sendTest()">Enviar</button>
  </div>
  ` : `
  <span class="status-badge waiting"><span class="dot"></span>${clientState}</span>
  <h1>Escanea el<br/>código QR</h1>
  <p class="subtitle">Abre WhatsApp en tu celular → <strong>Dispositivos vinculados</strong> → <strong>Vincular dispositivo</strong> → escanea este código.</p>

  <div class="qr-box">
    ${qrDataUrl
      ? `<img src="${qrDataUrl}" alt="QR"/>`
      : `<div style="width:220px;height:220px;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem;color:var(--muted);font-size:.85rem;background:var(--surface2);border-radius:12px">Generando QR…</div>`
    }
    <p class="qr-hint">El QR se actualiza cada 20 segundos.<br/>Esta página recarga automáticamente.</p>
  </div>
  <script>setTimeout(()=>location.reload(), 6000)</script>
  `}
</div>

<div id="toast"></div>

<script>
async function sendTest() {
  const phone = document.getElementById('phoneInput').value.trim();
  const text  = document.getElementById('textInput').value.trim();
  const token = document.getElementById('tokenInput')?.value.trim() || '';
  if (!phone || !text) { showToast('Completa teléfono y mensaje', false); return; }
  const btn = document.querySelector('.btn');
  btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    const url = '/send?phone=' + encodeURIComponent(phone) + '&text=' + encodeURIComponent(text) + (token ? '&token=' + encodeURIComponent(token) : '');
    const r = await fetch(url);
    const j = await r.json();
    if (j.ok) { showToast('✅ Mensaje enviado!', true); }
    else       { showToast('❌ ' + (j.error || 'Error'), false); }
  } catch(e) { showToast('❌ ' + e.message, false); }
  finally { btn.disabled = false; btn.textContent = 'Enviar'; }
}

function showToast(msg, ok) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show ' + (ok ? 'ok' : 'err');
  setTimeout(() => t.className = '', 3500);
}
</script>
</body>
</html>`;
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
