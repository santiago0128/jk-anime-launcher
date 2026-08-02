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

// QLever responde 308 a la URL sin barra final, así que seguir redirecciones
// no es opcional aquí.
function pedirJson(url, { metodo = 'GET', cabeceras = {}, cuerpo = null, saltos = 3 } = {}) {
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
      const destino = respuesta.headers?.location;
      if (respuesta.statusCode >= 300 && respuesta.statusCode < 400 && destino && saltos > 0) {
        respuesta.resume();
        return resolve(
          pedirJson(new URL(destino, url), { metodo, cabeceras, cuerpo, saltos: saltos - 1 })
        );
      }

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

const sinAcentos = (texto) =>
  String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Cada fuente conoce un título por varios nombres. Se quedan en orden de
// preferencia y sin repetir, para que el importador pueda reintentar con el
// siguiente cuando el primero no aparece en el sitio.
//
// Repetido es el mismo nombre salvo mayúsculas o acentos: "Capitán América: el
// primer vengador" y "Capitán América: El primer vengador" son el mismo
// intento de búsqueda, y probar los dos solo gasta tiempo.
//
// El tope existe porque cada reintento es una búsqueda entera por todos los
// sitios: El Imperio contraataca tiene doce alias en Wikidata, y un lote de
// cuarenta títulos que no existen no puede costar cuarenta veces doce.
const MAX_NOMBRES = 4;

function candidatos(nombres) {
  const vistos = new Set();
  const limpios = [];

  for (const bruto of nombres) {
    const nombre = String(bruto || '').trim();
    if (!nombre) continue;
    const clave = sinAcentos(nombre);
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    limpios.push(nombre);
    if (limpios.length >= MAX_NOMBRES) break;
  }

  return limpios;
}

// ---------------------------------------------------------------- AniList

// AniList no distingue "serie" de "película" como lo hace el importador: todo
// lo suyo entra por jkanime, así que todo sale como anime. El formato se
// conserva en la nota porque ayuda a revisar la lista antes de importarla.
const FORMATO = { TV: 'TV', TV_SHORT: 'TV corta', MOVIE: 'película', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'especial' };

function deAniList(media) {
  const nombres = candidatos([media.title?.romaji, media.title?.english, media.title?.native]);
  return {
    titulo: nombres[0],
    alternativos: nombres.slice(1),
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
  return GENEROS[sinAcentos(genero).trim()] || genero;
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

// El título traducido va primero, pero el original queda de respaldo: hay
// catálogos que nunca tradujeron la ficha y siguen listando el nombre de
// estreno.
function deTmdb(obra) {
  const esSerie = obra.media_type === 'tv' || Boolean(obra.first_air_date) || Boolean(obra.name);
  const nombres = candidatos([obra.title, obra.name, obra.original_title, obra.original_name]);
  return {
    titulo: nombres[0],
    alternativos: nombres.slice(1),
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

// --------------------------------------------------------- Wikidata/QLever

// Cine y series sin clave ni registro. El dato es de Wikidata, pero se
// consulta a través de QLever (Universidad de Friburgo) en vez del servicio
// oficial: ese devuelve HTTP 429 a la segunda petición seguida, y este aguanta
// sin rechistar. Los nombres se resuelven con la API normal de Wikidata, que
// tampoco limita.
const QLEVER = 'https://qlever.dev/api/wikidata/';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const AGENTE = 'StreamFlixImporter/1.0 (catalogo personal)';

const PREFIJOS = [
  'PREFIX wdt: <http://www.wikidata.org/prop/direct/>',
  'PREFIX wd: <http://www.wikidata.org/entity/>',
  'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
  'PREFIX schema: <http://schema.org/>',
  'PREFIX skos: <http://www.w3.org/2004/02/skos/core#>'
].join('\n');

// De "instancia de" al tipo que entiende el importador.
const CLASES = {
  Q11424: 'pelicula', // película
  Q506240: 'pelicula', // telefilme
  Q24869: 'pelicula', // largometraje
  Q5398426: 'serie', // serie de televisión
  Q1259759: 'serie', // miniserie
  Q581714: 'serie' // serie de televisión animada
};
const CLASES_SPARQL = Object.keys(CLASES).map((q) => `wd:${q}`).join(' ');

async function qlever(sparql) {
  const url = new URL(QLEVER);
  url.searchParams.set('query', `${PREFIJOS}\n${sparql}`);
  const datos = await pedirJson(url, {
    cabeceras: { 'User-Agent': AGENTE, Accept: 'application/sparql-results+json' }
  });
  if (datos.exception) throw new Error(`consulta rechazada: ${datos.exception}`);
  return datos?.results?.bindings || [];
}

// Sin esto, un nombre con comillas o llaves se colaría dentro de la consulta.
function exigirQid(qid) {
  if (!/^Q\d+$/.test(String(qid))) throw new Error(`identificador de Wikidata no válido: ${qid}`);
  return qid;
}

async function buscarEntidad(nombre, idioma) {
  const url = new URL(WIKIDATA_API);
  url.searchParams.set('action', 'wbsearchentities');
  url.searchParams.set('search', nombre);
  url.searchParams.set('language', idioma);
  url.searchParams.set('uselang', idioma);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '5');

  const datos = await pedirJson(url, { cabeceras: { 'User-Agent': AGENTE } });
  return datos?.search?.[0]?.id || null;
}

// La búsqueda va primero en español porque el pedido llega en español, pero
// Wikidata tiene mucha más etiqueta en inglés: "Marvel Cinematic Universe
// Phase One" existe y "primera fase del MCU" no encuentra nada. Sin este
// segundo intento, media franquicia no resuelve.
async function resolverEntidad(nombre) {
  return (await buscarEntidad(nombre, 'es')) || (await buscarEntidad(nombre, 'en'));
}

// Todas las consultas devuelven lo mismo, así que el SELECT se escribe una vez
// y cada intención solo aporta su patrón.
function consultaDeObras(patron, orden = 'ORDER BY ?anio') {
  return `SELECT ?obra (SAMPLE(?es) AS ?tEs) (SAMPLE(?wiki) AS ?tWiki) (SAMPLE(?en) AS ?tEn) (GROUP_CONCAT(DISTINCT ?alias; SEPARATOR="§") AS ?tAlias) (MIN(?a) AS ?anio) (SAMPLE(?clase) AS ?tipoObra) WHERE {
  ${patron}
  ?obra wdt:P31 ?clase .
  VALUES ?clase { ${CLASES_SPARQL} }
  OPTIONAL { ?obra rdfs:label ?es . FILTER(LANG(?es) = "es") }
  OPTIONAL { ?obra rdfs:label ?en . FILTER(LANG(?en) = "en") }
  OPTIONAL { ?obra skos:altLabel ?alias . FILTER(LANG(?alias) = "es") }
  OPTIONAL {
    ?articulo schema:about ?obra ; schema:isPartOf <https://es.wikipedia.org/> ; schema:name ?wiki .
  }
  OPTIONAL { ?obra wdt:P577 ?estreno }
  OPTIONAL { ?obra wdt:P580 ?inicio }
  BIND(YEAR(COALESCE(?estreno, ?inicio)) AS ?a)
} GROUP BY ?obra ${orden}`;
}

// El nombre del artículo en la Wikipedia española manda sobre la etiqueta
// "en español" de Wikidata, aunque suene raro: la etiqueta de El padrino II es
// literalmente "The Godfather Part II", mientras que el artículo se llama
// "El padrino II", que es como lo busca el importador en sitios en español.
// Al artículo se le quita el paréntesis desambiguador, que no es del título.
//
// Aun así el primer nombre se queda corto más veces de las que parece: la
// Wikipedia en español titula con el nombre de estreno en España, y para el
// MCU eso es el inglés ("The Avengers", "The Incredible Hulk"). Los sitios que
// raspa el importador son latinoamericanos y ahí esas dos son "Los Vengadores"
// y "El increíble Hulk", que Wikidata sí guarda, pero como alias. Por eso se
// devuelven todos los nombres: el importador prueba el siguiente si el
// primero no aparece.
function deWikidata(fila) {
  const clase = String(fila?.tipoObra?.value || '').split('/').pop();
  const wiki = String(fila?.tWiki?.value || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const alias = String(fila?.tAlias?.value || '').split('§');
  const nombres = candidatos([wiki, fila?.tEs?.value, ...alias, fila?.tEn?.value]);

  return {
    titulo: nombres[0] || null,
    alternativos: nombres.slice(1),
    tipo: CLASES[clase] || 'pelicula',
    anio: Number(fila?.anio?.value) || null,
    nota: ''
  };
}

function ordenarYRecortar(filas, limite) {
  return filas
    .map(deWikidata)
    // Sin fecha de estreno casi siempre es material que nunca salió, y el
    // importador no lo va a encontrar en ningún sitio.
    .filter((o) => o.titulo && o.anio)
    .sort((a, b) => (a.anio || 9999) - (b.anio || 9999))
    .slice(0, limite);
}

async function wikiPorPersona(busqueda, rol, limite) {
  const qid = exigirQid(await resolverEntidad(busqueda));
  const propiedad = rol === 'actor' ? 'P161' : 'P57';
  return ordenarYRecortar(await qlever(consultaDeObras(`?obra wdt:${propiedad} wd:${qid} .`)), limite);
}

// Un pedido rara vez es la franquicia entera: "la primera fase del MCU" son 6
// películas, no las 40 que cuelgan del universo. Wikidata tiene esos tramos
// como entidades propias, pero no se llegan por nombre —"primera fase del MCU"
// no encuentra nada— así que se listan los tramos de la franquicia y se
// empareja el matiz contra sus etiquetas.
//
// El emparejamiento normaliza antes de comparar porque los dos lados dicen lo
// mismo de formas distintas: el pedido llega como "primera fase" y la etiqueta
// es "Anexo:Fase Uno del Universo cinematográfico de Marvel".
const ORDINALES = {
  primera: '1', primer: '1', primero: '1', uno: '1', una: '1', one: '1', i: '1',
  segunda: '2', segundo: '2', dos: '2', two: '2', ii: '2',
  tercera: '3', tercer: '3', tercero: '3', tres: '3', three: '3', iii: '3',
  cuarta: '4', cuarto: '4', cuatro: '4', four: '4', iv: '4',
  quinta: '5', quinto: '5', cinco: '5', five: '5', v: '5',
  sexta: '6', sexto: '6', seis: '6', six: '6', vi: '6',
  septima: '7', septimo: '7', siete: '7', seven: '7', vii: '7'
};

// Las palabras con las que se nombra un tramo, en los dos idiomas: la etiqueta
// puede estar solo en inglés ("Star Wars original trilogy") y el pedido llega
// siempre en español.
const TRAMOS = {
  phase: 'fase', trilogy: 'trilogia', season: 'temporada',
  part: 'parte', saga: 'saga', series: 'serie'
};

// Ni "toda la primera fase" ni "la primera fase" deben diferenciarse: lo que
// sobra se tira para que solo queden las palabras que identifican el tramo.
const RELLENO = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'anexo',
  'of', 'the', 'and', 'a',
  'todo', 'toda', 'todos', 'todas', 'completa', 'completo', 'entera', 'entero'
]);

function palabrasClave(texto) {
  return sinAcentos(texto)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((p) => TRAMOS[p] || ORDINALES[p] || p)
    .filter((p) => !RELLENO.has(p));
}

async function buscarSubserie(qid, matiz) {
  const buscadas = palabrasClave(matiz);
  if (!buscadas.length) return null;

  // El + del camino es necesario: las fases del MCU no cuelgan del universo
  // directamente, sino de "The Infinity Saga", que sí.
  const filas = await qlever(`SELECT ?parte (SAMPLE(?es) AS ?tEs) (SAMPLE(?en) AS ?tEn) WHERE {
  { ?parte wdt:P179+ wd:${qid} } UNION { wd:${qid} wdt:P527+ ?parte }
  FILTER NOT EXISTS { ?parte wdt:P31 ?c . VALUES ?c { ${CLASES_SPARQL} } }
  OPTIONAL { ?parte rdfs:label ?es . FILTER(LANG(?es) = "es") }
  OPTIONAL { ?parte rdfs:label ?en . FILTER(LANG(?en) = "en") }
} GROUP BY ?parte LIMIT 300`);

  let mejor = null;
  for (const fila of filas) {
    for (const etiqueta of [fila?.tEs?.value, fila?.tEn?.value]) {
      if (!etiqueta) continue;
      const tiene = palabrasClave(etiqueta);
      // Se exige el matiz entero: con "primera fase", "Fase Dos" no vale y
      // "The Infinity Saga" tampoco. Entre los que encajan gana el de nombre
      // más corto, que es el más específico.
      if (!buscadas.every((p) => tiene.includes(p))) continue;
      if (!mejor || tiene.length < mejor.largo) {
        mejor = { qid: fila.parte.value.split('/').pop(), largo: tiene.length };
      }
    }
  }

  return mejor && /^Q\d+$/.test(mejor.qid) ? mejor.qid : null;
}

// "El Padrino" resuelve a la película de 1972, no a la saga; por eso se sale
// de la obra hacia su serie y desde ahí se recogen todas las partes.
async function wikiPorSaga(busqueda, limite, matiz = '') {
  const qid = exigirQid(await resolverEntidad(busqueda));
  const raiz = (await buscarSubserie(qid, matiz)) || qid;

  const porSerie = await qlever(consultaDeObras(`wd:${raiz} wdt:P179 ?serie . ?obra wdt:P179 ?serie .`));
  if (porSerie.length) return ordenarYRecortar(porSerie, limite);

  // Puede que el nombre ya apuntase a la serie en vez de a una de sus partes.
  return ordenarYRecortar(await qlever(consultaDeObras(partesDe(raiz))), limite);
}

// Las dos formas de decir "esto pertenece a aquello". El MCU usa P179 para sus
// películas pero P527 para colgar Iron Man de la Fase Uno, así que mirar solo
// una deja títulos fuera.
function partesDe(qid) {
  return `{ ?obra wdt:P179 wd:${qid} } UNION { wd:${qid} wdt:P527 ?obra }`;
}

async function wikiPorEstudio(busqueda, limite) {
  const qid = exigirQid(await resolverEntidad(busqueda));
  return ordenarYRecortar(await qlever(consultaDeObras(`?obra wdt:P272 wd:${qid} .`)), limite);
}

async function wikiPorGenero(busqueda, limite) {
  const qid = exigirQid(await resolverEntidad(busqueda));
  return ordenarYRecortar(await qlever(consultaDeObras(`?obra wdt:P136 wd:${qid} .`)), limite);
}

// Un título suelto no necesita grafo: basta con lo que devuelve la búsqueda.
async function wikiPorTitulo(busqueda, limite) {
  const qid = exigirQid(await resolverEntidad(busqueda));
  return ordenarYRecortar(await qlever(consultaDeObras(`BIND(wd:${qid} AS ?obra)`)), limite);
}

// --------------------------------------------------------------- portadas

// Un titulo que entra por una fuente pobre en metadatos (Gnula devuelve la
// ficha recortada; Pelismart va por embed) queda sin portada ni sinopsis. Los
// datos si estan en las mismas fuentes que ya usa /pide, asi que se rellenan
// desde ahi en vez de dejar la ficha coja.
async function buscarFicha({ titulo, tipo }) {
  if (!titulo) return null;

  if (tipo === 'anime') {
    const datos = await anilist(
      'query ($b: String) { Media(search: $b, type: ANIME) { coverImage { extraLarge } description(asHtml: false) startDate { year } } }',
      { b: titulo }
    );
    const media = datos?.Media;
    if (!media) return null;
    return {
      posterUrl: media.coverImage?.extraLarge || null,
      sinopsis: String(media.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null,
      anio: media.startDate?.year || null,
      fuente: 'AniList'
    };
  }

  const qid = await resolverEntidad(titulo);
  if (!qid || !/^Q\d+$/.test(qid)) return null;

  // P18 es la imagen del articulo; Special:FilePath devuelve el archivo real.
  // El VALUES ancla la consulta: un WHERE hecho solo de OPTIONAL no casa con
  // ninguna fila y devuelve vacio aunque el dato exista.
  const filas = await qlever(`SELECT ?img ?anio WHERE {
  VALUES ?obra { wd:${qid} }
  OPTIONAL { ?obra wdt:P18 ?img }
  OPTIONAL { ?obra wdt:P577 ?f . BIND(YEAR(?f) AS ?anio) }
} LIMIT 1`);
  const fila = filas[0];
  if (!fila) return null;

  return {
    posterUrl: fila?.img?.value || null,
    sinopsis: null,
    anio: Number(fila?.anio?.value) || null,
    fuente: 'Wikidata'
  };
}

// ------------------------------------------------------------- despachador

// Devuelve null cuando la fuente no aplica o no está configurada, para que
// quien llama sepa que tiene que probar otra cosa en vez de dar por buena una
// lista vacía.
async function buscarEnFuentes({ ambito, intencion, busqueda, rol, matiz = '' }, limite = 40) {
  if (!busqueda) return null;

  if (ambito === 'anime') {
    if (intencion === 'estudio') return { fuente: 'AniList', titulos: await animesDeEstudio(busqueda, limite) };
    if (intencion === 'genero') return { fuente: 'AniList', titulos: await animesDeGenero(busqueda, limite) };
    return { fuente: 'AniList', titulos: await animesDeFranquicia(busqueda, limite) };
  }

  // TMDB da mejores títulos en español, pero pide registro. Sin clave se usa
  // Wikidata, que no pide nada y trae la filmografía igual de completa.
  if (hayTmdb()) {
    if (intencion === 'persona') return { fuente: 'TMDB', titulos: await porPersona(busqueda, rol, limite) };
    if (intencion === 'saga') return { fuente: 'TMDB', titulos: await porSaga(busqueda, limite) };
    if (intencion === 'estudio') return { fuente: 'TMDB', titulos: await porEstudio(busqueda, limite) };
    return { fuente: 'TMDB', titulos: await porTitulo(busqueda, limite) };
  }

  const fuente = 'Wikidata';
  if (intencion === 'persona') return { fuente, titulos: await wikiPorPersona(busqueda, rol, limite) };
  if (intencion === 'saga') return { fuente, titulos: await wikiPorSaga(busqueda, limite, matiz) };
  if (intencion === 'estudio') return { fuente, titulos: await wikiPorEstudio(busqueda, limite) };
  if (intencion === 'genero') return { fuente, titulos: await wikiPorGenero(busqueda, limite) };
  return { fuente, titulos: await wikiPorTitulo(busqueda, limite) };
}

module.exports = {
  buscarEnFuentes,
  buscarFicha,
  hayTmdb,
  animesDeFranquicia,
  porPersona,
  porSaga,
  wikiPorPersona,
  wikiPorSaga,
  resolverEntidad
};
