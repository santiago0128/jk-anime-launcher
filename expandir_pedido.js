#!/usr/bin/env node

// Traduce un pedido en lenguaje natural a una lista concreta de títulos.
//
// El importador necesita un nombre exacto por título; una persona escribe
// "todas las de Marvel". Este módulo cubre esa distancia en dos pasos, y el
// reparto importa:
//
//   1. Un modelo interpreta el pedido: "todas las de Nolan" -> persona,
//      Christopher Nolan, director. Eso lo hace bien hasta un modelo pequeño.
//   2. Los títulos los pone una base de datos de cine (ver fuentes_catalogo).
//
// Hacerlo al revés —pedirle la lista al modelo— es lo que devolvía "El
// Padrino: El Segundo Sol", que no existe. Ese camino sigue ahí como respaldo
// para cuando ninguna fuente sabe responder, pero ya no es el principal.
//
// Motores para el paso 1:
//   ollama  el del servidor. Gratis, y para interpretar sobra. Es el de serie.
//   claude  la API de Anthropic. Solo si se pide, o si Ollama no responde.
//
// Uso desde consola (imprime JSON):
//   node expandir_pedido.js "la trilogia original de star wars"
//
// Variables:
//   PEDIDO_PROVEEDOR    claude | ollama. Por defecto ollama.
//   ANTHROPIC_API_KEY   necesaria para el motor claude
//   TMDB_API_KEY        opcional. Sin ella el cine sale de Wikidata, que no
//                       pide nada; con ella, de TMDB, que da mejores títulos.
//   OLLAMA_URL          por defecto http://host.docker.internal:11434
//   OLLAMA_MODELO       por defecto qwen2.5:1.5b
//   PEDIDO_MAX_TITULOS  tope de títulos por pedido (por defecto 40)

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { buscarEnFuentes } = require('./fuentes_catalogo.js');

const raizStreamflix = process.env.STREAMFLIX_ROOT;
if (raizStreamflix && fs.existsSync(path.join(raizStreamflix, '.env'))) {
  require('dotenv').config({ path: path.join(raizStreamflix, '.env') });
}

const MODELO = 'claude-opus-5';
const TIPOS = ['anime', 'serie', 'pelicula'];
const MAX_TITULOS = Number(process.env.PEDIDO_MAX_TITULOS) || 40;

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://host.docker.internal:11434').replace(/\/+$/, '');
const OLLAMA_MODELO = process.env.OLLAMA_MODELO || 'qwen2.5:1.5b';

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

// Las instrucciones de arriba están escritas para un modelo grande y a uno
// pequeño lo ahogan: con ellas, qwen2.5:1.5b se agarraba a la regla del pedido
// ambiguo y devolvía la lista vacía hasta para "la trilogía de El Padrino".
// Estas son las mismas ideas en la mitad de líneas y sin matices.
const INSTRUCCIONES_CORTAS = [
  'Recibes un pedido y devuelves los títulos concretos de cine, TV o anime que lo componen.',
  '',
  'Reglas:',
  '- Devuelve siempre todos los títulos que conozcas. Nunca pidas aclaraciones ni',
  '  devuelvas la lista vacía si el pedido nombra algo que se pueda ver.',
  '- Usa el título exacto y real. Si no recuerdas cómo se llama de verdad, no lo incluyas:',
  '  un título inventado hace que el importador busque algo que no existe.',
  '- tipo: "anime" si es animación japonesa, "serie" si es de imagen real por temporadas,',
  '  "pelicula" si es un largometraje.',
  '- Una serie es UN solo título: no enumeres temporadas ni capítulos.',
  '- anio es el año de estreno; si no estás seguro pon 0.',
  '- Ordena del más antiguo al más nuevo.',
  `- Como mucho ${MAX_TITULOS} títulos.`,
  '- En interpretacion, una frase corta con lo que entendiste.'
].join('\n');

// Interpretar el pedido es lo único que se le pide al modelo cuando hay una
// fuente de datos detrás: de "todas las de Nolan" solo hay que sacar que se
// habla de una persona llamada Christopher Nolan. Eso sí lo hace bien un
// modelo pequeño, y es gratis.
const ESQUEMA_INTENCION = {
  type: 'object',
  properties: {
    ambito: { type: 'string', enum: ['anime', 'cine'], description: 'anime para animación japonesa; cine para todo lo demás.' },
    intencion: {
      type: 'string',
      enum: ['persona', 'saga', 'estudio', 'genero', 'titulo'],
      description: 'Qué clase de pedido es.'
    },
    busqueda: { type: 'string', description: 'El nombre a buscar, sin adornos: "Christopher Nolan", "El Padrino", "Ghibli".' },
    rol: { type: 'string', enum: ['director', 'actor', ''], description: 'Solo si intencion es persona.' }
  },
  required: ['ambito', 'intencion', 'busqueda', 'rol'],
  additionalProperties: false
};

