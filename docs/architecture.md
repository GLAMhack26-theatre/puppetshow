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
- At start the main curtain (`assets/stage_parts/Main_Curtain.glb`, `src/stage/main-curtain.ts`) hangs right in front of the camera and covers the whole screen at any aspect ratio, with a light cloth wobble (shader). Two seconds after start three signs (`src/stage/signs.ts`, the plays to choose from: `Sign_Haensel`, `Sign_Froschkoenig`, `Sign_Impro` in `assets/stage_parts/`) drop in one after another in a loose, slightly tilted row in front of it, overshoot and settle, and cast soft fake shadows on it (blurred silhouette quads, no shadow map). Hover enlarges a sign; a click on a sign raises the curtain, and the signs go up with it. The same click starts the camera and MediaPipe hand control (`src/input/mediapipe.ts`): it is the user gesture camera access needs. Without a camera (or permission) the mouse keeps control; a **Kamera starten** button in the debug panel starts it by hand.
- **Impro mode** (the `Sign_Impro` sign, `src/impro/impro.ts`): once the curtain is up, a menu offers **Bühnenbild**. It slides in a panel from the right (a quarter of the screen width, at least 240 px for phones): a starry night sky with a scalloped gold edge, on which the painted backdrops are paper cards travelling along a curve while scrolling, the middle one biggest (`src/impro/backdrop-slider.ts`, look tuned in its `SLIDER` constants, no settings UI). The cards are the painted backdrops (`assets/stage_parts/Background_*.glb`, picked up automatically; thumbnails are cut from the texture inside each `.glb`). A click stands that backdrop still at the back edge of the stage floor, scaled to the floor's (`Ground_Box`) width and unlit, (`src/stage/backdrops.ts`), replacing the previous one; a second click removes it. Backdrops are revealed like a sheet let down from the fly loft: they sink into place while a ragged torn-paper edge uncovers them from the top (shader discard on uv), and hide in reverse; switching crossfades. Props (3D models) follow the same way later.
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
- Debug HUD with landmarks, FPS and physics wireframe, toggled with `?debug`.
- An old-film vignette (darkened, softly burnt-in edges) lies over the 3D view in 2D, under the UI (buttons, HUD, impro menu and slider): a CSS overlay in `index.html` that lets all input through.
- Without `?test` the page is the play itself: curtain, signs, then the marionette with hand control. Debug buttons top right pick `?test=…`; **impro** (`?test=nocurtain`) skips the main curtain and the signs and goes straight into impro mode; **puppet** is the marionette with the mouse only, **world** the stage alone with an orbit camera.

---

## 3. Marionette control

### 3.1 One input model

```ts
interface ControlInput {                              // mutable, written once per frame
  bar: { position: Vector3; rotation: Quaternion };   // main bar of the control cross (Spielkreuz)
  rock: { hands: number; legs: number; head: number }; // rad: rocking the hand bar / leg bar (±0.6) and the head bar (±45°)
  handBar: { detached: boolean; position: Vector3; rotation: Quaternion }; // the hand bar taken off the cross: its own world pose
  pulls: Record<StringId, number>;                    // 0..1 per string on top (plucking): head.L/R, shoulder.L/R, back, hand.L/R, knee.L/R
  grip: { left: boolean; right: boolean };            // puppet hands grab / release
  source: "mediapipe" | "phone" | "mouse" | "remote-phone" | "xr-3dof" | "xr-6dof";
}
```

| Source | Bar pose | Rock (legs / head / hands) | Hand bar off the cross | Pulls | Grip | When |
|---|---|---|---|---|---|---|
| MediaPipe (webcam on desktop or phone) | Palm of the cross hand: position, size (depth) and tilt | Finger flexion of the cross hand (legs, head) | A second hand takes it | None | Fist of the cross hand; held 3 s it lets go of the puppet, see below | now |
| Phone sensors + touch | DeviceOrientation (3DoF) | Open (not decided; e.g. touch sliders) | Open | Touch zones/sliders | Button | now |
| Mouse/keyboard | Drag, wheel | Q/E legs, A/D hands, Y/X head, sliders | H, then pointer and wheel | Sliders | Click | now (dev) |
| Remote phone (WebRTC) | Same as phone, streamed | Same | Same | Same | Same | later |
| WebXR 3DoF / 6DoF | Controller orientation / controller or `XRHand` pose | Open (not decided) | Open | Trigger / finger joints | Grip / pinch | later |

