#!/usr/bin/env node

// Importador de series y peliculas hacia la base StreamFlix.
// Replica el flujo del importador de anime (scraping -> verificacion de video ->
// dbo.Series / dbo.Seasons / dbo.Episodes + snapshot). Lo especifico de cada
// sitio (PelisPlusHD, Cuevana3) vive en su adaptador; el resto es comun.

const {
  getPool,
  closePool,
  fetchText,
  requestUrl,
  probeVideoUrl,
  extractMediaUrlsFromHtml,
  normalizeUrl,
  looksLikeVideoFile,
  cleanText,
  matchOne,
  matchAll,
  sleep,
  NO_VIDEO_FOUND
} = require('./save_episode_url_to_streamflix.js');

const PELISPLUS_BASE_URL = 'https://www.pelisplushd.la/';
const SOURCE_SITE = 'PelisPlusHD';
const HTML_ACCEPT = 'text/html,application/xhtml+xml';
// Abrir cada embed de terceros para buscar el archivo real es caro, asi que solo
// se hace con los primeros candidatos; el resto queda guardado como embed.
const MAX_DEEP_RESOLVE_CANDIDATES = 6;
// Hosts de la familia streamwish: son los que publican el m3u8 en el jwplayer
// empaquetado, asi que se intentan antes que el resto.
const RESOLVABLE_HOST_HINTS = [
  'filelions',
  'vidhide',
  'streamwish',
  'swish',
  'wish',
  'lulustream',
  'dhcplay',
  'smoothpre'
];

function resolvePriority(url) {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();

  return RESOLVABLE_HOST_HINTS.some((hint) => host.includes(hint)) ? 0 : 1;
}

// Una serie larga son decenas de descargas seguidas: un fallo de red puntual no
// debe hacer que se pierda el capitulo, asi que se reintenta con espera creciente.
async function fetchPageHtml(url, attempt = 1) {
  try {
    return await fetchText(url, { Accept: HTML_ACCEPT });
  } catch (error) {
    if (attempt >= 3) {
      throw error;
    }

    await sleep(600 * attempt);
    return fetchPageHtml(url, attempt + 1);
  }
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];

    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function normalizePageUrl(url, baseUrl = PELISPLUS_BASE_URL) {
  const absolute = normalizeUrl(url, baseUrl);
  if (!absolute) {
    throw new Error(`URL invalida: ${url}`);
  }

  return absolute.replace(/\/+$/, '');
}

// Cada sitio tiene su propio HTML, asi que lo especifico de cada uno vive en un
// adaptador y el resto del importador (video, base de datos) es comun.
function resolveAdapter(url) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    hostname = String(url || '').toLowerCase();
  }

  return hostname.includes('cuevana') ? CUEVANA3_ADAPTER : PELISPLUS_ADAPTER;
}

function contentTypeFromUrl(pageUrl) {
  return resolveAdapter(pageUrl).contentTypeFromUrl(pageUrl);
}

function slugFromPageUrl(pageUrl) {
  const segments = new URL(pageUrl).pathname.split('/').filter(Boolean);
  return segments[1] || segments[0] || null;
}

function stripTags(value) {
  return cleanText(String(value || '').replace(/<[^>]*>/g, ' '));
}

// El h1 de la ficha repite el año, que ya se guarda en ReleaseYear.
function cleanTitleHeading(value) {
  return cleanText(String(value || '').replace(/\s*\((?:19|20)\d{2}\)\s*$/, ''));
}

// El h1 del capitulo ("Serie: Temporada 1, Capitulo 1 - Episode 3") siempre dice
// "Capitulo 1" aunque sea otro: el numero fiable es el de la URL. Del h1 solo se
// rescata el nombre del episodio, y se ignora si es el generico "Episode N".
function buildPelisplusEpisodeTitle(heading, episodeNumber) {
  const parts = cleanText(heading || '').split(' - ');
  const name = parts.length > 1 ? cleanText(parts.slice(1).join(' - ')) : '';

  if (!name || /^episode\s*\d+$/i.test(name)) {
    return `Capitulo ${episodeNumber}`;
  }

  return `Capitulo ${episodeNumber} - ${name}`;
}

function parsePelisplusGenres(html) {
  const marker = html.indexOf('<small class="d-block">Generos</small>');
  if (marker < 0) return [];

  // Los enlaces de genero del contenido viven en el bloque inmediatamente
  // anterior a su etiqueta; el menu lateral tambien apunta a /generos/.
  const block = html.slice(Math.max(0, marker - 2000), marker);
  const start = block.lastIndexOf('<div class="p-v-20 p-h-15 text-center">');
  const scope = start >= 0 ? block.slice(start) : block;

  return [...new Set(matchAll(scope, /href="\/generos\/[^"]*"[^>]*>([^<]+)<\/a>/g, (match) => cleanText(match[1])))].filter(
    Boolean
  );
}

function parsePelisplusMetadata(html, pageUrl) {
  const pageTitle = matchOne(html, /<title>([^<]+)<\/title>/i);
  const metaDescription = matchOne(html, /<meta name="description" content="([^"]*)"/i);
  const metaKeywords = matchOne(html, /<meta name="keywords" content="([^"]*)"/i);
  const heading = matchOne(html, /<h1[^>]*>([^<]*)<\/h1>/i);
  const originalTitle = matchOne(html, /<p class="text-opacity m-b-20 font-size-13">@\s*([^<]*)<\/p>/i);
  const synopsisRaw = matchOne(html, /<b>Sinopsis:<\/b>\s*<\/p>\s*<div class="text-large">([\s\S]*?)<\/div>/i);
  const posterPath = matchOne(html, /<img class="img-fluid d-block mx-auto m-b-30" src="([^"]+)"/i);
  const releaseDate = matchOne(html, /Fecha de estreno:<\/span>\s*([^<]*)<\/div>/i);
  const releaseYearText = releaseDate ? (releaseDate.match(/(\d{4})/) || [])[1] : null;
  const ratingText = matchOne(html, /ion-md-star">\s*([\d.]+)\/10/i);
  const rating = ratingText ? Number(ratingText) : null;

  return {
    pageTitle,
    metaDescription,
    metaKeywords,
    title: cleanTitleHeading(heading),
    rawHeading: heading,
    originalTitle: originalTitle || null,
    synopsis: synopsisRaw ? stripTags(synopsisRaw) : null,
    posterUrl: posterPath ? normalizeUrl(posterPath, pageUrl) : null,
    releaseYear: releaseYearText ? Number(releaseYearText) : null,
    rating: rating != null && !Number.isNaN(rating) ? rating : null,
    genres: parsePelisplusGenres(html),
    actors: [...new Set(matchAll(html, /href="\/actor\/[^"]*"[^>]*>([^<]+)<\/a>/g, (match) => cleanText(match[1])))]
  };
}

function parsePelisplusEpisodes(html, pageUrl) {
  const seen = new Set();

  return matchAll(
    html,
    /href="(\/serie\/[^"]+\/temporada\/(\d+)\/capitulo\/(\d+))"[^>]*>([^<]*)<\/a>/g,
    (match) => ({
      path: match[1],
      url: normalizeUrl(match[1], pageUrl),
      seasonNumber: Number(match[2]),
      episodeNumber: Number(match[3]),
      label: cleanText(match[4])
    })
  )
    .filter((item) => {
      if (!item.url || seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    })
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

// PelisPlusHD usa dos plantillas: las peliculas traen la URL en el propio <li>,
// y los capitulos de serie la guardan aparte en #link_url emparejada por lid.
function parsePelisplusPlayers(html) {
  const inlineOptions = matchAll(
    html,
    /<li role="presentation" data-url="([^"]+)" data-name="([^"]*)"[^>]*>\s*<a href="[^"]*">([^<]*)<\/a>/g,
    (match) => ({
      embedUrl: cleanText(match[1]),
      language: cleanText(match[2]) || null,
      server: cleanText(match[3]) || null
    })
  ).map((item, index) => ({ index, ...item }));

  if (inlineOptions.length) {
    return inlineOptions;
  }

  const linkedUrls = new Map(
    matchAll(html, /<span lid="(\d+)" url="([^"]+)"><\/span>/g, (match) => [match[1], cleanText(match[2])])
  );

  if (!linkedUrls.size) {
    return [];
  }

  const language = matchOne(html, /<a class="divseason"[^>]*>[\s\S]*?<img[^>]*>\s*([^<]+)<\/a>/i);
  const servers = new Map(
    matchAll(html, /<li role="presentation" data-id="(\d+)"[^>]*>\s*<a href="[^"]*">([^<]*)<\/a>/g, (match) => [
      match[1],
      cleanText(match[2])
    ])
  );

  return [...linkedUrls.entries()].map(([lid, embedUrl], index) => ({
    index,
    embedUrl,
    language: language || null,
    server: servers.get(lid) || `Opcion ${lid}`
  }));
}

