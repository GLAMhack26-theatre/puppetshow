# Puppet control: results of the third play-test round

Status on 2026-11-15. This is the report of one round of work on the hand-controlled marionette: what was built, what was measured, where it falls short, what is still open, and which recordings are needed to go on. The decisions themselves, and how each part works, are in `docs/architecture.md` (§3.1 for the hand tracking, §3.2 for the rig, strings and grab); this file does not repeat them.

**Nothing in this round has been tried on a real hand or a real camera.** Every number below comes from synthetic hands, from the one recorded real session (60 s, one right hand, one webcam, recorded with the first mapping), or from headless Chrome stepping the page. Where a number was measured by a subagent and not re-run afterwards, the text says so.

## 1. What was asked for

After the second play test, seven changes:

1. Knee strings that still work when the hand does not hold its height ("option 3").
2. The head turns left / right about the vertical, by thumb and little finger, as the real sub-cross does with rubber strings; no tilt, no nod by finger.
3. A 640 / 1280 switch in the hand window; the second hand's grip tolerates about 0.5 s of jitter.
4. A new player's puppet is pulled up out of view and flown in slowly instead of dropping in.
5. A camera-independent algorithm for hand height and puppet height.
6. Less wobble (hip, head); a held hand bar rocks with the fist's turn, for waving.
7. Magnetic grabbing of props with the second hand's fist.

Decided with the user while planning: the thumb / little-finger turn replaces the pinch nod; the second hand at the head ring turns the head too; the second hand's fist (away from the rings) grabs, the cross hand's fist no longer does.

## 2. What was built, with the measured results

### 2.1 Knee strings and legs (item 1)

- **Take-up** (`TAKE_UP` in `src/puppet/strings.ts`): while the leg bar is level each knee string is drawn in until just taut, held while the bar rocks, and let out at free-fall rate.
  - A full leg rock lifts the knee 3.2–4.7 cm at cross heights from 2 cm above the rest height to 8 cm below. Before: nothing below −3 cm.
  - Half a rock lifts about 2–2.5 cm; while the cross sinks during a step, about 2.2–2.9 cm.
  - With a level bar the highest knee is 0.6 cm up; a plucked knee string is not drawn in further.
- **Standing band** (`TUNING.position.dead`): within ±3 cm of the standing height the cross keeps its rest height. On the recorded session the hand wandered by 2 cm while the fingers stepped.
- **Leg ring**: a third handle, further out and lower than the hand bar's, lets the second hand take the leg bar and rock it by turning the fist (large or held steps). Picking was checked at cross-hand leans of 0.3, 0.9 and 1.3 rad.

### 2.2 Head turn (item 2)

- `ControlInput.turn` (−1…1). The head bar turns on the cross by up to 60° and a spring on the head joint's twist stands in for the rubber strings.
  - Engine: 1.05 rad at ±1, 1.0 rad after 0.5 s, no overshoot; chest within 0.02 rad. The keyboard nod is unchanged within 10 %.
- Tracker: thumb pressed in turns the head to the thumb's side of the picture, little finger bent down to the other; checked for both hands and both mirror modes.
  - On the recorded session the turn is exactly 0 for the first 44 s (steps included) and answers to the old thumb and ring / little-finger gestures in its last seconds.
- The second hand at the head ring turns the head as well. The pinch nod is gone (`nod` stays in the engine for the keyboard).

### 2.3 Resolution switch and grip tolerance (item 3)

- A 640 / 1280 segment control under the hand window, remembered in the browser; `?res=` wins. After a switch the tracker takes a new rest pose. Checked with Chrome's fake camera only, again after all other changes of this round.
- The second hand keeps its bar until it has been seen open for 0.5 s (was 0.3 s), and through being lost or re-detected: the bar is kept for 0.65 s after its hand was last seen, and a hand that shows up in that time carries on with it.

### 2.4 Fly-in (item 4)

