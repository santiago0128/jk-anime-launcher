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
const { expandirPedido } = require('./expandir_pedido.js');

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
  '<b>Importar un título</b>',
  '/serie Breaking Bad',
  '/pelicula Interestelar',
  '/anime Dragon Ball Z',
  '',
  '<b>Importar por lotes</b>',
  '/pide — le pides a Claude en tus palabras y él arma la lista',
  '   ejemplo: <code>/pide la trilogía de El Padrino</code>',
  '   te enseño la lista y la confirmas con /ok (o /no)',
  '/cancelar — corta el lote en curso',
  '',
  '<b>Consultar</b>',
  '/estado — cómo va la importación en curso',
  '/catalogo — qué hay guardado',
  '/revisar — busca enlaces caducados',
  '/ayuda'
].join('\n');

const URL_CATALOGO = process.env.STREAMFLIX_URL || 'http://170.187.142.36';

// Telegram interpreta el mensaje como HTML, así que un título con & o < lo
// rompe entero. Los nombres vienen de sitios ajenos y de Claude: no son de fiar.
const escaparHtml = (texto) =>
  String(texto == null ? '' : texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Una importación a la vez: son decenas de descargas y lanzar varias en
// paralelo solo consigue que el sitio de origen empiece a rechazar.
let ocupado = null;

// Lista que Claude propuso y todavía no se ha confirmado. Un lote puede ser
// media noche de descargas, así que se enseña antes de lanzarlo.
let pendiente = null;
const CADUCIDAD_PENDIENTE = 15 * 60 * 1000;

// Lote en curso: los títulos van de uno en uno, igual que una importación
// suelta, y esto solo lleva la cuenta de por dónde va.
let lote = null;

// El importador deja aquí por dónde va, venga de donde venga: del bot, del
// cron o de un script suelto. Por eso /estado puede informar de una carga que
// el bot no lanzó, y por eso puede avisar cuando esa carga termina.
const ARCHIVO_PROGRESO = process.env.STREAMFLIX_PROGRESS_FILE || '/tmp/streamflix-progreso.json';

function leerProgreso() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVO_PROGRESO, 'utf8'));
  } catch {
    return null;
  }
}