const INSTRUCCIONES_INTENCION = [
  'Clasificas un pedido de películas, series o anime. No listas títulos: solo dices qué se está pidiendo.',
  '',
  'ambito: "anime" si habla de animación japonesa; "cine" para lo demás.',
  'intencion:',
  '  persona  — se pide la obra de alguien ("las de Nolan", "películas de Tom Hanks")',
  '  saga     — se pide una saga o trilogía ("la trilogía de El Padrino", "todo Star Wars")',
  '  estudio  — se pide lo de una productora o estudio ("lo de Ghibli", "películas de Pixar")',
  '  genero   — se pide un tema o género ("animes de deportes", "cine de terror")',
  '  titulo   — se nombra una obra concreta ("Breaking Bad")',
  'busqueda: el nombre limpio a buscar, sin "todas las de" ni "películas de".',
  'rol: "director" o "actor" solo cuando intencion es persona; si no, cadena vacía.',
  '',
  'Ejemplos:',
  '  "traeme todo lo que dirigio Christopher Nolan" -> cine / persona / Christopher Nolan / director',
  '  "la trilogia de El Padrino" -> cine / saga / El Padrino / ""',
  '  "todo boku no hero academia" -> anime / titulo / Boku no Hero Academia / ""',
  '  "animes de deportes" -> anime / genero / Sports / ""'
].join('\n');

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
async function pedirAClaude(mensaje, instrucciones = INSTRUCCIONES, esquema = ESQUEMA) {
  const client = crearCliente();
  const base = {
    model: MODELO,
    max_tokens: 16000,
    system: instrucciones,
    output_config: { format: { type: 'json_schema', schema: esquema } },
    messages: [{ role: 'user', content: mensaje }]
  };

  let respuesta;
  try {
    respuesta = await client.beta.messages.create({
      ...base,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    });
  } catch (error) {
    if (error?.status !== 400) throw error;
    respuesta = await client.messages.create(base);
  }

  // Los clasificadores pueden rechazar una petición: llega un 200 con el
  // contenido vacío, así que hay que mirar stop_reason antes que content.
  if (respuesta.stop_reason === 'refusal') {
    throw new Error('Claude declinó responder a ese pedido');
  }

  const bloque = (respuesta.content || []).find((b) => b.type === 'text');
  if (!bloque) throw new Error('Claude no devolvió ninguna lista');
  return bloque.text;
}

// Ollama no lleva SDK propio aquí: es una petición HTTP y así el módulo se
// carga igual en un Node sin fetch global.
function pedirAOllama(mensaje, instrucciones = INSTRUCCIONES_CORTAS, esquema = ESQUEMA) {
  const cuerpo = JSON.stringify({
    model: OLLAMA_MODELO,
    stream: false,
    format: esquema,
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: instrucciones },
      { role: 'user', content: mensaje }
    ]
  });

  const url = new URL(`${OLLAMA_URL}/api/chat`);
  const cliente = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const peticion = cliente.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo) },
        // En CPU y con una lista larga puede tardar minutos.
        timeout: 300000
      },
      (respuesta) => {
        let datos = '';
        respuesta.on('data', (c) => (datos += c));
        respuesta.on('end', () => {
          let json;
          try {
            json = JSON.parse(datos);
          } catch {
            return reject(new Error(`Ollama respondió algo ilegible: ${datos.slice(0, 200)}`));
          }
          if (json.error) {
            // Los modelos ":cloud" corren en los servidores de Ollama y piden
            // sesión iniciada; los locales no.
            const pista = /unauthorized/i.test(json.error)
              ? ` (¿es un modelo ":cloud"? necesita "ollama signin" en el servidor)`
              : '';
            return reject(new Error(`Ollama: ${json.error}${pista}`));
          }
          const texto = json?.message?.content;
          if (!texto) return reject(new Error('Ollama no devolvió ninguna lista'));
          resolve(texto);
        });
      }
    );

    peticion.on('timeout', () => peticion.destroy(new Error('Ollama tardó demasiado')));
    peticion.on('error', (error) =>
      reject(new Error(`No pude hablar con Ollama en ${OLLAMA_URL}: ${error.message}`))
    );
    peticion.end(cuerpo);
  });
}

// Ollama no se elige solo aunque esté ahí, y esto es a propósito: un modelo
// pequeño no solo se deja títulos, se los inventa ("El Padrino: El Segundo
// Sol"), y entonces el importador busca algo que no existe y el emparejador
// difuso puede colar otra cosa en el catálogo. Usarlo es una decisión, no un
// respaldo silencioso.
// Por defecto interpreta el modelo local: es gratis y para esta tarea llega.
// Claude solo entra si se pide, o como red de seguridad si Ollama no responde.
function elegirProveedor() {
  const pedido = String(process.env.PEDIDO_PROVEEDOR || '').trim().toLowerCase();
  if (pedido === 'claude' || pedido === 'ollama') return pedido;
  if (pedido) throw new Error(`PEDIDO_PROVEEDOR solo acepta "claude" u "ollama", no "${pedido}"`);
  return 'ollama';
}

