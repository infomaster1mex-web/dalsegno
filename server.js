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
 *   POST /send          → body JSON: { "phone": "521496139953", "text": "Hola" }
 *
 *  VARIABLES DE ENTORNO (Railway → Variables):
 *   PORT            (Railway lo pone automáticamente)
 *   ADMIN_TOKEN     Token secreto para proteger /send  (opcional pero recomendado)
 *   SESSION_DIR     Carpeta donde guardar la sesión   (por defecto: ./session)
 *
 *  ── NUEVAS VARIABLES PARA IA ──────────────────────────
 *   OPENAI_API_KEY      Tu API key de OpenAI (sk-...)
 *   DALSEGNO_API_URL    URL completa del bot.php en Hostinger
 *                       ej: https://tudominio.com/api/bot.php
 *   BOT_SECRET_TOKEN    Token secreto compartido con api/bot.php en PHP
 *   ADMIN_PHONES        Números autorizados separados por coma
 *                       ej: 529611234567,521234567890
 */

'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const app     = express();

// ── NUEVO: SDK de OpenAI ──────────────────────────────────────────────────────
const OpenAI = require('openai');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Configuración ─────────────────────────────────────────────────────────────
const PORT         = process.env.PORT         || 3000;
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN  || '';
const SESSION_DIR  = process.env.SESSION_DIR  || './session';

// ── NUEVO: Configuración de IA y Dalsegno ────────────────────────────────────
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || '';
const DALSEGNO_API_URL  = process.env.DALSEGNO_API_URL  || '';
const BOT_SECRET_TOKEN  = process.env.BOT_SECRET_TOKEN  || '';
const ADMIN_PHONES      = (process.env.ADMIN_PHONES || '').split(',').map(p => p.trim()).filter(Boolean);

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ── Estado global ─────────────────────────────────────────────────────────────
let qrDataUrl   = null;
let clientReady = false;
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
            '--disable-extensions',
            '--disable-sync',
            '--disable-component-update',
            '--single-process=false',        // ← Importante: multi-proceso
            '--disable-crash-handler',       // ← Evita locks en crashes
        ],
    },
});

client.on('qr', async (qr) => {
    clientState = 'QR_READY';
    clientReady = false;
    qrDataUrl = await qrcode.toDataURL(qr);
    console.log('[QR] Nuevo QR generado — visita /qr para escanearlo');
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
    setTimeout(() => {
        console.log('[WA] Intentando reconectar...');
        client.initialize().catch(console.error);
    }, 5000);
});

// ── Middleware de autenticación ───────────────────────────────────────────────
function authMiddleware(req, res, next) {
    if (!ADMIN_TOKEN) return next();
    const token =
        req.headers['x-admin-token'] ||
        req.query.token              ||
        (req.body && req.body.token);
    if (token === ADMIN_TOKEN) return next();
    return res.status(401).json({ ok: false, error: 'Token inválido' });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizePhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (/^52\d{10}$/.test(digits)) return digits;
    if (/^\d{10}$/.test(digits))   return '52' + digits;
    return digits;
}

async function sendMessage(phone, text) {
    if (!clientReady) {
        throw new Error(`El cliente WhatsApp no está listo (estado: ${clientState})`);
    }
    const numberId = await client.getNumberId(phone);
    if (!numberId) {
        throw new Error(`El número ${phone} no está registrado en WhatsApp`);
    }
    const info = await client.sendMessage(numberId._serialized, text);
    return { messageId: info.id._serialized };
}

// ── NUEVO: Funciones de IA ────────────────────────────────────────────────────

/**
 * Usa GPT para interpretar un comando en lenguaje natural
 * y convertirlo a una acción estructurada JSON.
 */
