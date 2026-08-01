---
description: Importa una película, serie o anime al catálogo de StreamFlix a partir del nombre
argument-hint: <nombre del título> [local]
allowed-tools: Bash
---

Importa `$ARGUMENTS` al catálogo de StreamFlix. El usuario solo da el nombre; el
resto lo resuelves tú sin preguntarle nada que puedas averiguar por tu cuenta.

## 1. Decide el tipo

Clasifica el título en `anime`, `serie` o `pelicula` con lo que ya sabes de él.
Cada tipo usa una fuente distinta, y equivocarse hace que no lo encuentre:

- **anime** → se busca en JK Anime (Dragon Ball, Naruto, Initial D, One Piece…)
- **serie** → Cuevana3 / PelisPlusHD (Stranger Things, Breaking Bad…)
- **pelicula** → Cuevana3 / PelisPlusHD (Interestelar, El Padrino…)

Una película de animación japonesa (El viaje de Chihiro) es `pelicula`, no
`anime`: `anime` es solo para series por capítulos de JK Anime.

Si de verdad es ambiguo (un título que existe como serie y como película),
pregunta. Si no, decide y sigue.

## 2. Lanza la importación

Por defecto se importa **en el servidor**, que es donde vive el catálogo real.
Si el usuario escribió `local` al final del nombre, usa la variante local.

**En el servidor** (por defecto):

```bash
ssh -i ~/.ssh/id_ed25519_streamflix -o BatchMode=yes root@170.187.142.36 \
  "docker run --rm --network streamflix_default \
   -v /opt/streamflix/streamflix/.env:/streamflix/.env:ro streamflix-bot \
   import_series_to_streamflix.js <ARGS>"
```

**En local** (solo si lo pidió), desde `/Users/santiagoguevaragalindo/Code/jk-anime-launcher`:

```bash
JK_NO_BROWSER=1 node import_series_to_streamflix.js <ARGS>
```

Donde `<ARGS>` es, según el tipo:

| Tipo | Argumentos |
|---|---|
| anime | `--series-name "NOMBRE" --no-browser` |
| serie | `--content-type serie --title "NOMBRE" --no-browser` |
| pelicula | `--content-type pelicula --title "NOMBRE" --no-browser` |

Una serie o un anime completos son decenas de descargas y pueden tardar varios
minutos. Lánzalo con `run_in_background` y avisa de cuánto puede tardar; no te
quedes esperando en primer plano.

## 3. Resuelve los dos casos que requieren decisión

**No lo encontró exacto.** El bot responde algo como *"No encontré X exacto. Lo
más parecido es Y (0.77)"*. No repitas con `--accept-similar` por tu cuenta:
pregunta al usuario si Y es lo que quería, porque ese es justo el caso en el que
se importa el título equivocado. Si dice que sí, repite el comando añadiendo
`--accept-similar`.

**No lo encontró en ningún sitio.** Dilo tal cual y ofrece dos salidas: probar
con otro nombre (el original en inglés suele funcionar mejor), o pasar la ficha
directa con `--page-url "URL"` si el usuario la tiene.

## 4. Verifica y reporta

Cuando termine, di en pocas líneas:

- título tal como quedó guardado (puede diferir del que pidió), tipo y año
- cuántos episodios entraron y cuántos se saltaron
- si quedaron como `hls`/`file` (reproductor interno) o `embed` (iframe)
- la URL para verlo: http://170.187.142.36

Si algún episodio se saltó, di el motivo real que dio el bot. Un `embed` no es un
fallo, es el último recurso cuando ningún servidor expone el archivo de video.

No des por bueno lo que no viste: el resumen sale del JSON que imprime el bot.
