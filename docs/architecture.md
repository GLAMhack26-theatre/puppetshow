# Puppetshow – SKKG Marionetten Theater (architecture plan)

## Context

GLAM hackathon 2026: bring the marionette paper theatre back into 3D. On a central, room-filling stage, the visitor plays a scene interactively with a rigged marionette controlled by gestures. The marionette can hold, throw and drop objects.

The repo is empty apart from the README; this doc defines the setup and architecture to build on.

## Decisions

| Topic | Decision |
|---|---|
| Rendering | three.js (the version bundled by IWSDK), `GLTFLoader`; no R3F |
| Game engine | **Meta IWSDK** (`@iwsdk/core`, MIT) in browser mode: `World.create(container, { xr: false })`. WebXR later via `xr: { offer: … }` |
| Physics | **Rapier** (`@dimforge/rapier3d-compat`) as our own system; IWSDK physics stays off (`features.physics: false`) |
| Gestures | MediaPipe (`@mediapipe/tasks-vision`: HandLandmarker + GestureRecognizer) |
| Targets | Phone and desktop with a webcam first, the phone running everything itself. WebRTC remote and VR later |
| Audio | three.js audio (Web Audio, positional) + **ZzFX** (~1 KB) for generated effects; music as `.m4a` |
| Tooling | TypeScript + Vite + HTTPS + Docker Compose; the app is served directly by Vite (no Traefik or nginx for now) |
| Assets | Sources committed in `/assets`, grouped by source; large files on external storage, downloaded by hand into `assets/external/` (git-ignored); the `convert` service turns both automatically into `/public` |
| Fonts | Geist Serif (titles, 3D letters) + Geist Sans (UI), bundled from the `geist` npm package (OFL) |
| Exit | Back to the title screen |
| Later | WebRTC remote (display + phone via QR), WebXR 3DoF/6DoF, LiteRT-LM |

Background: other engines and physics libraries were also evaluated.
- **Engines:** Needle Engine (not MIT), Houseki (GPL), elixr, Meep (archived), LittleJS (2D only), and our own thin engine.
- **Physics:** Rapier, Jolt, cannon-es and Havok. IWSDK ships Havok, but its physics API only covers rigid bodies: no joints, no sensors, no collision events, and the Havok instance is private (probably in a worker). The marionette needs all three, so Rapier runs as our own system.

---

## 1. Engine use (IWSDK)

**From IWSDK:**
- the ECS
- the render loop and scene
- spatial audio
- `PanelUI` / `ScreenSpace` UI
- canvas pointer, keyboard and gamepad input
- the Vite dev plugin (`@iwsdk/vite-plugin-dev`)
- later: XR input and the emulator

**Our own:**
- the stage camera (fixed or orbit; IWSDK leaves the camera to the app)
- all control input
- physics: `RapierSystem` (fixed 60 Hz step, poses synced to entities through `PhysicsLink`)
- the puppet rig, strings and grab: we write our own `GrabSystem`, because IWSDK's near-field grab is XR-only and grabbing here is done by the puppet's hands, not the user's

**Systems:**
- **Input:** `MediaPipeInputSystem`, `PhoneInputSystem` and `MouseInputSystem` all write `ControlInput`. `RemoteInputSystem` and `XRInputSystem` come later.
- **Puppet:** `PuppetRigSystem` (physics pose → `SkinnedMesh` bones), `StringSystem` (constraint lengths + rendering the strings), `GrabSystem`.
- **Stage and scenes:** `SpotlightSystem`, `AudioSystem`, `SceneFlowSystem` (Title ↔ Main).

**Components:** `Puppet`, `StringAttachment`, `Prop` (grabbable/throwable), `HangingLetter`, `Spotlight`.

