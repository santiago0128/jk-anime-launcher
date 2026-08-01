#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { main: saveEpisode } = require('./save_episode_url_to_streamflix.js');
const {
  main: importPelisplus,
  searchTitleAcrossSites,
  buildTitleUrl
} = require('./save_pelisplus_to_streamflix.js');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const JKANIME_BASE_URL = 'https://jkanime.net/';
const PELISPLUS_HOME_URL = 'https://ww9.cuevana3.to/';
// Si un titulo no aparece en el sitio principal se busca en los demas, en orden.
// Agregar uno nuevo aqui solo funciona si tiene adaptador en
// save_pelisplus_to_streamflix.js, que es quien sabe leer su HTML.
const CONTENT_SITES = [PELISPLUS_HOME_URL, 'https://www.pelisplushd.la/'];
const PELISPLUS_PATH_BY_TYPE = {
  series: 'serie',
  movie: 'pelicula'
};
function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];

    // Un flag sin valor (--no-browser) no debe comerse el siguiente parametro.
    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

// En segundo plano no se abre el navegador: la pestaña emergente es justo lo que
// interrumpe cuando la importacion corre desatendida.
function shouldOpenBrowser(args) {
  if (process.env.JK_NO_BROWSER === '1') return false;
  return args['no-browser'] !== 'true' && args['no-browser'] !== true;
}

// Estado de la importación en curso, en un archivo que cualquiera puede leer.
// Lo escribe el importador venga de donde venga (bot, cron o script), que es
// como el bot de Telegram puede informar del avance sin haberla lanzado él.
const ARCHIVO_PROGRESO = process.env.STREAMFLIX_PROGRESS_FILE || '/tmp/streamflix-progreso.json';

function escribirProgreso(datos) {
  try {
    fs.writeFileSync(
      ARCHIVO_PROGRESO,
      JSON.stringify({ ...datos, actualizado: new Date().toISOString() }, null, 2)
    );
  } catch {
    // El progreso es informativo: si no se puede escribir, la importación sigue.
  }
}

function fetchText(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/json',
          ...options.headers
        }
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          if (redirectCount >= 5) {
            reject(new Error(`Demasiadas redirecciones intentando cargar ${url}`));
            response.resume();
            return;
          }

          const redirectedUrl = new URL(response.headers.location, url).toString();
          response.resume();
          fetchText(redirectedUrl, options, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`No pude cargar ${url}. HTTP ${response.statusCode}`));
          response.resume();
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve(body);
        });
      }
    );

    request.on('error', reject);
  });
}

function postJson(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const request = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
      },
      (response) => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`No pude consultar ${url}. HTTP ${response.statusCode}`));
          response.resume();
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve(body);
        });
      }
    );

    request.on('error', reject);
    request.write(data);
    request.end();
  });
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanText(value) {
  return decodeHtml(value).replace(/\s+/g, ' ').trim();
}

function slugFromUrl(url) {
  const parsed = new URL(url);
  return parsed.pathname.split('/').filter(Boolean)[0];
}

function titleFromSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function episodeUrl(baseSeriesUrl, episodeNumber) {
  const normalized = baseSeriesUrl.endsWith('/') ? baseSeriesUrl : `${baseSeriesUrl}/`;
  return `${normalized}${episodeNumber}/`;
}

