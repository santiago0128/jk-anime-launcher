#!/usr/bin/env node

const https = require('https');
const path = require('path');
const readline = require('readline');
const { main: saveEpisode } = require('./save_episode_url_to_streamflix.js');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    args[key] = value;
    i += 1;
  }

  return args;
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

  const parsedUrl = new URL(normalizedUrl);
  const slug = parsedUrl.pathname.split('/').filter(Boolean)[0];
  const rawTitle = titleMatch ? cleanText(titleMatch[1]) : titleFromSlug(slug);
  const title = rawTitle.replace(/\s+Sub Español.*$/i, '').trim();
  const totalEpisodes = totalEpisodesMatch ? Number(totalEpisodesMatch[1]) : null;

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

async function findAniListId(seriesName) {
  try {
    const query = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          id
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
      id: media.id,
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
    emitJson: false
  }).catch((error) => {
    throw new Error(`Fallo el episodio ${episodeNumber}: ${error.message || String(error)}`);
  });
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolveInteractiveArgs(args) {
  if (args['series-name'] || args['series-url']) {
    return args;
  }

  const seriesUrl = await ask('Pega la URL de la serie de JK Anime que quieres cargar en la base de datos: ');
  if (!seriesUrl) {
    throw new Error('No enviaste una URL de serie.');
  }

  return {
    ...args,
    'series-url': seriesUrl
  };
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2));
  const args = await resolveInteractiveArgs(rawArgs);
  const seriesName = args['series-name'];
  const seriesUrlArg = args['series-url'];

  let start = Number(args.start || 1);
  let end = Number(args.end || start);

  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
    throw new Error('Los parametros --start y --end deben ser enteros validos.');
  }

  let jkSeries;
  if (seriesUrlArg) {
    jkSeries = await getSeriesMetadataFromUrl(seriesUrlArg);
    if (!args.end && jkSeries.totalEpisodes) {
      end = jkSeries.totalEpisodes;
    }
  } else if (seriesName) {
    jkSeries = await findSeriesOnJkAnime(seriesName);
  } else {
    throw new Error('Debes enviar --series-name "Nombre de la serie" o --series-url "https://jkanime.net/serie/".');
  }

  const aniList = await findAniListId(jkSeries.title || seriesName || titleFromSlug(jkSeries.slug));

  const config = {
    seriesName: jkSeries.title,
    seriesUrl: jkSeries.url.endsWith('/') ? jkSeries.url : `${jkSeries.url}/`,
    seriesSlug: slugFromUrl(jkSeries.url),
    aniskipId: aniList?.id || null,
    releaseYear: aniList?.releaseYear || null,
    rating: aniList?.rating || null
  };

  const imported = [];
  for (let episodeNumber = start; episodeNumber <= end; episodeNumber += 1) {
    const result = await importEpisode(config, episodeNumber);
    imported.push({
      episodeNumber,
      episodeId: result.episodeId,
      snapshotId: result.snapshotId,
      primaryVideoUrl: result.savedPrimaryVideoUrl,
      primaryVideoSource: result.savedPrimaryVideoSource,
      durationSec: result.durationSec
    });
  }

  console.log(
    JSON.stringify(
      {
        seriesName: config.seriesName,
        seriesSlug: config.seriesSlug,
        seriesUrl: config.seriesUrl,
        totalEpisodesDetected: jkSeries.totalEpisodes || null,
        aniskipId: config.aniskipId,
        releaseYear: config.releaseYear,
        rating: config.rating,
        importedRange: { start, end },
        importedCount: imported.length,
        imported
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