#### MediaPipe hands

MediaPipe (`HandLandmarker`, two hands) runs with `detectForVideo` on `requestVideoFrameCallback`, separate from the render loop. It uses the GPU delegate and falls back to CPU. The wasm and the `.task` models are served locally from `/mediapipe/`, so no CDN is needed at runtime.

**Start.** The click on a sign starts the camera (`startHandTracking()`, the user gesture iOS needs; the stream is requested before anything is awaited, the model loads during the permission prompt), possibly before the puppet has loaded; `setupHandTracking()` connects the puppet once it is there and adds the camera button (or C) for `?test=nocurtain` and a second try. `@mediapipe/tasks-vision` is loaded only then.

The code is split so that everything but the camera runs without a browser:
- `src/input/hand-tracking.ts`: pure functions and the `HandTracker` state machine (landmarks in, plain numbers out). Its `MAPPING` and `TUNING` tables hold every number that shapes the feel.
- `src/input/mediapipe.ts`: camera, landmarker, writing `ControlInput`, recording and replay.
- `src/input/hand-overlay.ts`: the picture above the camera feed.
- `src/input/hand-synthetic.ts`: a synthetic hand for tests and for `?replay=synthetic`.

**Hand roles.** The first hand seen is the cross hand and stays it; a second hand can take the hand bar. MediaPipe has no persistent ids and its result order changes, so each detection goes to the role whose palm was last seen nearest, with the handedness label as a tie-breaker. A hand that vanishes keeps its outputs for 0.5 s; after 1.5 s the cross hand gives up its role, and a remaining second hand moves up (the only hand in view is always the cross hand). The first two results after a hand is (re)detected are thrown away: they come from the rough palm-detector box and are far off.

**Mapping** (tilt and fingers are relative to the pose the hand had when it attached; N takes a new rest pose):

| Hand motion | Input |
|---|---|
| Palm centre in the image | `bar.position` x / y (the inner 80 % of the image spans the stage) |
| Hand moves towards / away from the screen | `bar.position` z (upstage / downstage) |
| Tilting the hand forward / back, sideways, turning it | `bar.rotation`: pitch about x, roll about z, yaw about y |
| Index against middle finger ("walking fingers") | `rock.legs` |
| Ring + little finger against tucking the thumb in | `rock.head` |
| Fist | `grip` left and right |
| Second hand pinches or closes at the hand bar | `handBar.detached`; the bar then follows that hand (position, depth, rotation) from where it was taken |

Rockers are differences of two finger signals, so moving or turning the hand does not trigger them, and they fade out while a fist forms. The bar end on the side of the curled finger goes up.

**The hand is the cross (decided).** The cross lies in the palm: a palm held level is a level cross, the fingers work the bars. A puppeteer keeps the wrist in line with the forearm, so the palm's tilt is the arm's tilt, and the arm and shoulder set height and place; tracking the palm therefore covers what the arm does. Tracking the elbow itself (a pose model) is open.