- `flyIn()` in `src/puppet/puppet.ts`: the puppet on the stage is pulled up until its feet are out of the picture (about 1 s) and let down at 0.3 m/s at the new hand (about 4 s); 5–6 s in total, measured in the page. The puppet stays upright and the strings stay within 0.25 mm.
- It fires when a new player's hand connects. A new player is a hand that comes after 5 s without one, or with a palm more than 30 % different in size.

### 2.5 Hand height (item 5)

- **The model** (`BodyFrame` in `src/input/body-frame.ts`): the hand's height is read against the camera's horizon row and against a zero the player sets. "Spielhöhe" is now a correction of ±30 cm around that zero.
- **The zero** is a guided capture: a band in the hand window shows where to hold the hand, one hint at a time, and after 1 s held still the height is taken together with the rest pose. It is offered for 8 s once the puppet has landed; "Kreuz zurücksetzen" takes it at any time.
- **The horizon row** is measured once per camera and resolution with "Kamera einmessen" in the debug panel: the hand held at one fixed height, near the camera and then further away. `?horizon=<row>` sets it by hand.
- **Results**
  - The recorded session replayed as from a camera pitched ±15°: with the matching horizon row the height differs from the level replay by 0.03–0.05 cm on average and by at most 0.18 cm after the first 3 s. Without it: 15.5 cm off, wandering over 8 to 9 cm. Re-run after the subagent's work, same numbers.
  - Synthetic scenes, horizon row given, cameras at −15° / 0° / +15° and 0.6 / 1.0 / 1.8 m: height within 0.34 cm (focal 0.9) and 0.76 cm (focal 1.2); a 10 cm lift reads within 0.28 / 0.45 cm.
  - Two holds at 0.6 and 1.5 m give the horizon row within 0.005 rows; three noisy holds within 0.002.
  - In the page (synthetic session): "Die Puppe kommt …" during the flight, then "Ruhig halten …", "So steht die Puppe", and the HUD reads `calibrated` with ± 0.5 cm.
- **Recorder** (`?record`, format 2): next to the hands each frame holds what a face detector, a face landmarker and a pose landmarker see, plus notes on the set-up; `?record=video` also saves the camera's video. These models load only while recording. The hand landmarker ran at 29 Hz alone and at about 18 Hz with all three (headless desktop).

### 2.6 Wobble and waving (item 6)

- Body and head are damped more (`STIFF` in `src/puppet/marionette.ts`: joint friction per part and air drag). Over five input steps the summed settling time fell from 136 s to 67 s and the number of swings from 308 to 157. Most of the wobble was the body swinging on its strings, not the joints: friction alone gave 124 s.
- Knee lift, nod, head turn and hand lift are unchanged; arms and legs swing as before.
- A held bar rocks by the fist's turn in the picture plus the turn of the forearm. A synthetic fist turned 0.6 rad either way gives 0.70–0.92 rad of rock at leans from 0 to 1.2 rad; held still, the bar stays within 0.04 rad.

### 2.7 Magnetic grab (item 7)

- **Gesture**: a fist of the second hand away from the rings switches on the magnets in the puppet's hands (on 0.17 s after the hand begins to close). With something held, a fist opened again within 0.6 s lets go; held longer it is the magnet for the other hand. 22 checks on synthetic hands; the two real recordings give no magnet and no release.
- **Engine** (`src/puppet/grab.ts`), measured by the subagent on the rig with a stand-in prop (a 7 cm cube of 27 g), not re-run afterwards:
  - A free hand takes the nearest grabbable prop within 6 cm of its tip and eases it into an upright grip pose in 0.2–0.5 s.
  - While held the prop weighs at most 3 g and meets the stage only. The cross shaken ±5 cm at 4 Hz: the prop stays.
  - Let go at rest it lands 0.2–2.1 cm away; in a 1 m/s sweep it leaves at 0.91–0.95 m/s.
  - A whip of the free hand bar throws it at 1.7–2.8 m/s, 25–54 cm far.

## 3. How it was checked

