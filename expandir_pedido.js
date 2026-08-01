#!/usr/bin/env node

// Traduce un pedido en lenguaje natural a una lista concreta de títulos.
//
// El importador necesita un nombre exacto por título; una persona escribe
// "todas las de Marvel". Este módulo cubre esa distancia preguntándole a
// Claude, que devuelve la lista ya clasificada en anime / serie / película.
//
// Uso desde consola (imprime JSON):
//   node expandir_pedido.js "la trilogia original de star wars"
//
// Variables:
//   ANTHROPIC_API_KEY   obligatoria, en el .env de StreamFlix
//   PEDIDO_MAX_TITULOS  tope de títulos por pedido (por defecto 40)

const path = require('path');
const fs = require('fs');

const raizStreamflix = process.env.STREAMFLIX_ROOT;
if (raizStreamflix && fs.existsSync(path.join(raizStreamflix, '.env'))) {
  require('dotenv').config({ path: path.join(raizStreamflix, '.env') });
}

const MODELO = 'claude-opus-5';
const TIPOS = ['anime', 'serie', 'pelicula'];
const MAX_TITULOS = Number(process.env.PEDIDO_MAX_TITULOS) || 40;

// El esquema obliga a que la respuesta venga ya parseable: sin él Claude
// contesta en prosa y habría que adivinar dónde empieza cada título.
const ESQUEMA = {
  type: 'object',
  properties: {
    interpretacion: {
      type: 'string',
      description: 'Una frase explicando qué se entendió del pedido.'
    },
    titulos: {
      type: 'array',
      description: 'Títulos concretos a importar, en orden de visionado.',
      items: {
        type: 'object',
        properties: {
          titulo: {
            type: 'string',
            description: 'Nombre por el que se busca el título en sitios en español.'
          },
          tipo: {
            type: 'string',
            enum: TIPOS,
            description: 'anime para animación japonesa, serie para live action por temporadas, pelicula para largometrajes.'
          },
          anio: { type: 'integer', description: 'Año de estreno; 0 si no se sabe.' },
          nota: { type: 'string', description: 'Aclaración breve, o cadena vacía.' }
        },
        required: ['titulo', 'tipo', 'anio', 'nota'],
        additionalProperties: false
      }
    }
  },
  required: ['interpretacion', 'titulos'],
  additionalProperties: false
};

const INSTRUCCIONES = [
  'Trabajas para un catálogo personal de streaming que importa contenido desde sitios en español.',
  'Recibes un pedido en lenguaje natural y devuelves los títulos concretos que hay que importar.',
  '',
  'Reglas:',
  '- Un pedido temático ("todas las de Marvel", "lo mejor de Nolan", "animes de deportes")',
  '  se expande a los títulos concretos que lo componen.',
  '- Un pedido que ya nombra un título concreto devuelve ese único título.',
  '- Ordena por orden de visionado: cronológico dentro de una saga, por estreno en el resto.',
  '- Clasifica bien el tipo: el importador busca los anime en un sitio distinto al del',
  '  resto, y equivocarse ahí hace que no encuentre nada.',
  '- Para las series NO enumeres temporadas: un solo registro por serie, que el importador',
  '  ya se trae todas las temporadas y episodios.',
  '- Usa el nombre por el que se conoce el título en español o su nombre original si es',
  '  así como se publica (los anime suelen ir en romaji). Sin subtítulos de edición,',
  '  sin "(versión extendida)", sin el año pegado al nombre.',
  '- Si el pedido es ambiguo o no se refiere a contenido audiovisual, devuelve la lista',
  '  vacía y explica el problema en "interpretacion".',
  `- Nunca más de ${MAX_TITULOS} títulos: si el tema da para más, quédate con los más`,
  '  relevantes y dilo en "interpretacion".'
].join('\n');

// El SDK se carga aquí y no arriba para que el bot arranque igual aunque esta
// dependencia falte: el resto de comandos no la necesitan.
function crearCliente() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Falta ANTHROPIC_API_KEY en el .env de StreamFlix');
  }
  if (typeof fetch === 'undefined') {
    throw new Error(`Este comando necesita Node 18 o superior (hay ${process.version})`);
  }
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic();
}

// Los reintentos ante una negativa se piden con una beta; si la cuenta o el
// SDK todavía no la tienen, la API responde 400 y se repite sin ella en vez de
// dejar el comando inservible.
async function pedirAClaude(client, mensaje) {
  const base = {
    model: MODELO,
    max_tokens: 16000,
    system: INSTRUCCIONES,
    output_config: { format: { type: 'json_schema', schema: ESQUEMA } },
    messages: [{ role: 'user', content: mensaje }]
  };

  try {
    return await client.beta.messages.create({
      ...base,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    });
  } catch (error) {
    if (error?.status !== 400) throw error;
    return client.messages.create(base);
  }
}

function normalizar(datos) {
  const vistos = new Set();
  const titulos = [];

  for (const fila of Array.isArray(datos?.titulos) ? datos.titulos : []) {
    const titulo = String(fila?.titulo || '').trim();
    const tipo = String(fila?.tipo || '').trim().toLowerCase();
    if (!titulo || !TIPOS.includes(tipo)) continue;

    const clave = `${tipo}:${titulo.toLowerCase()}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);

    const anio = Number(fila?.anio) || null;
    titulos.push({ titulo, tipo, anio: anio && anio > 1800 ? anio : null, nota: String(fila?.nota || '').trim() });
    if (titulos.length >= MAX_TITULOS) break;
  }

  return { interpretacion: String(datos?.interpretacion || '').trim(), titulos };
}

async function expandirPedido(pedido) {
  const texto = String(pedido || '').trim();
  if (!texto) throw new Error('El pedido está vacío');

  const respuesta = await pedirAClaude(crearCliente(), texto);

  // Los clasificadores pueden rechazar una petición: llega un 200 con el
  // contenido vacío, así que hay que mirar stop_reason antes que content.
  if (respuesta.stop_reason === 'refusal') {
    throw new Error('Claude declinó responder a ese pedido');
  }

  const bloque = (respuesta.content || []).find((b) => b.type === 'text');
  if (!bloque) throw new Error('Claude no devolvió ninguna lista');

  let datos;
  try {
    datos = JSON.parse(bloque.text);
  } catch {
    throw new Error('La respuesta de Claude no vino en el formato esperado');
  }

  return normalizar(datos);
}

module.exports = { expandirPedido, MAX_TITULOS, TIPOS };

if (require.main === module) {
  const pedido = process.argv.slice(2).join(' ');
  expandirPedido(pedido)
    .then((resultado) => console.log(JSON.stringify(resultado, null, 2)))
    .catch((error) => {
      console.error(error.message || String(error));
      process.exit(1);
    });
}
