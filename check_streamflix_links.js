#!/usr/bin/env node

// Revisa que los episodios guardados en StreamFlix sigan reproduciendose.
// Los enlaces de estos sitios llevan token y caducan en cuestion de horas, asi
// que lo normal es que una serie importada hace dias ya no cargue. Con --fix
// vuelve a importar las series que hayan quedado rotas.

const { getPool, closePool, requestUrl } = require('./save_episode_url_to_streamflix.js');
const { main: importAnimeEpisode } = require('./save_episode_url_to_streamflix.js');
const { main: importFromSite } = require('./save_pelisplus_to_streamflix.js');

// Comprobar todos los episodios de un catalogo grande son cientos de peticiones,
// y el token caduca por lote de importacion: con unos pocos por serie alcanza
// para saber si esa serie sigue viva.
const DEFAULT_SAMPLE = 3;
const STREAMFLIX_URL = String(process.env.STREAMFLIX_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

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

async function loadEpisodes(pool, filters) {
  const request = pool
    .request()
    .input('type', filters.type || null)
    .input('title', filters.title ? `%${filters.title}%` : null);

  const result = await request.query(`
    SELECT
      s.Id AS SeriesId, s.Title, s.ContentType, s.SourceRef,
      se.SeasonNumber, e.Id AS EpisodeId, e.EpisodeNumber, e.Provider, e.VideoUrl
    FROM dbo.Series s
    JOIN dbo.Seasons se ON se.SeriesId = s.Id
    JOIN dbo.Episodes e ON e.SeasonId = se.Id
    WHERE (@type IS NULL OR s.ContentType = @type)
      AND (@title IS NULL OR s.Title LIKE @title)
    ORDER BY s.Title, se.SeasonNumber, e.EpisodeNumber
  `);

  return result.recordset;
}

// El Referer con el que se verifico el video: algunos CDN lo exigen y sin el
// responden 403 aunque el enlace siga vigente.
async function loadReferers(pool) {
  const referers = new Map();

  for (const table of ['dbo.JkAnimeEpisodeSnapshots', 'dbo.PelisPlusSnapshots']) {
    try {
      const result = await pool.request().query(`
        SELECT EpisodePageUrl, VideoSrcUrl, VideoSrcReferer, VerifiedVideoUrl, VerifiedVideoReferer
          FROM ${table}
      `);

      for (const row of result.recordset) {
        if (row.VideoSrcUrl) referers.set(row.VideoSrcUrl, row.VideoSrcReferer);
        if (row.VerifiedVideoUrl) referers.set(row.VerifiedVideoUrl, row.VerifiedVideoReferer);
      }
    } catch {
      // La tabla puede no existir todavia; no es motivo para no revisar nada.
    }
  }

  return referers;
}

// Lo que devuelve un embed que ya no sirve para nada. Todo esto llega con
// codigo 200, que es justo por lo que hay que mirar el cuerpo:
//   - el propio host avisando de que el archivo caduco o se borro;
//   - el dominio incautado, que redirige a una pagina antipirateria;
//   - una pagina minuscula, que es la forma que tienen de decir "aqui no hay
//     nada" sin gastar un 404 (el stub de streamwish son 452 bytes).
const AVISOS_DE_MUERTO = [
  /no longer available/i,
  /has been deleted/i,
  /file (?:not found|was deleted|is expired)/i,
  /video (?:not found|has been removed|unavailable)/i,
  /this file (?:is|was) removed/i,
  /alliance4creativity|watch-it-legally/i,
  /domain (?:seized|has been seized)/i
];

function motivoEmbedMuerto(response) {
  const cuerpo = String(response.body || '');
  const destino = String(response.finalUrl || response.url || '');

  for (const patron of AVISOS_DE_MUERTO) {
    if (patron.test(cuerpo) || patron.test(destino)) {
      const encontrado = (cuerpo.match(patron) || destino.match(patron) || [''])[0];
      return `el host responde 200 pero dice: "${String(encontrado).slice(0, 60)}"`;
    }
  }

  // Sin regla por tamaño: streamwish sirve un cargador de pocos cientos de
  // bytes que en el navegador monta el reproductor entero. Marcarlo por
  // pequeño daba por muerto un embed que si funciona.

  return null;
}

function bloqueoDeIframe(response, pageUrl) {
  const headers = response && response.headers ? response.headers : {};
  const body = String(response.body || '');
  const finalUrl = String(response.finalUrl || response.url || pageUrl || '');
  const hostFinal = (() => {
    try {
      return new URL(finalUrl).hostname;
    } catch {
      return '';
    }
  })();

  const xFrame = String(headers['x-frame-options'] || '');
  if (/deny|sameorigin/i.test(xFrame)) {
    return `bloquea iframe por X-Frame-Options: ${xFrame}`;
  }

  const csp = String(headers['content-security-policy'] || '');
  const frameAncestors = csp.match(/frame-ancestors\s+([^;]+)/i);
  if (frameAncestors && !/\*/.test(frameAncestors[1])) {
    return `bloquea iframe por CSP: ${frameAncestors[1].trim()}`;
  }

  if (/window\.self\s*===\s*window\.top/i.test(body) || /document\.documentElement\.innerHTML\s*=\s*''/i.test(body)) {
    return 'el reproductor detecta ventana superior y se vacía fuera del iframe esperado';
  }

  if (hostFinal && /pelismart\.|embed69\./i.test(hostFinal)) {
    return `usa ${hostFinal}, que no se deja embeber desde Noxis`;
  }

  return null;
}

function esPlaylistValido(response) {
  const contentType = String(response.headers['content-type'] || '');
  return /mpegurl/i.test(contentType) || String(response.body || '').trimStart().startsWith('#EXTM3U');
}

function esVideoValido(response) {
  const contentType = String(response.headers['content-type'] || '');
  return /^video\//i.test(contentType) || /octet-stream/i.test(contentType);
}

async function probePlaybackResuelto(episode) {
  const playbackUrl = `${STREAMFLIX_URL}/api/episodes/${episode.EpisodeId}/playback`;
  try {
    const playback = await requestUrl('GET', playbackUrl, { Accept: 'application/json' });
    if (playback.statusCode >= 400) {
      return { estado: 'roto', detalle: `playback respondió ${playback.statusCode}` };
    }

    let data;
    try {
      data = JSON.parse(playback.body || '{}');
    } catch {
      return { estado: 'roto', detalle: 'playback devolvió JSON inválido' };
    }

    if (!data || !data.url) {
      return { estado: 'sin-fuente', detalle: 'playback no devolvió ninguna URL' };
    }

    if (data.provider === 'embed') {
      const embedResponse = await requestUrl('GET', data.url, {
        Accept: '*/*',
        Referer: `${STREAMFLIX_URL}/`
      });
      const muerto = motivoEmbedMuerto(embedResponse);
      if (muerto) return { estado: 'caducado', detalle: muerto };
      const bloqueado = bloqueoDeIframe(embedResponse, data.url);
      if (bloqueado) return { estado: 'caducado', detalle: bloqueado };
      return { estado: 'ok', detalle: `embed usable (${embedResponse.statusCode})` };
    }

    const resolvedUrl = String(data.url).startsWith('http')
      ? data.url
      : `${STREAMFLIX_URL}${String(data.url).startsWith('/') ? '' : '/'}${data.url}`;
    const streamResponse = await requestUrl('GET', resolvedUrl, { Accept: '*/*' });
    if (streamResponse.statusCode >= 400) {
      return { estado: 'caducado', detalle: `stream respondió ${streamResponse.statusCode}` };
    }
    if (esPlaylistValido(streamResponse)) {
      return { estado: 'ok', detalle: 'playback resuelto a playlist válido' };
    }
    if (esVideoValido(streamResponse)) {
      return { estado: 'ok', detalle: `playback resuelto a ${streamResponse.headers['content-type']}` };
    }

    return {
      estado: 'roto',
      detalle: `playback devolvió ${streamResponse.statusCode} ${streamResponse.headers['content-type'] || 'sin tipo'}`
    };
  } catch (error) {
    return { estado: 'roto', detalle: `playback falló: ${(error.message || String(error)).slice(0, 90)}` };
  }
}

async function probeEpisode(episode, referers) {
  const resuelto = await probePlaybackResuelto(episode);
  if (resuelto.estado === 'ok') {
    return resuelto;
  }

  const provider = String(episode.Provider || 'file').toLowerCase();
  const url = episode.VideoUrl;

  if (!url || url === 'NO_VIDEO_FOUND') {
    return { estado: 'sin-fuente', detalle: 'el episodio no tiene URL guardada' };
  }

  if (url.startsWith('/media/')) {
    return { estado: 'ok', detalle: 'archivo local' };
  }

  const headers = { Accept: '*/*' };
  const referer = referers.get(url);
  if (referer) headers.Referer = referer;

  try {
    const response = await requestUrl('GET', url, headers);
    const contentType = response.headers['content-type'] || '';

    if (provider === 'embed') {
      // Que el servidor conteste 200 no basta, y darlo por bueno era lo que
      // hacia pasar la revision a series que no reproducen nada: estos hosts
      // sirven su pagina de "archivo caducado" con codigo 200, y cuando cierran
      // un dominio lo reemplazan por un aviso antipirateria, tambien con 200.
      const muerto = motivoEmbedMuerto(response);
      if (muerto) return { estado: 'caducado', detalle: muerto };
      return { estado: 'ok', detalle: `embed responde (${response.statusCode})` };
    }

    if (/mpegurl/i.test(contentType) || response.body.trimStart().startsWith('#EXTM3U')) {
      return { estado: 'ok', detalle: 'playlist valido' };
    }

    if (/^video\//i.test(contentType) || /octet-stream/i.test(contentType)) {
      return { estado: 'ok', detalle: contentType };
    }

    return { estado: 'roto', detalle: `respondio ${response.statusCode} ${contentType || 'sin tipo'}` };
  } catch (error) {
    const message = error.message || String(error);
    const caducado = /HTTP 40[0-9]/.test(message);
    return { estado: caducado ? 'caducado' : 'roto', detalle: message.slice(0, 90) };
  }
}

function pickSample(episodes, sampleSize) {
  if (!sampleSize || episodes.length <= sampleSize) return episodes;

  // Primero, uno del medio y el ultimo: si el lote caduco, caducó entero.
  const indices = new Set([0, Math.floor(episodes.length / 2), episodes.length - 1]);
  while (indices.size < sampleSize) indices.add(Math.floor(Math.random() * episodes.length));

  return [...indices].sort((a, b) => a - b).slice(0, sampleSize).map((i) => episodes[i]);
}

function groupBySeries(episodes) {
  const grupos = new Map();

  for (const episode of episodes) {
    if (!grupos.has(episode.SeriesId)) {
      grupos.set(episode.SeriesId, {
        seriesId: episode.SeriesId,
        title: episode.Title,
        contentType: episode.ContentType,
        sourceRef: episode.SourceRef,
        episodes: []
      });
    }
    grupos.get(episode.SeriesId).episodes.push(episode);
  }

  return [...grupos.values()];
}

// El SourceRef guarda de donde vino cada serie, y es lo que permite reimportarla
// sin volver a buscarla: "jkanime:slug" o "pelisplushd:slug" / "cuevana3:slug".
function reimportTarget(serie, sitesByPrefix) {
  const [prefix, slug] = String(serie.sourceRef || '').split(':');
  if (!prefix || !slug) return null;

  if (prefix === 'jkanime') {
    return { kind: 'anime', url: `https://jkanime.net/${slug}/` };
  }

  const baseUrl = sitesByPrefix[prefix];
  if (!baseUrl) return null;

  const segment = serie.contentType === 'movie' ? 'pelicula' : 'serie';
  return { kind: 'site', url: `${baseUrl}${segment}/${slug}`, contentType: serie.contentType };
}

async function reimport(serie, target, onProgress) {
  if (target.kind === 'anime') {
    const total = serie.episodes.length;
    let hechos = 0;

    for (const episode of serie.episodes) {
      await importAnimeEpisode({
        episodeUrl: `${target.url}${episode.EpisodeNumber}/`,
        emitJson: false
      }).catch(() => null);
      hechos += 1;
      onProgress(`  → ${serie.title} cap ${episode.EpisodeNumber} [${hechos}/${total}]`);
    }

    return hechos;
  }

  const result = await importFromSite({
    pageUrl: target.url,
    contentType: target.contentType,
    emitJson: false,
    onProgress: (event) => onProgress(`  → ${serie.title} T${event.seasonNumber}E${event.episodeNumber}`)
  });

  return result.importedCount;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sampleSize = args.sample != null ? Number(args.sample) : DEFAULT_SAMPLE;
  const arreglar = args.fix === 'true';
  const log = (text) => process.stderr.write(`${text}\n`);

  const pool = await getPool();

  try {
    const episodes = await loadEpisodes(pool, { type: args.type, title: args.title });
    if (!episodes.length) {
      throw new Error('No hay episodios que revisar con ese filtro.');
    }

    const referers = await loadReferers(pool);
    const series = groupBySeries(episodes);
    const informe = [];

    log(`Revisando ${series.length} títulos (${sampleSize ? sampleSize + ' episodios por título' : 'todos los episodios'})…\n`);

    for (const serie of series) {
      const muestra = pickSample(serie.episodes, sampleSize);
      const resultados = [];

      for (const episode of muestra) {
        resultados.push(await probeEpisode(episode, referers));
      }

      const ok = resultados.filter((r) => r.estado === 'ok').length;
      const problema = resultados.find((r) => r.estado !== 'ok');
      const estado = problema ? problema.estado : 'ok';

      informe.push({
        Titulo: serie.title,
        Tipo: serie.contentType,
        Episodios: serie.episodes.length,
        Revisados: muestra.length,
        OK: ok,
        Estado: estado,
        Detalle: problema ? problema.detalle : ''
      });

      log(`${estado === 'ok' ? '✓' : '✗'} ${serie.title} — ${ok}/${muestra.length} ok${problema ? ` (${problema.detalle})` : ''}`);
      serie.estado = estado;
    }

    const rotas = series.filter((s) => s.estado !== 'ok');

    console.log('');
    console.table(informe);

    if (!rotas.length) {
      console.log('Todo el catálogo responde correctamente.');
      return;
    }

    if (!arreglar) {
      console.log(
        `\n${rotas.length} título(s) con problemas. Repite con --fix para volver a importarlos, ` +
          'o revisa el detalle de arriba.'
      );
      return;
    }

    // Los cuatro sitios que sabe leer el importador. Faltaban dos, asi que una
    // serie traida de Pelismart o Gnula no se podia reimportar: reimportTarget
    // no encontraba su prefijo y la daba por irrecuperable.
    const sitesByPrefix = {
      pelisplushd: 'https://www.pelisplushd.la/',
      cuevana3: 'https://ww9.cuevana3.to/',
      pelismart: 'https://pelismart.mov/',
      gnula: 'https://www2.gnula.one/',
      pelisflix200: 'https://pelisflix200.ws/',
      pelisplus: 'https://www.pelisplushd.la/'
    };

    log('\nReimportando los títulos rotos…');
    for (const serie of rotas) {
      const target = reimportTarget(serie, sitesByPrefix);
      if (!target) {
        log(`✗ ${serie.title}: no sé de dónde vino (SourceRef "${serie.sourceRef}")`);
        continue;
      }

      try {
        const total = await reimport(serie, target, log);
        log(`✓ ${serie.title}: ${total} episodio(s) reimportados`);
      } catch (error) {
        log(`✗ ${serie.title}: ${error.message || error}`);
      }
    }
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}

module.exports = { main };
