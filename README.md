# 🎵 Dalsegno — Bot WhatsApp

Servidor Node.js que usa **whatsapp-web.js** para enviar recordatorios de pago a través de WhatsApp.

---

## ✅ Requisitos

- Node.js 18+
- Una cuenta de WhatsApp activa en tu celular
- Cuenta en [Railway](https://railway.app) (gratis para empezar)

---

## 🚀 Deploy en Railway (recomendado)

### Paso 1 — Subir el código a GitHub
1. Crea un repositorio nuevo en GitHub (puede ser privado)
2. Sube todos estos archivos al repo

### Paso 2 — Crear proyecto en Railway
1. Ve a https://railway.app y entra con tu cuenta de GitHub
2. Clic en **"New Project"** → **"Deploy from GitHub repo"**
3. Selecciona el repositorio que creaste

### Paso 3 — Variables de entorno (opcional pero recomendado)
En Railway → tu proyecto → pestaña **Variables**, agrega:

| Variable | Valor | Descripción |
|----------|-------|-------------|
| `ADMIN_TOKEN` | `unaClaveSecreta123` | Protege el endpoint `/send` |
| `SESSION_DIR` | `/app/session` | Carpeta de sesión persistente |

### Paso 4 — Escanear el QR
1. Una vez desplegado, clic en la URL pública que Railway asigna (ej. `https://dalsegno-production-xxxx.up.railway.app`)
2. Verás el **código QR** en pantalla
3. Abre WhatsApp en tu celular → **Dispositivos vinculados** → **Vincular dispositivo**
4. Escanea el QR
5. ¡Listo! El bot está conectado ✅

---

## ⚙️ Actualizar la URL en tu panel PHP

En tu panel Hostinger, edita **`public_html/api/reminders-send-now.php`**:

```php
$RAILWAY_BASE = 'https://TU-NUEVA-URL.up.railway.app/';
```

Si configuraste `ADMIN_TOKEN`, también actualiza **`public_html/config/whatsapp.php`** 
agregando la constante:

```php
const ENDPOINT = 'https://TU-NUEVA-URL.up.railway.app/send';
const TOKEN    = 'unaClaveSecreta123'; // el mismo que pusiste en Railway
```

Y en `api/whatsapp-webhook.php`, en la función `sendWhatsApp()`, agrega el header:

```php
CURLOPT_HTTPHEADER => [
    'Content-Type: application/json',
    'x-admin-token: ' . WhatsAppConfig::TOKEN,
],
```

---

## 📡 Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Página de estado y QR |
| GET | `/qr` | QR como imagen PNG |
| GET | `/status` | JSON con estado del bot |
| GET | `/send?phone=521234567890&text=Hola` | Envía mensaje |
| POST | `/send` | Envía mensaje (body JSON) |

### Ejemplo de envío GET
```
https://tu-app.up.railway.app/send?phone=521234567890&text=Hola+recordatorio
```

### Ejemplo POST
```bash
curl -X POST https://tu-app.up.railway.app/send \
  -H "Content-Type: application/json" \
  -H "x-admin-token: tuToken" \
  -d '{"phone": "521234567890", "text": "Hola! Tu pago vence mañana."}'
```

---

## 🔧 Desarrollo local

```bash
npm install
node server.js
# Abre http://localhost:3000 y escanea el QR
```

---

## ⚠️ Notas importantes

- El número de WhatsApp que vincules **no puede estar abierto en el teléfono** como sesión web simultánea en otro lugar. Se recomienda usar un número dedicado para el bot.
- Railway tiene un plan gratuito con límite de horas. Para producción considera el plan de $5/mes o un VPS.
- La sesión se guarda en la carpeta `session/`. Si se borra, tendrás que escanear el QR de nuevo.
