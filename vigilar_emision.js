#!/usr/bin/env node

// Vigila los animes en emision y trae los capitulos nuevos segun salen.
//
// La idea: un anime en emision estrena un capitulo por semana, siempre el mismo
// dia. AniList publica ese calendario (`nextAiringEpisode`), asi que no hay que
// adivinarlo ni ir mirando la web: se guarda cuando toca el siguiente y un cron
// pasa cada hora a ver si ya salio.
//
// Por que se guarda el calendario en la base y no se pregunta cada vez:
//   - deja ver en la ficha "capitulo 3, el sabado", que es lo que uno quiere saber;
//   - si AniList no responde un dia, seguimos sabiendo cuando toca;
//   - y queda registro de por donde iba la importacion.
//
// Uso:
//   node vigilar_emision.js --registrar "Bleach"     apunta una serie del catalogo
//   node vigilar_emision.js --listar                 que hay vigilado y cuando toca
//   node vigilar_emision.js --olvidar "Bleach"       deja de vigilarla
//   node vigilar_emision.js                          revisa y trae lo que haya salido
//                                                    (esto es lo que lanza el cron)
//
// Variables:
//   EMISION_MARGEN_MIN   minutos de cortesia tras la hora de estreno antes de
//                        intentar la descarga. Por defecto 45: el sitio de
//                        origen no publica en el mismo minuto que la television.
//   EMISION_MAX_INTENTOS cuantas veces se reintenta un capitulo que aun no esta
//                        antes de dejarlo para la semana siguiente. Por defecto 8.

const path = require('path');
const fs = require('fs');

const raizStreamflix = process.env.STREAMFLIX_ROOT;
if (raizStreamflix && fs.existsSync(path.join(raizStreamflix, '.env'))) {
  require('dotenv').config({ path: path.join(raizStreamflix, '.env') });
}

const { getPool, closePool } = require('./save_episode_url_to_streamflix.js');
const { main: importarAnime } = require('./save_episode_url_to_streamflix.js');
const { enviarMensaje } = require('./telegram_notify.js');

const ANILIST_API = 'https://graphql.anilist.co';
const MARGEN_MIN = Number(process.env.EMISION_MARGEN_MIN) || 45;
const MAX_INTENTOS = Number(process.env.EMISION_MAX_INTENTOS) || 8;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const log = (texto) => process.stderr.write(`${texto}\n`);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const clave = token.slice(2);
    const siguiente = argv[i + 1];
    if (siguiente === undefined || siguiente.startsWith('--')) {
      args[clave] = 'true';
      continue;
    }
    args[clave] = siguiente;
    i += 1;
  }
  return args;
}

// ---------------------------------------------------------------- AniList

const CONSULTA = `query ($busqueda: String) {
  Page(perPage: 10) {
    media(search: $busqueda, type: ANIME, sort: POPULARITY_DESC) {
      id idMal status episodes
      title { romaji english native }
      nextAiringEpisode { episode airingAt }
    }
  }
}`;

async function anilist(busqueda) {
  const respuesta = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: CONSULTA, variables: { busqueda } })
  });

  if (!respuesta.ok) throw new Error(`AniList respondió ${respuesta.status}`);
  const datos = await respuesta.json();
  if (datos.errors) throw new Error(`AniList: ${datos.errors[0]?.message || 'error'}`);
  return datos?.data?.Page?.media || [];
}

// De todo lo que devuelve la busqueda interesa lo que esta emitiendose ahora.
// Un titulo como "Bleach" trae media docena de entradas —la original, cada arco,
// las peliculas— y solo una de ellas esta al aire.
function elegirEnEmision(candidatos, preferido) {
  const emitiendo = candidatos.filter((m) => m.status === 'RELEASING' && m.nextAiringEpisode);
  if (!emitiendo.length) return null;

  if (preferido) {
    const buscado = preferido.toLowerCase();
    const exacto = emitiendo.find((m) =>
      [m.title.romaji, m.title.english, m.title.native]
        .filter(Boolean)
        .some((t) => t.toLowerCase().includes(buscado)));
    if (exacto) return exacto;
  }

  // Sin preferencia, el que antes estrene: es el que de verdad esta en marcha.
  return emitiendo.sort((a, b) => a.nextAiringEpisode.airingAt - b.nextAiringEpisode.airingAt)[0];
}

const tituloDe = (media) => media.title.romaji || media.title.english || media.title.native;

// ---------------------------------------------------------------- Base de datos

