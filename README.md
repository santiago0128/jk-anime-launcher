# JK Anime Launcher

Mini proyecto para abrir `JK Anime` directamente en `Dragon Ball Z (Original)` capitulo 1.

## Ejecutar

Desde la carpeta del proyecto:

```bash
chmod +x open_jk_anime.sh
./open_jk_anime.sh
```

Para importar un rango completo sin tocar el codigo:

```bash
node import_series_to_streamflix.js --series-name "Dragon Ball Z" --start 1 --end 10
```

Para ejecutar el bot en modo interactivo y pegar la URL de la serie:

```bash
node import_series_to_streamflix.js
```

El bot te pedira una URL tipo:

```bash
https://jkanime.net/dragon-ball-z/
```

Tambien puedes pasarsela directo:

```bash
node import_series_to_streamflix.js --series-url "https://jkanime.net/dragon-ball-z/"
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

- Hace scraping de episodios de JK Anime
- Guarda la URL y los metadatos del episodio en la base SQL Server local `StreamFlix`
- En macOS usa `open`
- En Linux usa `xdg-open`
- Abre `https://jkanime.net/dragon-ball-z/1/` en tu navegador predeterminado

## Base de datos

Guarda informacion en:

- `dbo.Series`
- `dbo.Seasons`
- `dbo.Episodes`
- `dbo.JkAnimeEpisodeSnapshots`

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

Para ver el registro guardado:

```bash
node show_saved_url_from_streamflix.js
```