function openUrlInBrowser(url) {
  const openers = process.platform === 'darwin'
    ? [['open', [url]]]
    : process.platform === 'win32'
      ? [['cmd', ['/c', 'start', '', url]]]
      : [['xdg-open', [url]]];

  for (const [command, args] of openers) {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

// El buscador y el armado de URL dependen del sitio configurado en
// PELISPLUS_HOME_URL, asi que los resuelve el importador, que es quien conoce
// el HTML de cada uno.
function buildPelisplusUrl(contentType, title) {
  return (
    buildTitleUrl({ baseUrl: PELISPLUS_HOME_URL, contentType, title }) || PELISPLUS_HOME_URL
  );
}

function findOnPelisplus(contentType, title) {
  if (!PELISPLUS_PATH_BY_TYPE[contentType]) return Promise.resolve({ attempts: [] });
  return searchTitleAcrossSites({ contentType, title, baseUrls: CONTENT_SITES });
}

function getBrowserTargetUrl(contentType, animeUrl = null, title = null) {
  if (contentType === 'anime') {
    return animeUrl || JKANIME_BASE_URL;
  }

  return buildPelisplusUrl(contentType, title);
}

async function findSeriesOnJkAnime(seriesName) {
  const searchUrl = `https://jkanime.net/buscar?q=${encodeURIComponent(seriesName)}`;
  const html = await fetchText(searchUrl);
  const candidates = [...html.matchAll(/<div class="anime__item__text">[\s\S]*?<li class="anime">([\s\S]*?)<\/li>[\s\S]*?<h5><a[^>]*href="([^"]+)">([\s\S]*?)<\/a><\/h5>/g)].map(
    (match) => ({
      type: cleanText(match[1]),
      url: match[2],
      title: cleanText(match[3])
    })
  );

  const normalizedTarget = cleanText(seriesName).toLowerCase();
  const exactSeries = candidates.find(
    (item) => item.type?.toLowerCase() === 'serie' && item.title.toLowerCase() === normalizedTarget
  );
  if (exactSeries) return exactSeries;

  const containingSeries = candidates.find(
    (item) => item.type?.toLowerCase() === 'serie' && item.title.toLowerCase().includes(normalizedTarget)
  );
  if (containingSeries) return containingSeries;

  const firstSeries = candidates.find((item) => item.type?.toLowerCase() === 'serie');
  if (firstSeries) return firstSeries;

  throw new Error(`No encontre una serie para "${seriesName}" en JK Anime.`);
}

// jkanime publica cada temporada como una ficha aparte y con nombres que no
// siguen un único patrón: "2nd Season", "Final Season"… Además mezcla en la
// misma búsqueda películas, OVAs, recopilatorios y spin-offs, que no son
// temporadas aunque lleven el mismo nombre delante.
const PATRONES_TEMPORADA = [
  /^\d+(?:st|nd|rd|th)?\s*(?:season|temporada)?$/i,
  /^(?:season|temporada)\s*\d+$/i,
  /^final\s*(?:season|temporada)$/i,
  /^(?:part|parte)\s*\d+$/i,
  /^(?:ii|iii|iv|v|vi|vii|viii|ix|x)$/i
];

function normalizarTitulo(valor) {
  return cleanText(valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Devuelve el número de orden de una temporada, o null si el resto del título
// no es un marcador de temporada (ej. ": Memories", que es un recopilatorio).
function ordenDeTemporada(sufijo) {
  const resto = cleanText(sufijo).replace(/^[:\-–—\s]+/, '').trim();
  if (!resto) return 1;

  if (!PATRONES_TEMPORADA.some((patron) => patron.test(resto))) return null;
  if (/^final/i.test(resto)) return 999;

  const numero = (resto.match(/\d+/) || [])[0];
  if (numero) return Number(numero);

  const romanos = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  return romanos[resto.toLowerCase()] || null;
}

// Las OVAs, especiales y películas van al final, con números altos, para que la
// lista de temporadas de la ficha quede en orden natural.
const ORDEN_EXTRAS = { ova: 900, ona: 901, especial: 902, pelicula: 903 };

// Un sufijo que empieza por separador o por "the Movie"/"OVA" es material de la
// MISMA serie ("Boku no Hero Academia: Memories"). Uno que añade una palabra
// nueva antes es OTRA serie de la franquicia ("Dragon Ball Z", "Dragon Ball
// Super: Broly"), y meterla dentro sería mezclar series distintas.
function esMaterialDeLaMisma(sufijo) {
  const resto = cleanText(sufijo);
  if (!resto) return true;
  return /^[:\-–—(]/.test(resto) || /^\s*(?:the\s+)?(?:movie|film|ova|ona|special|especial)/i.test(resto);
}

function clasificarFicha(tipo, sufijo) {
  const clase = normalizarTitulo(tipo);

  if (clase.startsWith('serie')) {
    const orden = ordenDeTemporada(sufijo);
    if (orden === 999) return { orden: 899, etiqueta: 'Temporada final' };
    if (orden != null) return { orden, etiqueta: `Temporada ${orden}` };
    // No es temporada: solo cuenta si es material de esta misma serie.
    return esMaterialDeLaMisma(sufijo) ? { orden: ORDEN_EXTRAS.especial, etiqueta: 'Especiales' } : null;
  }

  if (!esMaterialDeLaMisma(sufijo)) return null;

  if (clase.startsWith('ova')) return { orden: ORDEN_EXTRAS.ova, etiqueta: 'OVAs' };
  if (clase.startsWith('ona')) return { orden: ORDEN_EXTRAS.ona, etiqueta: 'ONAs' };
  if (clase.startsWith('pelicula') || clase.startsWith('movie')) {
    return { orden: ORDEN_EXTRAS.pelicula, etiqueta: 'Películas' };
  }

  return { orden: ORDEN_EXTRAS.especial, etiqueta: 'Especiales' };
}

async function findAnimeSeasons(seriesName) {
  const searchUrl = `https://jkanime.net/buscar?q=${encodeURIComponent(seriesName)}`;
  const html = await fetchText(searchUrl);
  const candidatos = [...html.matchAll(/<div class="anime__item__text">[\s\S]*?<li class="anime">([\s\S]*?)<\/li>[\s\S]*?<h5><a[^>]*href="([^"]+)">([\s\S]*?)<\/a><\/h5>/g)].map(
    (match) => ({ tipo: cleanText(match[1]), url: match[2], title: cleanText(match[3]) })
  );

  // La base es la ficha de tipo serie más corta que coincide con lo buscado; el
  // resto del material de la franquicia empieza por ese nombre.
  const objetivo = normalizarTitulo(seriesName);
  const series = candidatos.filter((item) => normalizarTitulo(item.tipo).startsWith('serie'));
  const base =
    series.find((item) => normalizarTitulo(item.title) === objetivo) ||
    series
      .filter((item) => normalizarTitulo(item.title).startsWith(objetivo))
      .sort((a, b) => a.title.length - b.title.length)[0];

  if (!base) return [];

  const prefijo = normalizarTitulo(base.title);
  const fichas = [];

  for (const item of candidatos) {
    // Un spin-off como "Vigilante: Boku no Hero Academia" no empieza por el
    // nombre base, así que queda fuera: es otra serie, no material de esta.
    if (!normalizarTitulo(item.title).startsWith(prefijo)) continue;

    const clasificacion = clasificarFicha(item.tipo, item.title.slice(base.title.length));
    if (!clasificacion) continue;
    fichas.push({ ...item, ...clasificacion });
  }

  // Varias fichas pueden caer en la misma categoría (dos OVAs, cuatro
  // películas); se numeran hacia arriba para no pisarse la temporada.
  const usados = new Set();
  for (const ficha of fichas.sort((a, b) => a.orden - b.orden || a.title.localeCompare(b.title))) {
    while (usados.has(ficha.orden)) ficha.orden += 1;
    usados.add(ficha.orden);
  }

  return fichas;
}

async function getSeriesMetadataFromUrl(seriesUrl) {
  const normalizedUrl = seriesUrl.endsWith('/') ? seriesUrl : `${seriesUrl}/`;
  const html = await fetchText(normalizedUrl);

  const titleMatch =
    html.match(/<meta property="og:title" content="([^"]+)"/i) ||
    html.match(/<title>([^<]+)<\/title>/i);
  const totalEpisodesMatch =
    html.match(/<span class="d-block">(\d+)\s+episodios<\/span>/i) ||
    html.match(/<li>\s*<span>\s*Episodios:\s*<\/span>\s*(\d+)\s*<\/li>/i) ||
    html.match(/<span>\s*Episodios:\s*<\/span>\s*(\d+)/i);

  // En los animes en emision el campo "Episodios" viene en 0, asi que el numero
  // real hay que sacarlo del enlace al ultimo episodio publicado.
  const lastEpisodeMatch =
    html.match(/href="https?:\/\/jkanime\.net\/[^"]+\/(\d+)\/"[^>]*id="uep"/i) ||
    html.match(/id="uep"[^>]*>[^<]*?(\d+)\s*</i);

  const parsedUrl = new URL(normalizedUrl);
  const slug = parsedUrl.pathname.split('/').filter(Boolean)[0];
  const rawTitle = titleMatch ? cleanText(titleMatch[1]) : titleFromSlug(slug);
  // El <title> de la ficha viene con cola de SEO: "Nombre - anime Nombre online JkAnime".
  const title = rawTitle
    .replace(/\s+Sub Español.*$/i, '')
    .replace(/\s*[-–]\s*anime\b.*$/i, '')
    .replace(/\s*\|\s*JkAnime.*$/i, '')
    .trim();
  const declaredEpisodes = totalEpisodesMatch ? Number(totalEpisodesMatch[1]) : 0;
  const lastEpisode = lastEpisodeMatch ? Number(lastEpisodeMatch[1]) : 0;
  const totalEpisodes = Math.max(declaredEpisodes, lastEpisode) || null;

  if (!slug) {
    throw new Error(`No pude detectar el slug de la serie desde ${seriesUrl}`);
  }

  return {
    title,
    slug,
    url: normalizedUrl,
    totalEpisodes
  };
}

// Los titulos de jkanime traen adornos que AniList no reconoce: "(Original)",
// acentos, sufijos de temporada. Se prueban variantes de mas a menos especifica
// hasta que una coincida.
function aniListSearchVariants(seriesName) {
  const base = cleanText(seriesName);
  const withoutParens = base.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const withoutAccents = withoutParens.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = withoutAccents.split(' ').filter(Boolean);

  const variants = [base, withoutParens, withoutAccents];
  if (words.length > 2) variants.push(words.slice(0, 2).join(' '));

  return [...new Set(variants.filter(Boolean))];
}

async function findAniListId(seriesName) {
  for (const variant of aniListSearchVariants(seriesName)) {
    const found = await queryAniList(variant);
    if (found) return found;
  }

  return null;
}

async function queryAniList(seriesName) {
  try {
    const query = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          id
          idMal
          title {
            romaji
            english
            native
          }
          seasonYear
          averageScore
        }
      }
    `;

    const body = await postJson('https://graphql.anilist.co', {
      query,
      variables: { search: seriesName }
    });

    const payload = JSON.parse(body);
    const media = payload?.data?.Media;
    if (!media?.id) {
      return null;
    }

    return {
      id: media.idMal || null,
      aniListId: media.id,
      releaseYear: media.seasonYear || null,
      rating: media.averageScore ? Number((media.averageScore / 10).toFixed(1)) : null,
      matchedTitle: media.title?.english || media.title?.romaji || media.title?.native || seriesName
    };
  } catch {
    return null;
  }
}

function importEpisode(config, episodeNumber) {
  return saveEpisode({
    episodeUrl: episodeUrl(config.seriesUrl, episodeNumber),
    aniskipAnimeId: config.aniskipId,
    releaseYear: config.releaseYear,
    rating: config.rating,
    // Todas las fichas de la franquicia van a la misma serie del catálogo, cada
    // una como su propia temporada.
    seriesTitle: config.franquicia,
    seriesSourceRef: config.referencia,
    seasonNumber: config.seasonNumber,
    seasonTitle: config.seasonTitle,
    emitJson: false
  }).catch((error) => {
    throw new Error(`Fallo el episodio ${episodeNumber}: ${error.message || String(error)}`);
  });
}

let promptInterface = null;

function ask(question) {
  if (!promptInterface) {
    promptInterface = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  return new Promise((resolve) => {
    promptInterface.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function closePrompts() {
  if (promptInterface) {
    promptInterface.close();
    promptInterface = null;
  }
}

function normalizeContentType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['anime', 'animes'].includes(normalized)) return 'anime';
  if (['serie', 'series'].includes(normalized)) return 'series';
  if (['pelicula', 'películas', 'peliculas', 'movie', 'movies'].includes(normalized)) return 'movie';
  return null;
}

async function resolveInteractiveArgs(args) {
  if (args['series-name'] || args['series-url'] || args.title || args['page-url'] || args['content-type']) {
    return args;
  }

  // Sin terminal no hay quien conteste las preguntas: mejor avisar que quedarse
  // esperando en silencio, que es lo que pasaria corriendo en segundo plano.
  if (!process.stdin.isTTY) {
    throw new Error(
      'No hay terminal para preguntar. En segundo plano pasa los datos por parametro, ' +
        'por ejemplo: --content-type serie --title "Stranger Things" --no-browser'
    );
  }

  const rawType = await ask('¿Qué quieres cargar? [anime/serie/pelicula]: ');
  const contentType = normalizeContentType(rawType);
  if (!contentType) {
    throw new Error('Debes elegir anime, serie o pelicula.');
  }

  if (contentType === 'anime') {
    const animeInput = await ask('Pega la URL o el nombre del anime que quieres cargar: ');
    if (!animeInput) {
      throw new Error('No enviaste el nombre o la URL del anime.');
    }

    if (/^https?:\/\//i.test(animeInput)) {
      return {
        ...args,
        interactive: true,
        'content-type': contentType,
        'series-url': animeInput
      };
    }

    return {
      ...args,
      interactive: true,
      'content-type': contentType,
      'series-name': animeInput
    };
  }

  const label = contentType === 'movie' ? 'pelicula' : 'serie';
  const input = await ask(`Escribe el nombre de la ${label} (o pega la URL de PelisPlusHD): `);
  if (!input) {
    throw new Error(`No enviaste el nombre de la ${label}.`);
  }

  const target = /^https?:\/\//i.test(input) ? { 'page-url': input } : { title: input };

  if (contentType !== 'series') {
    return { ...args, 'content-type': contentType, ...target };
  }

  // Una serie completa puede ser medio centenar de capitulos y cada uno es una
  // descarga, asi que se deja elegir la temporada antes de arrancar.
  const season = await ask('¿Qué temporada quieres importar? (Enter = todas): ');

  return {
    ...args,
    'content-type': contentType,
    ...target,
    ...(season ? { season } : {})
  };
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2));
  const args = await resolveInteractiveArgs(rawArgs).finally(closePrompts);
  const contentType = normalizeContentType(args['content-type'] || 'anime') || 'anime';
  const seriesName = args['series-name'];
  const seriesUrlArg = args['series-url'];
  const titleArg = args.title;
  const pageUrlArg = args['page-url'];

  if (contentType !== 'anime') {
    const label = contentType === 'movie' ? 'pelicula' : 'serie';
    if (!titleArg && !pageUrlArg) {
      throw new Error(`Debes enviar --title "Nombre de la ${label}" o --page-url "https://www.pelisplushd.la/${label}/slug".`);
    }

    const search = titleArg
      ? await findOnPelisplus(contentType, titleArg).catch(() => ({ attempts: [] }))
      : { attempts: [] };
    let match = search.url ? search : null;

    // Un parecido no es un acierto: sin confirmar, importar "Stealing Pulp
    // Fiction" cuando pediste "Pulp Fiction" es peor que no importar nada.
    if (match && !match.strong && !pageUrlArg) {
      if (args['accept-similar'] === 'true') {
        process.stderr.write(`≈ Uso el parecido "${match.title}" (${match.score.toFixed(2)}) de ${match.baseUrl}\n`);
      } else if (args.interactive) {
        const answer = await ask(
          `No encontré "${titleArg}" exacto. El más parecido es "${match.title}" en ${match.baseUrl}. ¿Lo importo? [s/N]: `
        ).finally(closePrompts);
        if (!/^s(i|í)?$/i.test(answer)) {
          throw new Error('Cancelado: no se importó nada.');
        }
      } else {
        throw new Error(
          `No encontré "${titleArg}" exacto como ${label}. Lo más parecido es "${match.title}" ` +
            `(${match.score.toFixed(2)}) en ${match.baseUrl}.\n` +
            'Si es lo que buscas, repite con --accept-similar, o pasa la ficha con --page-url.'
        );
      }
    }

    if (titleArg && !match && !pageUrlArg) {
      const detail = search.attempts.map((item) => `  · ${item.baseUrl}: ${item.reason}`).join('\n');
      throw new Error(
        `No encontre "${titleArg}" como ${label} en ninguno de los sitios configurados.\n${detail}\n` +
          'Prueba con otro nombre, o pasa la ficha directo con --page-url.'
      );
    }

    const targetUrl = pageUrlArg || match?.url || getBrowserTargetUrl(contentType, null, titleArg);
    if (shouldOpenBrowser(args)) openUrlInBrowser(targetUrl);

    const nombreMostrado = match?.title || titleArg || targetUrl;
    escribirProgreso({
      estado: 'importando',
      tipo: label,
      titulo: nombreMostrado,
      hechos: 0,
      total: null,
      iniciado: new Date().toISOString()
    });

    const iniciado = new Date().toISOString();
    const result = await importPelisplus({
      pageUrl: targetUrl,
      baseUrl: match?.baseUrl || PELISPLUS_HOME_URL,
      contentType,
      season: args.season,
      start: args.start,
      end: args.end,
      emitJson: false,
      onProgress: (event) => {
        process.stderr.write(
          `→ T${event.seasonNumber}E${event.episodeNumber} (${event.provider})${
            event.total ? ` [${event.done}/${event.total}]` : ''
          }\n`
        );
        escribirProgreso({
          estado: 'importando',
          tipo: label,
          titulo: nombreMostrado,
          hechos: event.done || 0,
          total: event.total || null,
          ultimo: `T${event.seasonNumber}E${event.episodeNumber}`,
          iniciado
        });
      }
    }).catch((error) => {
      escribirProgreso({ estado: 'error', tipo: label, titulo: nombreMostrado, motivo: error.message, iniciado });
      throw error;
    });

    escribirProgreso({
      estado: 'terminado',
      tipo: label,
      titulo: result.title || nombreMostrado,
      hechos: result.importedCount,
      total: result.importedCount,
      saltados: result.skippedCount,
      iniciado
    });

    console.log(
      JSON.stringify(
        {
          ...result,
          searchedTitle: titleArg || null,
          matchedTitle: match?.title || null,
          matchedInSearch: Boolean(match),
          matchedSite: match?.baseUrl || null,
          matchScore: match?.score != null ? Number(match.score.toFixed(2)) : null,
          openedUrl: targetUrl
        },
        null,
        2
      )
    );
    return;
  }

  let start = Number(args.start || 1);
  let end = Number(args.end || start);

  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
    throw new Error('Los parametros --start y --end deben ser enteros validos.');
  }

  // Una franquicia está repartida en varias fichas del sitio (temporadas, OVAs,
  // especiales, películas). Buscando por nombre se traen todas y se guardan
  // como UNA serie con varias temporadas; con --series-url se importa solo esa.
  let fichas;
  if (seriesUrlArg) {
    const unica = await getSeriesMetadataFromUrl(seriesUrlArg);
    fichas = [{ title: unica.title, url: unica.url, orden: 1, etiqueta: 'Temporada 1', metadatos: unica }];
  } else if (seriesName) {
    const encontradas = await findAnimeSeasons(seriesName);
    if (!encontradas.length) {
      // Sin coincidencias por franquicia se cae a la búsqueda de una sola ficha.
      const found = await findSeriesOnJkAnime(seriesName);
      fichas = [{ title: found.title, url: found.url, orden: 1, etiqueta: 'Temporada 1' }];
    } else {
      fichas = args['solo-esta'] === 'true' ? [encontradas[0]] : encontradas;
    }
  } else {
    throw new Error('Debes enviar --series-name "Nombre de la serie" o --series-url "https://jkanime.net/serie/".');
  }

  const nombreFranquicia = fichas[0].title;
  const refFranquicia = `jkanime:${slugFromUrl(fichas[0].url)}`;

  if (fichas.length > 1) {
    process.stderr.write(`Encontré ${fichas.length} fichas de "${nombreFranquicia}":\n`);
    fichas.forEach((f) => process.stderr.write(`   ${String(f.orden).padStart(3)}  ${f.etiqueta.padEnd(16)} ${f.title}\n`));
  }

  const resumenFichas = [];
  let totalImportados = 0;
  let totalFallidos = 0;
  const iniciadoTodo = new Date().toISOString();

  for (const [indice, ficha] of fichas.entries()) {
    const jkSeries = ficha.metadatos || (await getSeriesMetadataFromUrl(ficha.url));
    const resultado = await importarFicha({
      jkSeries,
      ficha,
      args,
      seriesName,
      contentType,
      franquicia: { nombre: nombreFranquicia, referencia: refFranquicia },
      posicion: { indice: indice + 1, total: fichas.length },
      iniciadoTodo
    });

    resumenFichas.push(resultado);
    totalImportados += resultado.importedCount;
    totalFallidos += resultado.failedCount;
  }

  escribirProgreso({
    estado: totalImportados ? 'terminado' : 'error',
    tipo: 'anime',
    titulo: nombreFranquicia,
    hechos: totalImportados,
    total: totalImportados,
    fallidos: totalFallidos,
    iniciado: iniciadoTodo
  });

  if (!totalImportados) {
    throw new Error(`No pude importar ningún capítulo de "${nombreFranquicia}".`);
  }

  console.log(
    JSON.stringify(
      {
        seriesName: nombreFranquicia,
        sourceRef: refFranquicia,
        temporadas: resumenFichas.length,
        importedCount: totalImportados,
        failedCount: totalFallidos,
        detalle: resumenFichas
      },
      null,
      2
    )
  );
  return;
}

// Importa una ficha del sitio como una temporada de la franquicia.
async function importarFicha({ jkSeries, ficha, args, seriesName, contentType, franquicia, posicion, iniciadoTodo }) {
  let start = Number(args.start || 1);
  let end = Number(args.end || start);

  if (!args.end && jkSeries.totalEpisodes) {
    end = jkSeries.totalEpisodes;
  }

  // Importar una serie larga son cientos de descargas, asi que en modo
  // interactivo se muestra lo detectado y se deja recortar antes de arrancar.
  if (args.interactive && !args.end) {
    const detected = jkSeries.totalEpisodes;
    const answer = await ask(
      detected
        ? `Detecté ${detected} capítulos en "${jkSeries.title}". ¿Hasta cuál importo? (Enter = todos): `
        : `No pude detectar cuántos capítulos tiene "${jkSeries.title}". ¿Hasta cuál importo? (Enter = solo el ${start}): `
    ).finally(closePrompts);

    if (answer) {
      const requested = Number(answer);
      if (!Number.isInteger(requested) || requested < start) {
        throw new Error(`"${answer}" no es un capítulo válido (debe ser un entero >= ${start}).`);
      }
      end = requested;
    }
  }

  const aniList = await findAniListId(jkSeries.title || seriesName || titleFromSlug(jkSeries.slug));

  const config = {
    seriesName: jkSeries.title,
    seriesUrl: jkSeries.url.endsWith('/') ? jkSeries.url : `${jkSeries.url}/`,
    seriesSlug: slugFromUrl(jkSeries.url),
    aniskipId: aniList?.id || null,
    releaseYear: aniList?.releaseYear || null,
    rating: aniList?.rating || null,
    // Todo va bajo la misma ficha de catálogo; esta entra como una temporada.
    franquicia: franquicia.nombre,
    referencia: franquicia.referencia,
    seasonNumber: ficha.orden,
    seasonTitle: ficha.etiqueta
  };

  if (shouldOpenBrowser(args)) openUrlInBrowser(getBrowserTargetUrl(contentType, config.seriesUrl));

  const imported = [];
  const failed = [];
  const total = end - start + 1;
  const iniciado = iniciadoTodo || new Date().toISOString();
  const sufijoParte = posicion.total > 1 ? ` (${posicion.indice}/${posicion.total}: ${ficha.etiqueta})` : '';

  escribirProgreso({
    estado: 'importando',
    tipo: 'anime',
    titulo: `${franquicia.nombre}${sufijoParte}`,
    hechos: 0,
    total,
    iniciado
  });

  for (let episodeNumber = start; episodeNumber <= end; episodeNumber += 1) {
    // Un capitulo caido no puede llevarse por delante el resto de la serie.
    try {
      const result = await importEpisode(config, episodeNumber);
      imported.push({
        episodeNumber,
        episodeId: result.episodeId,
        snapshotId: result.snapshotId,
        primaryVideoUrl: result.savedPrimaryVideoUrl,
        primaryVideoSource: result.savedPrimaryVideoSource,
        durationSec: result.durationSec
      });
      process.stderr.write(`→ capítulo ${episodeNumber} [${imported.length + failed.length}/${total}]\n`);
    } catch (error) {
      failed.push({ episodeNumber, reason: error.message || String(error) });
      process.stderr.write(
        `✗ capítulo ${episodeNumber} [${imported.length + failed.length}/${total}]: ${error.message || error}\n`
      );
    }

    escribirProgreso({
      estado: 'importando',
      tipo: 'anime',
      titulo: `${franquicia.nombre}${sufijoParte}`,
      hechos: imported.length + failed.length,
      total,
      fallidos: failed.length,
      ultimo: `capítulo ${episodeNumber}`,
      iniciado
    });
  }



  // El resumen lo imprime main() con el total de la franquicia; aquí solo se
  // devuelve lo de esta temporada.
  return {
    temporada: ficha.orden,
    etiqueta: ficha.etiqueta,
    fichaTitulo: config.seriesName,
    fichaUrl: config.seriesUrl,
    totalEpisodesDetected: jkSeries.totalEpisodes || null,
    aniskipId: config.aniskipId,
    releaseYear: config.releaseYear,
    rating: config.rating,
    importedRange: { start, end },
    importedCount: imported.length,
    failedCount: failed.length,
    failed
  };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}

module.exports = { findAnimeSeasons, clasificarFicha, ordenDeTemporada };
