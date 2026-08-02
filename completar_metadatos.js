#!/usr/bin/env node

// Rellena portada y sinopsis de los títulos que entraron sin ellas.
//
// No todas las fuentes de vídeo traen metadatos: Gnula devuelve la ficha
// recortada y Pelismart va por embed, así que esos títulos quedan pelados en el
// catálogo. Los datos sí están en AniList y Wikidata, que ya se usan para
// /pide, y de ahí se completan.
//
// Uso:
//   node completar_metadatos.js            solo enseña lo que haría
//   node completar_metadatos.js --aplicar  escribe en la base

const { getPool, closePool, fetchText } = require('./save_episode_url_to_streamflix.js');
const { resolveAdapter, buildTitleUrl } = require('./save_pelisplus_to_streamflix.js');
const { buscarFicha } = require('./fuentes_catalogo.js');

// Misma lista y mismo orden que el importador. Un sitio puede tener la ficha
// —con su portada y su sinopsis en español— aunque no tenga video que
// funcione, y hasta ahora esa página se descartaba entera junto con el vídeo
// que le faltaba.
const SITIOS = ['https://ww9.cuevana3.to/', 'https://www.pelisplushd.la/', 'https://www2.gnula.one/'];

async function buscarEnLosSitios(titulo, contentType) {
  const tipo = contentType === 'series' ? 'series' : 'movie';

  for (const baseUrl of SITIOS) {
    try {
      const url = buildTitleUrl({ baseUrl, contentType: tipo, title: titulo });
      if (!url) continue;

      const html = await fetchText(url);
      const ficha = resolveAdapter(url).parseTitleMetadata(html, url);
      if (ficha?.posterUrl || ficha?.synopsis) {
        return {
          posterUrl: ficha.posterUrl || null,
          sinopsis: ficha.synopsis || null,
          fuente: new URL(baseUrl).hostname
        };
      }
    } catch {
      // Ese sitio no la tiene o no respondió: se prueba el siguiente.
    }
  }

  return null;
}

const aplicar = process.argv.includes('--aplicar');

async function main() {
  const pool = await getPool();

  try {
    const pendientes = await pool.request().query(`
      SELECT Id, Title, ContentType, PosterUrl, Description
        FROM dbo.Series
       WHERE PosterUrl IS NULL OR LTRIM(RTRIM(PosterUrl)) = ''
          OR Description IS NULL OR LTRIM(RTRIM(Description)) = ''
       ORDER BY Id
    `);

    if (!pendientes.recordset.length) {
      console.log('No hay títulos sin portada ni sinopsis.');
      return;
    }

    console.log(`${pendientes.recordset.length} título(s) por completar${aplicar ? '' : ' (simulación)'}\n`);
    let arreglados = 0;

    for (const fila of pendientes.recordset) {
      const falta = [];
      if (!fila.PosterUrl) falta.push('portada');
      if (!fila.Description) falta.push('sinopsis');

      const esAnime = fila.ContentType === 'anime';
      let ficha = null;
      try {
        // Primero los sitios de la cadena, que traen el dato en español y con
        // el mismo título que se importó. AniList y Wikidata cubren el resto.
        if (!esAnime) ficha = await buscarEnLosSitios(fila.Title, fila.ContentType);
        if (!ficha) ficha = await buscarFicha({ titulo: fila.Title, tipo: esAnime ? 'anime' : 'cine' });
      } catch (error) {
        console.log(`  #${fila.Id} ${fila.Title} — no pude consultar: ${error.message}`);
        continue;
      }

      // Solo se escribe lo que falta: lo que ya trajo la fuente de vídeo manda,
      // porque suele venir en español y coincidir con el título importado.
      const poster = !fila.PosterUrl && ficha?.posterUrl ? ficha.posterUrl : null;
      const sinopsis = !fila.Description && ficha?.sinopsis ? ficha.sinopsis : null;

      if (!poster && !sinopsis) {
        console.log(`  #${fila.Id} ${fila.Title} — sin datos en ${ficha?.fuente || 'ninguna fuente'} (falta ${falta.join(' y ')})`);
        continue;
      }

      if (aplicar) {
        const peticion = pool.request().input('id', fila.Id);
        const sets = [];
        if (poster) {
          peticion.input('poster', poster);
          sets.push('PosterUrl = @poster');
        }
        if (sinopsis) {
          peticion.input('sinopsis', sinopsis.slice(0, 1900));
          sets.push('Description = @sinopsis');
        }
        await peticion.query(`UPDATE dbo.Series SET ${sets.join(', ')} WHERE Id = @id`);
      }

      arreglados += 1;
      const puesto = [poster ? 'portada' : null, sinopsis ? 'sinopsis' : null].filter(Boolean).join(' + ');
      console.log(`  #${fila.Id} ${fila.Title} — ${puesto} desde ${ficha.fuente}`);
    }

    console.log(`\n${arreglados} completado(s)${aplicar ? '' : '. Repite con --aplicar para escribirlo.'}`);
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
