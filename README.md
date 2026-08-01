# JK Anime Launcher

Mini proyecto para abrir `JK Anime` directamente en `Dragon Ball Z (Original)` capitulo 1, o abrir `PelisPlusHD` en el navegador.

## Ejecutar

Desde la carpeta del proyecto:

```bash
chmod +x open_jk_anime.sh
./open_jk_anime.sh
```

Para abrir `PelisPlusHD`:

```bash
./open_jk_anime.sh pelisplus
```

Para importar un rango completo sin tocar el codigo:

```bash
node import_series_to_streamflix.js --series-name "Dragon Ball Z" --start 1 --end 10
```

Para ejecutar el bot en modo interactivo:

```bash
node import_series_to_streamflix.js
```

El bot primero te preguntara si quieres cargar:

- `anime`
- `serie`
- `pelicula`

Con `anime` detecta cuantos capitulos tiene y pregunta hasta cual importar
(Enter = todos). Para las series en emision jkanime reporta `Episodios: 0`, asi
que el total se toma del enlace al ultimo capitulo publicado. Un capitulo que
falle no corta la importacion: se reporta en `failed` y sigue con el resto.

Si eliges `anime`, puedes pegar una URL tipo:

```bash
https://jkanime.net/dragon-ball-z/
```

o escribir directamente el nombre del anime.

Si eliges `serie` o `pelicula`, el bot te pedira el nombre (o puedes pegar la URL
de la ficha) y armara la URL concatenando el tipo con ese nombre.

El sitio se elige con la constante `PELISPLUS_HOME_URL` en
`import_series_to_streamflix.js`, y estan soportados dos:

| Sitio | Series | Peliculas | Capitulos |
|---|---|---|---|
| PelisPlusHD | `/serie/<nombre>` | `/pelicula/<nombre>` | `/serie/<nombre>/temporada/N/capitulo/M` |
| Cuevana3 | `/serie/<nombre>` | `/<id>/<nombre>` | `/episodio/<nombre>-NxM` |

Antes de abrir busca el titulo en el sitio para usar el slug real (por ejemplo
`One Piece` abre `/serie/one-piece-111110` en PelisPlusHD). Si la busqueda no
encuentra nada, abre igual la URL armada con el nombre que escribiste. En
Cuevana3 las peliculas llevan un id numerico que no se puede adivinar, asi que
ahi la busqueda es obligatoria.

Despues de abrir la pagina hace el mismo trabajo que con anime: scraping de la ficha, verificacion del video y guardado en `StreamFlix`. Con `serie` pregunta ademas que temporada importar (Enter = todas), porque cada capitulo es una descarga aparte.

Tambien puedes pasarlo directo:

```bash
node import_series_to_streamflix.js --content-type pelicula --title "Interestelar"
node import_series_to_streamflix.js --content-type serie --title "Breaking Bad" --season 1 --start 1 --end 5
node import_series_to_streamflix.js --content-type serie --page-url "https://www.pelisplushd.la/serie/16-veranos"
```

O usar el importador de PelisPlusHD por separado:

```bash
node save_pelisplus_to_streamflix.js --url "https://www.pelisplushd.la/serie/16-veranos" --season 1 --start 1 --end 3
```

Tambien puedes pasarsela directo:

```bash
node import_series_to_streamflix.js --series-url "https://jkanime.net/dragon-ball-z/"
```

## Varios sitios y nombres imprecisos

`CONTENT_SITES` en `import_series_to_streamflix.js` lista los sitios donde buscar,
en orden. Si el titulo no aparece en el primero (o el sitio no responde) se
intenta con el siguiente, y el que acierte es el que se usa para importar.
Agregar un sitio a la lista solo funciona si tiene adaptador en
`save_pelisplus_to_streamflix.js`, que es quien sabe leer su HTML.

El nombre no tiene que ser exacto. La busqueda:

- ignora acentos, mayusculas, signos y articulos (`el`, `la`, `the`, `de`...);
- tolera erratas y singular/plural comparando por bigramas ("stranger thing"
  encuentra "Stranger Things");
- si el buscador del sitio no devuelve nada con el nombre completo, reintenta con
  menos palabras y por ultimo con un prefijo, que es lo unico que salva una
  errata dentro de la palabra ("interestellar" no da nada, pero "interes" si).

