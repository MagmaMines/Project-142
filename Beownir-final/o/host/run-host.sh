#!/usr/bin/env bash
# Starts the Beownir network-only host: IDE on PORT, runtime on PORT+1, preview on PORT+2.
# Run it on a Node 18.17+ server behind HTTPS and a reverse proxy that forwards WebSocket upgrades.
set -euo pipefail
: "${BEOWNIR_IDE_ORIGIN:?set BEOWNIR_IDE_ORIGIN, e.g. https://your-site.netlify.app}"
: "${BEOWNIR_RUNTIME_ORIGIN:?set BEOWNIR_RUNTIME_ORIGIN, e.g. https://runtime.yourdomain}"
: "${BEOWNIR_PREVIEW_ORIGIN:?set BEOWNIR_PREVIEW_ORIGIN, e.g. https://preview.yourdomain}"
here="$(cd "$(dirname "$0")" && pwd)"
export PORT="${PORT:-4173}"
exec node "$here/beownir-host.mjs" "${BEOWNIR_HTML:-$here/../site/index.html}"
