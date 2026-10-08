#!/usr/bin/env sh
# Corre el MVP con AWS simulado (macOS / Linux): sh iniciar-mvp.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "No se encontró Node.js. Instale Node.js 22 LTS o 24 LTS: https://nodejs.org"
  echo "macOS con Homebrew: brew install node@22"
  exit 1
fi
exec node iniciar-mvp.mjs "$@"
