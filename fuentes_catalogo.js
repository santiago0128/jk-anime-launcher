#!/usr/bin/env node

// De dónde salen los títulos de verdad.
//
// Un modelo de lenguaje sabe entender "todas las de Nolan", pero no sabe
// recitar filmografías: se deja títulos y se inventa otros. Eso no se arregla
// con un modelo más grande, se arregla preguntándole a quien tiene el dato.
//
//   AniList  anime. Sin clave y sin registro; devuelve temporadas, OVAs y
//            películas de una franquicia con su año y su formato.
//   TMDB     cine y series. Clave gratuita (themoviedb.org → Ajustes → API).
//            Tiene colecciones, créditos por persona y títulos en español.
//
// Se descartó Wikidata pese a no necesitar clave: tiene el dato completo, pero
// su servicio de consultas devuelve HTTP 429 a la segunda petición seguida.

const https = require('https');

const TMDB_API = 'https://api.themoviedb.org/3';
const ANILIST_API = 'https://graphql.anilist.co';
const TIEMPO_LIMITE = 20000;

function pedirJson(url, { metodo = 'GET', cabeceras = {}, cuerpo = null } = {}) {
  return new Promise((resolve, reject) => {
    const datos = cuerpo ? JSON.stringify(cuerpo) : null;
    const opciones = {
      method: metodo,
      headers: {
        Accept: 'application/json',
        ...(datos ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(datos) } : {}),
        ...cabeceras
      },
      timeout: TIEMPO_LIMITE
    };

    const peticion = https.request(url, opciones, (respuesta) => {
      let texto = '';
      respuesta.on('data', (c) => (texto += c));
      respuesta.on('end', () => {
        let json;
        try {
          json = JSON.parse(texto);
        } catch {
          return reject(new Error(`respuesta ilegible (HTTP ${respuesta.statusCode})`));
        }
        if (respuesta.statusCode >= 400) {
          const motivo = json?.status_message || json?.errors?.[0]?.message || `HTTP ${respuesta.statusCode}`;
          return reject(new Error(motivo));
        }
        resolve(json);
      });
    });

    peticion.on('timeout', () => peticion.destroy(new Error('tardó demasiado')));
    peticion.on('error', reject);
    peticion.end(datos);
  });
}

const anio = (fecha) => {
  const n = Number(String(fecha || '').slice(0, 4));
  return n > 1800 ? n : null;
};

// ---------------------------------------------------------------- AniList

// AniList no distingue "serie" de "película" como lo hace el importador: todo
// lo suyo entra por jkanime, así que todo sale como anime. El formato se
// conserva en la nota porque ayuda a revisar la lista antes de importarla.
const FORMATO = { TV: 'TV', TV_SHORT: 'TV corta', MOVIE: 'película', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'especial' };

function deAniList(media) {
  return {
    titulo: media.title?.romaji || media.title?.english || media.title?.native,
    tipo: 'anime',
    anio: media.startDate?.year || null,
    nota: FORMATO[media.format] || ''
  };
}

async function anilist(consulta, variables) {
  const datos = await pedirJson(ANILIST_API, { metodo: 'POST', cuerpo: { query: consulta, variables } });
  if (datos.errors?.length) throw new Error(datos.errors[0].message);
  return datos.data;
}

const CAMPOS = 'id title { romaji english native } startDate { year } format episodes isAdult';

async function animesDeFranquicia(busqueda, limite) {
  const datos = await anilist(
    `query ($b: String, $n: Int) { Page(perPage: $n) { media(search: $b, type: ANIME, sort: START_DATE) { ${CAMPOS} } } }`,
    { b: busqueda, n: limite }
  );
  return (datos?.Page?.media || []).filter((m) => !m.isAdult).map(deAniList);
}

async function animesDeEstudio(busqueda, limite) {
  const datos = await anilist(
    `query ($b: String, $n: Int) { Studio(search: $b) { name media(sort: START_DATE, perPage: $n) { nodes { ${CAMPOS} } } } }`,
    { b: busqueda, n: limite }
  );
  return (datos?.Studio?.media?.nodes || []).filter((m) => !m.isAdult).map(deAniList);
}

// AniList tiene los géneros en inglés y el pedido llega en español. La lista
// es corta y cerrada, así que una tabla resuelve mejor que otra llamada al
// modelo; lo que no esté aquí se prueba tal cual.
const GENEROS = {
  accion: 'Action', aventura: 'Adventure', aventuras: 'Adventure', comedia: 'Comedy',
  drama: 'Drama', fantasia: 'Fantasy', terror: 'Horror', horror: 'Horror',
  mecha: 'Mecha', musica: 'Music', misterio: 'Mystery', psicologico: 'Psychological',
  romance: 'Romance', romantico: 'Romance', 'ciencia ficcion': 'Sci-Fi', scifi: 'Sci-Fi',
  'recuentos de la vida': 'Slice of Life', cotidiano: 'Slice of Life',
  deporte: 'Sports', deportes: 'Sports', sobrenatural: 'Supernatural', thriller: 'Thriller',
  suspense: 'Thriller', magia: 'Mahou Shoujo'
};

function traducirGenero(genero) {
  const llave = String(genero)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
  return GENEROS[llave] || genero;
}

