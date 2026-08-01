#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-jkanime}"

case "$TARGET" in
  jkanime)
    URL="https://jkanime.net/dragon-ball-z/1/"
    SHOULD_SAVE_TO_DB="1"
    ;;
  pelisplus|pelisplushd)
    URL="https://www.pelisplushd.la/"
    SHOULD_SAVE_TO_DB="0"
    ;;
  *)
    echo "Uso: ./open_jk_anime.sh [jkanime|pelisplus]"
    exit 1
    ;;
esac

if [[ "$SHOULD_SAVE_TO_DB" == "1" ]]; then
  node "$SCRIPT_DIR/save_episode_url_to_streamflix.js"
fi

if command -v open >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
  exit 0
fi

echo "No encontre un comando compatible para abrir el navegador automaticamente."
echo "Abre manualmente: $URL"
exit 1
