#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const sql = require('mssql');

function resolveStreamflixRoot() {
  const candidates = [
    process.env.STREAMFLIX_ROOT,
    path.resolve(process.cwd(), '../streamflix'),
    path.resolve(__dirname, '../streamflix'),
    path.resolve(path.dirname(process.execPath), '../streamflix'),
    path.resolve(path.dirname(process.execPath), 'streamflix')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, '.env'))) {
      return candidate;
    }
  }

  throw new Error('No pude localizar la carpeta streamflix. Usa STREAMFLIX_ROOT si hace falta.');
}

const streamflixRoot = resolveStreamflixRoot();
dotenv.config({ path: path.join(streamflixRoot, '.env') });

let poolPromise;
function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool({
      server: process.env.DB_SERVER || 'localhost',
      port: Number(process.env.DB_PORT) || 1433,
      user: process.env.DB_USER || 'sa',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'StreamFlix',
      options: { encrypt: false, trustServerCertificate: true },
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
    }).connect().catch((error) => {
      poolPromise = null;
      throw error;
    });
  }

  return poolPromise;
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const ANISKIP_CLIENT_ID = 'ZGfO0sMF3eCwLYf8yMSCJjlynwNGRXWE';
const DEFAULT_EPISODE_LENGTH_SEC = 24 * 60;
const NO_VIDEO_FOUND = 'NO_VIDEO_FOUND';
const TRANSIENT_HTTP_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 524]);
// Algunos servidores de video aceptan la conexion y no responden nunca. Sin este
// tope una sola peticion deja colgada la importacion entera.
const REQUEST_TIMEOUT_MS = 20000;
const INSECURE_TLS_HOST_HINTS = ['pelisplushd.la'];
let runtimeConfig = null;

function needsInsecureTls(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return INSECURE_TLS_HOST_HINTS.some((hint) => hostname === hint || hostname.endsWith(`.${hint}`));
  } catch {
    return false;
  }
}

function buildRequestOptions(url, method, headers = {}) {
  const options = {
    method,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      'User-Agent': USER_AGENT,
      ...headers
    }
  };

  if (url.startsWith('https:') && needsInsecureTls(url)) {
    options.agent = new https.Agent({ rejectUnauthorized: false });
  }

  return options;
}

function buildRuntimeConfig(overrides = {}) {
  const episodeUrl = overrides.episodeUrl || process.env.JK_EPISODE_URL || 'https://jkanime.net/dragon-ball-z/1/';
  const aniskipAnimeIdRaw =
    overrides.aniskipAnimeId != null ? overrides.aniskipAnimeId : process.env.JK_ANISKIP_ANIME_ID;
  const releaseYearRaw = overrides.releaseYear != null ? overrides.releaseYear : process.env.JK_RELEASE_YEAR;
  const ratingRaw = overrides.rating != null ? overrides.rating : process.env.JK_RATING;

  // Sin valores por defecto: antes caian los de Dragon Ball Z (id 813, 1989, 9.0)
  // y cualquier anime al que le faltara el dato terminaba con SU intro, SU año y
  // SU calificacion. Es preferible quedarse sin marcas que con las de otra serie.
  return {
    episodeUrl,
    aniskipAnimeId: aniskipAnimeIdRaw != null && aniskipAnimeIdRaw !== '' ? Number(aniskipAnimeIdRaw) : null,
    releaseYear: releaseYearRaw != null && releaseYearRaw !== '' ? Number(releaseYearRaw) : null,
    rating: ratingRaw != null && ratingRaw !== '' ? Number(ratingRaw) : null,
    // Una franquicia con varias fichas en el sitio de origen (temporadas, OVAs,
    // especiales) se guarda como UNA serie con varias temporadas dentro, en vez
    // de como varias series sueltas con el mismo nombre.
    seriesTitle: overrides.seriesTitle || null,
    seriesSourceRef: overrides.seriesSourceRef || null,
    seasonNumber: overrides.seasonNumber != null ? Number(overrides.seasonNumber) : null,
    seasonTitle: overrides.seasonTitle || null
  };
}

function getRuntimeConfig() {
  if (!runtimeConfig) {
    runtimeConfig = buildRuntimeConfig();
  }

  return runtimeConfig;
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function cleanText(value) {
  return decodeHtml(value).replace(/\s+/g, ' ').trim();
}

function matchOne(text, regex, group = 1) {
  const match = text.match(regex);
  return match ? cleanText(match[group]) : null;
}

function matchAll(text, regex, mapFn) {
  const results = [];
  for (const match of text.matchAll(regex)) {
    results.push(mapFn(match));
  }
  return results;
}

function parseJsonArrayFromScript(text, varName) {
  const regex = new RegExp(`var\\s+${varName}\\s*=\\s*(\\[[\\s\\S]*?\\]);`);
  const match = text.match(regex);
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
}

function getHttpClient(url) {
  return url.startsWith('https:') ? https : http;
}

function isRedirectStatus(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function normalizeUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return null;
  }
}

function isVideoContentType(contentType) {
  if (!contentType) {
    return false;
  }

  return /^video\//i.test(contentType)
    || /^application\/octet-stream/i.test(contentType)
    || /^application\/vnd\.apple\.mpegurl/i.test(contentType)
    || /^application\/x-mpegurl/i.test(contentType);
}

