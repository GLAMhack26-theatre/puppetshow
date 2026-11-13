#!/usr/bin/env bash
#
# Spike only (T4): a typeface font for TextGeometry into public/fonts/.
# IWSDK's three.js (super-three) doesn't ship examples/fonts; the real
# Geist Serif font comes from the converter later.

set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p public/fonts
curl -fL -o public/fonts/helvetiker_bold.typeface.json \
  https://raw.githubusercontent.com/mrdoob/three.js/r170/examples/fonts/helvetiker_bold.typeface.json
ls -l public/fonts
