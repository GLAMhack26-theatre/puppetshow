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
# The body models: only loaded while a session is recorded (?record,
# src/input/body-source.ts), to have the player's face and body next to the hands
curl -fL -o public/mediapipe/blaze_face_short_range.tflite \
  "$BASE/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
curl -fL -o public/mediapipe/face_landmarker.task \
  "$BASE/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
curl -fL -o public/mediapipe/pose_landmarker_lite.task \
  "$BASE/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
ls -l public/mediapipe