async function interpretarComando(texto) {
    if (!openai) throw new Error('OPENAI_API_KEY no configurada');

    const mesActual = new Date().toISOString().slice(0, 7); // "2026-03"
    const fechaHoy  = new Date().toLocaleDateString('es-MX', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',   // barato y muy rápido, perfecto para esto
        max_tokens: 300,
        temperature: 0,         // respuestas consistentes
        response_format: { type: 'json_object' }, // fuerza JSON puro, sin markdown
        messages: [
            {
                role: 'system',
                content: `Eres el asistente de gestión de Dalsegno, una escuela de música en México.
Tu dueño te habla por WhatsApp en español coloquial e informal para administrar su negocio.

## CONTEXTO DEL NEGOCIO
Dalsegno registra alumnos, clases de música (guitarra, piano, batería, etc.) y pagos mensuales.
Los alumnos pagan mensualidades. El sistema también guarda recordatorios de vencimiento de pagos.

## TU ÚNICA TAREA
Analizar el mensaje del dueño e inferir qué quiere hacer. Responder SIEMPRE con JSON válido.
Fecha hoy: ${fechaHoy} | Mes actual: ${mesActual}

## ACCIONES DISPONIBLES
{ "action": "register_payment", "student_name": "", "amount": 0, "subject": "Música", "month": "${mesActual}", "method": "cash" }
  → Registrar que un alumno pagó. method puede ser: cash | transfer | card

{ "action": "check_payment", "student_name": "" }
  → Ver historial de pagos de un alumno específico

{ "action": "list_pending" }
  → Ver qué alumnos NO han pagado este mes

{ "action": "list_upcoming", "days": 60 }
  → Ver pagos próximos a vencer según recordatorios programados

{ "action": "list_classes", "days": 7 }
  → Ver clases programadas. Puede incluir "student_name" para filtrar por alumno

{ "action": "ask", "message": "pregunta corta" }
  → SOLO cuando sea imposible inferir la intención. Pregunta SOLO el dato mínimo que falta.
  → PROHIBIDO: frases genéricas como "¿qué deseas hacer?" o "¿qué información necesitas?"

## PRINCIPIOS DE INFERENCIA
1. NUNCA preguntes lo que puedes asumir con defaults razonables
2. Si el mensaje es solo un nombre → check_payment de ese alumno
3. Si mencionan dinero + nombre → register_payment
4. Si preguntan por fechas/vencimientos/cuándo → list_upcoming
5. Si preguntan por clases/horarios/agenda → list_classes
6. Si preguntan por deudas/morosos/quién debe → list_pending
7. Palabras ambiguas como "todo", "todos", "resumen" → usa list_pending + asume contexto de pagos
8. Typos y errores de escritura son normales, infiere la intención
9. Omite campos opcionales si no se mencionan, usa defaults`            },
            { role: 'user', content: texto }
        ]
    });

    const raw = response.choices[0].message.content.trim();
    return JSON.parse(raw);
}

/**
 * Llama a la API PHP de Dalsegno (api/bot.php en Hostinger)
 */
