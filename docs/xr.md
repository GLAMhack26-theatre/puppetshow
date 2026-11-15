# WebXR: the player is the puppet (implementation notes)

How the WebXR mode is built: the code paths, the math, the conventions, what was measured, and what is still open. The decisions and their reasons are in [`architecture.md`](architecture.md), section 3.3 and the decision log.

**Status:** everything here was run in IWER's emulated Quest 3, in headless Chrome at 60 fps. **Nothing has been run on a headset yet.** Numbers marked *measured* come from those runs. (Earlier runs in a throttled browser tab gave wrong numbers for anything timed; all figures here were taken again at 60 fps.)

## 1. What it does

The **WebXR** button (top right) starts an immersive VR session on a Quest 2/3. The visitor then stands on the stage as the marionette:

- the view comes from the puppet's eyes, at the puppet's size (the 1.4 m stage is as large as a room)
- the visitor's head and hands move the puppet's head and hands (6DoF, tracked hands first; controllers also work)
- the body turns with the visitor, and the legs take steps when the visitor walks through the room
- a pinch closes the puppet's hand, so props can be grabbed, carried and dropped
- torso and legs are otherwise a ragdoll hanging from the head, and the cross floats above with slack strings

## 2. Files

| File | Role |
|---|---|
| `src/xr/xr-button.ts`, `.css` | The button: support check, starts and ends the session, waits while the stage changes |
| `src/xr/xr-embodiment.ts` | `XrEmbodimentSystem`: places and scales the player, writes head and hand targets to `ControlInput.body` every frame, restores everything on exit |
| `src/xr/emulator.ts` | `?emu` on the dev server: IWER's emulated Quest 3 (dev only, not in the build) |
| `src/input/control-input.ts` | `controlInput.body`: the targets, plain data in world space |
| `src/puppet/body-drive.ts` | Puppet side: head pinned, hands drawn, body turned, strings slackened, first-person view |
| `src/puppet/body-walk.ts` | Steps: hip and knee motors on a gait that advances with the distance covered |
| `src/puppet/puppet.ts` | A driven puppet stays on stage during a scene change |
| `src/systems/frames.ts` | The world's loop as the clock for scene changes (works during a session) |
| `src/main.ts` | Creates the world XR-capable, registers the systems, tells the button when the stage is changing |

## 3. Session lifecycle

