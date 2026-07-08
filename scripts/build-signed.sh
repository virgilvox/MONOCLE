#!/usr/bin/env bash
# Build a signed installer locally (and notarized on macOS when the Apple API
# key vars are present). Mirrors the env the release workflow uses. Without the
# variables set, use `pnpm --filter @monoclejs/desktop package` for an unsigned
# build instead. See docs/BUILD.md for how to produce the base64 values.
set -euo pipefail
cd "$(dirname "$0")/.."

missing=0
require() {
  if [ -z "${!1:-}" ]; then
    echo "  missing: $1"
    missing=1
  fi
}

os="$(uname -s)"
echo "Checking signing environment for $os ..."
require CSC_LINK
require CSC_KEY_PASSWORD
if [ "$os" = "Darwin" ] && [ -z "${APPLE_API_KEY:-}" ]; then
  echo "  note: APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER not set;"
  echo "        the app will be signed but NOT notarized."
fi
if [ "$missing" = "1" ]; then
  echo "Set the variables above (docs/BUILD.md), or run an unsigned build:"
  echo "  pnpm --filter @monoclejs/desktop package"
  exit 1
fi

pnpm build:libs
pnpm --filter @monoclejs/desktop fetch:models
pnpm --filter @monoclejs/desktop build
pnpm --filter @monoclejs/desktop exec electron-builder
echo "Done. Installers are in apps/desktop/release/."
