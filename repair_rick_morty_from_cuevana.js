#!/usr/bin/env node

const https = require('https');
const sql = require('mssql');

function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            ...headers
          }
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve(body));
        }
      )
      .on('error', reject);
  });
}

function cuevanaPreferred(players) {
  const waaw = players.find((url) => /waaw\.to\/f\//i.test(url));
  if (waaw) return waaw.replace('/f/', '/e/');

  const streamwish = players.find((url) => /streamwish\.to\/e\//i.test(url));
  if (streamwish) return streamwish;

  return null;
}

async function main() {
  const pool = await new sql.ConnectionPool({
    server: process.env.DB_SERVER || 'sqlserver',
    port: Number(process.env.DB_PORT) || 1433,
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'StreamFlix',
    options: { encrypt: false, trustServerCertificate: true }
  }).connect();

  const base = 'https://ww9.cuevana3.to';
  const html = await fetch(`${base}/serie/rick-y-morty`);
  const seen = new Set();
  const episodes = [];
  const episodeRegex = /href=["']?(\/episodio\/rick-y-morty-(\d+)x(\d+))["']?/gi;
  let match;

  while ((match = episodeRegex.exec(html))) {
    const path = match[1];
    if (seen.has(path)) continue;
    seen.add(path);
    episodes.push({
      path,
      seasonNumber: Number(match[2]),
      episodeNumber: Number(match[3])
    });
  }

  episodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);

  let updated = 0;
  let skipped = 0;

  for (const episode of episodes) {
    const page = await fetch(`${base}${episode.path}`);
    const players = [];
    const playerRegex =
      /<div class=["']?TPlayerTb["']?[^>]*id=["']?\w+["']?[^>]*>\s*<iframe[^>]*data-src="([^"]+)"/gi;
    let playerMatch;

    while ((playerMatch = playerRegex.exec(page))) {
      players.push(playerMatch[1]);
    }

    const chosen = cuevanaPreferred(players);
    if (!chosen) {
      skipped += 1;
      continue;
    }

    await pool
      .request()
      .input('seriesTitle', sql.NVarChar, 'Rick y Morty')
      .input('seasonNumber', sql.Int, episode.seasonNumber)
      .input('episodeNumber', sql.Int, episode.episodeNumber)
      .input('videoUrl', sql.NVarChar, chosen)
      .input('provider', sql.NVarChar, 'embed')
      .query(`
        UPDATE e
        SET
          e.VideoUrl = @videoUrl,
          e.Provider = @provider
        FROM dbo.Episodes e
        JOIN dbo.Seasons se ON se.Id = e.SeasonId
        JOIN dbo.Series s ON s.Id = se.SeriesId
        WHERE s.Title = @seriesTitle
          AND se.SeasonNumber = @seasonNumber
          AND e.EpisodeNumber = @episodeNumber
      `);

    updated += 1;
  }

  console.log(JSON.stringify({ updated, skipped, total: episodes.length }, null, 2));
  await pool.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
