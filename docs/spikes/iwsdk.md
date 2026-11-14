# Phase 0 spike – IWSDK

Does Meta IWSDK work as the engine for the marionette theatre? The test code is in `src/spike/`, and the test is picked with `?test=world|puppet|interop`. The MediaPipe test (T3) has since become the page without `?test` (`src/input/mediapipe.ts`; `?test=mediapipe` still opens it): the camera starts with the click on a sign.

## Result before the spike (research)

- **IWSDK physics is not usable for the puppet.** It covers rigid bodies only: static, dynamic and kinematic bodies, shapes, damping, impulses and velocities. It has no joints or constraints, no sensors and no collision events. The Havok instance and body handles are private, and the physics probably runs in a Web Worker (`packages/core/src/physics/*`).
- **So IWSDK physics stays off** (`features.physics: false`), and Rapier runs as our own system (`src/systems/rapier-system.ts`).

## Run

```sh
./scripts/fetch-mediapipe-models.sh      # once
npm run dev                              # Mac only: http://localhost:5173/?test=…
npm run dev:https                        # phones: https://<LAN-IP>:5173/?test=…
npm run build                            # bundle size
```

## Questions

| # | Question | Result | Notes |
|---|---|---|---|
| 1 | IWSDK with `xr: false` on desktop, iOS Safari and Android Chrome (T1) | | |
| 2 | Rapier in the IWSDK loop: fixed step, pose sync through the ECS, rope joints, grab and throw (T2) | | |
| 3 | MediaPipe as an input source next to rendering (T3) | | |
| 4 | Plain three.js next to the ECS: `SkinnedMesh`, `TextGeometry` (`three/examples/jsm`), `PositionalAudio`, collision events (T4) | | |
| 5 | Our own camera works; IWSDK doesn't override it in browser mode | | |

## Measurements

| Device | T1 fps | T2 fps / physics ms | T3 fps / MediaPipe Hz (640) | T3 (320) | T4 fps |
|---|---|---|---|---|---|
| Desktop | | | | | |
| iPhone (model) | | | | | |
| Android (model) | | | | | |

Bundle size (`npm run build`, gzip; IWSDK `1.1.0-rc.2`, Rapier `0.21`, Vite 8):
- `world-initializer-*.js` 1.55 MB and `world-*.js` 1.68 MB: the two largest chunks, mostly IWSDK. Which chunks load on the first page view still needs checking in the network tab.
- `physicsShape-*.js` 184 KB: IWSDK physics code that is still bundled, although its physics is turned off.
- About 15 font chunks of 250–360 KB each (`inter`, `roboto`, …), from IWSDK's UI kit. Presumably loaded only when used.

## Findings so far

- **`super-three`:** IWSDK uses `three@npm:super-three@0.185.0` plus `@types/three@0.185`. `three/examples/jsm` add-ons (`OrbitControls`, `FontLoader`, `TextGeometry`) resolve and type-check against it. The package doesn't ship `examples/fonts`; the spike font (helvetiker, fetched by a script) was dropped later, and the interop test now hangs plain blocks.
- **API:** `tsc` passed on the first try. `World.create` options, `world.scene/camera/renderer`, `createSystem`, `createComponent`, `entity.object3D`, `getValue` and the three.js re-exports from `@iwsdk/core` all match what we assumed.
- **IWSDK version:** npm installed `1.1.0-rc.2`, a release candidate. Pin it or switch to the stable `1.0.x` before phase 1.

- The rope joint in Rapier's JS API has no length setter. Pulling a string removes and recreates the joint. This works, but check whether it causes jumps.
- Spherical joints have no cone limits in Rapier's JS API. For now, angular damping keeps the limbs calm. For the real rig, use revolute joints for elbows and knees, or generic joints if needed.

## Decision

Go or fallback (own thin engine, `docs/architecture.md` §1):