// Tabla propia en vez de columnas en Series: esto es un estado de seguimiento
// (por donde va, cuando se miro por ultima vez, cuantos intentos lleva) y no una
// propiedad del titulo. Asi Series sigue describiendo la serie y nada mas.
async function asegurarTabla(pool) {
  await pool.request().query(`
    IF OBJECT_ID('dbo.AnimeEmision', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.AnimeEmision (
        Id                INT IDENTITY(1,1) PRIMARY KEY,
        SeriesId          INT NOT NULL,
        AniListId         INT NULL,
        TituloAniList     NVARCHAR(300) NULL,
        Estado            NVARCHAR(30) NULL,
        DiaSemana         TINYINT NULL,
        HoraUtc           NVARCHAR(5) NULL,
        ProximoEpisodio   INT NULL,
        ProximoEnUtc      DATETIME2 NULL,
        UltimoImportado   INT NULL,
        Intentos          INT NOT NULL CONSTRAINT DF_AnimeEmision_Intentos DEFAULT 0,
        UltimaRevision    DATETIME2 NULL,
        UltimoResultado   NVARCHAR(400) NULL,
        Activo            BIT NOT NULL CONSTRAINT DF_AnimeEmision_Activo DEFAULT 1,
        CreadoEn          DATETIME2 NOT NULL CONSTRAINT DF_AnimeEmision_CreadoEn DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_AnimeEmision_Series FOREIGN KEY (SeriesId) REFERENCES dbo.Series(Id),
        CONSTRAINT UQ_AnimeEmision_Series UNIQUE (SeriesId)
      );
    END

    -- Una temporada nueva no siempre vive donde la serie original. El arco en
    -- emision de Bleach es otra entrada en jkanime
    -- (bleach-sennen-kessen-hen-kashin-tan) y sus capitulos empiezan otra vez
    -- por el 1, mientras la serie del catalogo va por el 366. Sin guardar de
    -- que slug se baja y a que temporada entra, el vigilante comparaba el
    -- capitulo 3 de AniList contra los 366 del catalogo, concluia "al dia" y no
    -- descargaba nada.
    IF COL_LENGTH('dbo.AnimeEmision', 'SlugOrigen') IS NULL
      ALTER TABLE dbo.AnimeEmision ADD SlugOrigen NVARCHAR(200) NULL;
    IF COL_LENGTH('dbo.AnimeEmision', 'SeasonNumber') IS NULL
      ALTER TABLE dbo.AnimeEmision ADD SeasonNumber INT NULL;
  `);
}

async function buscarSerie(pool, titulo) {
  const resultado = await pool
    .request()
    .input('titulo', titulo)
    .query(`
      SELECT TOP 5 Id, Title, ContentType, SourceRef
      FROM dbo.Series
      WHERE ContentType = 'anime' AND (Title = @titulo OR Title LIKE '%' + @titulo + '%')
      ORDER BY CASE WHEN Title = @titulo THEN 0 ELSE 1 END, Id
    `);
  return resultado.recordset;
}

// Con temporada, se cuenta dentro de ella: los capitulos de un arco nuevo
// empiezan por el 1 y compararlos con el maximo de toda la serie no dice nada.
async function ultimoEpisodioEn(pool, seriesId, seasonNumber) {
  const peticion = pool.request().input('id', seriesId);
  let filtro = 'se.SeriesId = @id';

  if (seasonNumber != null) {
    peticion.input('temporada', seasonNumber);
    filtro += ' AND se.SeasonNumber = @temporada';
  }

  const resultado = await peticion.query(`
    SELECT ISNULL(MAX(e.EpisodeNumber), 0) AS Ultimo
    FROM dbo.Episodes e JOIN dbo.Seasons se ON se.Id = e.SeasonId
    WHERE ${filtro}
  `);
  return resultado.recordset[0].Ultimo;
}

async function vigiladas(pool, soloActivas = true) {
  const resultado = await pool.request().query(`
    SELECT v.*, s.Title, s.SourceRef
    FROM dbo.AnimeEmision v JOIN dbo.Series s ON s.Id = v.SeriesId
    ${soloActivas ? 'WHERE v.Activo = 1' : ''}
    ORDER BY v.ProximoEnUtc
  `);
  return resultado.recordset;
}

