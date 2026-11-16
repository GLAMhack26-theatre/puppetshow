#!/bin/sh
# Unpacks the sound effects the app uses from the committed CC0 packs in
# assets/sounds/opengameart.org/ into assets/sounds/sfx/ (git-ignored), under
# fixed names (src/audio/sfx.ts groups them by the part before the number).
# POSIX sh: runs on macOS, Linux and WSL2. Needs unzip.
#
#   ./scripts/unpack-sounds.sh
#
# Sources (both CC0):
#   RPGsounds_Kenney.zip          Kenney, "50 RPG sound effects"
#                                 https://opengameart.org/content/50-rpg-sound-effects
#   sfx_breaking_and_falling.zip  rubberduck, "75 CC0 breaking, falling and hit SFX"
#                                 https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/assets/sounds/opengameart.org"
OUT="$ROOT/assets/sounds/sfx"

if ! command -v unzip >/dev/null 2>&1; then
  echo "unzip is missing. Install it, e.g.: sudo apt install unzip (Linux/WSL2); macOS ships it." >&2
  exit 1
fi

mkdir -p "$OUT"

# zip  path-in-zip  name-in-sfx
MAP="
RPGsounds_Kenney.zip OGG/creak1.ogg creak-1.ogg
RPGsounds_Kenney.zip OGG/creak2.ogg creak-2.ogg
RPGsounds_Kenney.zip OGG/creak3.ogg creak-3.ogg
RPGsounds_Kenney.zip OGG/bookFlip1.ogg paper-1.ogg
RPGsounds_Kenney.zip OGG/bookFlip2.ogg paper-2.ogg
RPGsounds_Kenney.zip OGG/bookFlip3.ogg paper-3.ogg
RPGsounds_Kenney.zip OGG/cloth1.ogg cloth-1.ogg
RPGsounds_Kenney.zip OGG/cloth2.ogg cloth-2.ogg
RPGsounds_Kenney.zip OGG/cloth3.ogg cloth-3.ogg
RPGsounds_Kenney.zip OGG/cloth4.ogg cloth-4.ogg
RPGsounds_Kenney.zip OGG/doorClose_1.ogg knock-1.ogg
RPGsounds_Kenney.zip OGG/doorClose_2.ogg knock-2.ogg
RPGsounds_Kenney.zip OGG/doorClose_3.ogg knock-3.ogg
RPGsounds_Kenney.zip OGG/doorClose_4.ogg knock-4.ogg
RPGsounds_Kenney.zip OGG/bookPlace1.ogg place-1.ogg
RPGsounds_Kenney.zip OGG/bookPlace2.ogg place-2.ogg
RPGsounds_Kenney.zip OGG/bookPlace3.ogg place-3.ogg
sfx_breaking_and_falling.zip bfh1_wood_hit_01.ogg wood-1.ogg
sfx_breaking_and_falling.zip bfh1_wood_hit_02.ogg wood-2.ogg
sfx_breaking_and_falling.zip bfh1_wood_hit_03.ogg wood-3.ogg
sfx_breaking_and_falling.zip bfh1_wood_falling_01.ogg fall-1.ogg
sfx_breaking_and_falling.zip bfh1_wood_falling_02.ogg fall-2.ogg
sfx_breaking_and_falling.zip bfh1_metal_hit_01.ogg metal-hit-1.ogg
sfx_breaking_and_falling.zip bfh1_metal_hit_02.ogg metal-hit-2.ogg
sfx_breaking_and_falling.zip bfh1_metal_hit_03.ogg metal-hit-3.ogg
sfx_breaking_and_falling.zip bfh1_metal_hit_04.ogg metal-hit-4.ogg
sfx_breaking_and_falling.zip bfh1_metal_hit_05.ogg metal-hit-5.ogg
sfx_breaking_and_falling.zip bfh1_metal_hit_06.ogg metal-hit-6.ogg
sfx_breaking_and_falling.zip bfh1_metal_falling_01.ogg metal-fall-1.ogg
sfx_breaking_and_falling.zip bfh1_metal_falling_02.ogg metal-fall-2.ogg
sfx_breaking_and_falling.zip bfh1_metal_falling_03.ogg metal-fall-3.ogg
sfx_breaking_and_falling.zip bfh1_metal_falling_04.ogg metal-fall-4.ogg
sfx_breaking_and_falling.zip bfh1_metal_falling_05.ogg metal-fall-5.ogg
sfx_breaking_and_falling.zip bfh1_rock_hit_01.ogg stone-hit-1.ogg
sfx_breaking_and_falling.zip bfh1_rock_falling_01.ogg stone-fall-1.ogg
sfx_breaking_and_falling.zip bfh1_rock_falling_02.ogg stone-fall-2.ogg
sfx_breaking_and_falling.zip bfh1_rock_falling_03.ogg stone-fall-3.ogg
sfx_breaking_and_falling.zip bfh1_rock_falling_04.ogg stone-fall-4.ogg
sfx_breaking_and_falling.zip bfh1_glass_hit_01.ogg glass-hit-1.ogg
sfx_breaking_and_falling.zip bfh1_glass_hit_02.ogg glass-hit-2.ogg
sfx_breaking_and_falling.zip bfh1_glass_falling_01.ogg glass-fall-1.ogg
sfx_breaking_and_falling.zip bfh1_glass_falling_02.ogg glass-fall-2.ogg
sfx_breaking_and_falling.zip bfh1_glass_falling_03.ogg glass-fall-3.ogg
sfx_breaking_and_falling.zip bfh1_glass_falling_04.ogg glass-fall-4.ogg
RPGsounds_Kenney.zip OGG/dropLeather.ogg soft-1.ogg
RPGsounds_Kenney.zip OGG/handleSmallLeather.ogg soft-2.ogg
RPGsounds_Kenney.zip OGG/handleSmallLeather2.ogg soft-3.ogg
"

echo "$MAP" | while read -r zip path name; do
  [ -n "$zip" ] || continue
  if [ -f "$OUT/$name" ]; then continue; fi
  if [ ! -f "$SRC/$zip" ]; then
    echo "missing $SRC/$zip" >&2
    exit 1
  fi
  # -p: to stdout, so the zip's folders are not recreated
  unzip -p "$SRC/$zip" "$path" > "$OUT/$name"
  echo "  $name  <- $zip:$path"
done

echo "sound effects in $OUT: $(ls "$OUT" | wc -l | tr -d ' ')"
