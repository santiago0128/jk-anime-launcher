#!/usr/bin/env node

// Bot de Telegram para lanzar importaciones desde el móvil.
//
// Usa long polling en vez de webhook: así no hace falta dominio ni HTTPS, que
// es lo que obliga la API de WhatsApp. Solo atiende a los chats autorizados,
// porque esto ejecuta importaciones en el servidor.
//
// Variables necesarias (en el .env de StreamFlix):
//   TELEGRAM_BOT_TOKEN   el que da @BotFather
//   TELEGRAM_CHAT_ID     tu chat; también es a donde van los avisos
//   TELEGRAM_ALLOWED     opcional, lista separada por comas si hay más de uno

const https = require('https');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { enviarMensaje } = require('./telegram_notify.js');

const raizStreamflix = process.env.STREAMFLIX_ROOT;
if (raizStreamflix && fs.existsSync(path.join(raizStreamflix, '.env'))) {
  require('dotenv').config({ path: path.join(raizStreamflix, '.env') });
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTORIZADOS = String(process.env.TELEGRAM_ALLOWED || process.env.TELEGRAM_CHAT_ID || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

if (!TOKEN) {
  console.error('Falta TELEGRAM_BOT_TOKEN');
  process.exit(1);
}
if (!AUTORIZADOS.length) {
  console.error('Falta TELEGRAM_CHAT_ID: sin lista de autorizados el bot quedaría abierto a cualquiera');
  process.exit(1);
}

const AYUDA = [
  '<b>Importar</b>',
  '/serie Breaking Bad',
  '/pelicula Interestelar',
  '/anime Dragon Ball Z',
  '',
  '<b>Consultar</b>',
  '/estado — qué hay en el catálogo',
  '/revisar — busca enlaces caducados',
  '/ayuda'
].join('\n');

// Una importación a la vez: son decenas de descargas y lanzar varias en
// paralelo solo consigue que el sitio de origen empiece a rechazar.
let ocupado = null;

function pedirTelegram(metodo, parametros) {
  const url = `https://api.telegram.org/bot${TOKEN}/${metodo}?${new URLSearchParams(parametros)}`;
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 60000 }, (response) => {
      let cuerpo = '';
      response.on('data', (c) => (cuerpo += c));
      response.on('end', () => {
        try {
          resolve(JSON.parse(cuerpo));
        } catch {
          reject(new Error('respuesta ilegible de Telegram'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

const responder = (chatId, texto) => enviarMensaje(texto, { chatId }).catch((e) => console.error(e.message));

// Lanza el importador como proceso aparte: si un título revienta, se lleva por
// delante su propio proceso y no el bot.
function importar(tipo, nombre, chatId) {
  return new Promise((resolve) => {
    const args =
      tipo === 'anime'
        ? ['import_series_to_streamflix.js', '--series-name', nombre, '--no-browser']
        : ['import_series_to_streamflix.js', '--content-type', tipo, '--title', nombre, '--no-browser'];

    const proceso = spawn('node', args, { cwd: __dirname, env: { ...process.env, JK_NO_BROWSER: '1' } });
    let salida = '';
    proceso.stdout.on('data', (d) => (salida += d));
    proceso.stderr.on('data', (d) => (salida += d));

    proceso.on('close', () => {
      const n = (salida.match(/"importedCount":\s*(\d+)/) || [])[1];
      const titulo = (salida.match(/"title":\s*"([^"]*)"/) || [])[1];
      const saltados = (salida.match(/"skippedCount":\s*(\d+)/) || [])[1];

      if (n && Number(n) > 0) {
        const extra = saltados && Number(saltados) > 0 ? `\n${saltados} capítulo(s) sin video disponible` : '';
        resolve(`✅ <b>${titulo || nombre}</b>\n${n} capítulo(s) importados${extra}\n\nhttp://170.187.142.36`);
        return;
      }

      const motivo = (salida.match(/No encontré[^\n]*/) || salida.match(/No encontre[^\n]*/) ||
        salida.match(/Ningun[^\n]*/) || salida.match(/[^\n]*rror[^\n]*/) || ['no se pudo importar'])[0];
      resolve(`❌ <b>${nombre}</b>\n${motivo.slice(0, 300)}`);
    });
  });
}

function ejecutarScript(script, args, chatId) {
  return new Promise((resolve) => {
    const proceso = spawn('node', [script, ...args], { cwd: __dirname, env: process.env });
    let salida = '';
    proceso.stdout.on('data', (d) => (salida += d));
    proceso.stderr.on('data', (d) => (salida += d));
    proceso.on('close', () => resolve(salida));
  });
}

async function atender(mensaje) {
  const chatId = String(mensaje.chat?.id || '');
  const texto = (mensaje.text || '').trim();
  if (!texto) return;

  if (!AUTORIZADOS.includes(chatId)) {
    console.warn(`mensaje ignorado de un chat no autorizado: ${chatId}`);
    return;
  }

  const [comandoCrudo, ...resto] = texto.split(/\s+/);
  const comando = comandoCrudo.toLowerCase().replace(/@.*$/, '');
  const argumento = resto.join(' ').trim();

  if (comando === '/start' || comando === '/ayuda' || comando === '/help') {
    return responder(chatId, `Bot de StreamFlix.\n\n${AYUDA}`);
  }

  if (comando === '/estado') {
    const salida = await ejecutarScript('resumen_catalogo.js', [], chatId);
    return responder(chatId, `<b>Catálogo</b>\n<pre>${salida.trim().slice(0, 3000)}</pre>`);
  }

  if (comando === '/revisar') {
    if (ocupado) return responder(chatId, `⏳ Ya hay algo en curso: ${ocupado}`);
    ocupado = 'revisión de enlaces';
    await responder(chatId, '🔍 Revisando qué enlaces siguen vivos, tarda un rato…');
    const salida = await ejecutarScript('check_streamflix_links.js', [], chatId);
    ocupado = null;
    const resumen = salida.split('\n').filter((l) => /^[✓✗]/.test(l)).join('\n') || salida.slice(-1500);
    return responder(chatId, `<b>Revisión terminada</b>\n<pre>${resumen.slice(0, 3000)}</pre>`);
  }

  if (['/serie', '/pelicula', '/anime'].includes(comando)) {
    if (!argumento) return responder(chatId, `Falta el nombre. Ejemplo: <code>${comando} Breaking Bad</code>`);
    if (ocupado) return responder(chatId, `⏳ Ya hay algo en curso: ${ocupado}. Espera a que termine.`);

    const tipo = comando.slice(1);
    ocupado = `${tipo} "${argumento}"`;
    await responder(chatId, `⏳ Importando <b>${argumento}</b>…\nUna serie completa puede tardar varios minutos.`);

    const resultado = await importar(tipo, argumento, chatId);
    ocupado = null;
    return responder(chatId, resultado);
  }

  return responder(chatId, `No conozco <code>${comando}</code>.\n\n${AYUDA}`);
}

async function escuchar() {
  let desde = 0;
  console.log(`bot escuchando; chats autorizados: ${AUTORIZADOS.join(', ')}`);

  // Long polling: Telegram deja la petición abierta hasta que hay novedades,
  // así que no hace falta preguntar en bucle ni exponer ningún puerto.
  for (;;) {
    try {
      const respuesta = await pedirTelegram('getUpdates', { offset: desde, timeout: 30 });
      for (const actualizacion of respuesta.result || []) {
        desde = actualizacion.update_id + 1;
        if (actualizacion.message) await atender(actualizacion.message);
      }
    } catch (error) {
      console.error('fallo consultando Telegram:', error.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

escuchar();