async function guardarCalendario(pool, seriesId, media, ultimoImportado, origen = {}) {
  const siguiente = media.nextAiringEpisode;
  const cuando = siguiente ? new Date(siguiente.airingAt * 1000) : null;

  await pool
    .request()
    .input('seriesId', seriesId)
    .input('aniListId', media.id)
    .input('titulo', tituloDe(media))
    .input('estado', media.status)
    .input('dia', cuando ? cuando.getUTCDay() : null)
    .input('hora', cuando ? cuando.toISOString().slice(11, 16) : null)
    .input('proximoEp', siguiente ? siguiente.episode : null)
    .input('proximoEn', cuando)
    .input('ultimo', ultimoImportado)
    .query(`
      MERGE dbo.AnimeEmision AS destino
      USING (SELECT @seriesId AS SeriesId) AS origen ON destino.SeriesId = origen.SeriesId
      WHEN MATCHED THEN UPDATE SET
        AniListId = @aniListId, TituloAniList = @titulo, Estado = @estado,
        DiaSemana = @dia, HoraUtc = @hora, ProximoEpisodio = @proximoEp,
        ProximoEnUtc = @proximoEn, UltimoImportado = @ultimo, UltimaRevision = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (SeriesId, AniListId, TituloAniList, Estado, DiaSemana, HoraUtc,
         ProximoEpisodio, ProximoEnUtc, UltimoImportado, UltimaRevision)
        VALUES (@seriesId, @aniListId, @titulo, @estado, @dia, @hora,
                @proximoEp, @proximoEn, @ultimo, SYSUTCDATETIME());
    `);

  // Después del MERGE, que en un alta es quien crea la fila. El origen solo lo
  // fija el registro: AniList no sabe nada de slugs de jkanime, así que una
  // revisión no debe tocarlo.
  if (origen.slug !== undefined || origen.temporada !== undefined) {
    await pool
      .request()
      .input('seriesId', seriesId)
      .input('slug', origen.slug ?? null)
      .input('temporada', origen.temporada ?? null)
      .query(`
        UPDATE dbo.AnimeEmision SET SlugOrigen = @slug, SeasonNumber = @temporada
        WHERE SeriesId = @seriesId
      `);
  }
}

async function anotarRevision(pool, id, { resultado, intentos, ultimoImportado }) {
  const peticion = pool.request().input('id', id).input('resultado', String(resultado).slice(0, 400));
  let sets = 'UltimaRevision = SYSUTCDATETIME(), UltimoResultado = @resultado';

  if (intentos != null) { peticion.input('intentos', intentos); sets += ', Intentos = @intentos'; }
  if (ultimoImportado != null) { peticion.input('ultimo', ultimoImportado); sets += ', UltimoImportado = @ultimo'; }

  await peticion.query(`UPDATE dbo.AnimeEmision SET ${sets} WHERE Id = @id`);
}

// ---------------------------------------------------------------- Acciones

async function registrar(pool, titulo, preferido, opciones = {}) {
  const series = await buscarSerie(pool, titulo);
  if (!series.length) {
    throw new Error(`No hay ningún anime en el catálogo que se parezca a "${titulo}". Impórtalo primero.`);
  }
  const serie = series[0];

  const candidatos = await anilist(preferido || serie.Title);
  const media = elegirEnEmision(candidatos, preferido);
  if (!media) {
    const vistos = candidatos.slice(0, 4).map((m) => `${tituloDe(m)} (${m.status})`).join(', ');
    throw new Error(
      `AniList no da ninguna temporada en emisión para "${serie.Title}".` +
      (vistos ? ` Encontré: ${vistos}. Si la que buscas se llama distinto, pásala con --anilist "<nombre>".` : '')
    );
  }

  const slug = opciones.slug || (String(serie.SourceRef || '').startsWith('jkanime:')
    ? String(serie.SourceRef).slice('jkanime:'.length)
    : null);
  const temporada = opciones.temporada != null ? Number(opciones.temporada) : null;

  const ultimo = await ultimoEpisodioEn(pool, serie.Id, temporada);
  await guardarCalendario(pool, serie.Id, media, ultimo, { slug, temporada });

  const proximo = media.nextAiringEpisode.episode;
  const cuando = new Date(media.nextAiringEpisode.airingAt * 1000);

  // El aviso que hace falta: si AniList va por el capitulo 3 y el catalogo tiene
  // 366, no es que falten 363 — es que cada uno cuenta una cosa distinta, y sin
  // decir la temporada destino el vigilante se quedaria de brazos cruzados.
  const descuadre = proximo - 1 <= ultimo && ultimo > proximo
    ? `La numeración no cuadra: AniList va por el capítulo ${proximo} y en el catálogo hay ${ultimo}. ` +
      'Casi seguro que esta temporada se guarda aparte: registra con --slug <slug-de-jkanime> ' +
      'y --temporada <nº de temporada>, o el vigilante creerá que está al día.'
    : null;

  return {
    serie: serie.Title,
    seriesId: serie.Id,
    anilist: tituloDe(media),
    slugOrigen: slug,
    temporadaDestino: temporada,
    proximoEpisodio: proximo,
    dia: DIAS[cuando.getUTCDay()],
    cuando: cuando.toISOString(),
    enCatalogo: ultimo,
    aviso: descuadre
  };
}