async function preguntarAlModelo(mensaje, { instrucciones, instruccionesCortas, esquema }) {
  const proveedor = elegirProveedor();

  if (proveedor === 'claude') {
    return { crudo: await pedirAClaude(mensaje, instrucciones, esquema), proveedor, modelo: MODELO };
  }

  try {
    return { crudo: await pedirAOllama(mensaje, instruccionesCortas, esquema), proveedor: 'ollama', modelo: OLLAMA_MODELO };
  } catch (error) {
    if (!process.env.ANTHROPIC_API_KEY) throw error;
    // Con clave a mano no tiene sentido dejar el comando muerto porque el
    // servidor local esté apagado o sin memoria.
    return { crudo: await pedirAClaude(mensaje, instrucciones, esquema), proveedor: 'claude', modelo: MODELO };
  }
}

// Saca del pedido qué se está buscando, para poder preguntárselo a quien tiene
// el dato. Si el modelo no da algo usable, se devuelve null y quien llama cae
// al camino antiguo de pedirle la lista entera al modelo.
async function interpretarPedido(texto) {
  let respuesta;
  try {
    respuesta = await preguntarAlModelo(texto, {
      instrucciones: INSTRUCCIONES_INTENCION,
      instruccionesCortas: INSTRUCCIONES_INTENCION,
      esquema: ESQUEMA_INTENCION
    });
    const datos = JSON.parse(extraerJson(respuesta.crudo));
    const busqueda = String(datos?.busqueda || '').trim();
    if (!busqueda) return null;

    return {
      ambito: datos.ambito === 'anime' ? 'anime' : 'cine',
      intencion: ['persona', 'saga', 'estudio', 'genero', 'titulo'].includes(datos.intencion) ? datos.intencion : 'titulo',
      busqueda,
      rol: datos.rol === 'actor' ? 'actor' : 'director',
      interprete: respuesta.modelo
    };
  } catch {
    return null;
  }
}

// Un modelo pequeño a veces envuelve el JSON en texto pese al esquema.
function extraerJson(texto) {
  const limpio = String(texto).trim();
  if (limpio.startsWith('{')) return limpio;
  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio < 0 || fin <= inicio) throw new Error('La respuesta no traía ningún JSON');
  return limpio.slice(inicio, fin + 1);
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

// Camino antiguo: pedirle la lista entera al modelo. Solo se usa cuando
// ninguna fuente de datos puede responder, porque es el que se deja títulos y
// de vez en cuando se inventa alguno.
async function listarConElModelo(texto) {
  const { crudo, proveedor, modelo } = await preguntarAlModelo(texto, {
    instrucciones: INSTRUCCIONES,
    instruccionesCortas: INSTRUCCIONES_CORTAS,
    esquema: ESQUEMA
  });

  let datos;
  try {
    datos = JSON.parse(extraerJson(crudo));
  } catch {
    throw new Error(`La respuesta de ${proveedor} no vino en el formato esperado`);
  }

  return { ...normalizar(datos), fuente: modelo, exacta: false };
}

async function expandirPedido(pedido) {
  const texto = String(pedido || '').trim();
  if (!texto) throw new Error('El pedido está vacío');

  // Primero el camino bueno: el modelo solo interpreta y los títulos salen de
  // una base de datos de cine, que ni se los inventa ni se deja la mitad.
  const intencion = await interpretarPedido(texto);
  if (intencion) {
    try {
      const encontrado = await buscarEnFuentes(intencion, MAX_TITULOS);
      if (encontrado && encontrado.titulos.length) {
        const { titulos } = normalizar({ titulos: encontrado.titulos });
        if (titulos.length) {
          return {
            interpretacion: describirIntencion(intencion),
            titulos,
            fuente: encontrado.fuente,
            exacta: true
          };
        }
      }
    } catch (error) {
      // Una fuente caída no puede dejar el comando inservible: se avisa por
      // registro y se sigue por el camino antiguo.
      console.error(`fuente de datos no disponible: ${error.message}`);
    }
  }

  return listarConElModelo(texto);
}

function describirIntencion({ ambito, intencion, busqueda, rol }) {
  if (intencion === 'persona') return `Obra de ${busqueda} como ${rol}`;
  if (intencion === 'saga') return `Saga ${busqueda}`;
  if (intencion === 'estudio') return `Producciones de ${busqueda}`;
  if (intencion === 'genero') return `${ambito === 'anime' ? 'Anime' : 'Cine'} del género ${busqueda}`;
  return busqueda;
}

module.exports = { expandirPedido, interpretarPedido, elegirProveedor, MAX_TITULOS, TIPOS };

if (require.main === module) {
  const pedido = process.argv.slice(2).join(' ');
  expandirPedido(pedido)
    .then((resultado) => console.log(JSON.stringify(resultado, null, 2)))
    .catch((error) => {
      console.error(error.message || String(error));
      process.exit(1);
    });
}
