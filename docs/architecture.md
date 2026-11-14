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
| Audio | Web Audio; background music and excerpts **streamed from archive.org** (netlabel releases, `assets/sounds/archive.json`); effects as CC0 samples + **ZzFX** (~1 KB); three.js positional audio for physics sounds. Off at every load, turned on by the speaker button |
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
- At start the main curtain (`assets/stage_parts/Main_Curtain.glb`, `src/stage/main-curtain.ts`) hangs right in front of the camera and covers the whole screen at any aspect ratio, with a light cloth wobble (shader). Two seconds after start three signs (`src/stage/signs.ts`, the plays to choose from: `Sign_Haensel`, `Sign_Froschkoenig`, `Sign_Impro` in `assets/stage_parts/`) drop in one after another in a loose, slightly tilted row in front of it, overshoot and settle, and cast soft fake shadows on it (blurred silhouette quads, no shadow map). Hover enlarges a sign; a click on a sign raises the curtain, and the signs go up with it. The same click starts the camera and MediaPipe hand control (`src/input/mediapipe.ts`): it is the user gesture camera access needs. Without a camera (or permission) the mouse keeps control; a **Kamera starten** button in the debug panel starts it by hand.
- **Impro mode** (the `Sign_Impro` sign, `src/impro/impro.ts`): once the curtain is up, round icon buttons (`assets/ui/icon-*.png`) appear at both screen edges, two per side: left **Requisiten** and **Sound**, right **Hintergrund** and **Licht**. Each side has one panel with a page per button; the buttons belong to the panel and ride along at its scalloped edge (closed, the panel stays out just far enough to keep them at the screen edge), the chosen one with a gold ring, and a golden X without background under them closes it. Licht is an empty sky for now; Sound lists the archive.org excerpts (see Sound below). The **Hintergrund** page is a panel from the right (a quarter of the screen width, at least 240 px for phones): a starry night sky with a scalloped gold edge, on which the painted backdrops are paper cards travelling along a curve while scrolling, the middle one biggest (`src/impro/backdrop-slider.ts`, look tuned in its `SLIDER` constants, no settings UI). The cards are the painted backdrops (`assets/stage_parts/Background_*.glb`, picked up automatically; thumbnails are cut from the texture inside each `.glb`). A click stands that backdrop still at the back edge of the stage floor, scaled to the floor's (`Ground_Box`) width and unlit, (`src/stage/backdrops.ts`), replacing the previous one; a second click removes it. Backdrops are revealed like a sheet let down from the fly loft: they sink into place while a ragged torn-paper edge uncovers them from the top (shader discard on uv), and hide in reverse; switching crossfades.
- **Requisiten** (props, `src/props/requisits.ts`): the same slider, mirrored on the left (`createSlider({ mirror: true })`), lists every `.glb` in `assets/digital.skkg.ch/requisits/`. Card picture: an image with the same name next to the `.glb` (`Stuhl.png`) if there is one, otherwise the model is rendered once in a small offscreen renderer. A click lowers the prop onto the stage as if on a string (kinematic), a second click lifts it off. The spot is chosen by best-candidate sampling: of 24 random spots on the floor the one with the most room to the props already there wins, so props spread out. Standing props are dynamic Rapier bodies (box collider; small ones register as grabbable); they are dragged across the floor with mouse or finger (kinematic while dragged, pushing others aside; the orbit camera is held off by a capture-phase listener). A prop knocked off the stage is let down again on a free spot. Anything larger than 0.5 m is scaled down.
- **IIIF objects** (`src/props/iiif.ts`): the last props card is a drop field. A IIIF 3D manifest (Presentation 4, e.g. `IIIFManifests/microscope_ethz_GEOB_0055.json`) dropped onto the slider as a file or link (a viewer link with `?manifest=` works too), or picked by a click, becomes a new prop card and lands on the stage at once. Read from the manifest: label (shortened to its first part), thumbnail, homepage (the card's "i") and the first painted `Model` with its rotate/scale transforms; the scene's cameras and lights are ignored. The `.glb` is loaded from where the manifest points (it must allow CORS), at real size in metres; Draco is decoded with three's decoder, served under `/draco/` by the Vite plugin. Added objects last until the page reloads.
- **Catalogue** (`assets/catalogue.json`, read by `src/catalogue.ts`): hand-edited per file name, for props (`requisits`) label, `scale` and `source`, for backdrops label and `source`. A scale other than 1 shows under the card's name as "Massstab 1 : 5". `source` is the object's page in the SKKG collection: a round gold "i" on the card's outer side (left on props, right on backdrops) opens it in a new tab. `"ai"` marks an object invented without an SKKG original: the "i" then shows the "Fake-Objekt gefunden!" popup (beige paper with the slider's scalloped gold edge, `src/impro/source-info.ts`). An empty `source` shows no "i".
- A central stage that fills the room: proscenium, curtains, and layered paper-theatre backdrops (scans as alpha planes).
- Behind the theatre: a curved red velvet wall with a gold band at its foot (`assets/stage_parts/wall.glb`, `src/stage/wall.ts`), 4 m wide, its hollow side towards the camera, 0.3 m behind the stage; the velvet texture is grey and tiled (one repeat per 0.5 m) instead of stretched; its colour is multiplied in from `VELVET_COLOR`.
- Around the theatre: a 20 m ground plane with the tiled asphalt wood (`assets/textures/herringbone_parquet_diff_1k.jpg`, one repeat per 1.5 m) at the bottom of the stage model, fading out radially so there is no horizon line (`src/stage/ground.ts`).
- **3-point lighting:** key, fill and back light (`src/stage/lighting.ts`), the general light on the stage. Kept low enough that the follow spots stand out and white props do not burn out (the renderer has no tone mapping, so the unlit painted parts keep their colours).
- **Follow spots** (`src/stage/spotlights.ts`, `SpotlightSystem`): every puppet on the stage gets its own spotlight, created with the puppet (`createPuppet`), which tracks its chest with a slight lag.
  - They hang on a lighting bar out in front of the stage (1.6 m in front, 1.2 m up, above the camera's view), as front-of-house spots do in a real theatre, each as a small fixture that turns with its beam.
  - They add a pool of focus light around the puppet to the stage already lit by the 3-point lighting; the beam is also drawn as faint haze (an additive cone, rendering only).
  - They are the only lights casting shadows; on phones only the first spot does.
- The marionette and props it can interact with: hold, throw, drop.
- **Exit** goes back to the title.

**UI/UX, "game theatre" character**
- Curtain transitions, ticket- or programme-style buttons, Geist Sans for the UI, Geist Serif for titles.
- **Debug mode** (`src/ui/debug-mode.ts`): the test links top right, the debug panel at the bottom, and the HUD (landmarks, FPS, physics wireframe) are hidden by default; the camera preview with the hand landmarks always stays visible, as the player's feedback. Shift+D toggles them, `?debug` switches them on; the state is kept in `sessionStorage`, so it survives the test links' reloads within the tab.
- **Sound** (`src/audio/`, `src/ui/sound-toggle.ts`): a round speaker button at the bottom right, below the camera preview, **off at every page load** (not remembered) until the speaker button or a sign is clicked; its click creates the `AudioContext` (the user gesture iOS needs). Left of it, while music plays, the credit of the track (title · creator · licence), linked to its archive.org item, as the CC BY licences require. Background music is streamed from archive.org, never committed (the NC/ND licences allow playing, not cutting): `assets/sounds/archive.json` lists the playlists and which play uses which (`ragtime` by default and for the curtain, Froschkönig `frogs`, Hänsel and Impro `percussion`; the Kaleidoscope EP was dropped, it has no licence); a sign click turns sound on (it is a user gesture) and crossfades to the play's playlist. Its tracks and credits are written by `scripts/index-archive.mjs` from the archive.org metadata API; items without a licence are left out, and an empty playlist falls back to `ragtime`. The audio elements go through Web Audio (archive.org sends CORS headers), because iOS ignores `HTMLMediaElement.volume`.
- **Excerpts** (`src/audio/excerpts.ts`): passages of Oda Klonk's "Ein Haus das klingt" (start and end in `archive.json`), played from the stream by seeking (archive.org serves range requests) and faded out at the end, never cut into files (ND licence). The impro **Sound** page lists them as cards (`src/impro/sound-icons.ts` draws their pictures); a click plays one and turns sound on if it was off, a second click stops it, the "i" opens the archive.org item. While an excerpt plays, the background music ducks to 30 % and the credit line shows the excerpt. Event cues (`archive.json` "cues"): the sign click plays "Eröffnung" (the end of the drum roll into the announcement "So meine Damen und Herren …") while the curtain rises.
- An old-film vignette (darkened, softly burnt-in edges) lies over the 3D view in 2D, under the UI (buttons, HUD, impro menu and slider): a CSS overlay in `index.html` that lets all input through.
- Without `?test` the page is the play itself: curtain, signs, then the marionette with hand control. Debug buttons top right (debug mode, Shift+D) pick `?test=…`; **impro** (`?test=nocurtain`) skips the main curtain and the signs and goes straight into impro mode; **puppet** is the marionette with the mouse only, **world** the stage alone with an orbit camera.

---

## 3. Marionette control

### 3.1 One input model

```ts
interface ControlInput {                              // mutable, written once per frame
  bar: { position: Vector3; rotation: Quaternion };   // main bar of the control cross (Spielkreuz)
  rock: { hands: number; legs: number };              // rad, ±0.6: rocking the hand bar / leg bar
  pulls: Record<StringId, number>;                    // 0..1 per string on top (plucking): head.L/R, shoulder.L/R, back, hand.L/R, knee.L/R
  grip: { left: boolean; right: boolean };            // puppet hands grab / release
  source: "mediapipe" | "phone" | "mouse" | "remote-phone" | "xr-3dof" | "xr-6dof";
}
```

| Source | Bar pose | Rock (hands / legs) | Pulls | Grip | When |
|---|---|---|---|---|---|
| MediaPipe (webcam on desktop or phone) | Wrist/palm pose of the main hand | Open (not decided) | Fingertip heights relative to the palm | Pinch (thumb–index); a fist lets go of the puppet, see below | now |
| Phone sensors + touch | DeviceOrientation (3DoF) | Open (not decided; e.g. touch sliders) | Touch zones/sliders | Button | now |
| Mouse/keyboard | Drag, wheel | Q/E legs, A/D hands, sliders | Sliders | Click | now (dev) |
| Remote phone (WebRTC) | Same as phone, streamed | Same | Same | Same | later |
| WebXR 3DoF / 6DoF | Controller orientation / controller or `XRHand` pose | Open (not decided) | Trigger / finger joints | Grip / pinch | later |

**Letting go of the puppet (MediaPipe, `src/input/hand-release.ts`):** while a hand is attached, the cross follows it, so lowering the hand would drag the puppet down. A fist held for 3 s lets go: the cross stays where it is and the puppet's hands open. The player then has 5 s to take the hand away, shown by a little timer (`src/ui/release-timer.ts`; the same ring fills while the fist is held). After that a hand connects again by itself as soon as it is seen above the low zone. A hand in the low zone (the bottom quarter of the camera image, standing in for "hand down at the lower torso", which a hand model cannot see) never connects; this also holds at the start, and for a hand that left the camera image for more than a second (it is let go without a countdown). Once attached, the hand may go as low as it likes, so the puppet can still be lowered. The fist is read from the hand landmarks (all four fingertips nearer to the wrist than their middle joints), so only the HandLandmarker runs.

MediaPipe runs with `detectForVideo` on `requestVideoFrameCallback`, separate from the render loop. It uses the GPU delegate and falls back to CPU. The wasm and the `.task` models are served locally from `/mediapipe/`, so no CDN is needed at runtime.

### 3.2 Puppet rig

1. **The model defines the rig (decided):** the SKKG marionette (README, "Marionette model") comes as `export/marionette.glb` plus `export/marionette_rig.json`. The JSON holds per bone the capsule collider, `mass_kg` and the joint (cone, or hinge with a bone-local axis and limits in degrees), and the 9 strings (socket, carrying bone, position, controller point, rest length). `src/puppet/marionette.ts` turns it into a rig description; nothing about the puppet is hard-coded.
   - **Bones:** `root`, `pelvis`, `chest`, `neck`, `head`, `upper_arm/forearm/hand.L/R`, `thigh/shin/foot.L/R`.
   - **Rest pose:** arms hanging down (no T-pose), as a marionette rests on its strings.
   - **Strings:** `head.L/R`, `shoulder.L/R`, `back`, `hand.L/R`, `knee.L/R`.
   - **Control cross:** the real SKKG 9-string cross, in the JSON's `controller` section (bars with pivot, rocking axis and sticks; each string names its bar):
     - main bar (16 cm, front–back): the back string at its rear end; a fixed shoulder crossbar (11 cm) and a head bar hanging below it;
     - leg bar (12 cm) on a post under the middle, rocks about the main bar's axis: knee strings, walking;
     - hand bar (15 cm) on a pivot at the front tip, rocks the same way: hand strings.
   - **Real scale:** the puppet is 0.35 m tall; the stage is scaled to match (1.4 m wide), and so are camera, lights and props.
   - **Masses:** the real masses from the JSON, with a floor of 5 % of the heaviest part, so the tiny hands don't destabilise the joint chains.
2. **At runtime:**
   - one Rapier body per bone with a collider (capsule from the JSON); all bodies start unrotated, so a hinge's world axis is the same in both bodies
   - spherical or revolute joints between neighbouring bones (Rapier's JS API has no cone limits for spherical joints, so angular damping or revolute joints keep the limbs plausible)
   - the physics pose drives the `SkinnedMesh` bones
3. **Strings:**
   - each bar of the cross is a kinematic body: the main bar is positioned from `ControlInput.bar`, the two rocking bars ride on it and turn by `ControlInput.rock`
   - each string is a rope joint (maximum distance, rest length from the JSON), from its eye on its bar to the socket `string_<id>`
   - tilting the cross does much of the acting: sideways tilts the head and sways the body; back raises the front bars (hands and knees lift); forward lowers them and lifts the back string a little (a slight bow; a deeper bow needs the back eye further behind the pivot, both sketch estimates); rocking the leg bar walks; rocking the hand bar lifts one hand
   - hips and knees are hinges: the angled knee strings would otherwise twist the legs
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
scripts/fetch-mediapipe-models.sh  scripts/index-archive.mjs
converter/              # Dockerfile (Blender LTS + node + ffmpeg), export.py, convert.mjs
certs/                  # git-ignored TLS cert/key for Vite (server.https / preview.https)
src/
  main.ts               # IWSDK World (xr:false), register systems
  components/  systems/  scenes/{title,main}.ts
  stage/{stage,lighting,spotlights,backdrops}.ts
  input/{control-input,mediapipe,hand-release,phone,mouse}.ts
  audio/{audio,ambient,zzfx}.ts   # graph + on/off, archive.org playlists
  ui/                   # overlay, release timer, sound button, debug mode, styles, Geist fonts
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
| 2026-11-14 | The sign click turns sound on | The curtain cue was almost never heard: sound is off at load, and the signs come before the visitor finds the speaker |
| 2026-11-14 | Sound page: archive.org excerpts as cards, played from the stream by seeking; the curtain cue plays the opening drum roll and announcement; background music ducks while an excerpt plays | Sounds the visitor can trigger during the play; seeking keeps the ND recording uncut |
| 2026-11-14 | Sound: background music streamed from archive.org netlabel releases (playlist per play, crossfade, credit shown while playing), indexed by `scripts/index-archive.mjs`; speaker button bottom right, off at every load; effects as CC0 samples + ZzFX instead of `.m4a` files | Era-fitting music without storing it; NC/ND licences allow streaming but not cutting; visitors choose whether there is sound |
| 2026-11-14 | Debug mode: test links, debug panel and HUD hidden unless Shift+D (or `?debug`) is on, kept per tab in `sessionStorage` | The play should show no developer controls; the test links reload the page, so the state must survive them; the hand preview stays, players need it |
| 2026-11-14 | Presentation mode (`src/presentation/`, Shift+P / button, ESC closes): 3 fullscreen slides (collection objects with turning models, marionette controls, outlook with QR code); one shared renderer for all slide views | Pitch inside the app, with the real models instead of screenshots |
| 2026-11-14 | Impro menu: round icon buttons at the panels' edges (two per side, with empty Sound and Licht pages) and a golden X replace the text buttons at the bottom | Stage set-up tools sit where their panels open; room for sound and light later |
| 2026-11-14 | IIIF drop field as the last props card: a 3D manifest becomes a prop on the stage; Draco decoder served locally next to the MediaPipe wasm | Objects from other collections join the play without a converter step |
| 2026-11-14 | `assets/catalogue.json` holds label, scale and SKKG source of props and backdrops (replaces the label/scale tables in code); "i" button per card, `"ai"` sources reveal a fake-object popup; prop models moved to `assets/digital.skkg.ch/requisits/` | One place for non-programmers to tune sizes and add collection links; visitors learn to check sources |
| 2026-11-14 | Impro props: mirrored slider on the left, props lowered onto free spots (best-candidate sampling) and dragged on the floor; thumbnails rendered from the `.glb` unless a picture lies next to it | Visitors furnish the stage after choosing the backdrop; no extra PNG needed per prop |
| 2026-11-14 | Follow spots: one spotlight per puppet, tracking it, on a lighting bar in front of the stage, replace the single controllable spotlight (`ControlInput.spotlight` dropped); general lighting about halved | Each puppet gets its own focus light, as in a real theatre; under the old levels the spot's pool did not show and whites burnt out |
| 2026-11-14 | The page without `?test` is the play (curtain, signs, marionette, hand control); the click on a sign starts the camera and MediaPipe; `?test=nocurtain` has the marionette too, the orbit camera stays in `?test=world` | No extra "start camera" step; the sign click is the user gesture iOS needs. Orbit and the mouse-led cross would fight over the pointer |
| 2026-11-14 | Letting go of the puppet: fist held 3 s releases the hand, 5 s countdown, then a hand above the low zone connects again; grip is the pinch only | The player must be able to put the hand down without dragging the puppet to the floor |
| 2026-11-14 | Control cross: the real SKKG 9-string cross (main bar + shoulder/head bars, rocking leg bar and hand bar) from `marionette_rig.json` replaces the single merged bar; `ControlInput.rock` added; hips became hinges | The real cross works by tilting and rocking, not by pulling single strings; angled knee strings twisted spherical hips |
| 2026-11-14 | Marionette rest pose: arms hanging down instead of T-pose; soft fabric hat instead of a lacquered one; head strings on the head, not the hat | Matches how the puppet really rests and is built |
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