async function llamarDalsegno(comando) {
    if (!DALSEGNO_API_URL) throw new Error('DALSEGNO_API_URL no configurada');

    const res = await fetch(DALSEGNO_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Bot-Token': BOT_SECRET_TOKEN
        },
        body: JSON.stringify(comando)
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Dalsegno API error ${res.status}: ${txt.slice(0, 100)}`);
    }
    return res.json();
}

// ── Manejador de mensajes entrantes ──────────────────────────────────────────
client.on('message', async (msg) => {
    const body  = msg.body ? msg.body.trim() : '';
    const lower = body.toLowerCase();

    // DEBUG: log todos los mensajes entrantes para ver el formato exacto del número
    console.log(`[MSG] from="${msg.from}" body="${body.substring(0, 50)}" type="${msg.type}"`);

    // ── Respuesta automática simple (para todos) ──────────────────────────
    if (lower === 'hola' || lower === 'hello') {
        msg.reply('¡Hola! Soy el asistente de Dalsegno 🎵. Para consultas sobre tus clases contacta a tu maestro.');
        return;
    }

    // ── Comandos de IA (solo para números administradores autorizados) ────
    if (ADMIN_PHONES.length === 0 || !openai || !DALSEGNO_API_URL) return;

    // Ignorar grupos
    if (msg.from.includes('@g.us')) return;

    // Obtener número real del contacto (maneja tanto @c.us como @lid)
    let numero = msg.from.replace('@c.us', '').replace('@s.whatsapp.net', '');
    
    // Si viene en formato @lid, obtener el número real del contacto
    if (msg.from.includes('@lid') || !/^\d+$/.test(numero)) {
        try {
            const contact = await msg.getContact();
            numero = contact.number || contact.id.user;
            console.log(`[MSG] Número real del contacto: "${numero}"`);
        } catch (e) {
            console.log(`[MSG] No se pudo obtener contacto: ${e.message}`);
        }
    }

    // Solo admins autorizados
    if (!ADMIN_PHONES.includes(numero)) {
        console.log(`[MSG] ⛔ Número no autorizado: "${numero}" — Admins: [${ADMIN_PHONES.join(', ')}]`);
        return;
    }
    
    console.log(`[MSG] ✅ Admin autorizado: ${numero}`);

    // Ignorar mensajes muy cortos (menos de 4 chars)
    if (!body || body.length < 4) return;

    console.log(`[BOT-IA] Mensaje de admin ${numero}: "${body.substring(0, 60)}"`);

    // ── Comandos directos (sin IA, más rápidos) ───────────────────────────
    if (lower === 'pendientes' || lower === 'sin pagar' || lower === 'quién debe') {
        try {
            const result = await llamarDalsegno({ action: 'list_pending' });
            await msg.reply(result.message || 'Sin datos');
        } catch (e) {
            console.error('[BOT-IA] Error list_pending:', e.message);
            await msg.reply('❌ Error al consultar pendientes: ' + e.message);
        }
        return;
    }

    if (lower === 'próximos' || lower === 'proximos' || lower === 'vencimientos' || lower === 'próximos pagos' || lower === 'proximos pagos') {
        try {
            const result = await llamarDalsegno({ action: 'list_upcoming', days: 30 });
            await msg.reply(result.message || 'Sin datos');
        } catch (e) {
            console.error('[BOT-IA] Error list_upcoming:', e.message);
            await msg.reply('❌ Error al consultar próximos vencimientos: ' + e.message);
        }
        return;
    }

    if (lower === 'ayuda' || lower === 'help') {
        await msg.reply(
`🎵 *Comandos disponibles:*

💰 *Registrar pago:*
_"Santiago ya pagó 500 de guitarra"_
_"Registra pago María 600 piano transferencia"_

🔍 *Consultar pagos:*
_"¿Ha pagado Roberto?"_
_"Ver pagos de Ana González"_

📋 *Sin pagar este mes:*
_"pendientes"_ o _"quién debe"_

📅 *Próximos vencimientos:*
_"próximos pagos"_ o _"cuándo vencen los pagos"_

🗓️ Puedes especificar el mes:
_"Registra pago Juan 400 batería enero"_`
        );
        return;
    }

    // ── Interpretar con Claude ────────────────────────────────────────────
    let procesando;
    try {
        procesando = await msg.reply('⏳ _Procesando..._');
    } catch (_) { /* no es crítico */ }

    try {
        const comando = await interpretarComando(body);
        console.log(`[BOT-IA] Comando interpretado:`, JSON.stringify(comando));

        if (comando.action === 'ask') {
            await msg.reply(`🤔 ${comando.message}`);
            return;
        }

        // Ejecutar en Dalsegno
        const result = await llamarDalsegno(comando);
        await msg.reply(result.message || (result.success ? '✅ Listo' : '❌ Error desconocido'));

    } catch (e) {
        console.error('[BOT-IA] Error:', e.message);

        if (e.message.includes('JSON')) {
            await msg.reply('❓ No entendí bien. Intenta ser más específico.\nEjemplo: _"Santiago pagó 500 de guitarra"_\nEscribe *ayuda* para ver todos los comandos.');
        } else {
            await msg.reply('❌ Error: ' + e.message);
        }
    }
});

// ── Rutas Express ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    const isReady = clientReady;
    const iaStatus = openai && DALSEGNO_API_URL
        ? `<div class="stat"><div class="stat-val" style="color:var(--green)">✓</div><div class="stat-key">IA activa</div></div>`
        : `<div class="stat"><div class="stat-val" style="color:var(--amber)">—</div><div class="stat-key">IA no configurada</div></div>`;

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
    --green:   #22c55e; --green2: #16a34a; --amber: #f59e0b; --red: #ef4444;
    --bg: #080d14; --surface: #0f1923; --surface2: #162130;
    --border: rgba(255,255,255,.07); --text: #e8f0fe; --muted: #64748b;
  }
  body { font-family:'Sora',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:2rem 1rem; position:relative; overflow-x:hidden; }
  body::before { content:''; position:fixed; inset:0; background:radial-gradient(ellipse 70% 50% at 20% 20%,rgba(34,197,94,.08) 0%,transparent 60%),radial-gradient(ellipse 50% 40% at 80% 80%,rgba(59,130,246,.07) 0%,transparent 60%); pointer-events:none; z-index:0; }
  .card { position:relative; z-index:1; background:var(--surface); border:1px solid var(--border); border-radius:24px; padding:3rem 2.5rem; width:100%; max-width:480px; box-shadow:0 40px 80px rgba(0,0,0,.5); animation:slideUp .6s cubic-bezier(.16,1,.3,1) both; }
  @keyframes slideUp { from{opacity:0;transform:translateY(30px)} to{opacity:1;transform:translateY(0)} }
  .logo { display:flex; align-items:center; gap:.75rem; margin-bottom:2.5rem; }
  .logo-icon { width:44px; height:44px; background:linear-gradient(135deg,#22c55e,#16a34a); border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:1.4rem; box-shadow:0 0 20px rgba(34,197,94,.4); }
  .logo-text { font-size:1.4rem; font-weight:800; letter-spacing:-.02em; }
  .logo-sub { font-size:.7rem; color:var(--muted); font-weight:400; letter-spacing:.08em; text-transform:uppercase; margin-top:1px; }
  .status-badge { display:inline-flex; align-items:center; gap:.5rem; padding:.35rem .9rem; border-radius:999px; font-size:.78rem; font-weight:600; letter-spacing:.03em; margin-bottom:2rem; border:1px solid; }
  .status-badge.ready   { background:rgba(34,197,94,.1);  color:var(--green); border-color:rgba(34,197,94,.25); }
  .status-badge.waiting { background:rgba(245,158,11,.1); color:var(--amber); border-color:rgba(245,158,11,.25); }
  .dot { width:7px; height:7px; border-radius:50%; background:currentColor; animation:pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.7)} }
  h1 { font-size:1.9rem; font-weight:800; line-height:1.15; letter-spacing:-.03em; margin-bottom:.6rem; }
  .subtitle { color:var(--muted); font-size:.9rem; line-height:1.6; margin-bottom:2rem; }
  .divider { height:1px; background:var(--border); margin:2rem 0; }
  .qr-box { background:var(--surface2); border:1px solid var(--border); border-radius:16px; padding:1.5rem; text-align:center; margin-bottom:1.5rem; }
  .qr-box img { width:220px; height:220px; border-radius:12px; display:block; margin:0 auto 1rem; background:white; padding:8px; }
  .qr-hint { font-size:.78rem; color:var(--muted); line-height:1.5; }
  .form-label { font-size:.75rem; font-weight:600; color:var(--muted); letter-spacing:.06em; text-transform:uppercase; margin-bottom:.6rem; display:block; }
  .form-row { display:flex; gap:.5rem; flex-wrap:wrap; }
  .input { flex:1; min-width:0; background:var(--surface2); border:1px solid var(--border); border-radius:10px; color:var(--text); font-family:'JetBrains Mono',monospace; font-size:.82rem; padding:.65rem .9rem; outline:none; transition:border-color .2s; }
  .input:focus { border-color:rgba(34,197,94,.5); }
  .input::placeholder { color:var(--muted); }
  .btn { padding:.65rem 1.4rem; background:linear-gradient(135deg,var(--green),var(--green2)); color:#fff; border:none; border-radius:10px; font-family:'Sora',sans-serif; font-size:.85rem; font-weight:700; cursor:pointer; transition:opacity .2s,transform .15s; white-space:nowrap; }
  .btn:hover{opacity:.9;transform:translateY(-1px)} .btn:active{transform:translateY(0)} .btn:disabled{opacity:.4;cursor:not-allowed}
  .token-row { display:flex; gap:.5rem; margin-bottom:1rem; }
  #toast { position:fixed; bottom:2rem; left:50%; transform:translateX(-50%) translateY(20px); background:var(--surface2); border:1px solid var(--border); border-radius:12px; padding:.75rem 1.5rem; font-size:.85rem; font-weight:600; opacity:0; transition:all .3s; z-index:99; pointer-events:none; white-space:nowrap; }
  #toast.show{opacity:1;transform:translateX(-50%) translateY(0)} #toast.ok{color:var(--green);border-color:rgba(34,197,94,.3)} #toast.err{color:var(--red);border-color:rgba(239,68,68,.3)}
  .stats { display:grid; grid-template-columns:1fr 1fr; gap:.75rem; margin-bottom:2rem; }
  .stat { background:var(--surface2); border:1px solid var(--border); border-radius:12px; padding:.9rem 1rem; }
  .stat-val { font-size:1.3rem; font-weight:800; letter-spacing:-.03em; }
  .stat-key { font-size:.7rem; color:var(--muted); font-weight:500; letter-spacing:.05em; text-transform:uppercase; margin-top:2px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">🎵</div>
    <div><div class="logo-text">Dalsegno</div><div class="logo-sub">Bot WhatsApp + IA</div></div>
  </div>
  ${isReady ? `
  <span class="status-badge ready"><span class="dot"></span>READY — Conectado</span>
  <h1>Bot activo<br/>y en línea</h1>
  <p class="subtitle">El servidor está procesando recordatorios y comandos de voz/texto con IA.</p>
  <div class="stats">
    <div class="stat"><div class="stat-val" style="color:var(--green)">✓</div><div class="stat-key">WhatsApp</div></div>
    ${iaStatus}
  </div>
  <div class="divider"></div>
  <label class="form-label">🔑 Token de acceso</label>
  <div class="token-row"><input id="tokenInput" class="input" type="password" placeholder="Tu ADMIN_TOKEN"/></div>
  <label class="form-label">📤 Enviar mensaje de prueba</label>
  <div class="form-row" style="margin-bottom:.6rem"><input id="phoneInput" class="input" placeholder="521234567890"/></div>
  <div class="form-row"><input id="textInput" class="input" placeholder="Escribe un mensaje de prueba..."/><button class="btn" onclick="sendTest()">Enviar</button></div>
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
  <script>setTimeout(()=>location.reload(),6000)</script>
  `}
</div>
<div id="toast"></div>
<script>
async function sendTest() {
  const phone=document.getElementById('phoneInput').value.trim();
  const text=document.getElementById('textInput').value.trim();
  const token=document.getElementById('tokenInput')?.value.trim()||'';
  if(!phone||!text){showToast('Completa teléfono y mensaje',false);return;}
  const btn=document.querySelector('.btn');
  btn.disabled=true;btn.textContent='Enviando…';
  try {
    const url='/send?phone='+encodeURIComponent(phone)+'&text='+encodeURIComponent(text)+(token?'&token='+encodeURIComponent(token):'');
    const r=await fetch(url); const j=await r.json();
    if(j.ok){showToast('✅ Mensaje enviado!',true);}else{showToast('❌ '+(j.error||'Error'),false);}
  }catch(e){showToast('❌ '+e.message,false);}
  finally{btn.disabled=false;btn.textContent='Enviar';}
}
function showToast(msg,ok){
  const t=document.getElementById('toast');
  t.textContent=msg;t.className='show '+(ok?'ok':'err');
  setTimeout(()=>t.className='',3500);
}
</script>
</body>
</html>`;
    res.send(html);
});