**The player's view (decided).** The webcam faces the player, who sits in front of the screen. The hand moves the cross the way the player sees their own hand move: right is right, up is up, pushing the hand towards the screen pushes the puppet upstage, and the cross turns and rolls as the hand does. Tipping the hand forward (fingertips down) tips the front of the cross down, so the puppet bows towards the audience: for pitch the hand is the cross, fingers at its front, although the puppet faces the player (`TUNING.tipForwardBows`; off, the cross tips as the hand is seen to tip, far end down). The camera sees all of that from the front, so the picture is mirrored and depth is turned round (`HandTracker.mirror`, on by default). `?mirror=0` or M turns it off, for a camera on the player's own side (a phone's back camera, never mirrored) or a player behind the stage: the same mapping turned half round about the vertical. MediaPipe always gets the raw image; on it, its handedness label is the player's real hand (checked on MediaPipe's own test photos with tasks-vision 1.2).

**Palm size and orientation from the image (decided).** Both come from the outline of the rigid palm (wrist and four knuckles) in the image, not from MediaPipe's 3D "world" landmarks. The palm is a flat shape of known proportions; seen at a slant it is squeezed along one direction and keeps its size along the other. So the least-squares map from that shape to the image gives the size (its larger stretch) whatever the slant, and the lean (the ratio of its two stretches is the cosine). Why not the 3D landmarks: on a real recorded session they shrank by a third whenever the hand was seen at a slant, which threw the puppet to the front of the stage on every bow, and they flipped between "leaning forward" and "leaning back", which made the tilt move in steps. What the outline cannot tell is which way the palm leans. A hand that holds a cross leans its fingers towards the screen, so that is assumed; the 3D landmarks only decide while the fingers do not clearly lean, and they give the whole orientation while the palm is nearly flat to the camera (there the outline hardly changes with the lean). The tilt against the rest pose is a rotation vector, not Euler angles, which locked up when the hand pitched towards 90°. A level palm is close to edge-on to the camera and may tip through it; the shape's handedness is fixed when the hand is first seen, so the orientation carries on to the other side. Known limit: a hand leaning *away* from the camera by more than about 25° is read as leaning towards it.

**Fingers from the image.** Each landmark is mapped back into the palm's own flat frame (the inverse of the outline map: size, turn and lean taken out). A finger's signal is how far its tip has come back towards its knuckle; the thumb's is how far its tip sticks out beyond the index knuckle. Ring and little finger count against the other two, and the rockers fade out while all four close: fingers closing together (a grip, a half-closed hand, a hand tipping towards edge-on) are not a rocker signal. The 3D landmarks' finger angles shifted with the hand's lean on the recorded session and rocked the head bar without a finger moving. A hand seen edge-on (lean above about 70°) cannot be read: the rockers fade out and the grip keeps its state there, and a fist also needs the 3D landmarks to agree (an edge-on hand looks like a fist in the image).

**Depth without a distance sensor.** The palm's size in the image is ∝ 1 / distance. The puppet's z is the log of that size against a baseline: the median of the last 10 s, followed with a 2.5 s time constant. A quick reach moves the puppet at once; a hand held forward drifts back to the middle within about 10 s, which also absorbs the player changing seat. The measure is trusted less while the hand moves fast across the image (MediaPipe's box lags and reads a few percent too large). Tipping the hand forward still moves the puppet a little, because the knuckles really come closer to the camera. Distance from the head or body (a second model) is open.

**Rest pose.** The cross hangs level in the hand's rest pose. It answers from the first frame: until the hand has paused, a usual pose stands in (a palm held level in front of the screen as a webcam below it sees it, leaning 0.9 rad from flat to the camera; measured on the recorded session). The first time the hand holds still for 1 s, its own pose becomes the rest pose and the cross eases over (0.5 s); N takes the current pose at once. The rockers stay level until then: how relaxed fingers and thumb read differs from hand to hand, so the stand-in has no zero for them. The overlay asks for the pause. Tried and dropped: waiting for the pause before tilting at all (the player on the recorded session moved for 11 s first), and taking the pose on a timer (it caught the hand on its way into a bow).

**Smoothing.** Every channel goes through a One Euro filter on the frame timestamps (steady at rest, quick when moving), with small dead zones around rest; the palm's outline is filtered before the lean is taken from it. When MediaPipe reports one hand twice, the detection that continues the tracked hand is kept (the copy is often a wrong pose with a high score). The engine also limits how fast the cross turns (`strings.ts`), as it already did for its position.

**Overlay.** Above the camera feed: both hands (thin, fingers in the colour of the bar they drive), the cross drawn beside the cross hand in its live pose with every bar rocked as it is, the magnet point and reach where the second hand takes the hand bar, a depth gauge with the baseline, meters for the rockers and the tilt in degrees. It starts at the top centre and can be dragged anywhere (the place is remembered; a double click puts it back).

**Record and replay.** `?record` keeps the landmark frames (R downloads them as JSON); `?replay=<url>` feeds a recording through the same pipeline instead of the camera, `?replay=synthetic` a scripted synthetic session. `node scripts/replay-recording.mjs <file> out.csv` runs a recording through the tracker without a browser and writes measurements and outputs per frame. A recorded real session is the basis for tuning.

**Letting go of the puppet (`src/input/hand-release.ts`):** while a hand is attached, the cross follows it, so lowering the hand would drag the puppet down. A fist held for 3 s lets go: the cross stays where it is and the puppet's hands open. The player then has 5 s to take the hand away, shown by a little timer (`src/ui/release-timer.ts`; the same ring fills while the fist is held). After that a hand connects again by itself as soon as it is seen above the low zone. A hand in the low zone (the bottom quarter of the camera image, standing in for "hand down at the lower torso", which a hand model cannot see) never connects; this also holds at the start, and for a hand that left the camera image for more than a second (it is let go without a countdown). Once attached, the hand may go as low as it likes, so the puppet can still be lowered. The fist is the cross hand's grip (`HandTracker`, `MAPPING.grip`): a short fist closes the puppet's hands, held 3 s it lets go. While no hand is connected the tracker keeps running (filters, roles) but nothing is written to `ControlInput`; letting go also levels the rockers and puts the hand bar back on the cross.

**Verified on one recorded session only** (60 s, one right hand, one webcam): the palm measures, the finger signals and the thresholds above were tuned on it. Other hands, cameras and the second hand taking the hand bar are not verified on a real hand yet.

### 3.2 Puppet rig

1. **The model defines the rig (decided):** the SKKG marionette (README, "Marionette model") comes as `export/marionette.glb` plus `export/marionette_rig.json`. The JSON holds per bone the capsule collider, `mass_kg` and the joint (cone, or hinge with a bone-local axis and limits in degrees), and the 9 strings (socket, carrying bone, position, controller point, rest length). `src/puppet/marionette.ts` turns it into a rig description; nothing about the puppet is hard-coded.
   - **Bones:** `root`, `pelvis`, `chest`, `neck`, `head`, `upper_arm/forearm/hand.L/R`, `thigh/shin/foot.L/R`.
   - **Rest pose:** arms hanging down (no T-pose), as a marionette rests on its strings.
   - **Strings:** `head.L/R`, `shoulder.L/R`, `back`, `hand.L/R`, `knee.L/R`.
   - **Control cross:** the real SKKG 9-string cross, in the JSON's `controller` section (bars with pivot, rocking axis and sticks; each string names its bar):
     - main bar (16 cm, front–back): the back string at its rear end; a fixed shoulder crossbar (11 cm);
     - head bar on a post below the shoulder crossbar, hinged in its middle: rocks about the main bar's axis by ±45° (`limit_deg`), head strings;
     - leg bar (12 cm) on a post under the middle, rocks the same way: knee strings, walking;
     - hand bar (15 cm) at the front tip, rocks the same way: hand strings. It sits there like on a magnet and can be taken off (`detachable`).
   - **Real scale:** the puppet is 0.35 m tall; the stage is scaled to match (1.4 m wide), and so are camera, lights and props.
   - **Masses:** the real masses from the JSON, with a floor of 5 % of the heaviest part, so the tiny hands don't destabilise the joint chains.
   - **Joints:** per bone a `cone` (swing / twist), a `hinge` (axis, min, max) or `fixed`. The feet are fixed on the shins at 90° (a marionette has no ankle joint) and the neck is fixed on the chest; the head has one joint.
2. **At runtime:**
   - one Rapier body per bone with a collider (capsule from the JSON); all bodies start unrotated, so a hinge's world axis is the same in both bodies
   - a fixed part has no body: its capsule joins its parent's body
   - joints between neighbouring bones keep the limits from the JSON: revolute joints for hinges, and for cones a generic ball joint with a limit on each rotation (set through Rapier's raw joint set, which takes limits for any axis; the JS classes only offer them on one-axis joints). Every free rotation has a little friction (a velocity motor towards 0), so limbs dangle but come to rest
   - the solver runs 16 iterations × 4 internal ones (Rapier's default 4 × 1 let strings stretch by 3 mm in play and hinges bend 25° off their axis); 0.2 ms per step on a desktop, not measured on phones
   - the physics pose drives the `SkinnedMesh` bones
3. **Strings:**
   - each bar of the cross is a kinematic body: the main bar is positioned from `ControlInput.bar` (speed and turn rate are capped, so a noisy source cannot whip the strings), the rocking bars ride on it and turn by `ControlInput.rock`, each within its own limit
   - the hand bar can leave the cross: while `ControlInput.handBar.detached`, it follows that pose instead (on a leash of 0.3 m), its strings stay on it; when it is let go, it is pulled back onto its seat. While it sits, the engine keeps `handBar` at the seat's pose, so a source taking it off starts from there
   - each string is a rope joint (maximum distance, rest length from the JSON), from its eye on its bar to the socket `string_<id>`
   - tilting the cross does much of the acting: sideways tilts the head and sways the body; back raises the front bars (hands and knees lift); forward lowers them and lifts the back string a little (a slight bow; a deeper bow needs the back eye further behind the pivot, both sketch estimates); rocking the leg bar walks; rocking the hand bar lifts one hand
   - hips and knees are hinges: the angled knee strings would otherwise twist the legs
   - a pull shortens the rope by setting the rope joint's length limit (at most 1 m/s); the joint is not recreated
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
scripts/test-hand-tracking.ts   # hand-tracking checks on synthetic hands (node, no browser)
scripts/replay-recording.mjs    # a recorded hand session through the tracker → CSV (node, no browser)
converter/              # Dockerfile (Blender LTS + node + ffmpeg), export.py, convert.mjs
certs/                  # git-ignored TLS cert/key for Vite (server.https / preview.https)
src/
  main.ts               # IWSDK World (xr:false), register systems
  components/  systems/  scenes/{title,main}.ts
  stage/{stage,lighting,spotlights,backdrops}.ts
  input/{control-input,mediapipe,hand-tracking,hand-overlay,hand-synthetic,hand-release,phone,mouse}.ts
  audio/{audio,zzfx}.ts
  ui/                   # overlay, release timer, styles, Geist fonts
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
- `node scripts/test-hand-tracking.ts` passes: smoothing, depth against tilt, hand roles, dropouts, mirror, finger mapping, taking the hand bar.
- `?test=mediapipe&replay=synthetic` plays a scripted session through the page without a camera.
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
| 2026-11-14 | Hand tracking merged: the two-hand `HandTracker` (cross, rockers, hand bar, overlay, record/replay) with letting go from main: the cross hand's fist grips, held 3 s it lets go; grip is the fist again, not the pinch | Both lines of work changed `src/input/mediapipe.ts`; the fist-as-grip was tuned on a recorded session, and a held fist keeps the let-go gesture |
| 2026-11-14 | Physics: feet and neck fixed (no joint); cone limits on waist, head, shoulders and wrists; joint friction instead of heavy angular damping; solver 16 × 4 iterations; pulls change the rope's length limit | Strings stretched like rubber and the ragdoll folded and spun in ways a wooden marionette cannot; measured string stretch in play fell from 3 mm to 0.15 mm |
| 2026-11-14 | MediaPipe: the player's view replaces face-to-face as the default (mirrored picture, hand towards the screen = upstage, cross turns and rolls as the hand is seen to; tipping the hand forward still bows the puppet); the hand is the cross (level palm = level cross); palm size, tilt and finger signals come from the palm's outline in the image instead of MediaPipe's 3D landmarks; a stand-in rest pose at once, the hand's own at its first pause; overlay movable | The user sits in front of the screen with the webcam facing them. A recorded real session showed the 3D landmarks shrinking and flipping when the hand leans, as it does when holding a cross: the puppet jumped downstage on every bow, the tilt moved in steps and the head bar rocked by itself |
| 2026-11-14 | MediaPipe control reworked (`src/input/`): time-aware filtering and a turn-rate cap in the engine; face-to-face mapping by default (selfie mirror as a toggle); depth from hand size against a sliding baseline; cross tilt from the palm's orientation; fingers drive the leg and head bar; an overlay shows the cross on the hand; record / replay | The spike tracking was shaky, had no depth and no fine control; puppeteers face their audience |
| 2026-11-14 | The first hand is the cross hand; a second hand takes the hand bar off the cross and moves it freely (`ControlInput.handBar`), it returns when let go. The head bar is hinged (`rock.head`, ±45°) | Two-handed play as on the real cross: one hand holds it, the other works the hand bar |
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