async function animesDeGenero(generoPedido, limite) {
  const genero = traducirGenero(generoPedido);
  const datos = await anilist(
    `query ($g: String, $n: Int) { Page(perPage: $n) { media(genre: $g, type: ANIME, sort: POPULARITY_DESC) { ${CAMPOS} } } }`,
    { g: genero, n: limite }
  );
  return (datos?.Page?.media || []).filter((m) => !m.isAdult).map(deAniList);
}

// ------------------------------------------------------------------- TMDB

function hayTmdb() {
  return Boolean(process.env.TMDB_API_KEY);
}

// TMDB acepta la clave v3 como parámetro y el token v4 como cabecera. Los
// tokens v4 son JWT y empiezan por "eyJ", que es como se distinguen.
function tmdbUrl(ruta, parametros = {}) {
  const clave = process.env.TMDB_API_KEY || '';
  const url = new URL(`${TMDB_API}${ruta}`);
  url.searchParams.set('language', 'es-ES');
  for (const [k, v] of Object.entries(parametros)) url.searchParams.set(k, String(v));
  if (!clave.startsWith('eyJ')) url.searchParams.set('api_key', clave);
  return url;
}

function tmdb(ruta, parametros) {
  const clave = process.env.TMDB_API_KEY || '';
  if (!clave) throw new Error('Falta TMDB_API_KEY');
  const cabeceras = clave.startsWith('eyJ') ? { Authorization: `Bearer ${clave}` } : {};
  return pedirJson(tmdbUrl(ruta, parametros), { cabeceras });
}

function deTmdb(obra) {
  const esSerie = obra.media_type === 'tv' || Boolean(obra.first_air_date) || Boolean(obra.name);
  return {
    titulo: obra.title || obra.name || obra.original_title || obra.original_name,
    tipo: esSerie ? 'serie' : 'pelicula',
    anio: anio(obra.release_date || obra.first_air_date),
    nota: ''
  };
}

async function porPersona(busqueda, rol, limite) {
  const encontrado = await tmdb('/search/person', { query: busqueda });
  const persona = encontrado?.results?.[0];
  if (!persona) return [];

  const creditos = await tmdb(`/person/${persona.id}/combined_credits`);
  const obras =
    rol === 'actor'
      ? creditos.cast || []
      : (creditos.crew || []).filter((c) => /^(Director|Writer)$/i.test(c.job) || /Director/i.test(c.job));

  // Un mismo título aparece varias veces cuando la persona hizo más de un
  // trabajo en él (dirigir y escribir, por ejemplo).
  const vistos = new Set();
  return obras
    .filter((o) => {
      const clave = `${o.media_type}:${o.id}`;
      if (vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    })
    .map(deTmdb)
    .filter((o) => o.titulo)
    .sort((a, b) => (a.anio || 9999) - (b.anio || 9999))
    .slice(0, limite);
}

async function porSaga(busqueda, limite) {
  const encontrado = await tmdb('/search/collection', { query: busqueda });
  const coleccion = encontrado?.results?.[0];
  if (!coleccion) return [];

  const detalle = await tmdb(`/collection/${coleccion.id}`);
  return (detalle?.parts || [])
    .map(deTmdb)
    .sort((a, b) => (a.anio || 9999) - (b.anio || 9999))
    .slice(0, limite);
}

async function porEstudio(busqueda, limite) {
  const encontrado = await tmdb('/search/company', { query: busqueda });
  const compania = encontrado?.results?.[0];
  if (!compania) return [];

  const peliculas = await tmdb('/discover/movie', {
    with_companies: compania.id,
    sort_by: 'primary_release_date.asc',
    include_adult: false
  });
  return (peliculas?.results || []).map(deTmdb).slice(0, limite);
}

async function porTitulo(busqueda, limite) {
  const encontrado = await tmdb('/search/multi', { query: busqueda, include_adult: false });
  return (encontrado?.results || [])
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .map(deTmdb)
    .filter((o) => o.titulo)
    .slice(0, limite);
}

// ------------------------------------------------------------- despachador

// Devuelve null cuando la fuente no aplica o no está configurada, para que
// quien llama sepa que tiene que probar otra cosa en vez de dar por buena una
// lista vacía.
async function buscarEnFuentes({ ambito, intencion, busqueda, rol }, limite = 40) {
  if (!busqueda) return null;

  if (ambito === 'anime') {
    if (intencion === 'estudio') return { fuente: 'AniList', titulos: await animesDeEstudio(busqueda, limite) };
    if (intencion === 'genero') return { fuente: 'AniList', titulos: await animesDeGenero(busqueda, limite) };
    return { fuente: 'AniList', titulos: await animesDeFranquicia(busqueda, limite) };
  }

  if (!hayTmdb()) return null;

  if (intencion === 'persona') return { fuente: 'TMDB', titulos: await porPersona(busqueda, rol, limite) };
  if (intencion === 'saga') return { fuente: 'TMDB', titulos: await porSaga(busqueda, limite) };
  if (intencion === 'estudio') return { fuente: 'TMDB', titulos: await porEstudio(busqueda, limite) };
  return { fuente: 'TMDB', titulos: await porTitulo(busqueda, limite) };
}

module.exports = { buscarEnFuentes, hayTmdb, animesDeFranquicia, porPersona, porSaga };
