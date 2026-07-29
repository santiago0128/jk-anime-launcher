#!/usr/bin/env node

const dotenv = require('/Users/santiagoguevaragalindo/Code/streamflix/node_modules/dotenv');

dotenv.config({ path: '/Users/santiagoguevaragalindo/Code/streamflix/.env' });

const { getPool } = require('/Users/santiagoguevaragalindo/Code/streamflix/server/db');

async function main() {
  const pool = await getPool();

  try {
    const result = await pool.request().query(`
      SELECT
        TOP 1
        Id,
        SeriesName,
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
        TotalEpisodes,
        DurationSec,
        IntroStartSec,
        IntroEndSec,
        OutroStartSec,
        NextEpisodeUrl,
        PreviousEpisodeUrl,
        JkAnimeAnimeId,
        JkAnimeEpisodeId,
        UpdatedAt
      FROM dbo.JkAnimeEpisodeSnapshots
      WHERE SeriesSlug = 'dragon-ball-z' AND EpisodeNumber = 1
      ORDER BY UpdatedAt DESC
    `);

    console.log(JSON.stringify(result.recordset, null, 2));
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