app.get('/qr', (req, res) => {
    if (clientReady) return res.json({ ok: true, message: 'Ya conectado, no necesitas QR' });
    if (!qrDataUrl)  return res.status(202).json({ ok: false, message: 'QR aún no disponible, espera unos segundos' });
    const base64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from(base64, 'base64'));
});

app.get('/status', (req, res) => {
    res.json({
        ok: true,
        ready: clientReady,
        state: clientState,
        ia: !!(openai && DALSEGNO_API_URL),
        admins: ADMIN_PHONES.length
    });
});

app.get('/send', authMiddleware, async (req, res) => {
    const phone = normalizePhone(req.query.phone);
    const text  = req.query.text || '';
    if (!phone || phone.length < 10) return res.status(400).json({ ok: false, error: 'Teléfono inválido' });
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'El texto no puede estar vacío' });
    try {
        const result = await sendMessage(phone, text);
        console.log(`[SEND] ✅ ${phone} — "${text.substring(0, 40)}..."`);
        res.json({ ok: true, phone, ...result });
    } catch (err) {
        console.error(`[SEND] ❌ ${phone} — ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/send', authMiddleware, async (req, res) => {
    const phone = normalizePhone(req.body.phone || req.body.to);
    const text  = req.body.text || req.body.message || '';
    if (!phone || phone.length < 10) return res.status(400).json({ ok: false, error: 'Teléfono inválido' });
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'El texto no puede estar vacío' });
    try {
        const result = await sendMessage(phone, text);
        console.log(`[SEND] ✅ ${phone} — "${text.substring(0, 40)}..."`);
        res.json({ ok: true, phone, ...result });
    } catch (err) {
        console.error(`[SEND] ❌ ${phone} — ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── LIMPIEZA PROFUNDA DE LOCKS (SOLUCIÓN RAILWAY) ────────────────────────────
function cleanChromiumLocks() {
    try {
        // Patrón de archivos/carpetas a eliminar
        const lockPatterns = [
            'SingletonLock', 
            'SingletonCookie', 
            'SingletonSocket',
            'Network Persistent State', 
            '.com.google.Chrome.metadata_shm',
            'GPUCache', 
            'Code Cache', 
            'Service Worker',
            'Cache',
            'shader_cache',
            '.chrome_profile_lock',
        ];
        
        function cleanDir(dir) {
            if (!fs.existsSync(dir)) return;
            try {
                const files = fs.readdirSync(dir);
                files.forEach(file => {
                    const full = path.join(dir, file);
                    try {
                        const stat = fs.statSync(full);
                        const shouldDelete = lockPatterns.some(p => file.includes(p));
                        
                        if (shouldDelete) {
                            if (stat.isDirectory()) {
                                fs.rmSync(full, { recursive: true, force: true });
                                console.log('[WA-CLEAN] 🧹 Eliminado carpeta:', file);
                            } else {
                                fs.unlinkSync(full);
                                console.log('[WA-CLEAN] 🧹 Eliminado archivo:', file);
                            }
                        } else if (stat.isDirectory() && !['node_modules', '.cache'].includes(file)) {
                            // Recursivamente limpiar subdirectorios
                            cleanDir(full);
                        }
                    } catch (e) {
                        console.warn('[WA-CLEAN] Error procesando:', file, e.message);
                    }
                });
            } catch (e) {
                console.warn('[WA-CLEAN] Error leyendo directorio:', dir, e.message);
            }
        }
        
        console.log('[WA-CLEAN] ▶️  Iniciando limpieza de locks...');
        cleanDir(SESSION_DIR);
        console.log('[WA-CLEAN] ✅ Limpieza completada');
    } catch (e) {
        console.error('[WA-CLEAN] Error crítico:', e.message);
    }
}

// ── Inicio ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[SERVER] 🚀 Servidor escuchando en puerto ${PORT}`);
    console.log(`[SERVER] Abre http://localhost:${PORT} en tu navegador para ver el QR`);
    if (ADMIN_TOKEN)    console.log('[SERVER] 🔒 ADMIN_TOKEN configurado');
    if (openai)         console.log('[SERVER] 🤖 OpenAI GPT activado');
    if (ADMIN_PHONES.length > 0) console.log(`[SERVER] 📱 Admins autorizados: ${ADMIN_PHONES.join(', ')}`);
    if (!openai)        console.log('[SERVER] ⚠️  Sin OPENAI_API_KEY — comandos IA desactivados');
    if (!DALSEGNO_API_URL) console.log('[SERVER] ⚠️  Sin DALSEGNO_API_URL — conexión con Dalsegno desactivada');
});

// Ejecutar limpieza ANTES de inicializar el cliente
console.log('[WA] Preparando ambiente...');
cleanChromiumLocks();

// Esperar un poco para que se complete la limpieza
setTimeout(() => {
    client.initialize().catch((err) => {
        console.error('[WA] ❌ Error al inicializar cliente:', err.message);
        process.exit(1);
    });
}, 1000);