1. **World:** `World.create(…, { xr: { offer: "none", sessionMode: ImmersiveVR, features: { handTracking: true } } })`. A world created with `xr: false` can never start a session (`launchXR` throws). `offer` must be given: without it IWSDK offers a session by itself.
2. **Button:** shown only if `navigator.xr.isSessionSupported("immersive-vr")` resolves true. A click calls `world.launchXR()` synchronously (a session needs the user gesture). `launchXR` returns nothing and only logs a failure, so the label follows the session events, not the call.
3. **`sessionstart`** (the renderer's event; `world.session` is set later): `enter()` remembers the input source and the camera's far plane, switches IWSDK's ray pointers off, and notifies listeners. `main.ts` uses that to skip the main curtain and the signs when the session starts from the play choice (it then starts impro mode).
4. **First head pose:** `place()` scales and positions the player (section 4) and hides the puppet's head meshes. It waits for a viewer pose, at most 30 frames.
5. **Every frame** (`update`, default system priority, so after IWSDK's `InputSystem` at −4 has written the poses): head and hand targets and the grip go to `controlInput`, `source` is `"xr-6dof"`.
6. **`sessionend`:** `leave()` clears the targets, resets `world.player` to identity (IWSDK's `restoreCameraOnExit` only restores the camera), restores the far plane, the head meshes and the input source. The puppet side notices `body.active` going false and undoes its changes (section 6).

## 4. Size and placement

The puppet stays 0.35 m: its rig (capsules, string lengths) only works at scale 1. The player is shrunk instead. `world.player` is IWSDK's XR origin; the camera and the hand spaces are its children, and three.js applies its transform and scale to both eyes (eye separation included, which is what makes the stage look big).

With `h` the tracked head height and `e` the puppet's eye height at rest (0.32 m):

- **scale** `s = e / h`, if `h` is between 0.9 and 2.1 m (standing or sitting on a floor the headset knows). Otherwise (reference space `local`, head height near 0) `s = e / 1.6`.
- **turn** `θ = π − ψ`, where `ψ` is the player's turn in the room. The room is turned so that the way the player faces becomes +z, towards the audience. `ψ` comes from the head's *sideways* axis: where the face points has no direction when the player looks straight up or down, and flips beyond.
- **position**: the player's head lands on the puppet's current head in x and z, wherever the player stands in the room; `y = floor + e − s·h`, so a floor the headset knows becomes the stage floor and a seated player gets a standing puppet.
- **far plane**: clip distances are in the player's metres, so `camera.far` is divided by `s` to keep 50 m on stage. The near plane (0.02) becomes 4 mm on stage, which lets the puppet's own hands come close.

*Measured:* a player at 1.7 m, 0.6 m off-centre and turned 0.9 rad gets scale 0.188, the head target on the puppet's eye and the puppet facing the audience. Starting while looking 100° up places the player the same way.

## 5. Conventions

`controlInput.body`:

```ts
body: {
  active: boolean,
  head: { position, rotation },                       // the eyes
  hands: { left | right: { tracked, position, rotation } },
}
```

- **World space**, puppet scale. Plain vectors and quaternions, so another player could receive them later.
- **Rotations are relative to the puppet's rest pose:** identity means facing the audience (+z), arms hanging, thumbs forward.
- **Half turn:** the camera looks along −z, the rest pose faces +z, so the head's world rotation is multiplied by a half turn about y. The same half turn fits the hands: the WebXR grip space has −z along the thumb, +x out of the back of the right hand (−x for the left), and the open hand's fingers along −y. A hand hanging at the side with the thumb forward therefore has an identity grip rotation in the player's own frame. *Measured on the emulated hand skeleton:* fingers along −y (0.99), thumb side along −z (0.95), both hands.
- **Hand position** is the grip space (the palm), for controllers and tracked hands alike.
- **Read `world.player.head`, not `world.camera`:** the camera only gets the frame's pose when rendering.

## 6. The puppet side (`body-drive.ts`)

Runs in `physics.beforeStep` (60 Hz). On `body.active` it takes over; when it goes false it gives everything back.

**Head.** The head body becomes `KinematicPositionBased` and follows the eye target (the eye point is 5 mm above and 15 mm in front of the middle of the head body). Speeds are capped (1.5 m/s, 8 rad/s), so switching on or a tracking jump cannot whip the ragdoll. **The camera never depends on this body:** it stays on the tracked head, and the puppet follows.

**Hands.** Each hand body gets a velocity towards its target (`gain × gap`, capped at 1.5 m/s, plus what gravity takes away during the step). The target is clamped to 97 % of the arm's length from the shoulder, so an unreachable hand cannot drag the torso. The shoulders are free all round (rig: cone swing 180°). The hand also gets an angular velocity towards the target rotation (the wrists' friction is off while driven), **but this has little effect so far**: *measured*, the hand stays 30–75° off a target turned up to 40° from rest, also with the wrist's limits lifted. The hand's middle is held on its target and its wrist end by the arm, so it has little freedom to turn; following the rotation needs the arm posed for it (the elbow placed so the wrist end is where the turned hand needs it).

**Body turn.** Only the head is tracked. Once the head is turned more than 0.3 rad from where the chest is held, the chest follows all the way and is then held there; the pelvis, and the legs on it, follows the chest. Both are driven through the motor of the joint above (neck: head–chest; waist: chest–pelvis), on the joint's twist axis. Two details matter:

- The motor sets the *child's* turn relative to the parent, so the child's own turning rate is added to the target. Without it a glance of the head would drag the chest along.
- The feet stand on the floor and hold the body back, so the motor is strong (factor 1000; the joints' friction is 10 to 40).
- The neck's twist axis is also where the strings' head turn lives (`controlInput.turn`, a spring set every step in `strings.ts`). One axis has one motor, so that spring stands by while `body.active`.

A look over the shoulder of more than 0.3 rad also turns the body: there is no way to tell it from a turn.

**Steps (`body-walk.ts`).** The player's legs are not tracked. When the head body travels along the floor, the hips and knees get position motors on a gait:

- the gait's phase advances with the distance covered (one cycle per 0.24 m on stage, 1.2 m in the room); the legs are half a cycle apart
- hip: `−level × (0.4 × forward × sin φ + 0.25 × air)`, knee: `level × 0.9 × air`, with `air = max(0, cos φ)`: the leg is in the air while it swings the way the puppet goes
- `forward` is the direction of travel projected on the pelvis' forward: backwards runs the gait in reverse, sideways steps on the spot (the hips are hinges, they only swing fore and aft)
- it starts when the head is faster than 0.06 m/s (0.3 m/s in the room) **and** more than 4.5 cm (22 cm in the room) from where the puppet stood, and ends below 0.03 m/s; the steps fade in and out over 0.25 s. The distance keeps leaning from stepping: *measured* with a head that turns about the neck, a lean of 20 cm gives no steps, one of 30 cm does
- no steps below 80 % of the standing height (the legs are folded on the floor)
- standing still, the hinges are back on the joints' friction, and the legs hang as always
- the motors are very stiff (50 000, critically damped): a joint motor only knows the two bodies it joins, and the shin with its lead-weighted foot hangs on the light thigh

**Strings and cross.** The main bar is written to `controlInput.bar` above the eyes as at rest, turned with the head but kept level; the rockers stay level. Every string gets 8 cm of slack (`strings.setSlack`, eased like a pull), so reaching or bowing does not pull one taut. The knee strings' take-up (`TAKE_UP` in `strings.ts`, which draws a slack knee string in until it is just taut) is off while slack is given: it would draw that slack in again. The head strings join two kinematic bodies then and do nothing.

**Grip.** A pinch closes that hand: Quest reports it as a select and as the trigger of the hand's own gamepad, and either counts. With controllers, squeeze or trigger. In the engine a closed hand is a magnet that is on (`controlInput.grip`, a level): the free hand takes the prop within 6 cm (`puppet/grab.ts`). The magnet going off does not drop the prop, so opening the hand also bumps `controlInput.release` (the engine's "let go"); leaving a session opens both hands.

**First person.** The `Head`, `Hat` and `HatRosette` meshes are hidden (the camera sits inside them, and all materials are double-sided).

**Giving back.** Head body dynamic again, neck and waist motors back to friction, wrist friction on, leg motors back to friction (and the leg bodies woken: a sleeping body does not notice a motor change), slack 0, the cross back to its rest pose. Friction is each part's own (`RigPart.friction`: head 30, waist 40, hips 20, the rest 10). The feet stand where the session left them: after leaving while turned, the body stays twisted under the head (*measured:* pelvis 0.37 rad off) until the puppet is next lifted off the floor.

## 7. IWSDK specifics

- **No controller or hand models, nothing from a CDN.** IWSDK shows a model for every controller and tracked hand and downloads it when the input connects: `cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/<profile>/<left|right>.glb` (*measured:* four files per session, two controllers and two hands). There is no option to switch that off, and IWSDK re-shows a hidden model every frame. The visual adapters keep the loader they were built with, so `XrEmbodimentSystem.init()` replaces it with one that has no model (`NO_MODELS`). IWSDK then tracks the input without a visual and prints "Failed to load visual asset https://cdn.jsdelivr.net/…" once per input: that is its message for "no model", nothing is requested. *Measured:* no request leaves the page's server when a session starts, with hands or controllers.
- **Input profiles** (button layouts) are bundled with IWSDK and need no network.
- **Other hosts named in bundled libraries, not requested by the app:** `unpkg.com` (IWSDK's Draco/Basis decoder paths, used only if IWSDK's own asset manager loads a compressed model; the app loads its models itself), `api.dicebear.com` (default picture of an unused uikit component).
- **Ray pointers** are switched off per session (`multiPointers[side].toggleSubPointer("ray", false)`).
- **`@iwsdk/vite-plugin-dev`** (emulator with UI) needs Vite 7; the project is on Vite 8. Plain `iwer` is used instead.
- **Body tracking** cannot be requested through IWSDK 1.1 (only the features it knows are passed on).

## 8. The button and a changing stage

The button gets a `busy()` from `main.ts`: true while the main curtain moves, while a scene change is counted as under way (`isSceneChanging()` in `plays.ts`: choosing a play until its first scene stands, and a scene switch from the stage curtain coming down until it goes up again), and on the way back to the play choice.

A click while busy waits (label "WebXR – nach dem Szenenwechsel", at most 20 s) and then enters, so the player steps onto a set stage. The browser counts a click as a user gesture for about 5 s:

- a click late in a change enters by itself when the change is done
- a click early in a long change finds the gesture expired (`navigator.userActivation.isActive` false): the button then asks for a second tap ("WebXR – nochmals tippen") instead of failing silently

*Measured:* a scene switch takes 5.4 s, so a click in its first half second needs the second tap.

The wait is a choice, not a need: since scene changes run during a session (section 9), the button could enter at once. It is kept so the player does not land in the middle of a set change.

## 9. Scene changes during a session

On a headset the page's `requestAnimationFrame` stops while a session runs, and its timers may be throttled. A scene change used both (the puppet's fade, the cross travelling, props settling, the pauses) and would hang until the session ends.

- **Clock:** `systems/frames.ts` offers `nextFrame`, `until` and `seconds` on the world's own loop (`FrameSystem`), which is the session's loop in XR. `puppet.ts`, `plays.ts`, `scene-buttons.ts` and the main curtain's lowering use it.
- **The driven puppet stays:** in a scene change the puppet normally fades out and its cross is pulled up 1 m, so props come down onto a free stage. A puppet with a player inside is exempt from the fade, the lift and the wait for the cross: its head is where the player's is, and the player would lose their hands.
- **Stepping into a hidden puppet:** if a session starts while the puppet is hidden or pulled up, it is shown and let down at once (`BodyDrive.onStart`).
- **Props** still come down on the stage with the player on it. *Measured:* a chair, a chest and a cup sent to the player's own spot were set down 13–19 cm beside it (the props module moves them off an occupied spot) and did not push the body.
- **Props in the hands:** a scene change makes every puppet let go of what it holds and take nothing until it is over (`dropAllHeld`, `suspendGrab`), the driven one too: the change sorts the props.
- **Fly-in:** a new camera player's entrance (`flyIn`, the puppet pulled up out of the picture and let down again) leaves a puppet with a player inside alone.
- **Trigger:** inside a session only the number keys 1–9 can start a change today (the scene buttons are DOM and not visible in the headset).

*Measured, with the page's frames stopped for app code during the session:* a scene switch finishes in 3.0 s; the stage curtain closes and opens, the props change, the puppet is never hidden, the cross does not move, the head does not move.

## 10. Trying it without a headset

`?emu` on the dev server installs IWER's emulated Quest 3 before the world is created (`installRuntime({ forceInstall: true })`: desktop Chrome has a `navigator.xr` of its own). The device is `xrDevice` in the console; with `?debug` also `world`, `puppet`, `controlInput`, `physics`.

```js
xrDevice.position.set(0.5, 1.6, 0)             // walk; in room metres
xrDevice.quaternion.set(0, 0.707, 0, 0.707)    // turn a quarter to the left
xrDevice.primaryInputMode = "hand"             // tracked hands instead of controllers
xrDevice.hands.left.position.set(-0.2, 1.2, -0.3)
xrDevice.hands.left.updatePinchValue(1)        // pinch: closes the puppet's left hand
xrDevice.controllers.right.updateButtonValue("squeeze", 1)

world.player.scale.x                           // about 0.2 in a session
puppet.body.driving()                          // true while a player is inside
puppet.body.stepping()                         // 0 hanging … 1 full steps
world.player.worldToLocal(point)               // a stage point → room coordinates for xrDevice
```

Caveats when scripting:

- A scripted `.click()` is no user gesture. The emulator starts a session anyway; the button's wait then ends in "nochmals tippen". Use a real click to test that path.
- The emulator keeps the page's frames running during a session, a headset does not. To test what depends on that, drop `requestAnimationFrame` callbacks that come from app code (`/src/` in the stack) while `world.renderer.xr.isPresenting`.
- **Frame rate matters.** A background or occluded tab runs at a few frames per second; the physics then falls behind real time (at most 4 steps per frame) and timed tests give wrong results. Headless system Chrome through `playwright-core` (in `node_modules` as a transitive dependency) runs at 60 fps.

On a Quest: `adb reverse tcp:5173 tcp:5173`, then `http://localhost:5173` (a secure context without a certificate warning), or `npm run dev:https` over the LAN.

## 11. Tuning

All in metres, seconds and radians, at puppet scale.

| Constant | File | Value | What it sets |
|---|---|---|---|
| `EYE` | `body-drive.ts` | (0, 0.005, 0.015) | Eye point in the head body |
| `STRING_SLACK` | `body-drive.ts` | 0.08 | Extra string length while driven |
| `MAX_HEAD_SPEED`, `MAX_HEAD_TURN` | `body-drive.ts` | 1.5, 8 | How fast the head body follows |
| `HAND_GAIN`, `MAX_HAND_SPEED` | `body-drive.ts` | 30, 1.5 | Hand follow |
| `HAND_TURN_GAIN`, `MAX_HAND_TURN` | `body-drive.ts` | 20, 12 | Hand rotation follow |
| `REACH` | `body-drive.ts` | 0.97 | Share of the arm's length a hand target may be away |
| `BODY_FREE_TURN` | `body-drive.ts` | 0.3 | Head turn that leaves the body alone |
| `BODY_TURN_GAIN`, `MAX_BODY_TURN`, `BODY_TURN_FORCE` | `body-drive.ts` | 12, 4, 1000 | Chest and pelvis turn |
| `STRIDE` | `body-walk.ts` | 0.24 | Distance for one gait cycle |
| `SWING`, `LIFT`, `KNEE` | `body-walk.ts` | 0.4, 0.25, 0.9 | Hip swing, extra hip lift and knee bend of a step |
| `START_SPEED`, `STOP_SPEED`, `START_DISTANCE` | `body-walk.ts` | 0.06, 0.03, 0.045 | When steps start and end |
| `CROUCH` | `body-walk.ts` | 0.8 | Share of the standing height below which there are no steps |
| `STIFFNESS`, `DAMPING` | `body-walk.ts` | 50 000, 450 | Leg motors |
| `DEFAULT_EYE_HEIGHT`, `EYE_HEIGHT_RANGE` | `xr-embodiment.ts` | 1.6, 0.9–2.1 | Player height when the headset gives none, and what counts as on the floor |
| `MAX_WAIT_MS` | `xr-button.ts` | 20 000 | Longest wait for a changing stage |

## 12. Measured (emulator, 60 fps)

Rows marked ✱ were measured again after merging `main`'s engine rework of 2026-11-15 (magnetic grab, head-turn spring, stiffer body and head, knee-string take-up); the others are from before it.

| What | Result |
|---|---|
| Hands at the sides, tracked hands ✱ | within 3 mm of their targets |
| Arms straight overhead ✱ | hands at 0.344 m, above the head (0.315 m); before the merge within 1.5 mm of a target in reach |
| Hand rotation | **not followed:** 30° off at a rest target, 43–75° off after a 40° bend, 38° off after a 40° twist |
| Hand target 0.5 m away | hand at arm's length (94.5 mm from the shoulder), chest moves 0.4 mm, head 0 |
| Glance of 15° for 0.6 s ✱ | chest does not move |
| Quarter turn of the head ✱ | chest within 0.02 rad after 1 s; pelvis and shins within 0.08 rad after 1 s, 0.04 rad after 1.5 s (all within 0.01 rad after 1 s before the body was damped more) |
| Half turn | within 0.02 rad after 3 s |
| Pinch and grab ✱ | crouching to the ball, the closed hand takes it (in reach, then held), it rises with the hand (to 0.20 m), opening the hand lets go (`release` +1) and it lies on the floor again |
| Walking forward at 0.8 m/s for 1.5 m ✱ | gait on, a step with each foot (knees bend to 0.85 rad, hips swing 0.4 rad, feet lift 13–16 mm), gait off 0.5 s after stopping |
| Backward, sideways ✱ | gait on |
| After a quarter turn | gait on, steps with both feet |
| Direction of the steps | the foot in the air moves the way of travel relative to the pelvis (+0.06 m/s), the foot on the floor against it; the same walking backwards |
| Seen from the side (flat page, head driven across the stage) | reads as walking: feet apart and alternating, together again after stopping |
| Leaning 20 cm, quarter turn on the spot, crouched and moving ✱ | gait stays off |
| Nodding, looking around, a quick look over the shoulder (head turning about the neck) | gait stays off |
| Leaning 30 cm | steps |
| Strings after a session with walking ✱ | as on a fresh page: a full leg-bar rock lifts either foot 32 mm, the head turns ±1.04 rad with `turn` ±1 |
| Scene switch inside a session ✱ | 3.1 s, puppet stays, see section 9 |
| Requests to other servers on session start ✱ | none |

Nodding or turning the head sharply still swings the hanging body (feet lift up to 5 mm with a head that turns about the neck): that is the ragdoll hanging from the pinned head, not the gait.

## 13. Not verified, not built

- **Any run on a headset:** frame rate with the lighting rig, comfort, the eye point, drive speeds, slack, the walking thresholds with a real head.
- **Hand rotation** does not follow yet (section 6). Positions do.
- **Timers during a session** on a Quest: the scene-change waits no longer use them, but other code does.
- **The player on stage during a scene change:** props can land on them (section 9).
- **Stepping is a fixed gait:** it does not know where the player's feet are, and sideways travel steps on the spot.
- **Moving without walking** (no thumbstick, since controllers are not planned): 1 m in the room is about 0.2 m on stage.
- **Finger joints, a menu in the headset, settings per puppet** (the eye point and the head, hand and leg bones are constants for the SKKG marionette), **sending `body` to other players**.
- **MediaPipe** contains a logging call to `odml.pa.googleapis.com/v1/log`; whether it is sent while camera hand tracking runs was not checked (it is unrelated to XR).
