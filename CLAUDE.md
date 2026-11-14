# Puppetshow – SKKG Marionetten Theater

GLAM hackathon 2026: the marionette paper theatre in 3D. A rigged marionette on a central stage, controlled by gestures (MediaPipe on webcam or phone camera, phone sensors; WebRTC remote and WebXR later). Built on Meta IWSDK (three.js, ECS) with Rapier physics, TypeScript and Vite.

## Architecture doc

@docs/architecture.md

- `docs/architecture.md` is the source of truth for decisions (engine, physics, input, asset pipeline, setup).
- When a change contradicts or extends a decision there, update the doc in the same change and add a line to its decision log (section 9).
- New plans build on this doc instead of starting from scratch.

## Conventions

- Code, comments and docs in English. Comments explain why.
- Assets: sources are committed in `assets/` (grouped by source, e.g. `assets/digital.skkg.ch/`). Large files (over about 20 MB) go to external storage and are downloaded by hand into `assets/external/` (git-ignored, see its README). `public/` is git-ignored (MediaPipe models from `scripts/fetch-mediapipe-models.sh`; later also the `convert` service's output) and never committed. No git LFS.
- Do not commit or push without being asked.
