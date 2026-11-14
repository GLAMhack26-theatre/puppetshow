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
- At start the main curtain (`assets/stage_parts/Main_Curtain.glb`, `src/stage/main-curtain.ts`) hangs right in front of the camera and covers the whole screen at any aspect ratio. A click on it raises it out of view.
- A central stage that fills the room: proscenium, curtains, and layered paper-theatre backdrops (scans as alpha planes).
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

---

## 3. Marionette control

### 3.1 One input model

```ts
interface ControlInput {                              // mutable, written once per frame
  bar: { position: Vector3; rotation: Quaternion };   // main bar of the control cross (Spielkreuz), rig coordinates (the engine adds stringExtra)
  rock: { hands: number; legs: number; head: number }; // rad: rocking the hand bar (±0.6), the leg bar (±50°) and the head bar (±45°)
  handBar: { detached: boolean; position: Vector3; rotation: Quaternion }; // the hand bar taken off the cross: its own world pose
  hook: { id: StringId | null; along: number; offset: Vector3 }; // a string caught by the other hand: where along it (0 eye … 1 socket) and how far it is pushed off its line
  stringExtra: number;                                // m: strings this much longer than in the rig, the cross that much higher (a player's setting)
  pulls: Record<StringId, number>;                    // 0..1 per string on top (plucking): head.L/R, shoulder.L/R, back, hand.L/R, knee.L/R
  grip: { left: boolean; right: boolean };            // puppet hands grab / release
  spotlight?: { target: Vector3 };
  source: "mediapipe" | "phone" | "mouse" | "remote-phone" | "xr-3dof" | "xr-6dof";
}
```

| Source | Bar pose | Rock (legs / head / hands) | Hand bar off the cross | Pulls | Grip | When |
|---|---|---|---|---|---|---|
| MediaPipe (webcam on desktop or phone) | Palm of the cross hand: position, size (depth) and tilt | Finger flexion of the cross hand (legs, head); a second hand can turn the head bar | A second hand takes it | None; a second hand pushes the back string (`hook`) | Fist of the cross hand | now |
| Phone sensors + touch | DeviceOrientation (3DoF) | Open (not decided; e.g. touch sliders) | Open | Touch zones/sliders | Button | now |
| Mouse/keyboard | Drag, wheel | Q/E legs, A/D hands, Y/X head, sliders | H, then pointer and wheel | Sliders; B pushes the back string | Click | now (dev) |
| Remote phone (WebRTC) | Same as phone, streamed | Same | Same | Same | Same | later |
| WebXR 3DoF / 6DoF | Controller orientation / controller or `XRHand` pose | Open (not decided) | Open | Trigger / finger joints | Grip / pinch | later |

#### MediaPipe hands

MediaPipe (`HandLandmarker`, two hands) runs with `detectForVideo` on `requestVideoFrameCallback`, separate from the render loop. It uses the GPU delegate and falls back to CPU. The wasm and the `.task` models are served locally from `/mediapipe/`, so no CDN is needed at runtime.

The code is split so that everything but the camera runs without a browser:
- `src/input/hand-tracking.ts`: pure functions and the `HandTracker` state machine (landmarks in, plain numbers out). Its `MAPPING` and `TUNING` tables hold every number that shapes the feel.
- `src/input/mediapipe.ts`: camera, landmarker, writing `ControlInput`, recording and replay.
- `src/input/hand-overlay.ts`: the picture above the camera feed.
- `src/input/hand-synthetic.ts`: a synthetic hand for tests and for `?replay=synthetic`.

**Hand roles.** The first hand seen is the cross hand and stays it; a second hand can take the hand bar or the head bar, or push the back string. MediaPipe has no persistent ids and its result order changes, so each detection goes to the role whose palm was last seen nearest, with the handedness label as a tie-breaker. A hand that vanishes keeps its outputs for 0.5 s; after 1.5 s the cross hand gives up its role, and a remaining second hand moves up (the only hand in view is always the cross hand). The first two results after a hand is (re)detected are thrown away: they come from the rough palm-detector box and are far off.