Cada resultado se puntua de 0 a 1. Por encima de `0.85` se importa directo; entre
`0.55` y `0.85` es solo un parecido y **no se importa sin confirmar**, porque es
donde se cuela el titulo equivocado (pedir "Pulp Fiction" y traer "Stealing Pulp
Fiction"). En modo interactivo lo pregunta; desatendido hay que repetir con
`--accept-similar` o pasar la ficha con `--page-url`.

## Marcas de intro y creditos (solo anime)

Las marcas salen de AniSkip, que indexa por **id de MyAnimeList**. El bot busca la
serie en AniList y usa su campo `idMal`; con el id de AniList la API responde que
no encuentra nada, o peor, datos de otra serie.

Los titulos de jkanime traen adornos que AniList no reconoce (`(Original)`,
acentos, sufijos de temporada), asi que se prueban variantes de mas a menos
especifica: el titulo tal cual, sin parentesis, sin acentos y por ultimo las dos
primeras palabras.

Si no hay dato, el episodio se guarda **sin marcas**. Antes caian los valores por
defecto del script (id 813, año 1989, rating 9.0, que son los de Dragon Ball Z) y
cualquier anime terminaba con la intro, el año y la calificacion de esa serie.

Series y peliculas no tienen equivalente a AniSkip, asi que nunca traen marcas de
intro; el reproductor usa el ultimo tramo del episodio para ofrecer el siguiente.

## Importar desde Claude Code

Hay un comando propio en `.claude/commands/importar.md`. Basta con el nombre:

```
/importar Stranger Things
/importar Interestelar
/importar Dragon Ball Z
/importar Breaking Bad local
```

Claude deduce si es anime, serie o pelicula (cada uno sale de una fuente
distinta), lanza la importacion **en el servidor**, y reporta que quedó. Con
`local` al final la hace contra la base de esta maquina en vez del servidor.

Solo pregunta en dos casos: cuando el titulo es ambiguo (existe como serie y como
pelicula) y cuando la busqueda no encontro el nombre exacto sino uno parecido,
que es donde se cuela el titulo equivocado.

## Ejecutar en segundo plano

Para que una importacion larga corra desatendida sin interrumpir, hay que evitar
las dos cosas que piden atencion: la pestaña del navegador y las preguntas.

```bash
nohup node import_series_to_streamflix.js \
  --content-type serie --title "Stranger Things" --no-browser \
  > import.log 2>&1 &
```

- `--no-browser` (o `JK_NO_BROWSER=1`) evita que se abra el navegador.
- Hay que pasar los datos por parametro: sin terminal no hay quien conteste las
  preguntas, y el bot avisa en vez de quedarse esperando.
- El progreso va a `stderr` (`→ T1E3 (hls) [3/42]`) y el resumen JSON a `stdout`,
  asi que en el log quedan los dos.

Para seguirlo:

```bash
tail -f import.log
```

## Ejecutables

Windows:

```bash
/Users/santiagoguevaragalindo/Code/jk-anime-launcher/jk-anime-streamflix-bot.exe
```

macOS Apple Silicon:

```bash
/Users/santiagoguevaragalindo/Code/jk-anime-launcher/jk-anime-streamflix-bot-macos-arm64
```

macOS Intel:

```bash
/Users/santiagoguevaragalindo/Code/jk-anime-launcher/jk-anime-streamflix-bot-macos-x64
```

## Qué hace

- Hace scraping de episodios de JK Anime (anime) y de fichas de PelisPlusHD (series y peliculas)
- Guarda la URL y los metadatos del episodio en la base SQL Server local `StreamFlix`
- En macOS usa `open`
- En Linux usa `xdg-open`
- Abre `https://jkanime.net/dragon-ball-z/1/` en tu navegador predeterminado
- O abre `https://www.pelisplushd.la/` si ejecutas `./open_jk_anime.sh pelisplus`
- Para series y peliculas abre `https://www.pelisplushd.la/serie/<nombre>` o `https://www.pelisplushd.la/pelicula/<nombre>`

## Base de datos

Guarda informacion en:

- `dbo.Series` (con `ContentType`: `anime`, `series` o `movie`)
- `dbo.Seasons`
- `dbo.Episodes`
- `dbo.SeriesGenres` y `dbo.Genres` (generos leidos de PelisPlusHD)
- `dbo.JkAnimeEpisodeSnapshots` (anime)
- `dbo.PelisPlusSnapshots` (series y peliculas)

Las peliculas se guardan como una temporada y un episodio tecnico, que es como
StreamFlix las modela para reutilizar el reproductor.

Los capitulos de PelisPlusHD se guardan con `Provider = 'hls'` (o `file`) apuntando
al video real, para que se reproduzcan en el reproductor propio de StreamFlix igual
que el anime. Para lograrlo el importador abre el embed del servidor, desempaqueta
el JS del reproductor (`eval(function(p,a,c,k,e,d)`) y verifica el `m3u8` que sale
de ahi. Los servidores de la familia streamwish (filelions, vidhide, streamwish)
son los que exponen ese enlace, por eso se intentan primero.

Si ningun servidor del capitulo deja llegar al archivo, se guarda como
`Provider = 'embed'` y se reproduce en un iframe: es el ultimo recurso, no lo
normal. Ten en cuenta que los enlaces traen token y caducan, asi que hay que
reimportar cada tanto (pasa igual con el anime).

La tabla `dbo.JkAnimeEpisodeSnapshots` guarda, entre otros:

- nombre de la serie
- slug de la serie
- numero y titulo del episodio
- URL del episodio
- metadatos SEO de la pagina
- imagenes del episodio
- enlace del siguiente episodio
- reproductores detectados
- servidores detectados
- opciones de descarga detectadas

La tabla `dbo.PelisPlusSnapshots` guarda lo equivalente para PelisPlusHD:

- tipo de contenido, titulo original y sinopsis
- temporada y capitulo
- URL de la ficha o del capitulo
- poster, año, rating, generos y actores
- reproductores detectados con su servidor e idioma
- resultado de la verificacion de video y el `Provider` con el que se guardo

Para ver el registro guardado:

```bash
node show_saved_url_from_streamflix.js
```
