#!/usr/bin/env bash
#
# Downloads the MediaPipe models into public/mediapipe/ (git-ignored).
# The wasm runtime comes from node_modules (vite.config.ts), only the
# models are fetched here.

set -euo pipefail
cd "$(dirname "$0")/.."

BASE=https://storage.googleapis.com/mediapipe-models
mkdir -p public/mediapipe
curl -fL -o public/mediapipe/hand_landmarker.task \
  "$BASE/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
curl -fL -o public/mediapipe/gesture_recognizer.task \
  "$BASE/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task"
ls -l public/mediapipe