function looksLikeVideoFile(url) {
  return /\.(mp4|webm|m3u8|mov)(?:$|\?)/i.test(url);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractVideoEmbeds(text) {
  return matchAll(
    text,
    /video\[(\d+)\]\s*=\s*'(<iframe class="player_conte" src="([^"]+)"[^']*><\/iframe>)';/g,
    (match) => ({
      index: Number(match[1]),
      iframeHtml: decodeHtml(match[2]),
      embedUrl: match[3]
    })
  );
}

function parseEpisodeData(html) {
  const pageTitle = matchOne(html, /<title>([^<]+)<\/title>/i);
  const metaDescription = matchOne(html, /<meta name="description" content="([^"]*)"/i);
  const metaKeywords = matchOne(html, /<meta name="keywords" content="([^"]*)"/i);
  const ogTitle = matchOne(html, /<meta property="og:title" content="([^"]*)"/i);
  const ogImageUrl = matchOne(html, /<meta property="og:image" content="([^"]*)"/i);
  const ogUrl = matchOne(html, /<meta property="og:url" content="([^"]*)"/i);
  const csrfToken = matchOne(html, /<meta name="csrf-token" content="([^"]*)"/i);
  const seriesTitle = matchOne(
    html,
    /<div class="col col-8 col-md-10 video_i">\s*<a href="[^"]+">([^<]+)<\/a>/i
  );
  const seriesUrl = matchOne(
    html,
    /<div class="col col-8 col-md-10 video_i">\s*<a href="([^"]+)">/i
  );
  const totalEpisodesText = matchOne(html, /<span class="d-block">(\d+)\s+episodios<\/span>/i);
  const seriesSynopsis = matchOne(html, /<span class="d-block">\d+\s+episodios<\/span>\s*<p class="d-block mt-2">([\s\S]*?)<\/p>/i);
  // El poster vive en el bloque video_t de la ficha; antes se buscaba por el alt
  // de Dragon Ball, asi que el resto de los animes quedaba sin portada.
  const posterUrl =
    matchOne(html, /<div class="video_t">\s*<a href="[^"]*">\s*<img src="([^"]+)"/i) ||
    matchOne(html, /<img src="(https?:\/\/[^"]*\/assets\/images\/animes\/image\/[^"]+)"/i);
  const nextEpisodeUrl = matchOne(html, /<a class="ml-1\s+w-100\s+" href="([^"]+)"><div class="btn btn-primary mt-1 videonav w-100">Siguiente/i);
  const previousEpisodeUrl = matchOne(html, /<a class="mr-1\s+w-100\s+" href="([^"]+)"><div class="btn btn-primary mt-1 videonav w-100">Anterior/i);
  const { episodeUrl } = getRuntimeConfig();
  const episodePageUrl = ogUrl || episodeUrl;
  const episodeNumberText = matchOne(html, /data-numero="(\d+)"/i) || matchOne(html, /dragon-ball-z\/(\d+)\//i);
  const episodeNumber = episodeNumberText ? Number(episodeNumberText) : null;
  const episodeNumericIdText = matchOne(html, /data-capitulo="(\d+)"/i);
  const episodeNumericId = episodeNumericIdText ? Number(episodeNumericIdText) : null;
  const animeNumericIdText = matchOne(html, /data-anime="dragon-ball-z" class="player-btn"[\s\S]*?data-capitulo="\d+"[\s\S]*?<\/div>[\s\S]*?url:\s*'https:\/\/jkanime\.net\/ajax\/episodes\/(\d+)\/'/i)
    || matchOne(html, /url:\s*'https:\/\/jkanime\.net\/ajax\/episodes\/(\d+)\/'/i);
  const animeNumericId = animeNumericIdText ? Number(animeNumericIdText) : null;
  const seriesSlug = matchOne(html, /data-anime="([^"]+)"/i) || (seriesUrl ? new URL(seriesUrl).pathname.split('/').filter(Boolean)[0] : null);
  const episodeTitle =
    matchOne(html, /<title>([^<]+?)\s+Sub Español Online gratis/i) ||
    (seriesTitle && episodeNumber ? `${seriesTitle} ${episodeNumber}` : pageTitle);
  const pageImageUrl = matchOne(html, /addToHistory\("1",\s*"[^"]+",\s*"([^"]+)"/i);
  const playerEmbeds = extractVideoEmbeds(html);
  const serverOptions = parseJsonArrayFromScript(html, 'servers').map((item, index) => {
    const decodedRemoteUrl = Buffer.from(item.remote, 'base64').toString('utf8').trim();
    const generatedEmbedUrl = `https://jkanime.net/jkplayer/c1?u=${item.remote}&s=${item.server.toLowerCase()}`;
    const generatedDownloadUrl = `https://c1.jkplayers.com/d/${item.slug}/`;
    return {
      index,
      server: item.server,
      languageCode: item.lang,
      size: item.size,
      slug: item.slug,
      append: item.append,
      remoteBase64: item.remote,
      decodedRemoteUrl,
      generatedEmbedUrl,
      generatedDownloadUrl
    };
  });
  const localPlayerDesu = playerEmbeds.find((item) => item.index === 0) || null;
  const localPlayerMagi = playerEmbeds.find((item) => item.index === 1) || null;
  const localPlayerDesuka = playerEmbeds.find((item) => item.index === 2) || null;
  const localPlayerOptions = [
    { label: 'Desu', embedUrl: localPlayerDesu ? localPlayerDesu.embedUrl : null, type: 'jkplayer-um' },
    { label: 'Magi', embedUrl: localPlayerMagi ? localPlayerMagi.embedUrl : null, type: 'jkplayer-umv' },
    { label: 'Desuka', embedUrl: localPlayerDesuka ? localPlayerDesuka.embedUrl : null, type: 'jkplayer-jk' }
  ].filter((item) => item.embedUrl);
  const downloadOptions = serverOptions.map((item) => ({
    server: item.server,
    size: item.size,
    languageCode: item.languageCode,
    directUrl: item.generatedDownloadUrl,
    remoteUrl: item.decodedRemoteUrl
  }));
  const directMediaOption =
    serverOptions.find((item) => /\.(mp4|webm)(?:$|\?)/i.test(item.decodedRemoteUrl)) ||
    null;
  const preferredLocalPlayer =
    localPlayerOptions.find((item) => item.label === 'Magi') ||
    localPlayerOptions.find((item) => item.label === 'Desu') ||
    localPlayerOptions.find((item) => item.label === 'Desuka') ||
    null;
  const preferredServerPlayer =
    serverOptions.find((item) => item.server === 'Streamwish') ||
    serverOptions.find((item) => item.server === 'Vidhide') ||
    serverOptions.find((item) => item.server === 'Mp4upload') ||
    serverOptions[0] ||
    null;
  const primaryVideoUrl =
    (preferredLocalPlayer && preferredLocalPlayer.embedUrl) ||
    (preferredServerPlayer && preferredServerPlayer.generatedEmbedUrl) ||
    (preferredServerPlayer && preferredServerPlayer.decodedRemoteUrl) ||
    null;
  const primaryVideoSource =
    (preferredLocalPlayer && preferredLocalPlayer.label) ||
    (preferredServerPlayer && preferredServerPlayer.server) ||
    null;
  const directMediaUrl = (directMediaOption && directMediaOption.decodedRemoteUrl) || null;
  const directMediaSource = (directMediaOption && directMediaOption.server) || null;
  const directMediaFormat = directMediaUrl
    ? ((directMediaUrl.match(/\.(mp4|webm)(?:$|\?)/i) || [])[1] || null)
    : null;

  return {
    sourceSite: 'JKAnime',
    sourceType: 'episode-page',
    pageTitle,
    metaDescription,
    metaKeywords,
    ogTitle,
    ogImageUrl,
    ogUrl,
    csrfToken,
    seriesTitle,
    seriesSlug,
    seriesUrl,
    seriesSynopsis,
    totalEpisodes: totalEpisodesText ? Number(totalEpisodesText) : null,
    episodeTitle,
    episodeNumber,
    episodePageUrl,
    episodeNumericId,
    animeNumericId,
    posterUrl,
    pageImageUrl,
    nextEpisodeUrl,
    previousEpisodeUrl,
    directMediaUrl,
    directMediaSource,
    directMediaFormat,
    primaryVideoUrl,
    primaryVideoSource,
    localPlayerOptions,
    serverOptions,
    downloadOptions,
    playerEmbeds,
    rawExtractedJson: {
      playerEmbeds,
      serverOptions,
      downloadOptions
    }
  };
}

async function fetchEpisodeHtml(attempt = 1) {
  const { episodeUrl } = getRuntimeConfig();
  try {
    return await new Promise((resolve, reject) => {
      const request = https.get(
        episodeUrl,
        buildRequestOptions(episodeUrl, 'GET', { Accept: 'text/html,application/xhtml+xml' }),
        (response) => {
          if (response.statusCode && response.statusCode >= 400) {
            const error = new Error(`No pude cargar el episodio. HTTP ${response.statusCode}`);
            error.statusCode = response.statusCode;
            reject(error);
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

      request.on('timeout', () => {
        const error = new Error(`Tiempo de espera agotado (${REQUEST_TIMEOUT_MS} ms) cargando ${episodeUrl}`);
        error.timedOut = true;
        request.destroy(error);
      });
      request.on('error', reject);
    });
  } catch (error) {
    if (attempt < 4 && (error.timedOut || TRANSIENT_HTTP_STATUS_CODES.has(error.statusCode))) {
      await sleep(500 * attempt);
      return fetchEpisodeHtml(attempt + 1);
    }

    throw error;
  }
}

async function requestUrl(method, url, headers = {}, redirectCount = 0) {
  if (redirectCount > 8) {
    throw new Error(`Demasiadas redirecciones para ${url}`);
  }

  return new Promise((resolve, reject) => {
    const client = getHttpClient(url);
    const request = client.request(
      url,
      buildRequestOptions(url, method, headers),
      (response) => {
        if (response.statusCode && isRedirectStatus(response.statusCode) && response.headers.location) {
          const redirectedUrl = normalizeUrl(response.headers.location, url);
          response.resume();

          if (!redirectedUrl) {
            reject(new Error(`No pude resolver la redirección de ${url}`));
            return;
          }

          requestUrl(method, redirectedUrl, headers, redirectCount + 1)
            .then(resolve)
            .catch(reject);
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
          resolve({
            url,
            finalUrl: url,
            statusCode: response.statusCode || null,
            headers: response.headers,
            body
          });
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error(`Tiempo de espera agotado (${REQUEST_TIMEOUT_MS} ms) para ${url}`));
    });
    request.on('error', reject);
    request.end();
  });
}

async function fetchText(url, headers = {}) {
  const response = await requestUrl('GET', url, headers);
  return response.body;
}

async function probeVideoUrl(url, extraHeaders = {}) {
  if (!url) {
    return null;
  }

  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) {
    return null;
  }

  const probes = [
    { method: 'HEAD', headers: { Accept: '*/*', ...extraHeaders } },
    { method: 'GET', headers: { Accept: '*/*', Range: 'bytes=0-1', ...extraHeaders } }
  ];

  for (const probe of probes) {
    try {
      const response = await requestUrl(probe.method, normalizedUrl, probe.headers);
      const contentType = response.headers['content-type'] || '';
      if ((response.statusCode === 200 || response.statusCode === 206) && isVideoContentType(contentType)) {
        return {
          url: response.finalUrl || normalizedUrl,
          statusCode: response.statusCode,
          contentType,
          verified: true
        };
      }
    } catch (error) {
      continue;
    }
  }

  return null;
}

function extractMediaUrlsFromHtml(html, pageUrl) {
  const candidates = [];
  const seen = new Set();
  const patterns = [
    /player\.src\(\s*\{\s*type:\s*"video\/[^"]+"\s*,\s*src:\s*"([^"]+)"/gi,
    /file:\s*"([^"]+\.(?:mp4|webm|m3u8|mov)(?:\?[^"]*)?)"/gi,
    /sources?\s*:\s*\[\s*\{\s*file:\s*"([^"]+)"/gi,
    /<source[^>]+src="([^"]+)"/gi,
    /https?:\/\/[^"'\\\s]+?\.(?:mp4|webm|m3u8|mov)(?:\?[^"'\\\s]*)?/gi
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const rawValue = match[1] || match[0];
      const candidate = normalizeUrl(decodeHtml(rawValue), pageUrl);
      if (candidate) {
        const dedupeKey = candidate.toLowerCase();
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          candidates.push(candidate);
        }
      }
    }
  }

  return candidates;
}

async function resolveVerifiedVideo(episodeData) {
  const attempted = [];
  const seen = new Set();

  const addCandidate = (url, source, kind) => {
    const normalized = normalizeUrl(url);
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    attempted.push({ url: normalized, source, kind });
  };

  addCandidate(episodeData.directMediaUrl, episodeData.directMediaSource || 'direct', 'direct-media');
  addCandidate(episodeData.primaryVideoUrl, episodeData.primaryVideoSource || 'primary', 'primary-player');

  for (const localPlayer of episodeData.localPlayerOptions) {
    addCandidate(localPlayer.embedUrl, localPlayer.label, 'local-player-embed');
  }

  for (const serverOption of episodeData.serverOptions) {
    addCandidate(serverOption.decodedRemoteUrl, serverOption.server, 'provider-page');
    addCandidate(serverOption.generatedEmbedUrl, serverOption.server, 'provider-embed');
    addCandidate(serverOption.generatedDownloadUrl, serverOption.server, 'provider-download');
  }

  for (const candidate of attempted) {
    if (looksLikeVideoFile(candidate.url)) {
      const verified = await probeVideoUrl(candidate.url, {
        Referer: episodeData.episodePageUrl
      });
      if (verified) {
        return {
          videoSrcUrl: candidate.url,
          videoSrcSource: candidate.source,
          videoSrcReferer: episodeData.episodePageUrl,
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

    try {
      const html = await fetchText(candidate.url, { Accept: 'text/html,application/xhtml+xml' });
      const extractedMediaUrls = extractMediaUrlsFromHtml(html, candidate.url);
      if (!extractedMediaUrls.length) {
        continue;
      }

      for (const extractedMediaUrl of extractedMediaUrls) {
        const verified = await probeVideoUrl(extractedMediaUrl, {
          Referer: candidate.url
        });
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

async function fetchAniSkipTimings(episodeNumber) {
  const { aniskipAnimeId } = getRuntimeConfig();

  if (!aniskipAnimeId || Number.isNaN(aniskipAnimeId)) {
    return null;
  }

  const url = `https://api.aniskip.com/v2/skip-times/${aniskipAnimeId}/${episodeNumber}?types=op&types=ed&episodeLength=${DEFAULT_EPISODE_LENGTH_SEC}`;

  try {
    const body = await fetchText(url, {
      'X-Client-ID': ANISKIP_CLIENT_ID,
      Accept: 'application/json'
    });
    const payload = JSON.parse(body);

    if (!payload.found || !Array.isArray(payload.results)) {
      return null;
    }

    const opening = payload.results.find((item) => item.skipType === 'op') || null;
    const ending = payload.results.find((item) => item.skipType === 'ed') || null;
    const durationSec =
      (ending && ending.episodeLength) || (opening && opening.episodeLength) || DEFAULT_EPISODE_LENGTH_SEC;

    return {
      source: 'AniSkip',
      animeId: aniskipAnimeId,
      episodeNumber,
      durationSec: durationSec ? Math.round(durationSec) : null,
      introStartSec:
        opening && opening.interval && opening.interval.startTime != null
          ? Math.round(opening.interval.startTime)
          : null,
      introEndSec:
        opening && opening.interval && opening.interval.endTime != null ? Math.round(opening.interval.endTime) : null,
      outroStartSec:
        ending && ending.interval && ending.interval.startTime != null ? Math.round(ending.interval.startTime) : null,
      outroEndSec:
        ending && ending.interval && ending.interval.endTime != null ? Math.round(ending.interval.endTime) : null,
      raw: payload
    };
  } catch (error) {
    return {
      source: 'AniSkip',
      animeId: aniskipAnimeId,
      episodeNumber,
      error: String(error)
    };
  }
}

async function ensureSnapshotTable(pool) {
  await pool.request().query(`
    IF OBJECT_ID('dbo.JkAnimeEpisodeSnapshots', 'U') IS NULL
    CREATE TABLE dbo.JkAnimeEpisodeSnapshots (
      Id INT IDENTITY(1,1) PRIMARY KEY,
      SourceSite NVARCHAR(100) NOT NULL,
      SourceType NVARCHAR(100) NOT NULL,
      JkAnimeAnimeId INT NULL,
      JkAnimeEpisodeId INT NULL,
      SeriesName NVARCHAR(255) NOT NULL,
      SeriesSlug NVARCHAR(255) NULL,
      SeriesUrl NVARCHAR(1000) NULL,
      SeriesSynopsis NVARCHAR(MAX) NULL,
      TotalEpisodes INT NULL,
      EpisodeNumber INT NULL,
      EpisodeTitle NVARCHAR(500) NULL,
      EpisodePageUrl NVARCHAR(1000) NOT NULL,
      DirectMediaUrl NVARCHAR(1000) NULL,
      DirectMediaSource NVARCHAR(255) NULL,
      DirectMediaFormat NVARCHAR(50) NULL,
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
      DurationSec INT NULL,
      IntroStartSec INT NULL,
      IntroEndSec INT NULL,
      OutroStartSec INT NULL,
      OutroEndSec INT NULL,
      PageTitle NVARCHAR(500) NULL,
      MetaDescription NVARCHAR(MAX) NULL,
      MetaKeywords NVARCHAR(MAX) NULL,
      OgTitle NVARCHAR(500) NULL,
      OgImageUrl NVARCHAR(1000) NULL,
      PosterUrl NVARCHAR(1000) NULL,
      PageImageUrl NVARCHAR(1000) NULL,
      NextEpisodeUrl NVARCHAR(1000) NULL,
      PreviousEpisodeUrl NVARCHAR(1000) NULL,
      LocalPlayerOptionsJson NVARCHAR(MAX) NULL,
      ServerOptionsJson NVARCHAR(MAX) NULL,
      DownloadOptionsJson NVARCHAR(MAX) NULL,
      PlayerEmbedsJson NVARCHAR(MAX) NULL,
      VerificationAttemptsJson NVARCHAR(MAX) NULL,
      RawExtractedJson NVARCHAR(MAX) NULL,
      CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      CONSTRAINT UQ_JkAnimeEpisodeSnapshots_EpisodePageUrl UNIQUE (EpisodePageUrl)
    );

    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'DurationSec') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD DurationSec INT NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'DirectMediaUrl') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD DirectMediaUrl NVARCHAR(1000) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'DirectMediaSource') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD DirectMediaSource NVARCHAR(255) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'DirectMediaFormat') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD DirectMediaFormat NVARCHAR(50) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'PrimaryVideoUrl') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD PrimaryVideoUrl NVARCHAR(1000) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'PrimaryVideoSource') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD PrimaryVideoSource NVARCHAR(255) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'VideoSrcUrl') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD VideoSrcUrl NVARCHAR(2000) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'VideoSrcSource') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD VideoSrcSource NVARCHAR(255) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'VideoSrcReferer') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD VideoSrcReferer NVARCHAR(1000) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'VerifiedVideoUrl') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD VerifiedVideoUrl NVARCHAR(1000) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'VerifiedVideoSource') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD VerifiedVideoSource NVARCHAR(255) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'VerifiedVideoKind') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD VerifiedVideoKind NVARCHAR(100) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'VerifiedVideoContentType') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD VerifiedVideoContentType NVARCHAR(255) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'VerifiedVideoStatusCode') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD VerifiedVideoStatusCode INT NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'VerifiedVideoReferer') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD VerifiedVideoReferer NVARCHAR(1000) NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'IntroStartSec') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD IntroStartSec INT NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'IntroEndSec') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD IntroEndSec INT NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'OutroStartSec') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD OutroStartSec INT NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'OutroEndSec') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD OutroEndSec INT NULL;
    IF COL_LENGTH('dbo.JkAnimeEpisodeSnapshots', 'VerificationAttemptsJson') IS NULL
      ALTER TABLE dbo.JkAnimeEpisodeSnapshots ADD VerificationAttemptsJson NVARCHAR(MAX) NULL;
  `);
}

async function ensureSeries(pool, episodeData) {
  const { releaseYear, rating, seriesTitle, seriesSourceRef } = getRuntimeConfig();
  // Cuando la ficha es una temporada de una franquicia, la fila de Series es la
  // de la franquicia entera, no la de esta ficha suelta.
  const tituloSerie = seriesTitle || episodeData.seriesTitle;
  const referencia = seriesSourceRef || `jkanime:${episodeData.seriesSlug}`;

  const existing = await pool
    .request()
    .input('sourceRef', referencia)
    .input('title', tituloSerie)
    .query(`
      SELECT TOP 1 Id
      FROM dbo.Series
      WHERE SourceRef = @sourceRef OR Title = @title
      ORDER BY Id ASC
    `);

  if (existing.recordset.length) {
    const seriesId = existing.recordset[0].Id;

    await pool
      .request()
      .input('id', seriesId)
      .input('title', tituloSerie)
      .input('description', episodeData.seriesSynopsis)
      .input('posterUrl', episodeData.posterUrl)
      .input('backdropUrl', episodeData.ogImageUrl)
      .input('releaseYear', releaseYear)
      .input('rating', rating)
      .input('contentType', 'anime')
      .input('sourceRef', referencia)
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
    .input('title', tituloSerie)
    .input('description', episodeData.seriesSynopsis)
    .input('posterUrl', episodeData.posterUrl)
    .input('backdropUrl', episodeData.ogImageUrl)
    .input('releaseYear', releaseYear)
    .input('rating', rating)
    .input('contentType', 'anime')
    .input('sourceRef', referencia)
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

async function ensureSeason(pool, seriesId) {
  const config = getRuntimeConfig();
  // Cada ficha del sitio de origen entra como una temporada de la franquicia:
  // las numeradas van 1, 2, 3…, y las OVAs, especiales y películas ocupan
  // números altos para quedar al final de la lista.
  const seasonNumber = config.seasonNumber != null ? config.seasonNumber : 1;
  const seasonTitle = config.seasonTitle || `Temporada ${seasonNumber}`;
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

async function ensureEpisode(pool, seasonId, episodeData, timingData) {
  const provider =
    episodeData.verifiedVideoContentType &&
    /mpegurl/i.test(episodeData.verifiedVideoContentType)
      ? 'hls'
      : 'file';

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
      .input('title', episodeData.episodeTitle)
      .input('description', episodeData.metaDescription)
      .input('videoUrl', episodeData.verifiedVideoUrl || null)
      .input('provider', provider)
      .input('thumbnailUrl', episodeData.pageImageUrl || episodeData.ogImageUrl)
      .input('durationSec', timingData && timingData.durationSec != null ? timingData.durationSec : null)
      .input('introStartSec', timingData && timingData.introStartSec != null ? timingData.introStartSec : null)
      .input('introEndSec', timingData && timingData.introEndSec != null ? timingData.introEndSec : null)
      .input('outroStartSec', timingData && timingData.outroStartSec != null ? timingData.outroStartSec : null)
      .query(`
        UPDATE dbo.Episodes
        SET
          Title = @title,
          Description = @description,
          VideoUrl = @videoUrl,
          Provider = @provider,
          ThumbnailUrl = @thumbnailUrl,
          DurationSec = @durationSec,
          IntroStartSec = @introStartSec,
          IntroEndSec = @introEndSec,
          OutroStartSec = @outroStartSec
        WHERE Id = @id
      `);
    return episodeId;
  }

  const inserted = await pool
    .request()
    .input('seasonId', seasonId)
    .input('episodeNumber', episodeData.episodeNumber)
    .input('title', episodeData.episodeTitle)
    .input('description', episodeData.metaDescription)
    .input('videoUrl', episodeData.verifiedVideoUrl || null)
    .input('provider', provider)
    .input('thumbnailUrl', episodeData.pageImageUrl || episodeData.ogImageUrl)
    .input('durationSec', timingData && timingData.durationSec != null ? timingData.durationSec : null)
    .input('introStartSec', timingData && timingData.introStartSec != null ? timingData.introStartSec : null)
    .input('introEndSec', timingData && timingData.introEndSec != null ? timingData.introEndSec : null)
    .input('outroStartSec', timingData && timingData.outroStartSec != null ? timingData.outroStartSec : null)
    .query(`
      INSERT INTO dbo.Episodes (
        SeasonId,
        EpisodeNumber,
        Title,
        Description,
        VideoUrl,
        Provider,
        ThumbnailUrl,
        DurationSec,
        IntroStartSec,
        IntroEndSec,
        OutroStartSec
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
        @durationSec,
        @introStartSec,
        @introEndSec,
        @outroStartSec
      )
    `);

  return inserted.recordset[0].Id;
}

async function upsertSnapshot(pool, episodeData, timingData) {
  const existing = await pool
    .request()
    .input('episodePageUrl', episodeData.episodePageUrl)
    .query(`
      SELECT TOP 1 Id
      FROM dbo.JkAnimeEpisodeSnapshots
      WHERE EpisodePageUrl = @episodePageUrl
    `);

  const payload = {
    sourceSite: episodeData.sourceSite,
    sourceType: episodeData.sourceType,
    jkAnimeAnimeId: episodeData.animeNumericId,
    jkAnimeEpisodeId: episodeData.episodeNumericId,
    seriesName: episodeData.seriesTitle,
    seriesSlug: episodeData.seriesSlug,
    seriesUrl: episodeData.seriesUrl,
    seriesSynopsis: episodeData.seriesSynopsis,
    totalEpisodes: episodeData.totalEpisodes,
    episodeNumber: episodeData.episodeNumber,
    episodeTitle: episodeData.episodeTitle,
    episodePageUrl: episodeData.episodePageUrl,
    directMediaUrl: episodeData.directMediaUrl,
    directMediaSource: episodeData.directMediaSource,
    directMediaFormat: episodeData.directMediaFormat,
    primaryVideoUrl: episodeData.primaryVideoUrl,
    primaryVideoSource: episodeData.primaryVideoSource,
    videoSrcUrl: episodeData.videoSrcUrl,
    videoSrcSource: episodeData.videoSrcSource,
    videoSrcReferer: episodeData.videoSrcReferer,
    verifiedVideoUrl: episodeData.verifiedVideoUrl,
    verifiedVideoSource: episodeData.verifiedVideoSource,
    verifiedVideoKind: episodeData.verifiedVideoKind,
    verifiedVideoContentType: episodeData.verifiedVideoContentType,
    verifiedVideoStatusCode: episodeData.verifiedVideoStatusCode,
    verifiedVideoReferer: episodeData.verifiedVideoReferer,
    durationSec: timingData && timingData.durationSec != null ? timingData.durationSec : null,
    introStartSec: timingData && timingData.introStartSec != null ? timingData.introStartSec : null,
    introEndSec: timingData && timingData.introEndSec != null ? timingData.introEndSec : null,
    outroStartSec: timingData && timingData.outroStartSec != null ? timingData.outroStartSec : null,
    outroEndSec: timingData && timingData.outroEndSec != null ? timingData.outroEndSec : null,
    pageTitle: episodeData.pageTitle,
    metaDescription: episodeData.metaDescription,
    metaKeywords: episodeData.metaKeywords,
    ogTitle: episodeData.ogTitle,
    ogImageUrl: episodeData.ogImageUrl,
    posterUrl: episodeData.posterUrl,
    pageImageUrl: episodeData.pageImageUrl,
    nextEpisodeUrl: episodeData.nextEpisodeUrl,
    previousEpisodeUrl: episodeData.previousEpisodeUrl,
    localPlayerOptionsJson: JSON.stringify(episodeData.localPlayerOptions),
    serverOptionsJson: JSON.stringify(episodeData.serverOptions),
    downloadOptionsJson: JSON.stringify(episodeData.downloadOptions),
    playerEmbedsJson: JSON.stringify(episodeData.playerEmbeds),
    verificationAttemptsJson: JSON.stringify(episodeData.verificationAttempts || []),
    rawExtractedJson: JSON.stringify(episodeData.rawExtractedJson)
  };

  const request = pool.request();
  for (const [key, value] of Object.entries(payload)) {
    request.input(key, value);
  }

  if (existing.recordset.length) {
    request.input('id', existing.recordset[0].Id);
    await request.query(`
      UPDATE dbo.JkAnimeEpisodeSnapshots
      SET
        SourceSite = @sourceSite,
        SourceType = @sourceType,
        JkAnimeAnimeId = @jkAnimeAnimeId,
        JkAnimeEpisodeId = @jkAnimeEpisodeId,
        SeriesName = @seriesName,
        SeriesSlug = @seriesSlug,
        SeriesUrl = @seriesUrl,
        SeriesSynopsis = @seriesSynopsis,
        TotalEpisodes = @totalEpisodes,
        EpisodeNumber = @episodeNumber,
        EpisodeTitle = @episodeTitle,
        DirectMediaUrl = @directMediaUrl,
        DirectMediaSource = @directMediaSource,
        DirectMediaFormat = @directMediaFormat,
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
        DurationSec = @durationSec,
        IntroStartSec = @introStartSec,
        IntroEndSec = @introEndSec,
        OutroStartSec = @outroStartSec,
        OutroEndSec = @outroEndSec,
        PageTitle = @pageTitle,
        MetaDescription = @metaDescription,
        MetaKeywords = @metaKeywords,
        OgTitle = @ogTitle,
        OgImageUrl = @ogImageUrl,
        PosterUrl = @posterUrl,
        PageImageUrl = @pageImageUrl,
        NextEpisodeUrl = @nextEpisodeUrl,
        PreviousEpisodeUrl = @previousEpisodeUrl,
        LocalPlayerOptionsJson = @localPlayerOptionsJson,
        ServerOptionsJson = @serverOptionsJson,
        DownloadOptionsJson = @downloadOptionsJson,
        PlayerEmbedsJson = @playerEmbedsJson,
        VerificationAttemptsJson = @verificationAttemptsJson,
        RawExtractedJson = @rawExtractedJson,
        UpdatedAt = SYSUTCDATETIME()
      WHERE Id = @id
    `);
    return existing.recordset[0].Id;
  }

  const inserted = await request.query(`
    INSERT INTO dbo.JkAnimeEpisodeSnapshots (
      SourceSite,
      SourceType,
      JkAnimeAnimeId,
      JkAnimeEpisodeId,
      SeriesName,
      SeriesSlug,
      SeriesUrl,
      SeriesSynopsis,
      TotalEpisodes,
      EpisodeNumber,
      EpisodeTitle,
      EpisodePageUrl,
      DirectMediaUrl,
      DirectMediaSource,
      DirectMediaFormat,
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
      DurationSec,
      IntroStartSec,
      IntroEndSec,
      OutroStartSec,
      OutroEndSec,
      PageTitle,
      MetaDescription,
      MetaKeywords,
      OgTitle,
      OgImageUrl,
      PosterUrl,
      PageImageUrl,
      NextEpisodeUrl,
      PreviousEpisodeUrl,
      LocalPlayerOptionsJson,
      ServerOptionsJson,
      DownloadOptionsJson,
      PlayerEmbedsJson,
      VerificationAttemptsJson,
      RawExtractedJson
    )
    OUTPUT INSERTED.Id
    VALUES (
      @sourceSite,
      @sourceType,
      @jkAnimeAnimeId,
      @jkAnimeEpisodeId,
      @seriesName,
      @seriesSlug,
      @seriesUrl,
      @seriesSynopsis,
      @totalEpisodes,
      @episodeNumber,
      @episodeTitle,
      @episodePageUrl,
      @directMediaUrl,
      @directMediaSource,
      @directMediaFormat,
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
      @durationSec,
      @introStartSec,
      @introEndSec,
      @outroStartSec,
      @outroEndSec,
      @pageTitle,
      @metaDescription,
      @metaKeywords,
      @ogTitle,
      @ogImageUrl,
      @posterUrl,
      @pageImageUrl,
      @nextEpisodeUrl,
      @previousEpisodeUrl,
      @localPlayerOptionsJson,
      @serverOptionsJson,
      @downloadOptionsJson,
      @playerEmbedsJson,
      @verificationAttemptsJson,
      @rawExtractedJson
    )
  `);

  return inserted.recordset[0].Id;
}

async function main(options = {}) {
  runtimeConfig = buildRuntimeConfig(options);
  const html = await fetchEpisodeHtml();
  const episodeData = parseEpisodeData(html);
  const verificationData = await resolveVerifiedVideo(episodeData);
  Object.assign(episodeData, verificationData);

  // Se comprueba antes de tocar la base: si ningun servidor entrego un video
  // reproducible, guardar la fila solo mete un episodio muerto en el catalogo.
  if (!episodeData.verifiedVideoUrl || episodeData.verifiedVideoUrl === NO_VIDEO_FOUND) {
    throw new Error(
      `Ningun servidor entrego un video reproducible para ${episodeData.episodePageUrl}` +
        ` (se probaron ${
          episodeData.verificationAttempts ? episodeData.verificationAttempts.length : 0
        } fuentes). No se guardo nada.`
    );
  }
  const timingData = await fetchAniSkipTimings(episodeData.episodeNumber);

  const pool = await getPool();

  try {
    await ensureSnapshotTable(pool);
    const seriesId = await ensureSeries(pool, episodeData);
    const seasonId = await ensureSeason(pool, seriesId);
    const episodeId = await ensureEpisode(pool, seasonId, episodeData, timingData);
    const snapshotId = await upsertSnapshot(pool, episodeData, timingData);

    const result = {
      database: 'StreamFlix',
      seriesId,
      seasonId,
      episodeId,
      snapshotId,
      savedEpisodeUrl: episodeData.episodePageUrl,
      savedDirectMediaUrl: episodeData.directMediaUrl,
      savedDirectMediaSource: episodeData.directMediaSource,
      savedDirectMediaFormat: episodeData.directMediaFormat,
      savedPrimaryVideoUrl: episodeData.primaryVideoUrl,
      savedPrimaryVideoSource: episodeData.primaryVideoSource,
      savedVideoSrcUrl: episodeData.videoSrcUrl,
      savedVideoSrcSource: episodeData.videoSrcSource,
      savedVideoSrcReferer: episodeData.videoSrcReferer,
      savedVerifiedVideoUrl: episodeData.verifiedVideoUrl,
      savedVerifiedVideoSource: episodeData.verifiedVideoSource,
      savedVerifiedVideoKind: episodeData.verifiedVideoKind,
      savedVerifiedVideoContentType: episodeData.verifiedVideoContentType,
      savedVerifiedVideoStatusCode: episodeData.verifiedVideoStatusCode,
      savedVerifiedVideoReferer: episodeData.verifiedVideoReferer,
      seriesName: episodeData.seriesTitle,
      episodeTitle: episodeData.episodeTitle,
      durationSec: timingData && timingData.durationSec != null ? timingData.durationSec : null,
      introStartSec: timingData && timingData.introStartSec != null ? timingData.introStartSec : null,
      introEndSec: timingData && timingData.introEndSec != null ? timingData.introEndSec : null,
      outroStartSec: timingData && timingData.outroStartSec != null ? timingData.outroStartSec : null,
      outroEndSec: timingData && timingData.outroEndSec != null ? timingData.outroEndSec : null,
      serversCaptured: episodeData.serverOptions.length,
      embedsCaptured: episodeData.playerEmbeds.length,
      timingSource: (timingData && timingData.source) || null
    };

    if (options.emitJson !== false) {
      console.log(JSON.stringify(result, null, 2));
    }

    return result;
  } finally {
    await pool.close();
    poolPromise = null;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

// Los helpers de red y de conexion se comparten con el importador de PelisPlusHD
// para no duplicar la logica de verificacion de video ni la del pool.
async function closePool() {
  if (!poolPromise) {
    return;
  }

  const pending = poolPromise;
  poolPromise = null;
  const pool = await pending.catch(() => null);
  if (pool) {
    await pool.close();
  }
}

module.exports = {
  main,
  getPool,
  closePool,
  requestUrl,
  fetchText,
  probeVideoUrl,
  extractMediaUrlsFromHtml,
  normalizeUrl,
  looksLikeVideoFile,
  isVideoContentType,
  cleanText,
  decodeHtml,
  matchOne,
  matchAll,
  sleep,
  USER_AGENT,
  NO_VIDEO_FOUND
};
