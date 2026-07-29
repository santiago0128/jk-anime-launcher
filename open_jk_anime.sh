#!/usr/bin/env bash

set -euo pipefail

URL="https://jkanime.net/dragon-ball-z/1/"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "$SCRIPT_DIR/save_episode_url_to_streamflix.js"

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