### Phase 0 spike (½ day)
1. `xr: false` on a real phone (iOS Safari, Android Chrome): frame rate, bundle size, touch input, and the camera running together with MediaPipe.
2. **Rapier in the IWSDK loop:** fixed timestep, pose sync, rope joints for strings, spherical joints for limbs, grab with a sensor and a fixed joint. (IWSDK's own physics was ruled out before the spike.)
3. Plain three.js next to the ECS: raw `SkinnedMesh` bones, `TextGeometry`, `PositionalAudio`.
4. Does a custom system (MediaPipe) fit cleanly into the IWSDK loop?

If items 1 or 2 fail, the fallback is our own thin engine with the same split into systems and components.

---

## 2. Scenes & gameplay

**Title screen**
- "SKKG Marionetten Theater": each letter is a `TextGeometry` mesh in Geist Serif. The font is converted to typeface JSON by the converter.
- Each letter hangs on strings (Rapier rope joints) and sways. Pointer or hand movement pushes the letters.
- The **Play** button opens the main scene. It also unlocks audio and asks for the camera and motion-sensor permissions, because iOS only grants these after a user gesture.

**Main scene**
- At start the main curtain (`assets/stage_parts/Main_Curtain.glb`, `src/stage/main-curtain.ts`) hangs right in front of the camera and covers the whole screen at any aspect ratio, with a light cloth wobble (shader). Two seconds after start three signs (`src/stage/signs.ts`, the plays to choose from: `Sign_Haensel`, `Sign_Froschkoenig`, `Sign_Impro` in `assets/stage_parts/`) drop in one after another in a loose, slightly tilted row in front of it, overshoot and settle, and cast soft fake shadows on it (blurred silhouette quads, no shadow map). Hover enlarges a sign; a click on a sign raises the curtain, and the signs go up with it.
- **Impro mode** (the `Sign_Impro` sign, `src/impro/impro.ts`): once the curtain is up, a menu offers **Bühnenbild**. It slides in a panel from the right (a quarter of the screen width, at least 240 px for phones): a starry night sky with a scalloped gold edge, on which the painted backdrops are paper cards travelling along a curve while scrolling, the middle one biggest (`src/impro/backdrop-slider.ts`, look tuned in its `SLIDER` constants, no settings UI). The cards are the painted backdrops (`assets/stage_parts/Background_*.glb`, picked up automatically; thumbnails are cut from the texture inside each `.glb`). A click stands that backdrop still at the back edge of the stage floor, scaled to the floor's (`Ground_Box`) width and unlit, (`src/stage/backdrops.ts`), replacing the previous one; a second click removes it. Backdrops are revealed like a sheet let down from the fly loft: they sink into place while a ragged torn-paper edge uncovers them from the top (shader discard on uv), and hide in reverse; switching crossfades. Props (3D models) follow the same way later.
- A central stage that fills the room: proscenium, curtains, and layered paper-theatre backdrops (scans as alpha planes).
- Behind the theatre: a curved red velvet wall with a gold band at its foot (`assets/stage_parts/wall.glb`, `src/stage/wall.ts`), 4 m wide, its hollow side towards the camera, 0.3 m behind the stage; the velvet texture is grey and tiled (one repeat per 0.5 m) instead of stretched; its colour is multiplied in from `VELVET_COLOR`.
- Around the theatre: a 20 m ground plane with the tiled asphalt wood (`assets/textures/herringbone_parquet_diff_1k.jpg`, one repeat per 1.5 m) at the bottom of the stage model, fading out radially so there is no horizon line (`src/stage/ground.ts`).
- **3-point lighting:** key, fill and back light.
- **One controllable spotlight:**
  - moved by gesture, phone or UI
  - option to follow the puppet
  - the only light casting shadows on phones
- The marionette and props it can interact with: hold, throw, drop.
- **Exit** goes back to the title.

**UI/UX, "game theatre" character**
- Curtain transitions, ticket- or programme-style buttons, Geist Sans for the UI, Geist Serif for titles.
- Debug HUD with landmarks, FPS and physics wireframe, toggled with `?debug`.
- An old-film vignette (darkened, softly burnt-in edges) lies over the 3D view in 2D, under the UI (buttons, HUD, impro menu and slider): a CSS overlay in `index.html` that lets all input through.
- Debug buttons top right pick `?test=…`; **impro** (`?test=nocurtain`) skips the main curtain and the signs and goes straight into impro mode.

---

## 3. Marionette control

### 3.1 One input model

```ts
interface ControlInput {                              // mutable, written once per frame
  bar: { position: Vector3; rotation: Quaternion };   // the control bar (Spielkreuz)
  pulls: Record<StringId, number>;                    // 0..1 per string: head.L/R, shoulder.L/R, back, hand.L/R, knee.L/R
  grip: { left: boolean; right: boolean };            // puppet hands grab / release
  spotlight?: { target: Vector3 };
  source: "mediapipe" | "phone" | "mouse" | "remote-phone" | "xr-3dof" | "xr-6dof";
}
```

| Source | Bar pose | Pulls | Grip | When |
|---|---|---|---|---|
| MediaPipe (webcam on desktop or phone) | Wrist/palm pose of the main hand | Fingertip heights relative to the palm | `Closed_Fist` / pinch | now |
| Phone sensors + touch | DeviceOrientation (3DoF) | Touch zones/sliders | Button | now |
| Mouse/keyboard | Drag, wheel | Keys | Click | now (dev) |
| Remote phone (WebRTC) | Same as phone, streamed | Same | Same | later |
| WebXR 3DoF / 6DoF | Controller orientation / controller or `XRHand` pose | Trigger / finger joints | Grip / pinch | later |

MediaPipe runs with `detectForVideo` on `requestVideoFrameCallback`, separate from the render loop. It uses the GPU delegate and falls back to CPU. The wasm and the `.task` models are served locally from `/mediapipe/`, so no CDN is needed at runtime.

### 3.2 Puppet rig

1. **The model defines the rig (decided):** the SKKG marionette (README, "Marionette model") comes as `export/marionette.glb` plus `export/marionette_rig.json`. The JSON holds per bone the capsule collider, `mass_kg` and the joint (cone, or hinge with a bone-local axis and limits in degrees), and the 9 strings (socket, carrying bone, position, controller point, rest length). `src/puppet/marionette.ts` turns it into a rig description; nothing about the puppet is hard-coded.
   - **Bones:** `root`, `pelvis`, `chest`, `neck`, `head`, `upper_arm/forearm/hand.L/R`, `thigh/shin/foot.L/R`.
   - **Strings:** `head.L/R`, `shoulder.L/R`, `back`, `hand.L/R`, `knee.L/R`. The model's three controller bars are merged into one bar.
   - **Real scale:** the puppet is 0.35 m tall; the stage is scaled to match (1.4 m wide), and so are camera, lights and props.
   - **Masses:** the real masses from the JSON, with a floor of 5 % of the heaviest part, so the tiny hands don't destabilise the joint chains.
2. **At runtime:**
   - one Rapier body per bone with a collider (capsule from the JSON); all bodies start unrotated, so a hinge's world axis is the same in both bodies
   - spherical or revolute joints between neighbouring bones (Rapier's JS API has no cone limits for spherical joints, so angular damping or revolute joints keep the limbs plausible)
   - the physics pose drives the `SkinnedMesh` bones
3. **Strings:**
   - the control bar is a kinematic body positioned from `ControlInput.bar`
   - each string is a rope joint (maximum distance, rest length from the JSON), from a point on the bar to the socket `string_<id>`
   - a pull shortens the rope; the JS API has no length setter, so the joint is recreated when the length changes
   - the string is drawn as a sagging verlet/catenary line (rendering only)
4. **Grab, throw, drop:**
   - each puppet hand has a sensor collider
   - grip while a prop is in reach creates a fixed joint
   - release removes the joint; the prop keeps the hand's velocity, which gives a throw
   - release at low speed is a drop

---

## 4. Asset pipeline (`convert` service)

The sources are committed in `/assets`, grouped by where they come from (e.g. `assets/digital.skkg.ch/Stuhl_25210.6.{blend,glb,jpg}`: the original photo, the Blender file and a `.glb`). Large files (over about 20 MB) are not committed: they live on external storage and everyone downloads them by hand into `assets/external/<source>/`, which is git-ignored except for its README (`assets/external/README.md`, with the storage location). No git LFS. The converter reads both `assets/` and `assets/external/`.

The converter writes to `/public` (git-ignored) plus `public/manifest.json`. It works incrementally, comparing source hashes, and runs with `--watch` in dev.

| Source | Tool (in the container) | Output |
|---|---|---|
| `.blend`, `.fbx`, `.obj` | Blender headless (`blender -b … --python export.py`) | `.glb` with skeleton and `string.*` empties |
| `.glb/.gltf` + Blender output | `gltf-transform` (meshopt, KTX2/WebP) | optimized `.glb` |
| Paper sheet scans | `sharp` + `gltf-transform` | alpha quad `.glb` |
| Audio | ffmpeg | `.m4a` (+ `.webm`) |
| Geist Serif | typeface conversion | JSON for `TextGeometry` |

---

## 5. Project layout

```
assets/<source>/        # committed sources (models, sheets, audio, fonts), e.g. assets/digital.skkg.ch/
assets/external/        # large files from external storage, downloaded by hand (git-ignored)
blender/  export/  tools/   # marionette: Blender build scripts, exported .glb/.fbx + rig JSON, texture tools
scripts/fetch-mediapipe-models.sh
converter/              # Dockerfile (Blender LTS + node + ffmpeg), export.py, convert.mjs
certs/                  # git-ignored TLS cert/key for Vite (server.https / preview.https)
src/
  main.ts               # IWSDK World (xr:false), register systems
  components/  systems/  scenes/{title,main}.ts
  stage/{stage,lighting,backdrops}.ts
  input/{control-input,mediapipe,phone,mouse}.ts
  audio/{audio,zzfx}.ts
  ui/                   # overlay, styles, Geist fonts
index.html  vite.config.ts  tsconfig.json  package.json
Dockerfile  docker-compose.yml  dev.sh  CLAUDE.md
```

**Setup:**
- **Vite:** `@vitejs/plugin-basic-ssl` behind `--mode https` (`npm run dev:https`, works in every shell) or `HTTPS=1`, because the camera, DeviceOrientation and WebXR need HTTPS on phones. A Vite plugin serves the wasm files (MediaPipe, basis transcoder) from `node_modules`.
- **Served directly for now:** no reverse proxy, no Traefik and no nginx.
  - The `web` container runs Vite with HTTPS: `vite` (HMR) in dev, or `vite build && vite preview` for the demo.
  - The port (5173 / 4173) is published directly. TLS comes from `@vitejs/plugin-basic-ssl`, or from a certificate in `./certs` passed through `server.https` / `preview.https`.
  - An nginx image can be added later without changes to the app.
- **`docker-compose.yml`:** `web` (Vite, port published) and `convert` (`--watch` in dev).
- **`dev.sh`:** `./dev.sh --https -- --host` for testing phones on the LAN.

---

## 6. Phases

0. IWSDK spike (section 1): go or fallback.
1. Scaffold: IWSDK browser-mode project, Vite/TS/HTTPS, scene flow, Docker Compose (Vite served directly), dev.sh, CLAUDE.md.
2. Converter + asset sync.
3. Title scene: hanging letters, Play → main, Exit → title.
4. Main stage: 3-point lights, spotlight, backdrops, audio (music + ZzFX).
5. Puppet: placeholder rigged `.glb` until the real `.blend` arrives; strings; mouse control.
6. MediaPipe → `ControlInput` (desktop + phone camera).
7. Phone sensors + touch control.
8. Grab, throw, drop with props.
9. Later: WebRTC remote (signaling service + QR pairing), WebXR, LiteRT-LM.

## 7. Risks

- **Rapier next to IWSDK:** IWSDK's own physics stays off. If we later want IWSDK features that assume its physics (e.g. its grabbing in XR), they will need an adapter to our Rapier bodies.
- **MediaPipe and rendering together on a mid-range phone:** performance needs to be measured in phase 0. Possible measures: lower camera resolution, inference at 15–30 Hz.
- **Blender in Docker on Apple Silicon** runs under x86 emulation and is slow. A local `BLENDER_BIN` is the fallback.
- **iOS permissions:** camera, DeviceOrientation and audio all need a user gesture, which the Play button provides.
- **Self-signed certificates:** phones warn once. For the demo, use a real certificate on the server.

## 8. Verification

- `npm run build` passes (tsc + vite).
- `./dev.sh --https -- --host <LAN-IP>`:
  - the title letters sway and Play/Exit work
  - the puppet follows the mouse, then MediaPipe on desktop and phone
  - a prop can be grabbed, thrown and dropped
- `docker compose run --rm convert`: all source types produce output, and a second run skips unchanged files.
- `docker compose up`: `https://<LAN-IP>:5173` (or 4173 for preview) opens on a phone, and the camera and sensors work.

---

## 9. Decision log

Add one line per change to a decision in this doc: date, what changed, why.

| Date | Change | Reason |
|---|---|---|
| 2026-11-14 | Old-film vignette drawn over the 3D view, under the UI (CSS overlay); `?test=nocurtain` (debug button "impro") skips the main curtain and the signs and starts impro mode | Look of an old film; faster development without clicking through the curtain |
| 2026-11-14 | Curved velvet wall behind the theatre | The stage stood in front of empty black space |
| 2026-11-14 | Backdrop picker: paper-theatre slider (night sky, cards on a curve) instead of a plain list; panel at least 240 px wide | Design from the "Papiertheater" mock-up; a quarter of a phone screen is too narrow for the cards |
| 2026-11-13 | Ground around the theatre: tiled asphalt plane, fading out at its rim | The theatre floated in black space |
| 2026-11-13 | Impro mode: stage set built by the visitor, starting with backdrops from a side panel; backdrops unlit and as wide as `Ground_Box` | First step of the impro play: choose the scenery before playing |
| 2026-11-13 | Main curtain follows the camera (camera space, drawn over everything) instead of being placed in the stage; a click on one of the signs in front of it raises it | It must cover the screen on every aspect ratio (phone portrait, desktop) and while the orbit camera moves |
| 2026-11-13 | HTTPS switched on by `vite --mode https` (`HTTPS=1` still works); `.sh` files always checked out with LF (`.gitattributes`) | `HTTPS=1 vite` fails in cmd/PowerShell, and CRLF scripts fail in WSL2 |
| 2026-11-13 | Marionette: rig from `export/marionette_rig.json` (9 strings), real scale 0.35 m with the stage scaled to 1.4 m, real masses with a 5 % floor, file size reduced later by the converter | The rigged SKKG model arrived with full engine metadata |
| 2026-11-13 | Large assets: external storage, downloaded by hand into `assets/external/` (git-ignored); no git LFS | Keep the repo small without LFS quotas |
| 2026-11-13 | Assets: committed in `/assets` (grouped by source) instead of synced from outside git | The team already committed the first objects |
| 2026-11-13 | Physics: Havok → Rapier as our own system, IWSDK physics off | IWSDK's physics has no joints, sensors or collision events, and its Havok instance is private |
| 2026-11-13 | Initial architecture: IWSDK + Havok, MediaPipe, three.js audio + ZzFX, phone-only first, Vite served directly (no proxy), assets outside git | Planning session |