async function olvidar(pool, titulo) {
  const series = await buscarSerie(pool, titulo);
  if (!series.length) throw new Error(`No encontré "${titulo}" en el catálogo.`);
  const resultado = await pool
    .request()
    .input('id', series[0].Id)
    .query('UPDATE dbo.AnimeEmision SET Activo = 0 WHERE SeriesId = @id');
  if (!resultado.rowsAffected[0]) throw new Error(`"${series[0].Title}" no estaba vigilada.`);
  return series[0].Title;
}

// El corazon del cron. Para cada serie vigilada: refresca el calendario en
// AniList y, si hay capitulos emitidos que no tenemos, los trae.
async function revisar(pool) {
  const lista = await vigiladas(pool);
  const novedades = [];

  for (const fila of lista) {
    const etiqueta = fila.Title;
    let media = null;

    try {
      const candidatos = await anilist(fila.TituloAniList || etiqueta);
      media = candidatos.find((m) => m.id === fila.AniListId)
        || elegirEnEmision(candidatos, fila.TituloAniList);
    } catch (error) {
      log(`  ${etiqueta}: no pude consultar AniList (${error.message})`);
      await anotarRevision(pool, fila.Id, { resultado: `AniList no respondió: ${error.message}` });
      continue;
    }

    if (!media) {
      await anotarRevision(pool, fila.Id, { resultado: 'AniList ya no la encuentra' });
      continue;
    }

    const enCatalogo = await ultimoEpisodioEn(pool, fila.SeriesId, fila.SeasonNumber);
    await guardarCalendario(pool, fila.SeriesId, media, enCatalogo);

    // Cuantos capitulos deberian existir ya. Si AniList anuncia el 3 para el
    // sabado, es que el 2 ya salio; cuando termina la emision no hay siguiente
    // y valen todos los que tenga.
    const emitidos = media.nextAiringEpisode
      ? media.nextAiringEpisode.episode - 1
      : (media.episodes || enCatalogo);

    if (emitidos <= enCatalogo) {
      await anotarRevision(pool, fila.Id, { resultado: `al día (${enCatalogo}/${emitidos})`, intentos: 0 });
      log(`  ${etiqueta}: al día (${enCatalogo}/${emitidos})`);
      continue;
    }

    // Margen de cortesia: el sitio de origen no sube en el mismo minuto que se
    // emite. Sin esto, el cron se lanza a por un capitulo que aun no existe y
    // gasta los intentos antes de que este disponible.
    if (media.nextAiringEpisode) {
      const salidaUltimo = new Date((media.nextAiringEpisode.airingAt - 7 * 24 * 3600) * 1000);
      const listoDesde = new Date(salidaUltimo.getTime() + MARGEN_MIN * 60000);
      if (Date.now() < listoDesde.getTime()) {
        await anotarRevision(pool, fila.Id, { resultado: `esperando margen hasta ${listoDesde.toISOString().slice(11, 16)} UTC` });
        log(`  ${etiqueta}: el capítulo ${emitidos} acaba de salir; espero el margen`);
        continue;
      }
    }

    if (fila.Intentos >= MAX_INTENTOS) {
      log(`  ${etiqueta}: ${fila.Intentos} intentos fallidos con el capítulo ${enCatalogo + 1}; lo dejo estar`);
      continue;
    }

    // El slug del alta manda: es el de la temporada en emision, que puede ser
    // una entrada distinta a la de la serie original.
    const slug = fila.SlugOrigen || (String(fila.SourceRef || '').startsWith('jkanime:')
      ? String(fila.SourceRef).slice('jkanime:'.length)
      : null);

    if (!slug) {
      await anotarRevision(pool, fila.Id, { resultado: 'sin slug de jkanime en SourceRef' });
      log(`  ${etiqueta}: no sé de dónde bajarla (SourceRef = ${fila.SourceRef || 'vacío'})`);
      continue;
    }

    for (let numero = enCatalogo + 1; numero <= emitidos; numero += 1) {
      const url = `https://jkanime.net/${slug}/${numero}/`;
      log(`  ${etiqueta}: trayendo capítulo ${numero}…`);

      let importado = false;
      let motivo = null;
      try {
        await importarAnime({
          episodeUrl: url,
          // Sin esto el capitulo se guardaria como una serie aparte con el
          // mismo nombre en vez de sumarse a la que ya existe.
          seriesTitle: etiqueta,
          seriesSourceRef: fila.SourceRef,
          // Sin esto, un arco nuevo entraria como temporada suelta en vez de
          // sumarse a la que ya tiene sus capitulos anteriores.
          ...(fila.SeasonNumber != null ? { seasonNumber: fila.SeasonNumber } : {}),
          // AniList ya nos dio el id de MyAnimeList, que es por donde indexa
          // AniSkip: se lo pasamos y el capitulo entra con marcas de intro en
          // vez de sin ellas.
          aniskipAnimeId: media.idMal || null,
          // Su volcado JSON taparia el resumen del vigilante.
          emitJson: false
        });
        importado = true;
      } catch (error) {
        motivo = (error.message || String(error)).slice(0, 200);
      }

      // El importador cierra el pool compartido en su `finally`, pase lo que
      // pase. Sin volver a pedirlo, la siguiente consulta —incluso la de anotar
      // que fue bien— falla con "Connection is closed" y un capítulo que sí se
      // guardó acaba contándose como fallido.
      pool = await getPool();

      if (importado) {
        novedades.push({ serie: etiqueta, episodio: numero });
        await anotarRevision(pool, fila.Id, { resultado: `capítulo ${numero} importado`, intentos: 0, ultimoImportado: numero });
        continue;
      }

      log(`  ${etiqueta}: el capítulo ${numero} todavía no está (${motivo})`);
      await anotarRevision(pool, fila.Id, {
        resultado: `capítulo ${numero} no disponible: ${motivo}`,
        intentos: (fila.Intentos || 0) + 1
      });
      break; // si falta el N, no tiene sentido pedir el N+1
    }
  }

  return novedades;
}

