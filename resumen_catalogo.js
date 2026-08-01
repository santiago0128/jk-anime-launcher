#!/usr/bin/env node

// Resumen de lo que hay en el catálogo. Sale en texto plano porque lo consume
// el bot de Telegram, que no puede pintar tablas.

const { getPool, closePool } = require('./save_episode_url_to_streamflix.js');

const ETIQUETAS = { anime: 'Animes', series: 'Series', movie: 'Películas' };

async function main() {
  const pool = await getPool();

  try {
    const totales = await pool.request().query(`
      SELECT s.ContentType,
             COUNT(DISTINCT s.Id) AS Titulos,
             COUNT(e.Id) AS Episodios
        FROM dbo.Series s
        LEFT JOIN dbo.Seasons se ON se.SeriesId = s.Id
        LEFT JOIN dbo.Episodes e ON e.SeasonId = se.Id
       GROUP BY s.ContentType
    `);

    const porTitulo = await pool.request().query(`
      SELECT TOP 40 s.Title, s.ContentType, COUNT(e.Id) AS Episodios
        FROM dbo.Series s
        LEFT JOIN dbo.Seasons se ON se.SeriesId = s.Id
        LEFT JOIN dbo.Episodes e ON e.SeasonId = se.Id
       GROUP BY s.Title, s.ContentType
       ORDER BY COUNT(e.Id) DESC
    `);

    const lineas = [];
    let episodios = 0;
    let titulos = 0;

    for (const fila of totales.recordset) {
      lineas.push(`${(ETIQUETAS[fila.ContentType] || fila.ContentType).padEnd(10)} ${String(fila.Titulos).padStart(3)} títulos  ${String(fila.Episodios).padStart(5)} cap`);
      episodios += fila.Episodios;
      titulos += fila.Titulos;
    }

    lineas.push('');
    lineas.push(`TOTAL      ${String(titulos).padStart(3)} títulos  ${String(episodios).padStart(5)} cap`);
    lineas.push('');

    for (const fila of porTitulo.recordset) {
      lineas.push(`${String(fila.Episodios).padStart(4)}  ${fila.Title.slice(0, 34)}`);
    }

    console.log(lineas.join('\n'));
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