function parsePelisplusNavigation(html, pageUrl) {
  const nextPath = matchOne(html, /<a href="([^"]+)" class="btn btn btn-primary btn-block">Capitulo Siguiente<\/a>/i);
  const seriesPath = matchOne(html, /<a href="([^"]+)" class="btn btn btn-primary btn-block">Todos los capitulos<\/a>/i);

  return {
    nextEpisodeUrl: nextPath ? normalizeUrl(nextPath, pageUrl) : null,
    seriesUrl: seriesPath ? normalizeUrl(seriesPath, pageUrl) : null
  };
}

// ---------------------------------------------------------------------------
// Cuevana3
// ---------------------------------------------------------------------------
// Estructura del sitio: las series viven en /serie/<slug>, sus capitulos en
// /episodio/<slug>-<temporada>x<capitulo>, y las peliculas en /<id>/<slug>.
// El HTML trae muchos atributos sin comillas, por eso los patrones aceptan las
// dos formas.
const CUEVANA_ATTR = '["\']?';

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'embed';
  }
}

function cuevanaContentTypeFromUrl(pageUrl) {
  const path = new URL(pageUrl).pathname;
  if (/^\/(?:serie|episodio)\//i.test(path)) return 'series';
  if (/^\/\d+\//.test(path)) return 'movie';
  return null;
}

function parseCuevanaMetadata(html, pageUrl) {
  const pageTitle = matchOne(html, /<title>([^<]+)<\/title>/i);
  const metaDescription = matchOne(html, /<meta name=["']?description["']? content="([^"]*)"/i);
  const metaKeywords = matchOne(html, /<meta name=["']?keywords["']? content="([^"]*)"/i);
  const heading = matchOne(html, /<h1[^>]*>([^<]*)<\/h1>/i);
  const subtitle = matchOne(html, /<h2 class=["']?SubTitle["']?>([^<]*)<\/h2>/i);
  const synopsis = matchOne(html, /<div class=["']?Description["']?>\s*<p>([\s\S]*?)<\/p>/i);
  const posterPath = matchOne(html, new RegExp(`data-src=${CUEVANA_ATTR}(/poster/[^"'\\s>]+)`, 'i'));
  const meta = matchOne(html, /<p class=["']?meta["']?>([\s\S]*?)<\/p>/i);
  // El rating sale del bloque meta; si la ficha no lo trae, queda el porcentaje
  // de votos que el sitio guarda en data-percent.
  const percent = matchOne(html, /id=["']?TPVotes["']?[^>]*data-percent=["']?(\d+)/i);
  const ratingText = (meta ? (meta.match(/([\d.]+)\s*\/\s*10/) || [])[1] : null) || (percent ? Number(percent) / 10 : null);
  // El año sale del bloque meta y, si no está, del <title> "Ver X (2016) Online".
  const yearText =
    (meta ? (meta.match(/\b((?:19|20)\d{2})\b/) || [])[1] : null) ||
    (pageTitle ? (pageTitle.match(/\(((?:19|20)\d{2})\)/) || [])[1] : null);
  const rating = ratingText ? Number(ratingText) : null;

  return {
    pageTitle,
    metaDescription,
    metaKeywords,
    title: cleanTitleHeading(heading),
    rawHeading: heading,
    // El subtítulo viene como "Civil: Titulo original".
    originalTitle: subtitle ? cleanText(subtitle.replace(/^[^:]*:\s*/, '')) || null : null,
    synopsis: synopsis ? stripTags(synopsis) : null,
    posterUrl: posterPath ? normalizeUrl(posterPath, pageUrl) : null,
    releaseYear: yearText ? Number(yearText) : null,
    rating: rating != null && !Number.isNaN(rating) ? rating : null,
    // El menu del sitio tambien enlaza a /category/, asi que los generos se
    // buscan solo dentro del renglon "Genero:" de la ficha.
    genres: (() => {
      const block = matchOne(html, /<strong>\s*Genero:\s*<\/strong>([\s\S]*?)<\/li>/i);
      if (!block) return [];
      return [
        ...new Set(
          matchAll(
            block,
            new RegExp(`href=${CUEVANA_ATTR}/category/[^"'\\s>]*${CUEVANA_ATTR}[^>]*>([^<]+)</a>`, 'g'),
            (match) => cleanText(match[1])
          )
        )
      ].filter(Boolean);
    })(),
    actors: [
      ...new Set(
        matchAll(
          html,
          new RegExp(`href=${CUEVANA_ATTR}/actor/[^"'\\s>]*${CUEVANA_ATTR}[^>]*>([^<]+)</a>`, 'g'),
          (match) => cleanText(match[1])
        )
      )
    ].filter(Boolean)
  };
}

// La ficha lista capitulos de otras series en las barras laterales, asi que solo
// se toman los que cuelgan del slug de esta y traen sufijo <temporada>x<capitulo>.
function parseCuevanaEpisodes(html, pageUrl) {
  const seriesSlug = new URL(pageUrl).pathname.split('/').filter(Boolean)[1] || '';
  const seen = new Set();

  return matchAll(
    html,
    new RegExp(`href=${CUEVANA_ATTR}(/episodio/([a-z0-9-]+)-(\\d+)x(\\d+))${CUEVANA_ATTR}[\\s>]`, 'gi'),
    (match) => ({
      path: match[1],
      slug: match[2],
      url: normalizeUrl(match[1], pageUrl),
      seasonNumber: Number(match[3]),
      episodeNumber: Number(match[4]),
      label: `${match[3]}x${match[4]}`
    })
  )
    .filter((item) => {
      if (!item.url || item.slug !== seriesSlug || seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    })
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

function parseCuevanaPlayers(html) {
  // Los nombres de servidor van en una lista aparte, emparejados por el id OptEN.
  const servers = new Map(
    matchAll(
      html,
      /<li id=["']?(Opt\w+)["']?[^>]*>[\s\S]{0,400}?<span class=["']?cdtr["']?><span>([^<]+)<\/span>/g,
      (match) => [match[1], cleanText(match[2])]
    )
  );

  return matchAll(
    html,
    /<div class=["']?TPlayerTb["']?[^>]*id=["']?(\w+)["']?[^>]*>\s*<iframe[^>]*data-src="([^"]+)"/g,
    (match) => ({
      optionId: match[1],
      embedUrl: cleanText(match[2]),
      server: servers.get(match[1]) || null
    })
  )
    .filter((item) => item.embedUrl)
    .map((item, index) => ({
      index,
      embedUrl: item.embedUrl,
      language: null,
      // El texto del servidor viene como "5 - streamwish - HD".
      server: item.server
        ? cleanText(item.server.replace(/^\d+\s*-\s*/, '').replace(/\s*-\s*HD$/i, ''))
        : hostLabel(item.embedUrl)
    }));
}

function parseCuevanaNavigation(html, pageUrl) {
  const nextPath = matchOne(
    html,
    new RegExp(`href=${CUEVANA_ATTR}(/episodio/[^"'\\s>]+)${CUEVANA_ATTR}[^>]*class="[^"]*\\bnext\\b`, 'i')
  );
  const seriesPath = matchOne(
    html,
    new RegExp(`href=${CUEVANA_ATTR}(/serie/[^"'\\s>]+)${CUEVANA_ATTR}[^>]*class="[^"]*\\blist\\b`, 'i')
  );

  return {
    nextEpisodeUrl: nextPath ? normalizeUrl(nextPath, pageUrl) : null,
    seriesUrl: seriesPath ? normalizeUrl(seriesPath, pageUrl) : null
  };
}

function parseCuevanaSearchResults(html, baseUrl) {
  return matchAll(
    html,
    new RegExp(
      `<a href=${CUEVANA_ATTR}(/(?:serie/[^"'\\s>]+|\\d+/[^"'\\s>]+))${CUEVANA_ATTR}[\\s>][\\s\\S]{0,900}?<h2 class="Title">([^<]*)</h2>`,
      'g'
    ),
    (match) => ({
      path: match[1],
      url: normalizeUrl(match[1], baseUrl),
      title: cleanText(match[2]),
      contentType: match[1].startsWith('/serie/') ? 'series' : 'movie'
    })
  );
}

const PELISPLUS_ADAPTER = {
  id: 'pelisplushd',
  sourceSite: 'PelisPlusHD',
  contentTypeFromUrl: (pageUrl) => {
    if (/\/serie\//i.test(pageUrl)) return 'series';
    if (/\/pelicula\//i.test(pageUrl)) return 'movie';
    return null;
  },
  buildTitleUrl: (baseUrl, contentType, slug) =>
    normalizeUrl(`${contentType === 'movie' ? 'pelicula' : 'serie'}/${slug}`, baseUrl),
  searchUrl: (baseUrl, title) => normalizeUrl(`search?s=${encodeURIComponent(title)}`, baseUrl),
  parseSearchResults: (html, baseUrl) =>
    matchAll(
      html,
      /<a href="(\/(?:serie|pelicula)\/[^"]+)" class="Posters-link"[\s\S]*?<div class="listing-content">\s*<p>([\s\S]*?)<\/p>/g,
      (match) => ({
        path: match[1],
        url: normalizeUrl(match[1], baseUrl),
        title: cleanText(match[2]),
        contentType: match[1].startsWith('/serie/') ? 'series' : 'movie'
      })
    ),
  parseTitleMetadata: parsePelisplusMetadata,
  parseSeasonEpisodes: parsePelisplusEpisodes,
  parsePlayerOptions: parsePelisplusPlayers,
  parseEpisodeNavigation: parsePelisplusNavigation,
  buildEpisodeTitle: (meta, episode) => buildPelisplusEpisodeTitle(meta.rawHeading, episode.episodeNumber)
};

const CUEVANA3_ADAPTER = {
  id: 'cuevana3',
  sourceSite: 'Cuevana3',
  contentTypeFromUrl: cuevanaContentTypeFromUrl,
  // Las peliculas llevan un id numerico que no se puede adivinar desde el
  // nombre, asi que solo las series se pueden armar por concatenacion.
  buildTitleUrl: (baseUrl, contentType, slug) =>
    contentType === 'movie' ? null : normalizeUrl(`serie/${slug}`, baseUrl),
  searchUrl: (baseUrl, title) => normalizeUrl(`?s=${encodeURIComponent(title)}`, baseUrl),
  parseSearchResults: parseCuevanaSearchResults,
  parseTitleMetadata: parseCuevanaMetadata,
  parseSeasonEpisodes: parseCuevanaEpisodes,
  parsePlayerOptions: parseCuevanaPlayers,
  parseEpisodeNavigation: parseCuevanaNavigation,
  buildEpisodeTitle: (_meta, episode) => `Capitulo ${episode.episodeNumber}`
};

// Palabras que no aportan a la identidad del titulo y estorban al comparar.
const MATCH_STOPWORDS = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'y', 'the', 'a', 'an', 'of', 'and']);

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulWords(value) {
  const words = normalizeForMatch(value)
    .split(' ')
    .filter((word) => word && !MATCH_STOPWORDS.has(word));

  // Los buscadores devuelven el año pegado al titulo ("Chernobyl (2019)"), y
  // contarlo como una palabra mas hundia el parecido de un titulo idéntico.
  // Se conserva si es lo unico que hay, que es el caso de peliculas como "1917".
  const withoutYear = words.filter((word) => !/^(?:19|20)\d{2}$/.test(word));
  return withoutYear.length ? withoutYear : words;
}

// Coeficiente de Dice sobre bigramas: tolera erratas y letras de mas o de menos
// ("interestellar" contra "interestelar").
function diceSimilarity(a, b) {
  const bigrams = (text) => {
    const clean = normalizeForMatch(text).replace(/\s+/g, '');
    const result = [];
    for (let i = 0; i < clean.length - 1; i += 1) result.push(clean.slice(i, i + 2));
    return result;
  };

  const first = bigrams(a);
  const second = bigrams(b);
  if (!first.length || !second.length) return 0;

  const pool = new Map();
  for (const gram of first) pool.set(gram, (pool.get(gram) || 0) + 1);

  let hits = 0;
  for (const gram of second) {
    const left = pool.get(gram) || 0;
    if (left > 0) {
      pool.set(gram, left - 1);
      hits += 1;
    }
  }

  return (2 * hits) / (first.length + second.length);
}

// Puntua que tan bien un resultado corresponde a lo que se pidio. Se combina la
// similitud del texto con cuantas palabras del titulo buscado aparecen, que es
// lo que salva casos como "stranger things" contra "Stranger Things: Relatos del 85".
function scoreCandidate(query, candidate) {
  const queryWords = meaningfulWords(query);
  const candidateWords = meaningfulWords(candidate.title);
  const candidateSet = new Set(candidateWords);
  const slugSet = new Set(meaningfulWords(lastPathSegment(candidate.path).replace(/-/g, ' ')));
  const querySet = new Set(queryWords);

  // Dos palabras cuentan como la misma si se parecen bastante, para que un
  // singular por plural o una errata ("thing" por "things", "interestellar" por
  // "interestelar") no rompan la comparacion.
  const matchesAny = (word, pool) => {
    if (pool.has(word)) return true;
    for (const other of pool) {
      if (Math.abs(other.length - word.length) <= 3 && diceSimilarity(word, other) >= 0.8) return true;
    }
    return false;
  };

  // Se miden las dos direcciones: cuanto del titulo buscado aparece en el
  // candidato, y cuanto del candidato sobra. Sin la segunda, "Pulp Fiction"
  // encajaria perfecto con "Stealing Pulp Fiction".
  const covered = queryWords.filter((word) => matchesAny(word, candidateSet) || matchesAny(word, slugSet)).length;
  const back = candidateWords.filter((word) => matchesAny(word, querySet)).length;
  const forward = queryWords.length ? covered / queryWords.length : 0;
  const backward = candidateWords.length ? back / candidateWords.length : 0;
  let overlap = forward + backward ? (2 * forward * backward) / (forward + backward) : 0;

  // Comparar palabra por palabra falla cuando una va partida en dos ("show man"
  // contra "Showman"): ahi se mide todo junto, sin espacios.
  const glued = diceSimilarity(queryWords.join(''), candidateWords.join(''));
  overlap = Math.max(overlap, glued >= 0.9 ? glued : 0);

  const textual = Math.max(
    diceSimilarity(query, candidate.title),
    diceSimilarity(query, lastPathSegment(candidate.path).replace(/-/g, ' '))
  );

  return overlap * 0.6 + textual * 0.4;
}

// Por debajo de esto ni se considera; entre ambos es "parecido pero no seguro" y
// hay que confirmarlo, porque es donde se cuelan los titulos equivocados.
const MIN_MATCH_SCORE = 0.55;
const STRONG_MATCH_SCORE = 0.9;

function isStrongMatch(match) {
  return Boolean(match) && match.score >= STRONG_MATCH_SCORE;
}

// Busca un titulo en el sitio que corresponda a baseUrl y devuelve la mejor
// coincidencia del tipo pedido, o null si ninguna se parece lo suficiente.
async function searchTitle({ baseUrl, contentType, title, minScore = MIN_MATCH_SCORE }) {
  const adapter = resolveAdapter(baseUrl);
  const words = meaningfulWords(title);
  // Si el nombre completo no da resultados se reintenta con menos palabras: los
  // buscadores de estos sitios fallan ante subtitulos o años sobrantes. El
  // ultimo intento es un prefijo, que es lo unico que salva una errata dentro
  // de la palabra ("interestellar" no da nada, pero "interes" si).
  const longest = [...words].sort((a, b) => b.length - a.length)[0] || '';
  const queries = [title];
  if (words.length > 2) queries.push(words.slice(0, 2).join(' '));
  if (words.length > 1) queries.push(words[0]);
  if (longest.length > 6) queries.push(longest.slice(0, 6));

  const seen = new Set();
  const scored = [];

  for (const query of queries) {
    let html;
    try {
      html = await fetchPageHtml(adapter.searchUrl(baseUrl, query));
    } catch {
      continue;
    }

    for (const candidate of adapter.parseSearchResults(html, baseUrl)) {
      if (candidate.contentType !== contentType || seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      scored.push({ ...candidate, score: scoreCandidate(title, candidate) });
    }

    const best = scored.sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= STRONG_MATCH_SCORE) return best;
  }

  const best = scored.sort((a, b) => b.score - a.score)[0];
  return best && best.score >= minScore ? best : null;
}

// Recorre los sitios hasta dar con el titulo. Devuelve tambien de que sitio
// salio, porque de ahi se resuelve el adaptador con el que se va a importar.
// Una coincidencia floja no corta la busqueda: puede que el siguiente sitio
// tenga el titulo exacto, y se prefiere ese.
async function searchTitleAcrossSites({ contentType, title, baseUrls }) {
  const attempts = [];
  let bestSoFar = null;

  for (const baseUrl of baseUrls) {
    try {
      const match = await searchTitle({ baseUrl, contentType, title });

      if (isStrongMatch(match)) {
        return { ...match, baseUrl, strong: true, attempts };
      }

      if (match) {
        attempts.push({ baseUrl, reason: `solo un parecido: "${match.title}" (${match.score.toFixed(2)})` });
        if (!bestSoFar || match.score > bestSoFar.score) {
          bestSoFar = { ...match, baseUrl, strong: false };
        }
      } else {
        attempts.push({ baseUrl, reason: 'sin coincidencias' });
      }
    } catch (error) {
      attempts.push({ baseUrl, reason: error.message || String(error) });
    }
  }

  if (bestSoFar) {
    return { ...bestSoFar, attempts };
  }

  return { attempts };
}

function lastPathSegment(path) {
  return String(path || '').split('/').filter(Boolean).pop() || '';
}

function slugifyTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// URL armada concatenando el tipo con el nombre escrito; null si el sitio no
// permite adivinarla (Cuevana3 usa un id numerico en las peliculas).
function buildTitleUrl({ baseUrl, contentType, title }) {
  const adapter = resolveAdapter(baseUrl);
  const slug = slugifyTitle(title);
  if (!slug) return null;
  return adapter.buildTitleUrl(baseUrl, contentType, slug);
}

// Los reproductores de la familia streamwish (filelions, vidhidepro, streamwish,
// vidhide...) entregan el jwplayer dentro de un eval(function(p,a,c,k,e,d)).
// Deshacer ese empaquetado es lo que deja a la vista la URL del m3u8.
function unpackPackedScript(source) {
  const match = source.match(
    /eval\(function\(p,a,c,k,e,[dr]\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/s
  );

  if (!match) {
    return null;
  }

  const payload = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const radix = Number(match[2]);
  const count = Number(match[3]);
  const dictionary = match[4].split('|');

  const encode = (value) =>
    (value < radix ? '' : encode(Math.floor(value / radix))) +
    ((value = value % radix) > 35 ? String.fromCharCode(value + 29) : value.toString(36));

  let unpacked = payload;
  for (let i = count - 1; i >= 0; i -= 1) {
    if (dictionary[i]) {
      unpacked = unpacked.replace(new RegExp(`\\b${encode(i)}\\b`, 'g'), dictionary[i]);
    }
  }

  return unpacked;
}

// El player hace sources:[{file: links.hls4||links.hls3||links.hls2}], asi que se
// respeta ese mismo orden: el primero es el del propio host y es el que responde.
function extractPlayerMediaUrls(html, pageUrl) {
  const unpacked = unpackPackedScript(html);
  const urls = [];

  if (unpacked) {
    const linksBlock = unpacked.match(/var\s+links\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (linksBlock) {
      try {
        const links = JSON.parse(linksBlock[1]);
        for (const key of ['hls4', 'hls3', 'hls2', 'hls', 'mp4']) {
          if (links[key]) urls.push(links[key]);
        }
      } catch {
        // Si el objeto no es JSON valido se cae a los patrones de abajo.
      }
    }

    urls.push(...matchAll(unpacked, /(?:file|src)\s*:\s*"([^"]+)"/g, (match) => match[1]));
    urls.push(...extractMediaUrlsFromHtml(unpacked, pageUrl));
  }

  urls.push(...extractMediaUrlsFromHtml(html, pageUrl));

  const seen = new Set();
  return urls
    .map((url) => normalizeUrl(url, pageUrl))
    .filter((url) => {
      if (!url || !/\.(m3u8|mp4|webm|mov)(?:$|\?)/i.test(url) || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

// Un host caido tarda lo que dure el timeout, y los mismos servidores se repiten
// en todos los capitulos: si uno falla se anota para no reintentarlo en esta
// corrida (42 capitulos x 20 s por servidor muerto es media hora perdida).
const unreachableHosts = new Set();

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// Mismo criterio que el importador de anime: se prefiere un archivo de video
// verificado; si ningun embed lo expone, el episodio se guarda como iframe.
async function resolveVerifiedVideo(playerOptions, pageUrl) {
  const attempted = [];
  const seen = new Set();

  for (const option of playerOptions) {
    const normalized = normalizeUrl(option.embedUrl, pageUrl);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    attempted.push({ url: normalized, source: option.server || 'embed', kind: 'provider-embed' });
  }

  attempted.sort((a, b) => resolvePriority(a.url) - resolvePriority(b.url));

  let deepResolveBudget = MAX_DEEP_RESOLVE_CANDIDATES;

  for (const candidate of attempted) {
    if (unreachableHosts.has(hostOf(candidate.url))) {
      continue;
    }

    if (looksLikeVideoFile(candidate.url)) {
      const verified = await probeVideoUrl(candidate.url, { Referer: pageUrl });
      if (verified) {
        return {
          videoSrcUrl: candidate.url,
          videoSrcSource: candidate.source,
          videoSrcReferer: pageUrl,
          verifiedVideoUrl: verified.url,
          verifiedVideoSource: candidate.source,
          verifiedVideoKind: candidate.kind,
          verifiedVideoContentType: verified.contentType,
          verifiedVideoStatusCode: verified.statusCode,
          verifiedVideoReferer: null,
          verificationAttempts: attempted
        };
      }
    }

    if (deepResolveBudget <= 0) {
      continue;
    }

    deepResolveBudget -= 1;

    try {
      const html = await fetchText(candidate.url, { Accept: HTML_ACCEPT, Referer: pageUrl });
      const extractedMediaUrls = extractPlayerMediaUrls(html, candidate.url);

      for (const extractedMediaUrl of extractedMediaUrls) {
        const verified = await probeVideoUrl(extractedMediaUrl, { Referer: candidate.url });
        if (verified) {
          return {
            videoSrcUrl: extractedMediaUrl,
            videoSrcSource: candidate.source,
            videoSrcReferer: candidate.url,
            verifiedVideoUrl: verified.url,
            verifiedVideoSource: candidate.source,
            verifiedVideoKind: `${candidate.kind}-extracted`,
            verifiedVideoContentType: verified.contentType,
            verifiedVideoStatusCode: verified.statusCode,
            verifiedVideoReferer: candidate.url,
            verificationAttempts: attempted
          };
        }
      }
    } catch (error) {
      // Si el host ni siquiera respondio, no vale la pena volver a esperarlo en
      // los capitulos siguientes.
      if (/tiempo de espera|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(error.message || '')) {
        unreachableHosts.add(hostOf(candidate.url));
      }
      continue;
    }
  }

  return {
    videoSrcUrl: NO_VIDEO_FOUND,
    videoSrcSource: 'NO_VIDEO_FOUND',
    videoSrcReferer: null,
    verifiedVideoUrl: NO_VIDEO_FOUND,
    verifiedVideoSource: 'NO_VIDEO_FOUND',
    verifiedVideoKind: 'not-found',
    verifiedVideoContentType: null,
    verifiedVideoStatusCode: null,
    verifiedVideoReferer: null,
    verificationAttempts: attempted
  };
}

// Un embed solo sirve si su servidor sigue en pie. Guardar el primero sin
// comprobarlo es lo que metia en el catalogo capitulos que no reproducen nada,
// asi que se prueba uno por uno y si ninguno responde el capitulo no se guarda.
async function embedResponds(embedUrl, pageUrl) {
  const host = hostOf(embedUrl);
  if (unreachableHosts.has(host)) return false;

  try {
    const response = await requestUrl('GET', embedUrl, { Accept: HTML_ACCEPT, Referer: pageUrl });
    return response.statusCode < 400;
  } catch (error) {
    if (/tiempo de espera|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(error.message || '')) {
      unreachableHosts.add(host);
    }
    return false;
  }
}

async function pickPlayback(playerOptions, verification, pageUrl) {
  const hasVerified = verification.verifiedVideoUrl && verification.verifiedVideoUrl !== NO_VIDEO_FOUND;

  if (hasVerified) {
    return {
      videoUrl: verification.verifiedVideoUrl,
      provider: /mpegurl/i.test(verification.verifiedVideoContentType || '') ? 'hls' : 'file',
      source: verification.verifiedVideoSource
    };
  }

  for (const option of playerOptions) {
    if (!option.embedUrl) continue;
    if (await embedResponds(option.embedUrl, pageUrl)) {
      return {
        videoUrl: option.embedUrl,
        provider: 'embed',
        source: option.server || 'embed'
      };
    }
  }

  return null;
}

async function ensureSnapshotTable(pool) {
  await pool.request().query(`
    IF OBJECT_ID('dbo.PelisPlusSnapshots', 'U') IS NULL
    CREATE TABLE dbo.PelisPlusSnapshots (
      Id INT IDENTITY(1,1) PRIMARY KEY,
      SourceSite NVARCHAR(100) NOT NULL,
      SourceType NVARCHAR(100) NOT NULL,
      ContentType NVARCHAR(20) NOT NULL,
      SeriesName NVARCHAR(255) NOT NULL,
      SeriesSlug NVARCHAR(255) NULL,
      SeriesUrl NVARCHAR(1000) NULL,
      OriginalTitle NVARCHAR(500) NULL,
      SeriesSynopsis NVARCHAR(MAX) NULL,
      SeasonNumber INT NULL,
      EpisodeNumber INT NULL,
      EpisodeTitle NVARCHAR(500) NULL,
      EpisodePageUrl NVARCHAR(1000) NOT NULL,
      PrimaryVideoUrl NVARCHAR(1000) NULL,
      PrimaryVideoSource NVARCHAR(255) NULL,
      VideoSrcUrl NVARCHAR(2000) NULL,
      VideoSrcSource NVARCHAR(255) NULL,
      VideoSrcReferer NVARCHAR(1000) NULL,
      VerifiedVideoUrl NVARCHAR(1000) NULL,
      VerifiedVideoSource NVARCHAR(255) NULL,
      VerifiedVideoKind NVARCHAR(100) NULL,
      VerifiedVideoContentType NVARCHAR(255) NULL,
      VerifiedVideoStatusCode INT NULL,
      VerifiedVideoReferer NVARCHAR(1000) NULL,
      SavedProvider NVARCHAR(20) NULL,
      PageTitle NVARCHAR(500) NULL,
      MetaDescription NVARCHAR(MAX) NULL,
      MetaKeywords NVARCHAR(MAX) NULL,
      PosterUrl NVARCHAR(1000) NULL,
      ReleaseYear INT NULL,
      Rating DECIMAL(3,1) NULL,
      NextEpisodeUrl NVARCHAR(1000) NULL,
      GenresJson NVARCHAR(MAX) NULL,
      ActorsJson NVARCHAR(MAX) NULL,
      PlayerOptionsJson NVARCHAR(MAX) NULL,
      VerificationAttemptsJson NVARCHAR(MAX) NULL,
      CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      CONSTRAINT UQ_PelisPlusSnapshots_EpisodePageUrl UNIQUE (EpisodePageUrl)
    );
  `);
}

async function ensureGenres(pool, names) {
  const ids = {};

  for (const name of names) {
    const existing = await pool.request().input('name', name).query(`
      SELECT TOP 1 Id FROM dbo.Genres WHERE Name = @name
    `);

    if (existing.recordset.length) {
      ids[name] = existing.recordset[0].Id;
      continue;
    }

    const inserted = await pool.request().input('name', name).query(`
      INSERT INTO dbo.Genres (Name) OUTPUT INSERTED.Id VALUES (@name)
    `);
    ids[name] = inserted.recordset[0].Id;
  }

  return ids;
}

async function linkSeriesGenres(pool, seriesId, genreIds) {
  for (const genreId of Object.values(genreIds)) {
    await pool
      .request()
      .input('seriesId', seriesId)
      .input('genreId', genreId)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.SeriesGenres WHERE SeriesId = @seriesId AND GenreId = @genreId)
          INSERT INTO dbo.SeriesGenres (SeriesId, GenreId) VALUES (@seriesId, @genreId);
      `);
  }
}

async function ensureSeries(pool, titleData) {
  const sourceRef = `pelisplushd:${titleData.slug}`;
  const existing = await pool
    .request()
    .input('sourceRef', sourceRef)
    .input('title', titleData.title)
    .input('contentType', titleData.contentType)
    .query(`
      SELECT TOP 1 Id
      FROM dbo.Series
      WHERE SourceRef = @sourceRef OR (Title = @title AND ContentType = @contentType)
      ORDER BY Id ASC
    `);

  if (existing.recordset.length) {
    const seriesId = existing.recordset[0].Id;

    await pool
      .request()
      .input('id', seriesId)
      .input('title', titleData.title)
      .input('description', titleData.synopsis)
      .input('posterUrl', titleData.posterUrl)
      .input('backdropUrl', titleData.posterUrl)
      .input('releaseYear', titleData.releaseYear)
      .input('rating', titleData.rating)
      .input('contentType', titleData.contentType)
      .input('sourceRef', sourceRef)
      .query(`
        UPDATE dbo.Series
        SET
          Title = @title,
          Description = @description,
          PosterUrl = @posterUrl,
          BackdropUrl = @backdropUrl,
          ReleaseYear = @releaseYear,
          Rating = @rating,
          ContentType = @contentType,
          SourceRef = @sourceRef
        WHERE Id = @id
      `);

    return seriesId;
  }

  const inserted = await pool
    .request()
    .input('title', titleData.title)
    .input('description', titleData.synopsis)
    .input('posterUrl', titleData.posterUrl)
    .input('backdropUrl', titleData.posterUrl)
    .input('releaseYear', titleData.releaseYear)
    .input('rating', titleData.rating)
    .input('contentType', titleData.contentType)
    .input('sourceRef', sourceRef)
    .query(`
      INSERT INTO dbo.Series (
        Title,
        Description,
        PosterUrl,
        BackdropUrl,
        ReleaseYear,
        Rating,
        ContentType,
        SourceRef
      )
      OUTPUT INSERTED.Id
      VALUES (
        @title,
        @description,
        @posterUrl,
        @backdropUrl,
        @releaseYear,
        @rating,
        @contentType,
        @sourceRef
      )
    `);

  return inserted.recordset[0].Id;
}

async function ensureSeason(pool, seriesId, seasonNumber, seasonTitle) {
  const existing = await pool
    .request()
    .input('seriesId', seriesId)
    .input('seasonNumber', seasonNumber)
    .query(`
      SELECT TOP 1 Id
      FROM dbo.Seasons
      WHERE SeriesId = @seriesId AND SeasonNumber = @seasonNumber
    `);

  if (existing.recordset.length) {
    const seasonId = existing.recordset[0].Id;
    await pool
      .request()
      .input('id', seasonId)
      .input('title', seasonTitle)
      .query(`
        UPDATE dbo.Seasons
        SET Title = @title
        WHERE Id = @id
      `);
    return seasonId;
  }

  const inserted = await pool
    .request()
    .input('seriesId', seriesId)
    .input('seasonNumber', seasonNumber)
    .input('title', seasonTitle)
    .query(`
      INSERT INTO dbo.Seasons (SeriesId, SeasonNumber, Title)
      OUTPUT INSERTED.Id
      VALUES (@seriesId, @seasonNumber, @title)
    `);

  return inserted.recordset[0].Id;
}

async function ensureEpisode(pool, seasonId, episodeData) {
  const existing = await pool
    .request()
    .input('seasonId', seasonId)
    .input('episodeNumber', episodeData.episodeNumber)
    .query(`
      SELECT TOP 1 Id
      FROM dbo.Episodes
      WHERE SeasonId = @seasonId AND EpisodeNumber = @episodeNumber
    `);

  if (existing.recordset.length) {
    const episodeId = existing.recordset[0].Id;
    await pool
      .request()
      .input('id', episodeId)
      .input('title', episodeData.title)
      .input('description', episodeData.description)
      .input('videoUrl', episodeData.videoUrl)
      .input('provider', episodeData.provider)
      .input('thumbnailUrl', episodeData.thumbnailUrl)
      .input('durationSec', episodeData.durationSec ?? null)
      .query(`
        UPDATE dbo.Episodes
        SET
          Title = @title,
          Description = @description,
          VideoUrl = @videoUrl,
          Provider = @provider,
          ThumbnailUrl = @thumbnailUrl,
          DurationSec = @durationSec
        WHERE Id = @id
      `);
    return episodeId;
  }

  const inserted = await pool
    .request()
    .input('seasonId', seasonId)
    .input('episodeNumber', episodeData.episodeNumber)
    .input('title', episodeData.title)
    .input('description', episodeData.description)
    .input('videoUrl', episodeData.videoUrl)
    .input('provider', episodeData.provider)
    .input('thumbnailUrl', episodeData.thumbnailUrl)
    .input('durationSec', episodeData.durationSec ?? null)
    .query(`
      INSERT INTO dbo.Episodes (
        SeasonId,
        EpisodeNumber,
        Title,
        Description,
        VideoUrl,
        Provider,
        ThumbnailUrl,
        DurationSec
      )
      OUTPUT INSERTED.Id
      VALUES (
        @seasonId,
        @episodeNumber,
        @title,
        @description,
        @videoUrl,
        @provider,
        @thumbnailUrl,
        @durationSec
      )
    `);

  return inserted.recordset[0].Id;
}

async function upsertSnapshot(pool, snapshot) {
  const existing = await pool
    .request()
    .input('episodePageUrl', snapshot.episodePageUrl)
    .query(`
      SELECT TOP 1 Id
      FROM dbo.PelisPlusSnapshots
      WHERE EpisodePageUrl = @episodePageUrl
    `);

  const bind = (request) =>
    request
      .input('sourceSite', snapshot.sourceSite || SOURCE_SITE)
      .input('sourceType', snapshot.sourceType)
      .input('contentType', snapshot.contentType)
      .input('seriesName', snapshot.seriesName)
      .input('seriesSlug', snapshot.seriesSlug)
      .input('seriesUrl', snapshot.seriesUrl)
      .input('originalTitle', snapshot.originalTitle)
      .input('seriesSynopsis', snapshot.seriesSynopsis)
      .input('seasonNumber', snapshot.seasonNumber)
      .input('episodeNumber', snapshot.episodeNumber)
      .input('episodeTitle', snapshot.episodeTitle)
      .input('episodePageUrl', snapshot.episodePageUrl)
      .input('primaryVideoUrl', snapshot.primaryVideoUrl)
      .input('primaryVideoSource', snapshot.primaryVideoSource)
      .input('videoSrcUrl', snapshot.videoSrcUrl)
      .input('videoSrcSource', snapshot.videoSrcSource)
      .input('videoSrcReferer', snapshot.videoSrcReferer)
      .input('verifiedVideoUrl', snapshot.verifiedVideoUrl)
      .input('verifiedVideoSource', snapshot.verifiedVideoSource)
      .input('verifiedVideoKind', snapshot.verifiedVideoKind)
      .input('verifiedVideoContentType', snapshot.verifiedVideoContentType)
      .input('verifiedVideoStatusCode', snapshot.verifiedVideoStatusCode)
      .input('verifiedVideoReferer', snapshot.verifiedVideoReferer)
      .input('savedProvider', snapshot.savedProvider)
      .input('pageTitle', snapshot.pageTitle)
      .input('metaDescription', snapshot.metaDescription)
      .input('metaKeywords', snapshot.metaKeywords)
      .input('posterUrl', snapshot.posterUrl)
      .input('releaseYear', snapshot.releaseYear)
      .input('rating', snapshot.rating)
      .input('nextEpisodeUrl', snapshot.nextEpisodeUrl)
      .input('genresJson', JSON.stringify(snapshot.genres || []))
      .input('actorsJson', JSON.stringify(snapshot.actors || []))
      .input('playerOptionsJson', JSON.stringify(snapshot.playerOptions || []))
      .input('verificationAttemptsJson', JSON.stringify(snapshot.verificationAttempts || []));

  if (existing.recordset.length) {
    const snapshotId = existing.recordset[0].Id;
    await bind(pool.request().input('id', snapshotId)).query(`
      UPDATE dbo.PelisPlusSnapshots
      SET
        SourceSite = @sourceSite,
        SourceType = @sourceType,
        ContentType = @contentType,
        SeriesName = @seriesName,
        SeriesSlug = @seriesSlug,
        SeriesUrl = @seriesUrl,
        OriginalTitle = @originalTitle,
        SeriesSynopsis = @seriesSynopsis,
        SeasonNumber = @seasonNumber,
        EpisodeNumber = @episodeNumber,
        EpisodeTitle = @episodeTitle,
        PrimaryVideoUrl = @primaryVideoUrl,
        PrimaryVideoSource = @primaryVideoSource,
        VideoSrcUrl = @videoSrcUrl,
        VideoSrcSource = @videoSrcSource,
        VideoSrcReferer = @videoSrcReferer,
        VerifiedVideoUrl = @verifiedVideoUrl,
        VerifiedVideoSource = @verifiedVideoSource,
        VerifiedVideoKind = @verifiedVideoKind,
        VerifiedVideoContentType = @verifiedVideoContentType,
        VerifiedVideoStatusCode = @verifiedVideoStatusCode,
        VerifiedVideoReferer = @verifiedVideoReferer,
        SavedProvider = @savedProvider,
        PageTitle = @pageTitle,
        MetaDescription = @metaDescription,
        MetaKeywords = @metaKeywords,
        PosterUrl = @posterUrl,
        ReleaseYear = @releaseYear,
        Rating = @rating,
        NextEpisodeUrl = @nextEpisodeUrl,
        GenresJson = @genresJson,
        ActorsJson = @actorsJson,
        PlayerOptionsJson = @playerOptionsJson,
        VerificationAttemptsJson = @verificationAttemptsJson,
        UpdatedAt = SYSUTCDATETIME()
      WHERE Id = @id
    `);

    return snapshotId;
  }

  const inserted = await bind(pool.request()).query(`
    INSERT INTO dbo.PelisPlusSnapshots (
      SourceSite,
      SourceType,
      ContentType,
      SeriesName,
      SeriesSlug,
      SeriesUrl,
      OriginalTitle,
      SeriesSynopsis,
      SeasonNumber,
      EpisodeNumber,
      EpisodeTitle,
      EpisodePageUrl,
      PrimaryVideoUrl,
      PrimaryVideoSource,
      VideoSrcUrl,
      VideoSrcSource,
      VideoSrcReferer,
      VerifiedVideoUrl,
      VerifiedVideoSource,
      VerifiedVideoKind,
      VerifiedVideoContentType,
      VerifiedVideoStatusCode,
      VerifiedVideoReferer,
      SavedProvider,
      PageTitle,
      MetaDescription,
      MetaKeywords,
      PosterUrl,
      ReleaseYear,
      Rating,
      NextEpisodeUrl,
      GenresJson,
      ActorsJson,
      PlayerOptionsJson,
      VerificationAttemptsJson
    )
    OUTPUT INSERTED.Id
    VALUES (
      @sourceSite,
      @sourceType,
      @contentType,
      @seriesName,
      @seriesSlug,
      @seriesUrl,
      @originalTitle,
      @seriesSynopsis,
      @seasonNumber,
      @episodeNumber,
      @episodeTitle,
      @episodePageUrl,
      @primaryVideoUrl,
      @primaryVideoSource,
      @videoSrcUrl,
      @videoSrcSource,
      @videoSrcReferer,
      @verifiedVideoUrl,
      @verifiedVideoSource,
      @verifiedVideoKind,
      @verifiedVideoContentType,
      @verifiedVideoStatusCode,
      @verifiedVideoReferer,
      @savedProvider,
      @pageTitle,
      @metaDescription,
      @metaKeywords,
      @posterUrl,
      @releaseYear,
      @rating,
      @nextEpisodeUrl,
      @genresJson,
      @actorsJson,
      @playerOptionsJson,
      @verificationAttemptsJson
    )
  `);

  return inserted.recordset[0].Id;
}

function selectEpisodes(episodes, options) {
  const season = options.season != null ? Number(options.season) : null;
  const start = options.start != null ? Number(options.start) : null;
  const end = options.end != null ? Number(options.end) : null;

  return episodes.filter((item) => {
    if (season != null && item.seasonNumber !== season) return false;
    if (start != null && item.episodeNumber < start) return false;
    if (end != null && item.episodeNumber > end) return false;
    return true;
  });
}

async function importMovie(pool, context, options) {
  const { titleData, html, pageUrl, adapter } = context;
  const playerOptions = adapter.parsePlayerOptions(html);
  const verification = await resolveVerifiedVideo(playerOptions, pageUrl);
  const playback = await pickPlayback(playerOptions, verification, pageUrl);

  if (!playback) {
    throw new Error(`La pelicula "${titleData.title}" no expone ningun reproductor en ${adapter.sourceSite}.`);
  }

  const seriesId = await ensureSeries(pool, titleData);
  if (titleData.genres.length) {
    await linkSeriesGenres(pool, seriesId, await ensureGenres(pool, titleData.genres));
  }

  // La pelicula se guarda como temporada/episodio tecnico, que es como
  // StreamFlix modela las peliculas para reutilizar el reproductor.
  const seasonId = await ensureSeason(pool, seriesId, 1, 'Pelicula');
  const episodeId = await ensureEpisode(pool, seasonId, {
    episodeNumber: 1,
    title: titleData.title,
    description: titleData.synopsis || titleData.metaDescription,
    videoUrl: playback.videoUrl,
    provider: playback.provider,
    thumbnailUrl: titleData.posterUrl,
    durationSec: null
  });

  const snapshotId = await upsertSnapshot(pool, {
    sourceSite: adapter.sourceSite,
    sourceType: 'movie-page',
    contentType: titleData.contentType,
    seriesName: titleData.title,
    seriesSlug: titleData.slug,
    seriesUrl: pageUrl,
    originalTitle: titleData.originalTitle,
    seriesSynopsis: titleData.synopsis,
    seasonNumber: 1,
    episodeNumber: 1,
    episodeTitle: titleData.title,
    episodePageUrl: pageUrl,
    primaryVideoUrl: playerOptions[0]?.embedUrl || null,
    primaryVideoSource: playerOptions[0]?.server || null,
    savedProvider: playback.provider,
    pageTitle: titleData.pageTitle,
    metaDescription: titleData.metaDescription,
    metaKeywords: titleData.metaKeywords,
    posterUrl: titleData.posterUrl,
    releaseYear: titleData.releaseYear,
    rating: titleData.rating,
    nextEpisodeUrl: null,
    genres: titleData.genres,
    actors: titleData.actors,
    playerOptions,
    ...verification
  });

  if (options.onProgress) {
    options.onProgress({ seasonNumber: 1, episodeNumber: 1, provider: playback.provider, url: pageUrl });
  }

  return {
    seriesId,
    imported: [
      {
        seasonNumber: 1,
        episodeNumber: 1,
        episodeId,
        snapshotId,
        pageUrl,
        videoUrl: playback.videoUrl,
        provider: playback.provider,
        videoSource: playback.source,
        playersFound: playerOptions.length
      }
    ],
    skipped: []
  };
}

async function importSeries(pool, context, options) {
  const { titleData, html, pageUrl, adapter } = context;
  const allEpisodes = adapter.parseSeasonEpisodes(html, pageUrl);

  if (!allEpisodes.length) {
    throw new Error(`No encontre capitulos listados para "${titleData.title}" en ${pageUrl}`);
  }

  const episodes = selectEpisodes(allEpisodes, options);
  if (!episodes.length) {
    throw new Error('El filtro de temporada/rango no dejo ningun capitulo por importar.');
  }

  // La serie se crea recien cuando un capitulo resuelve video, para no dejar
  // fichas vacias en el catalogo cuando PelisPlusHD no publica reproductores.
  let seriesId = null;
  const ensureSeriesOnce = async () => {
    if (seriesId == null) {
      seriesId = await ensureSeries(pool, titleData);
      if (titleData.genres.length) {
        await linkSeriesGenres(pool, seriesId, await ensureGenres(pool, titleData.genres));
      }
    }

    return seriesId;
  };

  const seasonIds = new Map();
  const imported = [];
  const skipped = [];

  for (const episode of episodes) {
    let episodeHtml;
    try {
      episodeHtml = await fetchPageHtml(episode.url);
    } catch (error) {
      skipped.push({ ...episode, reason: `No pude cargar la pagina: ${error.message || String(error)}` });
      continue;
    }

    const playerOptions = adapter.parsePlayerOptions(episodeHtml);
    if (!playerOptions.length) {
      skipped.push({ ...episode, reason: 'El capitulo no tiene reproductores publicados.' });
      continue;
    }

    const verification = await resolveVerifiedVideo(playerOptions, episode.url);
    const playback = await pickPlayback(playerOptions, verification, episode.url);
    if (!playback) {
      skipped.push({ ...episode, reason: 'No pude resolver ninguna URL de video.' });
      continue;
    }

    if (!seasonIds.has(episode.seasonNumber)) {
      seasonIds.set(
        episode.seasonNumber,
        await ensureSeason(pool, await ensureSeriesOnce(), episode.seasonNumber, `Temporada ${episode.seasonNumber}`)
      );
    }

    const episodeMeta = adapter.parseTitleMetadata(episodeHtml, episode.url);
    const navigation = adapter.parseEpisodeNavigation(episodeHtml, episode.url);
    const episodeTitle = adapter.buildEpisodeTitle(episodeMeta, episode);

    const episodeId = await ensureEpisode(pool, seasonIds.get(episode.seasonNumber), {
      episodeNumber: episode.episodeNumber,
      title: episodeTitle,
      description: episodeMeta.synopsis || titleData.synopsis,
      videoUrl: playback.videoUrl,
      provider: playback.provider,
      thumbnailUrl: episodeMeta.posterUrl || titleData.posterUrl,
      durationSec: null
    });

    const snapshotId = await upsertSnapshot(pool, {
      sourceSite: adapter.sourceSite,
      sourceType: 'episode-page',
      contentType: titleData.contentType,
      seriesName: titleData.title,
      seriesSlug: titleData.slug,
      seriesUrl: pageUrl,
      originalTitle: titleData.originalTitle,
      seriesSynopsis: titleData.synopsis,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      episodeTitle,
      episodePageUrl: episode.url,
      primaryVideoUrl: playerOptions[0]?.embedUrl || null,
      primaryVideoSource: playerOptions[0]?.server || null,
      savedProvider: playback.provider,
      pageTitle: episodeMeta.pageTitle,
      metaDescription: episodeMeta.metaDescription,
      metaKeywords: episodeMeta.metaKeywords,
      posterUrl: episodeMeta.posterUrl || titleData.posterUrl,
      releaseYear: titleData.releaseYear,
      rating: titleData.rating,
      nextEpisodeUrl: navigation.nextEpisodeUrl,
      genres: titleData.genres,
      actors: titleData.actors,
      playerOptions,
      ...verification
    });

    imported.push({
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      episodeId,
      snapshotId,
      pageUrl: episode.url,
      videoUrl: playback.videoUrl,
      provider: playback.provider,
      videoSource: playback.source,
      playersFound: playerOptions.length
    });

    if (options.onProgress) {
      options.onProgress({
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        provider: playback.provider,
        url: episode.url,
        done: imported.length,
        total: episodes.length
      });
    }
  }

  if (!imported.length) {
    const detail = skipped[0]?.reason ? ` Motivo del primero: ${skipped[0].reason}` : '';
    throw new Error(
      `Ningun capitulo de "${titleData.title}" tenia video disponible, no se guardo nada.${detail}`
    );
  }

  return { seriesId, imported, skipped, episodesDetected: allEpisodes.length };
}

async function main(options = {}) {
  const pageUrl = normalizePageUrl(options.pageUrl, options.baseUrl || PELISPLUS_BASE_URL);
  const adapter = resolveAdapter(pageUrl);
  const contentType = options.contentType || adapter.contentTypeFromUrl(pageUrl);

  if (contentType !== 'series' && contentType !== 'movie') {
    throw new Error(`Tipo de contenido no soportado para ${adapter.sourceSite}: ${contentType}`);
  }

  const html = await fetchPageHtml(pageUrl);
  const parsed = adapter.parseTitleMetadata(html, pageUrl);

  if (!parsed.title) {
    throw new Error(`No pude leer el titulo de ${pageUrl}. Puede que la ficha no exista.`);
  }

  const titleData = {
    ...parsed,
    contentType,
    slug: slugFromPageUrl(pageUrl),
    pageUrl
  };

  const context = { titleData, html, pageUrl, adapter };
  const pool = await getPool();

  try {
    await ensureSnapshotTable(pool);
    const outcome =
      contentType === 'movie'
        ? await importMovie(pool, context, options)
        : await importSeries(pool, context, options);

    const result = {
      database: 'StreamFlix',
      sourceSite: adapter.sourceSite,
      contentType,
      seriesId: outcome.seriesId,
      title: titleData.title,
      originalTitle: titleData.originalTitle,
      slug: titleData.slug,
      pageUrl,
      releaseYear: titleData.releaseYear,
      rating: titleData.rating,
      genres: titleData.genres,
      episodesDetected: outcome.episodesDetected ?? outcome.imported.length,
      importedCount: outcome.imported.length,
      skippedCount: outcome.skipped.length,
      imported: outcome.imported,
      skipped: outcome.skipped
    };

    if (options.emitJson !== false) {
      console.log(JSON.stringify(result, null, 2));
    }

    return result;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  main({
    pageUrl: args.url || args['page-url'],
    contentType: args['content-type'],
    season: args.season,
    start: args.start,
    end: args.end,
    onProgress: (event) =>
      process.stderr.write(
        `→ T${event.seasonNumber}E${event.episodeNumber} (${event.provider})${
          event.total ? ` [${event.done}/${event.total}]` : ''
        }\n`
      )
  }).catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  main,
  searchTitle,
  searchTitleAcrossSites,
  buildTitleUrl,
  resolveAdapter,
  contentTypeFromUrl
};
