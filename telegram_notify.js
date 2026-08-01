#!/usr/bin/env node

// Envío de mensajes a Telegram. Se usa desde el bot y desde los scripts de
// carga, para avisar cuando una importación larga termina.
//
//   node telegram_notify.js "texto del mensaje"
//
// Necesita TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID, que salen del .env de la
// aplicación igual que los datos de la base.

const https = require('https');
const path = require('path');
const fs = require('fs');

// El .env de StreamFlix es la fuente de configuración; si no aparece se sigue
// con las variables de entorno, que es como corre dentro del contenedor.
function cargarEntorno() {
  const raiz = process.env.STREAMFLIX_ROOT;
  const ruta = raiz ? path.join(raiz, '.env') : null;
  if (ruta && fs.existsSync(ruta)) {
    require('dotenv').config({ path: ruta });
  }
}

function enviarMensaje(texto, { token, chatId } = {}) {
  cargarEntorno();
  const botToken = token || process.env.TELEGRAM_BOT_TOKEN;
  const destino = chatId || process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !destino) {
    return Promise.reject(new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID'));
  }

  // Telegram corta los mensajes a 4096 caracteres.
  const payload = JSON.stringify({
    chat_id: destino,
    text: String(texto).slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });

  return new Promise((resolve, reject) => {
    const request = https.request(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        timeout: 20000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      },
      (response) => {
        let cuerpo = '';
        response.on('data', (c) => (cuerpo += c));
        response.on('end', () => {
          try {
            const datos = JSON.parse(cuerpo);
            if (datos.ok) return resolve(datos.result);
            reject(new Error(datos.description || 'Telegram rechazó el mensaje'));
          } catch {
            reject(new Error(`Respuesta inesperada de Telegram: ${cuerpo.slice(0, 120)}`));
          }
        });
      }
    );

    request.on('timeout', () => request.destroy(new Error('Telegram no respondió a tiempo')));
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

if (require.main === module) {
  const texto = process.argv.slice(2).join(' ');
  if (!texto) {
    console.error('Uso: node telegram_notify.js "mensaje"');
    process.exit(1);
  }

  enviarMensaje(texto)
    .then(() => console.log('mensaje enviado'))
    .catch((error) => {
      console.error(error.message || String(error));
      process.exit(1);
    });
}

module.exports = { enviarMensaje };