function formatearDuracion(segundos) {
  if (!isFinite(segundos) || segundos < 0) return '—';
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${Math.round(segundos)} s`;
}

function describirProgreso(p) {
  if (!p) return 'No hay ninguna importación registrada todavía.\n\n/catalogo para ver lo que hay guardado.';

  const inicio = p.iniciado ? new Date(p.iniciado).getTime() : null;
  const transcurrido = inicio ? (Date.now() - inicio) / 1000 : null;

  if (p.estado === 'importando') {
    const lineas = [`⏳ <b>${escaparHtml(p.titulo)}</b> (${escaparHtml(p.tipo)})`];

    if (p.total) {
      const pct = Math.round((p.hechos / p.total) * 100);
      const barra = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
      lineas.push(`<code>${barra}</code> ${pct}%`);
      lineas.push(`${p.hechos} de ${p.total} capítulos`);

      // El tiempo restante se calcula con el ritmo real de esta carga, que
      // depende de cuántos servidores haya que probar por capítulo.
      if (transcurrido && p.hechos > 0) {
        const ritmo = p.hechos / transcurrido;
        lineas.push(`Faltan ~${formatearDuracion((p.total - p.hechos) / ritmo)}`);
      }
    } else {
      lineas.push(`${p.hechos || 0} capítulos hasta ahora`);
    }

    if (transcurrido) lineas.push(`Lleva ${formatearDuracion(transcurrido)}`);
    if (p.fallidos) lineas.push(`${p.fallidos} fallidos`);
    return lineas.join('\n');
  }

  if (p.estado === 'terminado') {
    const partes = [`✅ <b>${escaparHtml(p.titulo)}</b> (${escaparHtml(p.tipo)})`, `${p.hechos} capítulos importados`];
    if (p.saltados) partes.push(`${p.saltados} sin video disponible`);
    if (p.fallidos) partes.push(`${p.fallidos} fallidos`);
    if (transcurrido) partes.push(`Tardó ${formatearDuracion(transcurrido)}`);
    partes.push('', 'Última importación terminada. /catalogo para ver el total.');
    return partes.join('\n');
  }

  return `❌ <b>${escaparHtml(p.titulo || 'importación')}</b>\n${escaparHtml(p.motivo || 'terminó con error')}`;
}

// Vigila el archivo de progreso para avisar cuando una carga termina, aunque
// la haya lanzado el cron o un script y no el bot.
function vigilarProgreso() {
  let anterior = leerProgreso()?.estado || null;
  let anteriorTitulo = leerProgreso()?.titulo || null;

  setInterval(() => {
    const actual = leerProgreso();
    if (!actual) return;

    const cambio = actual.estado !== anterior || actual.titulo !== anteriorTitulo;
    const acabaDeTerminar = cambio && (actual.estado === 'terminado' || actual.estado === 'error');

    // Si la lanzó el bot, ya responde él con el resultado; este aviso es para
    // las que corren por su cuenta.
    if (acabaDeTerminar && !ocupado) {
      enviarMensaje(describirProgreso(actual)).catch((e) => console.error(e.message));
    }

    anterior = actual.estado;
    anteriorTitulo = actual.titulo;
  }, 15000);
}

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
function importar(tipo, nombre) {
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
        resolve({
          ok: true,
          titulo: titulo || nombre,
          capitulos: Number(n),
          saltados: Number(saltados) || 0
        });
        return;
      }

      const motivo = (salida.match(/No encontré[^\n]*/) || salida.match(/No encontre[^\n]*/) ||
        salida.match(/Ningun[^\n]*/) || salida.match(/[^\n]*rror[^\n]*/) || ['no se pudo importar'])[0];
      resolve({ ok: false, titulo: nombre, motivo: motivo.slice(0, 300) });
    });
  });
}

function describirImportacion(resultado) {
  if (!resultado.ok) {
    return `❌ <b>${escaparHtml(resultado.titulo)}</b>\n${escaparHtml(resultado.motivo)}`;
  }
  const extra = resultado.saltados ? `\n${resultado.saltados} capítulo(s) sin video disponible` : '';
  return `✅ <b>${escaparHtml(resultado.titulo)}</b>\n${resultado.capitulos} capítulo(s) importados${extra}\n\n${URL_CATALOGO}`;
}

const ICONO = { anime: '🌸', serie: '📺', pelicula: '🎬' };

function describirLista(propuesta) {
  const lineas = propuesta.titulos.map((t, i) => {
    const anio = t.anio ? ` <i>(${t.anio})</i>` : '';
    return `${String(i + 1).padStart(2)}. ${ICONO[t.tipo] || ''} ${escaparHtml(t.titulo)}${anio}`;
  });
  return lineas.join('\n');
}

// El lote va de uno en uno por la misma razón que no se permiten dos
// importaciones a la vez: en paralelo el sitio de origen empieza a rechazar.
async function correrLote(chatId) {
  const total = lote.titulos.length;

  for (const item of lote.titulos) {
    if (lote.cancelado) break;

    lote.indice += 1;
    lote.actual = item.titulo;
    const marca = `[${lote.indice}/${total}]`;

    const resultado = await importar(item.tipo, item.titulo);
    lote.resultados.push(resultado);

    await responder(
      chatId,
      resultado.ok
        ? `${marca} ✅ <b>${escaparHtml(resultado.titulo)}</b> — ${resultado.capitulos} cap`
        : `${marca} ❌ <b>${escaparHtml(item.titulo)}</b> — ${escaparHtml(resultado.motivo)}`
    );
  }

  const buenos = lote.resultados.filter((r) => r.ok);
  const capitulos = buenos.reduce((suma, r) => suma + r.capitulos, 0);
  const fallidos = lote.resultados.filter((r) => !r.ok);
  const transcurrido = (Date.now() - lote.iniciado) / 1000;

  const resumen = [
    lote.cancelado ? '🛑 <b>Lote cancelado</b>' : '🎉 <b>Lote terminado</b>',
    `${buenos.length} de ${total} títulos, ${capitulos} capítulos en total`,
    `Tardó ${formatearDuracion(transcurrido)}`
  ];

  if (fallidos.length) {
    resumen.push('', `<b>No entraron (${fallidos.length}):</b>`);
    for (const r of fallidos.slice(0, 15)) resumen.push(`• ${escaparHtml(r.titulo)}`);
  }
  resumen.push('', URL_CATALOGO);

  lote = null;
  return responder(chatId, resumen.join('\n'));
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
    const detalle = describirProgreso(leerProgreso());
    if (!lote) return responder(chatId, detalle);

    // Dentro de un lote el archivo de progreso solo cuenta el título que está
    // descargando ahora mismo; el avance del lote lo lleva el bot.
    const cabecera = [
      `📦 <b>Lote:</b> ${lote.indice} de ${lote.titulos.length} títulos`,
      `<i>${escaparHtml(lote.pedido)}</i>`,
      ''
    ].join('\n');
    return responder(chatId, cabecera + detalle);
  }

  if (comando === '/cancelar') {
    if (!lote) return responder(chatId, 'No hay ningún lote en curso.');
    lote.cancelado = true;
    return responder(chatId, '🛑 Vale. Corto en cuanto termine el título que está bajando ahora.');
  }

  if (['/pide', '/pedido', '/claude'].includes(comando)) {
    if (!argumento) {
      return responder(chatId, ['Dime qué quieres traer, en tus palabras.', '', 'Ejemplos:',
        '<code>/pide la trilogía de El Padrino</code>',
        '<code>/pide los animes clásicos de los 90</code>',
        '<code>/pide lo que dirigió Tarantino</code>'].join('\n'));
    }
    if (ocupado) return responder(chatId, `⏳ Ya hay algo en curso: ${escaparHtml(ocupado)}. Espera a que termine.`);

    await responder(chatId, '🤔 Pensando qué títulos son…');

    let propuesta;
    ocupado = 'consultando a Claude';
    try {
      propuesta = await expandirPedido(argumento);
    } catch (error) {
      return responder(chatId, `❌ ${escaparHtml(error.message || String(error))}`);
    } finally {
      ocupado = null;
    }

    if (!propuesta.titulos.length) {
      return responder(chatId, `🤷 No saqué títulos de ahí.\n\n${escaparHtml(propuesta.interpretacion || 'Prueba a ser más concreto.')}`);
    }

    pendiente = { pedido: argumento, titulos: propuesta.titulos, creado: Date.now() };

    // De dónde salió la lista explica cuánto fiarse: una base de datos de cine
    // da la filmografía entera, un modelo de memoria se deja títulos.
    const firma = propuesta.exacta
      ? `<i>datos de ${escaparHtml(propuesta.fuente)} — lista completa</i>`
      : [
          `⚠️ <i>lista armada por ${escaparHtml(propuesta.fuente)} de memoria: repásala antes de /ok,`,
          'se deja títulos fuera y de vez en cuando se inventa alguno.</i>',
          propuesta.falta === 'TMDB_API_KEY'
            ? '\n💡 <i>Con una clave gratuita de TMDB en el .env esto saldría completo y exacto.</i>'
            : ''
        ].join(' ');

    return responder(chatId, [
      `<b>${propuesta.titulos.length} títulos</b> para «${escaparHtml(argumento)}»`,
      propuesta.interpretacion ? `<i>${escaparHtml(propuesta.interpretacion)}</i>` : '',
      '',
      describirLista(propuesta),
      '',
      '/ok para importarlos todos · /no para descartar',
      firma
    ].filter(Boolean).join('\n'));
  }

  if (['/ok', '/si', '/sí', '/dale'].includes(comando)) {
    if (!pendiente) return responder(chatId, 'No hay ninguna lista esperando. Empieza con /pide.');
    if (Date.now() - pendiente.creado > CADUCIDAD_PENDIENTE) {
      pendiente = null;
      return responder(chatId, 'Esa lista ya caducó. Pídela otra vez con /pide.');
    }
    if (ocupado) return responder(chatId, `⏳ Ya hay algo en curso: ${escaparHtml(ocupado)}. Espera a que termine.`);

    lote = { pedido: pendiente.pedido, titulos: pendiente.titulos, indice: 0, actual: null, resultados: [], cancelado: false, iniciado: Date.now() };
    pendiente = null;
    ocupado = `lote de ${lote.titulos.length} títulos`;

    await responder(chatId, [
      `🚀 Empiezo con ${lote.titulos.length} títulos.`,
      'Te aviso por cada uno y con un resumen al final.',
      'Esto va para largo: /estado para ver cómo va, /cancelar para cortar.'
    ].join('\n'));

    try {
      await correrLote(chatId);
    } catch (error) {
      lote = null;
      await responder(chatId, `❌ El lote se cortó: ${escaparHtml(error.message || String(error))}`);
    } finally {
      ocupado = null;
    }
    return;
  }

  if (['/no', '/descartar'].includes(comando)) {
    if (!pendiente) return responder(chatId, 'No hay ninguna lista esperando.');
    pendiente = null;
    return responder(chatId, 'Descartada. Pide otra cosa cuando quieras.');
  }

  if (comando === '/catalogo') {
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
    await responder(chatId, `⏳ Importando <b>${escaparHtml(argumento)}</b>…\nUna serie completa puede tardar varios minutos.`);

    const resultado = await importar(tipo, argumento);
    ocupado = null;
    return responder(chatId, describirImportacion(resultado));
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
        // Sin await: una importación tarda minutos y un lote puede tardar
        // horas. Si el bucle esperase a que terminen, el bot quedaría sordo
        // justo a /estado y /cancelar, que es cuando más falta hacen. Lo que
        // no puede solaparse ya lo frena la bandera "ocupado".
        if (actualizacion.message) {
          atender(actualizacion.message).catch((e) => console.error('fallo atendiendo:', e.message));
        }
      }
    } catch (error) {
      console.error('fallo consultando Telegram:', error.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Solo arranca si lo ejecutan; requerirlo desde otro script (una prueba) no
// debe abrir el polling ni dejar temporizadores sueltos.
if (require.main === module) {
  vigilarProgreso();
  escuchar();
}

module.exports = { atender };