| Check | Covers | State |
|---|---|---|
| `node scripts/test-hand-tracking.ts` | tracker on synthetic hands: roles, players, fingers, head turn, second hand, grasp, height band | passes |
| `node scripts/test-body-frame.ts` | height model on synthetic scenes (72 checks) | passes |
| `node scripts/replay-recording.mjs --self-test` | re-projection for `--pitch`, body columns (18 checks) | passes |
| `npm run build` | tsc + vite | passes |
| `?test=nocurtain&replay=synthetic&debug`, headless | fly-in, guided capture, head turn ±1, leg rock ±50°, hand bar taken, magnet on | runs, console clean |
| `?test=nocurtain&debug` with Chrome's fake camera | resolution switch 640 ↔ 1280 | works |
| `?test=puppet&debug`, stepped headless | engine numbers in §2 | measured during the work |

## 4. Shortfalls

### Deviations from what was asked or planned

- **No face or body model runs in play.** Item 5 asked for face detection by name. The model can read a face or a body and the recorder captures them, but at the hand's usual distance the picture is only about 0.47 m tall, so a face and a chest-high hand rarely fit together, and nothing face-based can be validated without a recording that contains one. Until then a pitched camera needs the installer's step, and without it the height drifts with the hand's distance (31 cm between 0.6 and 1.8 m on a synthetic scene).
- **Throw by motion is on although the plan's rule left it off.** The plan asked for a factor of 1.5 between motions that must hold and motions meant to throw before switching it on. Tipping the cross is within 1.2 times of a lift and does not throw. Whips of the hand bar read 1.9 times above every hold motion, so `GRAB.flingSpeed` is 1.05 and `pullMin` 0.7. A real hand's brisk lift of the hand bar may already count as a whip. `GRAB.flingSpeed = Infinity` switches it off.
- **Grabbing single strings** (part of option 3) is deferred until a two-hand recording shows the hands can be told apart there.

### Targets not reached

- **Guided capture on the real session.** With a 5.5 s fly-in as the page runs it, the zero was taken 6.8 s after the landing, 1.2 s before the offer ends. Offered from the hand's first frame, no zero was taken within 8 s. That player was not guided (the session predates the capture), so this says little about a guided one. A missed offer is not repeated; the player has to press "Kreuz zurücksetzen", and until then the puppet stands for a hand at the camera's height, with a band of ±6 cm.
- **Height at focal length 1.5**: off by 1.26 cm (target 1 cm), a 10 cm lift within 0.66 cm (target 0.5).
- **First walk towards a pitched camera, horizon row unknown, face as anchor**: within 5.1–5.5 cm (target 4). Without the face: 29 cm.
- **Sitting down by 0.4 m**: the puppet stands again 2.6–2.8 s after the player starts to sit (target 2.5 s).
- **Zero from the body for a child of 1.2 m**: off by 8 to 20 cm, mostly through the assumed palm length.
- **Face noise of ±2 px** on a face 14–28 px wide: the height is off by up to 17 cm; such a face is no ruler.
- **Walking the full range with a taken zero and 1.5–2 px of landmark noise**: within 2.5 cm, which is more than the leg window; the standing band and the take-up have to cover it.

### Limits measured on the rig

- A standing puppet's hand tips hang 13.4 cm above the floor and reach 6 cm, so a prop lower than 7.4 cm is caught only once the puppet sinks about 3 cm.
- A hard sideways step of the cross still twists the body once by up to 0.8 rad; it is back within about 1 s.
- A held prop (3 g) is pulled through a thin fixed collider instead of being stopped by it.
- The puppet's hands hang about 1.4 rad twisted about the vertical at rest.
- The quick fist/open takes 0.2 s or more to be read, so a timed throw by release is a matter of luck.

### Found, not fixed