async function avisar(novedades) {
  if (!novedades.length) return;

  const porSerie = new Map();
  for (const n of novedades) {
    if (!porSerie.has(n.serie)) porSerie.set(n.serie, []);
    porSerie.get(n.serie).push(n.episodio);
  }

  const lineas = [...porSerie.entries()].map(([serie, eps]) =>
    `📺 <b>${serie}</b> — capítulo${eps.length > 1 ? 's' : ''} ${eps.join(', ')}`);

  try {
    await enviarMensaje(['<b>Capítulos nuevos</b>', '', ...lineas].join('\n'));
  } catch (error) {
    log(`No pude avisar por Telegram: ${error.message}`);
  }
}

// ---------------------------------------------------------------- Principal

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = await getPool();

  try {
    await asegurarTabla(pool);

    if (args.registrar && args.registrar !== 'true') {
      const alta = await registrar(pool, args.registrar, args.anilist !== 'true' ? args.anilist : null, {
        slug: args.slug !== 'true' ? args.slug : null,
        temporada: args.temporada !== 'true' ? args.temporada : null
      });
      console.log(JSON.stringify(alta, null, 2));
      log(`\n✅ Vigilando "${alta.serie}": capítulo ${alta.proximoEpisodio} los ${alta.dia}.`);
      if (alta.aviso) log(`\n⚠️  ${alta.aviso}`);
      return;
    }

    if (args.olvidar && args.olvidar !== 'true') {
      const nombre = await olvidar(pool, args.olvidar);
      log(`✅ Dejo de vigilar "${nombre}".`);
      return;
    }

    if (args.listar) {
      const lista = await vigiladas(pool, false);
      if (!lista.length) { log('No hay ningún anime vigilado.'); return; }
      console.log(JSON.stringify(lista.map((f) => ({
        serie: f.Title,
        anilist: f.TituloAniList,
        estado: f.Estado,
        dia: f.DiaSemana != null ? DIAS[f.DiaSemana] : null,
        horaUtc: f.HoraUtc,
        proximoEpisodio: f.ProximoEpisodio,
        proximoEnUtc: f.ProximoEnUtc,
        slugOrigen: f.SlugOrigen,
        temporadaDestino: f.SeasonNumber,
        enCatalogo: f.UltimoImportado,
        ultimaRevision: f.UltimaRevision,
        ultimoResultado: f.UltimoResultado,
        activo: Boolean(f.Activo)
      })), null, 2));
      return;
    }

    log(`Revisando animes en emisión…`);
    const novedades = await revisar(pool);
    await avisar(novedades);
    console.log(JSON.stringify({ novedades, revisadoEn: new Date().toISOString() }, null, 2));
    log(novedades.length ? `\n✅ ${novedades.length} capítulo(s) nuevo(s).` : '\nSin novedades.');
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main().catch((error) => {
    log(`❌ ${error.message || error}`);
    process.exit(1);
  });
}

module.exports = { main, revisar, registrar, olvidar, vigiladas, asegurarTabla };