**Mapping** (height, tilt and fingers are relative to the hand's rest pose, see below; N takes a new one):

| Hand motion | Input |
|---|---|
| Palm centre in the image, sideways | `bar.position` x (the inner 80 % of the image spans the stage) |
| Hand higher / lower than where it rests | `bar.position` y, from the cross's rest height (0.8 m per image height; at most 0.25 m down, 0.4 m up) |
| Hand moves towards / away from the screen | `bar.position` z (upstage / downstage) |
| Tilting the hand forward / back, sideways, turning it | `bar.rotation`: pitch about x, roll about z, yaw about y |
| Index against middle finger, bent down at the knuckle ("walking fingers") | `rock.legs` |
| Ring + little finger against tucking the thumb in | `rock.head` |
| Fist | `grip` left and right |
| Second hand pinches or closes at the hand bar's handle | `handBar.detached`; the bar then follows that hand (position, depth, rotation) from where it was taken |
| Second hand pinches or closes at the head bar's handle and turns | `rock.head`, instead of the cross hand's fingers while it holds |
| Second hand, open, moves sideways against the back string | `hook` on the back string: pushed along with the hand's leading edge (up to 12 cm), let go when the hand draws back. On the stage the string is drawn back (upstage) by that much and only 30 % sideways: the camera cannot see depth, and drawn back the puppet bows instead of swinging round |

Rockers are differences of two finger angles, so moving or turning the hand does not trigger them, and they fade out while all four fingers close. The bar end on the side of the bent finger goes up. A finger bent 30° further than the other is a full rock; leg bar and head bar can be rocked together.

**The hand is the cross (decided).** The cross lies in the palm: a palm held level is a level cross, the fingers work the bars. A puppeteer keeps the wrist in line with the forearm, so the palm's tilt is the arm's tilt, and the arm and shoulder set height and place; tracking the palm therefore covers what the arm does. Tracking the elbow itself (a pose model) is open.

**The player's view (decided).** The webcam faces the player, who sits in front of the screen. The hand moves the cross the way the player sees their own hand move: right is right, up is up, pushing the hand towards the screen pushes the puppet upstage, and the cross turns and rolls as the hand does. Tipping the hand forward (fingertips down) tips the front of the cross down, so the puppet bows towards the audience: for pitch the hand is the cross, fingers at its front, although the puppet faces the player (`TUNING.tipForwardBows`; off, the cross tips as the hand is seen to tip, far end down). The camera sees all of that from the front, so the picture is mirrored and depth is turned round (`HandTracker.mirror`, on by default). `?mirror=0` or M turns it off, for a camera on the player's own side (a phone's back camera, never mirrored) or a player behind the stage: the same mapping turned half round about the vertical. MediaPipe always gets the raw image; on it, its handedness label is the player's real hand (checked on MediaPipe's own test photos with tasks-vision 1.2).

**Palm size and orientation from the image (decided).** Both come from the outline of the rigid palm (wrist and four knuckles) in the image, not from MediaPipe's 3D "world" landmarks. The palm is a flat shape of known proportions; seen at a slant it is squeezed along one direction and keeps its size along the other. So the least-squares map from that shape to the image gives the size (its larger stretch) whatever the slant, and the lean (the ratio of its two stretches is the cosine). Why not the 3D landmarks: on a real recorded session they shrank by a third whenever the hand was seen at a slant, which threw the puppet to the front of the stage on every bow, and they flipped between "leaning forward" and "leaning back", which made the tilt move in steps. What the outline cannot tell is which way the palm leans. A hand that holds a cross leans its fingers towards the screen, so that is assumed; the 3D landmarks only decide while the fingers do not clearly lean, and they give the whole orientation while the palm is nearly flat to the camera (there the outline hardly changes with the lean). The tilt against the rest pose is a rotation vector, not Euler angles, which locked up when the hand pitched towards 90°. A level palm is close to edge-on to the camera and may tip through it; the shape's handedness is fixed when the hand is first seen, so the orientation carries on to the other side. Known limit: a hand leaning *away* from the camera by more than about 25° is read as leaning towards it.

**Fingers as angles (decided).** A puppeteer's fingers work the bars like piano keys, so a finger's signal is the angle by which it is bent down out of the palm at its knuckle. The finger is taken as a stick from knuckle to tip that turns from where it lies at rest towards the palm side; the palm's orientation says where such a stick appears in the image for every angle, and the angle whose stick fits the finger as seen is taken. The finger's length and the direction it fans out in are measured on the player's own hand at the rest pose. Why: the first version mapped each fingertip back through the palm's outline, which only holds for points in the palm's plane. On the recorded session the same bent index finger read as fully curled with the palm leaning 0.75 rad, as a third of that at 1.1 rad, and the rockers were faded out from 1.2 rad on, which is where a level palm is: the leg bar was an on/off switch in one pose and dead in another. With angles the same session gives a full rock for the same bend at 0.75 and 1.2 rad, graded in between, and no rocking while the fingers rest (leg bar within 7 % of its range). The outline map is still used for the thumb (how far its tip sticks out beyond the index knuckle), the pinch and the fist; a fist also needs the 3D landmarks to agree (an edge-on hand looks like one in the image), and the grip keeps its state above a lean of 1.2 rad. Limits: the rockers fade out only above about 1.4 rad (the palm is a line there); seen flat-on, a finger bending towards the camera hardly changes in the image, so each angle has a dead zone of 0.25 rad there; a hand seen from the back is read too, but only up to the angle at which the bent finger lies in the image plane (not tried on a real hand).

**Depth without a distance sensor.** The palm's size in the image is ∝ 1 / distance. The puppet's z is the log of that size against a baseline: the median of the last 10 s, followed with a 2.5 s time constant. A quick reach moves the puppet at once; a hand held forward drifts back to the middle within about 10 s, which also absorbs the player changing seat. The measure is trusted less while the hand moves fast across the image (MediaPipe's box lags and reads a few percent too large). Tipping the hand forward still moves the puppet a little, because the knuckles really come closer to the camera. Distance from the head or body (a second model) is open.

**Rest pose.** In the hand's rest pose the cross hangs level at its rest height, where the puppet just stands, and the rockers are level. The cross answers from the first frame: until the hand has paused, a usual pose stands in (a palm held level in front of the screen as a webcam below it sees it, leaning 0.9 rad from flat to the camera; measured on the recorded session), and the rest height stays with the hand for its first second and then follows it with 0.5 s, so a hand coming up into the picture does not fling the puppet up and only quick moves lift it (on the recorded session the hand rose a third of the picture in its first 1.4 s, and with a fixed first-frame height the puppet flew 23 cm). The first time the hand holds still for 1 s, its own pose becomes the rest pose (orientation, height, and how its fingers lie) and the cross eases over (0.5 s); N takes the current pose at once. The rockers stay level until then: finger lengths and how a relaxed thumb reads differ from hand to hand, so the stand-in has no zero for them. The overlay asks for the pause. Why height is relative: an absolute map from image height to stage height left the puppet hanging in the air whenever the hand was held high. Tried and dropped: waiting for the pause before tilting at all (the player on the recorded session moved for 11 s first), and taking the pose on a timer (it caught the hand on its way into a bow).

**The player's settings.** Three sliders, all remembered. "Kreuz neigen" adds up to ±45° to the cross's pitch (`HandTracker.pitchTrim`), for a camera that looks at the hand from above or below, or a hand held tilted because it tracks better that way. "Kreuz heben" adds up to ±20 cm to its height (`heightTrim`), for a puppet that hangs in the air or sags with the hand at rest: the hand's rest height is only an estimate of where the puppet stands. Both come on top of the rest pose, which does not reset them. "Fadenlänge" sets `stringExtra`: longer strings and a cross further above the puppet. The puppet stands the same at any value, so it does not put the feet on the floor; that is "Kreuz heben".

**Smoothing and jumps.** Every channel goes through a One Euro filter on the frame timestamps (steady at rest, quick when moving), with small dead zones around rest; the palm's outline and the fingers are filtered before any angle is taken from them. When MediaPipe reports one hand twice, the detection that continues the tracked hand is kept (the copy is often a wrong pose with a high score). One jump was measured on the recorded session and is eased now: a hand that attaches, or comes back after more than 0.25 s, finds the cross where it was left (level, or where the hand vanished), and the cross jumped 0.4 rad at the first frame, so at every re-attach. The outputs now go over to the hand within 0.6 s. Two more are guarded against without having been seen on a real hand. Which of the two ways the palm leans (its outline allows both) is kept from frame to frame unless the evidence is clearly against it, instead of being decided anew on every frame (on a synthetic hand with noise it changed its mind up to 104 times in 20 s for a palm nearly flat to the camera). And a bar in the second hand is let go only after the hand has stayed open for 0.3 s, so a pinch reading that dips for single frames does not drop it. Other sudden moves seen in play are not explained yet: a `?record` session that contains one is needed (`replay-recording.mjs` lists the largest steps of the cross). The engine adds its own follower (`strings.ts`), so a step that still gets through does not whip the strings.

**Overlay.** Above the camera feed: both hands (thin, fingers in the colour of the bar they drive) and the cross lying in the cross hand as the hand holds it: rear end at the wrist, front tip with the hand bar at the fingertips, its top towards the back of the hand, every bar rocked as it is. The handles where the second hand takes the hand bar and the head bar are rings 12.5 cm out from the main bar, on the side the second hand is on: beyond the bars' ends and clear of the cross hand, because MediaPipe loses hands that overlap. The back string hangs down the picture from the rear end and bends where a hand pushes it. Also a depth gauge with the baseline, meters for the rockers and the tilt in degrees. The overlay starts at the top centre and can be dragged anywhere (the place is remembered; a double click puts it back).

**Record and replay.** `?record` keeps the landmark frames (R downloads them as JSON); `?replay=<url>` feeds a recording through the same pipeline instead of the camera, `?replay=synthetic` a scripted synthetic session. `node scripts/replay-recording.mjs <file> out.csv` runs a recording through the tracker without a browser and writes measurements and outputs per frame. A recorded real session is the basis for tuning.

**Verified on one recorded session only** (60 s, one right hand, one webcam, made with the first mapping): the palm measures, the finger angles and the thresholds above were tuned on it. Other hands and cameras, a hand seen from the back, and everything the second hand does (taking the hand bar or the head bar, pushing the back string) are checked on synthetic hands only, not on a real hand yet.

### 3.2 Puppet rig

1. **The model defines the rig (decided):** the SKKG marionette (README, "Marionette model") comes as `export/marionette.glb` plus `export/marionette_rig.json`. The JSON holds per bone the capsule collider, `mass_kg` and the joint (cone, or hinge with a bone-local axis and limits in degrees), and the 9 strings (socket, carrying bone, position, controller point, rest length). `src/puppet/marionette.ts` turns it into a rig description; nothing about the puppet is hard-coded.
   - **Bones:** `root`, `pelvis`, `chest`, `neck`, `head`, `upper_arm/forearm/hand.L/R`, `thigh/shin/foot.L/R`.
   - **Rest pose:** arms hanging down (no T-pose), as a marionette rests on its strings.
   - **Strings:** `head.L/R`, `shoulder.L/R`, `back`, `hand.L/R`, `knee.L/R`.
   - **Control cross:** the real SKKG 9-string cross, in the JSON's `controller` section (bars with pivot, rocking axis and sticks; each string names its bar):
     - main bar (16 cm, front–back): the back string at its rear end; a fixed shoulder crossbar (11 cm);
     - head bar on a post below the shoulder crossbar, hinged in its middle: rocks about the main bar's axis by ±45° (`limit_deg`), head strings;
     - leg bar (12 cm) on a post under the middle, rocks the same way by ±50° (a full rock lifts the foot 3.3 cm; at the first 34.4° it was 2.1 cm): knee strings, walking;
     - hand bar (15 cm) at the front tip, rocks the same way: hand strings. It sits there like on a magnet and can be taken off (`detachable`).
   - **Real scale:** the puppet is 0.35 m tall; the stage is scaled to match (1.4 m wide), and so are camera, lights and props.
   - **Masses:** the real masses from the JSON with a floor of 5 % of the heaviest part, plus lead in hands and feet as real marionettes carry it (hands 12 g, feet 40 g; forearms, upper arms, shins and thighs raised with them so the joint chains stay stable). Only mass ratios show: scaling all masses alike changes nothing (measured at ×0.2 and ×5), because gravity, damping and joint friction do not depend on mass.
   - **Joints:** per bone a `cone` (swing / twist), a `hinge` (axis, min, max) or `fixed`. The feet are fixed on the shins at 90° (a marionette has no ankle joint) and the neck is fixed on the chest; the head has one joint.
2. **At runtime:**
   - one Rapier body per bone with a collider (capsule from the JSON); all bodies start unrotated, so a hinge's world axis is the same in both bodies
   - a fixed part has no body: its capsule joins its parent's body
   - joints between neighbouring bones keep the limits from the JSON: revolute joints for hinges, and for cones a generic ball joint with a limit on each rotation (set through Rapier's raw joint set, which takes limits for any axis; the JS classes only offer them on one-axis joints). Every free rotation has a little friction (a velocity motor towards 0), so limbs dangle but come to rest
   - the solver runs 16 iterations × 4 internal ones (Rapier's default 4 × 1 let strings stretch by 3 mm in play and hinges bend 25° off their axis); 0.2 ms per step on a desktop, not measured on phones
   - the physics pose drives the `SkinnedMesh` bones
3. **Strings:**
   - each bar of the cross is a kinematic body. The main bar follows `ControlInput.bar` through a critically damped spring (0.08 s behind a steady move) with caps on speed and acceleration (12 m/s², 40 rad/s²), so a tracker spike or a hand found again elsewhere cannot whip the strings; the rocking bars ride on it and follow `ControlInput.rock` the same way, each within its own limit
   - `ControlInput.stringExtra` (default 0.15 m) makes every string that much longer and hangs the whole cross that much higher; the puppet stands the same. `bar.position` stays in rig coordinates, the engine adds the lift. It follows the setting at 0.25 m/s; the bars are set to their new height at once, not moved there, because a rope's length holds for a whole step
   - the hand bar can leave the cross: while `ControlInput.handBar.detached`, it follows that pose instead (on a leash of 0.3 m), its strings stay on it; when it is let go it drifts back onto its seat (most of the way in 0.4 s, seated after about 1 s; the first version snapped back in 0.2 s and jerked the puppet's hands), measured against the seat so it comes home while the cross moves. While it sits, the engine keeps `handBar` at the seat's pose, so a source taking it off starts from there
   - each string is a rope joint (maximum distance, rest length from the JSON), from its eye on its bar to the socket `string_<id>`
   - tilting the cross does much of the acting: sideways tilts the head and sways the body; back raises the front bars (hands and knees lift); forward lowers them and lifts the back string a little (a slight bow; a deeper bow needs the back eye further behind the pivot, both sketch estimates); rocking the leg bar walks; rocking the hand bar lifts one hand
   - hips and knees are hinges: the angled knee strings would otherwise twist the legs
   - a pull shortens the rope by setting the rope joint's length limit (at most 1 m/s); the joint is not recreated
   - a string caught by the other hand (`ControlInput.hook`) runs eye → hook → socket: the rope joint's anchor on the bar moves to the hook point and only the length below it stays free, which drags the socket towards the hook (the back string drawn 10 cm upstage at mid-length lifts the seat 2.4 cm and pitches the pelvis 48°, a bow; pushed straight sideways it swings and rolls the puppet). The push is followed like a bar, eases out on release and is capped at 0.25 m. A hooked rope, not a simulated chain of string segments: light segments between a kinematic bar and the puppet would stretch like the rubber strings that were just fixed
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
  stage/{stage,lighting,backdrops}.ts
  input/{control-input,mediapipe,hand-tracking,hand-overlay,hand-synthetic,phone,mouse}.ts
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
- `node scripts/test-hand-tracking.ts` passes: smoothing, depth against tilt, rest pose, hand roles, dropouts, mirror, finger mapping, the second hand (hand bar, head bar, back string), finger angles at different leans, relative height.
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
| 2026-11-14 | Engine followers: bar pose, rock angles, free hand bar and hook follow their input through a critically damped spring with an acceleration cap instead of a speed cap alone; the hand bar returns in about 1 s instead of 0.4 s | An input step became a full-speed sweep (90 m/s² at the bar); now 12 m/s², and a spike of two steps moves the bar 12 mm instead of 50 mm |
| 2026-11-14 | String length is a runtime setting (`ControlInput.stringExtra`, default +0.15 m); leg bar limit 34.4° → 50°; lead in hands and feet (masses are no longer the real ones); a string can be hooked by the other hand, as a moved rope anchor rather than a simulated chain | The cross was too close to the puppet; a full leg rock raised the foot only 2 cm (now 3.3 cm); more weight in hands and feet and pulling the back string by moving against it were asked for after the first play test |
| 2026-11-14 | MediaPipe, after the first play test: fingers are read as bend angles at the knuckle (a stick fitted to the finger as seen) instead of fingertip positions mapped through the palm's outline; the cross's height is relative to where the hand rests; outputs ease over when a hand attaches or comes back; a second hand can also turn the head bar and push the back string (`ControlInput.hook`); the overlay draws the cross in the cross hand; a pitch slider and a string-length slider (`stringExtra`) | The leg bar answered as a switch in one hand pose and not at all in another, the puppet hung in the air for a hand held high, and the cross jumped 0.4 rad whenever a hand attached (all three measured on the recorded session) |
| 2026-11-14 | Physics: feet and neck fixed (no joint); cone limits on waist, head, shoulders and wrists; joint friction instead of heavy angular damping; solver 16 × 4 iterations; pulls change the rope's length limit | Strings stretched like rubber and the ragdoll folded and spun in ways a wooden marionette cannot; measured string stretch in play fell from 3 mm to 0.15 mm |
| 2026-11-14 | MediaPipe: the player's view replaces face-to-face as the default (mirrored picture, hand towards the screen = upstage, cross turns and rolls as the hand is seen to; tipping the hand forward still bows the puppet); the hand is the cross (level palm = level cross); palm size, tilt and finger signals come from the palm's outline in the image instead of MediaPipe's 3D landmarks; a stand-in rest pose at once, the hand's own at its first pause; overlay movable | The user sits in front of the screen with the webcam facing them. A recorded real session showed the 3D landmarks shrinking and flipping when the hand leans, as it does when holding a cross: the puppet jumped downstage on every bow, the tilt moved in steps and the head bar rocked by itself |
| 2026-11-14 | MediaPipe control reworked (`src/input/`): time-aware filtering and a turn-rate cap in the engine; face-to-face mapping by default (selfie mirror as a toggle); depth from hand size against a sliding baseline; cross tilt from the palm's orientation; fingers drive the leg and head bar; an overlay shows the cross on the hand; record / replay | The spike tracking was shaky, had no depth and no fine control; puppeteers face their audience |
| 2026-11-14 | The first hand is the cross hand; a second hand takes the hand bar off the cross and moves it freely (`ControlInput.handBar`), it returns when let go. The head bar is hinged (`rock.head`, ±45°) | Two-handed play as on the real cross: one hand holds it, the other works the hand bar |
| 2026-11-14 | Control cross: the real SKKG 9-string cross (main bar + shoulder/head bars, rocking leg bar and hand bar) from `marionette_rig.json` replaces the single merged bar; `ControlInput.rock` added; hips became hinges | The real cross works by tilting and rocking, not by pulling single strings; angled knee strings twisted spherical hips |
| 2026-11-14 | Marionette rest pose: arms hanging down instead of T-pose; soft fabric hat instead of a lacquered one; head strings on the head, not the hat | Matches how the puppet really rests and is built |
| 2026-11-13 | Main curtain follows the camera (camera space, drawn over everything) instead of being placed in the stage; a click raises it | It must cover the screen on every aspect ratio (phone portrait, desktop) and while the orbit camera moves |
| 2026-11-13 | HTTPS switched on by `vite --mode https` (`HTTPS=1` still works); `.sh` files always checked out with LF (`.gitattributes`) | `HTTPS=1 vite` fails in cmd/PowerShell, and CRLF scripts fail in WSL2 |
| 2026-11-13 | Marionette: rig from `export/marionette_rig.json` (9 strings), real scale 0.35 m with the stage scaled to 1.4 m, real masses with a 5 % floor, file size reduced later by the converter | The rigged SKKG model arrived with full engine metadata |
| 2026-11-13 | Large assets: external storage, downloaded by hand into `assets/external/` (git-ignored); no git LFS | Keep the repo small without LFS quotas |
| 2026-11-13 | Assets: committed in `/assets` (grouped by source) instead of synced from outside git | The team already committed the first objects |
| 2026-11-13 | Physics: Havok → Rapier as our own system, IWSDK physics off | IWSDK's physics has no joints, sensors or collision events, and its Havok instance is private |
| 2026-11-13 | Initial architecture: IWSDK + Havok, MediaPipe, three.js audio + ZzFX, phone-only first, Vite served directly (no proxy), assets outside git | Planning session |