- Taking a bar has no debounce: one fist frame inside a ring takes it.
- The director bar ("Regie") covers the top edge of the hand window in impro mode until the window is dragged away.
- A capital P typed into the recorder's notes field opens the presentation.
- Depth lags by up to 27 % while the player walks towards the camera: the palm's speed across the picture makes the tracker distrust its size all through the walk.
- A rest pose taken with the palm flat to the camera halves the leg rock for the same finger bend (−0.44 instead of −0.84).
- A camera below the face foreshortens the eyes-to-mouth distance, so a head turned by 40° still reads 15 % small.
- `?record=video` with a file-fed fake camera: a page stall of a second or more stops the camera for good. Not seen with Chrome's built-in fake camera; not tried with a real one.
- The face detector reported faces on a test pattern in 102 of 227 frames; detections under a score of 0.7 are left out.
- At +15° the pitched replay differs from the level one by 1.6 cm in the first frames after the hand attaches (0.8 cm after 1 s). Not looked into.

## 5. Open questions

For the user to decide:

1. **Should "Spielhöhe" reset for each new player?** It is stored in the browser, so the next visitor's captured zero is shifted by the last one's correction. It is stored as before for now.
2. **How long should the guided capture be offered?** 8 s after the landing now; the alternative is to keep it open until a zero is taken.
3. **"Markenhöhe" in the recorder's set-up form** is taken as the height of the mark the hand is held at. Is that what was meant?
4. **Should a jerk of the whole cross throw a held prop?** It does not now, by construction: only a whip of the free hand bar does.
5. **One release drops what both puppet hands hold.** Should the two hands be released separately?
6. **Held props pass through other props** and only props up to 10 cm can be grabbed. Keep both?

To be answered by trying it on a real hand:

- Whether a pressed thumb and a bent little finger read as cleanly as on the synthetic hand, and whether the thresholds fit other hands.
- Whether the 0.6 s window for the quick fist/open is right, how a fist reads at the picture's edge, and whether a relaxed hand counts as open.
- Whether a fist turned from the forearm rocks the hand bar far enough to wave.
- Whether the capture's band (rows 0.35–0.70), its size and lean limits and its 1 s hold fit a real player, and how well two real holds give the horizon row.
- Whether the three rings can be told apart in play, and whether the second hand still drops its bar on sudden moves.
- Frame rate and behaviour on phones and in Safari.

## 6. Recordings needed

Recordings are the basis for tuning and for the next step of the height model (a face or body model in play). Hand recordings (`hand-recording-*.json`, `.webm`, `.mp4`) stay out of git.

**How:** open the page with `?record&debug`, fill in the set-up form in the debug panel (camera height, camera pitch, the player's height, the height of the mark, notes), play, then press R to save. About 90 s each. Add `=video` only when the video itself is wanted, and watch the frame counter in the hand window: it shows whether the camera still runs.

**Set-ups**, each with a stick marked at the playing height, 20 cm above and 15 cm below:

- a laptop webcam on a table;
- an external webcam at 1.2–1.3 m, level, and again pitched 10–15° down;
- a phone's front camera, propped up, in portrait and in landscape;
- one camera at hand height;
- one session seated.

**In each recording:**

1. Hold the hand still at the mark.
2. Walk between 0.6 and 2 m from the camera, hand at the mark.
3. Move the hand up and down to the other two marks.
4. Play: steps with index and middle finger, head turns with thumb and little finger, bows.
5. Sit down and stand up.
6. Leave the picture and come back; then a second person takes over.

Three players if possible, one of them left-handed.

**For the second hand**, one or two sessions with both hands: take each of the three rings and turn the fist, move the fist from one ring to another, push the back string, make the magnet fist away from the rings and the quick fist/open. A session that contains a sudden unexplained move of the cross is worth keeping too: `scripts/replay-recording.mjs` lists the largest steps.

**Before recording with a pitched camera**, run "Kamera einmessen" once and note the row it reports in the form's notes, so the replay can be checked against it (`--horizon=<row>`).

## 7. What comes next

- A face or body model at runtime, on a stride of frames, once recordings with a face exist: a first zero for a new player, sitting down and standing up, the horizon row fitted from a walk.
- Tuning of the finger thresholds, the capture and the throw on real hands.
- Grabbing single strings with the second hand.
- The items under "Found, not fixed".
