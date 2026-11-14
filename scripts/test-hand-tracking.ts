// Checks the hand-tracking pipeline (src/input/hand-tracking.ts) on synthetic
// hands (src/input/hand-synthetic.ts). No camera, no browser:
//     node scripts/test-hand-tracking.ts
// Node 24 runs TypeScript directly. It proves the maths and the state machine,
// not MediaPipe's accuracy on a real hand.
import {
  HandTracker, MAPPING, TUNING, hysteresis, palmInImage, palmPose, tiltBetween, toDisplay,
  type HandFrame, type TrackerOutput,
} from "../src/input/hand-tracking.ts";
import { CAMERA, demoRecording, gaussian, synthesize, type SyntheticHand } from "../src/input/hand-synthetic.ts";

const FPS = 30;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const std = (values: number[]) => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};
const f = (v: number, digits = 3) => v.toFixed(digits);
const snapshot = (out: TrackerOutput) => structuredClone({ status: out.status, calibrated: out.calibrated, bar: out.bar, rock: out.rock, grip: out.grip, handBar: out.handBar, headBar: out.headBar, hook: out.hook });
type Snapshot = ReturnType<typeof snapshot>;

/** Run hands(t) through a tracker from `from` to `to` seconds; returns one snapshot per frame */
function run(tracker: HandTracker, from: number, to: number, hands: (t: number) => HandFrame[]): Snapshot[] {
  const result: Snapshot[] = [];
  for (let i = Math.round(from * FPS); i < Math.round(to * FPS); i++) {
    result.push(snapshot(tracker.update((i / FPS) * 1000, hands(i / FPS), CAMERA.aspect)));
  }
  return result;
}
const REST: SyntheticHand = { hand: "right", x: 0.4, y: 0.5, distance: 0.6 };
/** A tracker with the rest hand attached (2 s of holding still) */
function attached(rest = REST, noise?: () => number) {
  const tracker = new HandTracker();
  run(tracker, 0, 2, () => [synthesize(rest, CAMERA, noise)]);
  return tracker;
}
const ramp = (t: number, from: number, to: number) => Math.max(0, Math.min(1, (t - from) / (to - from)));

console.log("1 smoothing");
{
  const noise = gaussian(1);
  const tracker = attached(REST, noise);
  const raw: { x: number; roll: number; pitch: number; z: number }[] = [];
  // The same measurements without the filters (display frame: the tracker's default mirrors the picture)
  const measure = (hand: HandFrame) => {
    const shown = toDisplay(hand, true);
    return palmPose(shown.image, shown.world, CAMERA.aspect);
  };
  const rest = measure(synthesize(REST));
  const out = run(tracker, 2, 8, () => {
    const hand = synthesize(REST, CAMERA, noise);
    const pose = measure(hand);
    const tilt = tiltBetween(rest.quat, pose.quat);
    raw.push({
      x: ((palmInImage(hand.image, CAMERA.aspect).x / CAMERA.aspect - 0.5) / TUNING.position.imageSpan) * 2 * TUNING.position.x,
      roll: tilt.roll,
      pitch: tilt.pitch,
      z: TUNING.depth.gain * Math.log(pose.scale / rest.scale),
    });
    return [hand];
  });
  for (const key of ["x", "roll", "pitch", "z"] as const) {
    const [before, after] = [std(raw.map((r) => r[key])), std(out.map((o) => o.bar[key]))];
    check(`jitter on ${key} attenuated ≥ 3×`, after * 3 <= before, `raw σ ${f(before * 1000, 2)} → ${f(after * 1000, 2)} (mm or mrad), ${f(before / Math.max(after, 1e-9), 1)}×`);
  }
  // Lag: a quick move of 0.15 of the image width in 0.2 s
  const mover = attached(REST, gaussian(2));
  const moved = run(mover, 2, 3.5, (t) => [synthesize({ ...REST, x: 0.4 + 0.15 * ramp(t, 2.2, 2.4) }, CAMERA, gaussian(3))]);
  const [start, end] = [moved[0].bar.x, moved[moved.length - 1].bar.x];
  const reached = moved.findIndex((o) => (o.bar.x - start) / (end - start) > 0.9);
  const lag = reached / FPS - 0.4 + 0.2 * 0.1; // the input itself passes 90 % at 2.38 s
  check("quick move: 90 % reached within 120 ms of the hand", lag < 0.12, `${f(lag * 1000, 0)} ms`);
}

console.log("2 depth does not couple to tilt");
{
  const noise = gaussian(4);
  for (const axis of ["pitch", "yaw", "roll"] as const) {
    const tracker = attached(REST, noise);
    let naive = [Infinity, 0];
    const out = run(tracker, 2, 10, (t) => {
      const hand = synthesize({ ...REST, [axis]: 0.6 * Math.sin(2 * Math.PI * ramp(t, 2, 10)) }, CAMERA, noise);
      const size = palmInImage(hand.image, CAMERA.aspect).length;
      naive = [Math.min(naive[0], size), Math.max(naive[1], size)];
      return [hand];
    });
    const z = Math.max(...out.map((o) => Math.abs(o.bar.z)));
    const tilt = Math.max(...out.map((o) => Math.abs(o.bar[axis])));
    const plain = TUNING.depth.gain * Math.log(naive[1] / naive[0]);
    // Not zero: the hand turns about its palm, so its knuckles really come 2 cm closer to the camera
    check(`±0.6 rad of ${axis}: z stays within 5 cm`, z < 0.05, `max |z| ${f(z * 1000, 1)} mm; plain 2D palm size would move it ${f(plain * 100, 0)} cm`);
    check(`±0.6 rad of ${axis} reaches the bar`, tilt > 0.45 && tilt < 0.7, `max ${f(tilt)} rad`);
  }
  // Sign. Fingertips tipped forward and down (camera-x rotation +) = the front of
  // the cross goes down, the puppet bows (stage pitch +): the hand is the cross,
  // for the player in front of the screen as from the far side of the stage
  for (const [mirror, sign] of [[true, 1], [false, 1]] as const) {
    const tracker = new HandTracker();
    tracker.mirror = mirror;
    const out = run(tracker, 0, 4, (t) => [synthesize({ ...REST, pitch: 0.4 * ramp(t, 2, 3), roll: 0 })]);
    const pitch = out[out.length - 1].bar.pitch;
    check(`fingertips towards the camera: pitch ${sign > 0 ? "+" : "−"} (mirror ${mirror ? "on" : "off"})`, sign * pitch > 0.3, f(pitch));
  }
  // A palm flat to the camera cannot show which way it leans in its outline: the 3D
  // landmarks decide there, so a small lean backwards is read as backwards
  {
    const tracker = attached();
    const out = run(tracker, 2, 4, (t) => [synthesize({ ...REST, pitch: -0.25 * ramp(t, 2, 3) })]);
    check("small lean backwards from flat keeps its direction", out[out.length - 1].bar.pitch < -0.15, f(out[out.length - 1].bar.pitch));
  }
  // The hand as it holds a cross: leaning 0.9 rad towards the screen, then tipped flat (1.4) and back upright (0.4)
  {
    const lean = (t: number) => 0.9 + 0.5 * ramp(t, 3, 4) - 1.0 * ramp(t, 5, 7);
    const tracker = new HandTracker();
    const noise = gaussian(41);
    const out = run(tracker, 0, 8, (t) => [synthesize({ ...REST, pitch: lean(t) }, CAMERA, noise)]);
    const at = (t: number) => out[Math.round(t * FPS)].bar;
    check("leaning hand tipped flat and back upright: pitch follows both ways", Math.abs(at(4.5).pitch - 0.5) < 0.12 && Math.abs(at(7.8).pitch + 0.5) < 0.12, `flat ${f(at(4.5).pitch)} (+0.5, bow), upright ${f(at(7.8).pitch)} (−0.5)`);
    const steps = out.slice(1).map((o, i) => Math.abs(o.bar.pitch - out[i].bar.pitch));
    check("no jumps on the way", Math.max(...steps) < 0.06, `largest step ${f(Math.max(...steps))} rad per frame`);
    const side = Math.max(...out.map((o) => Math.max(Math.abs(o.bar.yaw), Math.abs(o.bar.roll))));
    check("yaw and roll stay quiet while it pitches", side < 0.12, `max ${f(side)} rad`);
  }
}

console.log("2b rest pose");
{
  // The hand as it holds a cross (palm level, fingers towards the screen: lean 0.9), moving from the first frame on
  const LEVEL = { ...REST, pitch: TUNING.attach.lean };
  const tracker = new HandTracker();
  const noise = gaussian(42);
  const wave = (t: number) => 0.4 + 0.1 * Math.sin(2 * t) * (1 - ramp(t, 3, 3.2)); // moves for 3 s, then pauses
  const out = run(tracker, 0, 6, (t) => [synthesize({ ...LEVEL, x: wave(t) }, CAMERA, noise)]);
  const at = (t: number) => out[Math.round(t * FPS)];
  const early = out.slice(Math.round(0.3 * FPS), Math.round(3 * FPS));
  check("the cross answers at once: attached within 0.3 s, before any pause", at(0.3).status === "attached" && !at(2.5).calibrated);
  check("a level hand gives a level cross before it has paused", early.every((o) => Math.abs(o.bar.pitch) < 0.12 && Math.abs(o.bar.roll) < 0.12), `max pitch ${f(Math.max(...early.map((o) => Math.abs(o.bar.pitch))))}`);
  check("its first pause of 1 s makes its own pose the rest pose", at(5).calibrated && !at(3.5).calibrated);
  // A hand that attaches in a pose far from the usual one: the cross tilts over to it, it does not jump
  const upright = run(new HandTracker(), 0, 0.9, () => [synthesize({ ...REST, x: 0.6, pitch: 0.3 }, CAMERA, noise)]);
  const tilts = upright.slice(1).map((o, i) => Math.max(Math.abs(o.bar.pitch - upright[i].bar.pitch), Math.abs(o.bar.x - upright[i].bar.x)));
  check("attaching away from the usual pose: no jump of the cross", Math.abs(upright[upright.length - 1].bar.pitch) > 0.4 && Math.max(...tilts) < 0.06, `pitch ${f(upright[upright.length - 1].bar.pitch)} reached in steps of at most ${f(Math.max(...tilts))}`);
  // A hand that rests in another pose: tilted until it pauses, then eased level
  const other = new HandTracker();
  const tilted = run(other, 0, 4, () => [synthesize({ ...REST, pitch: 0.4, roll: 0.25 }, CAMERA, noise)]);
  const steps = tilted.slice(1).map((o, i) => Math.abs(o.bar.pitch - tilted[i].bar.pitch));
  check("another rest pose: level after its pause, eased without a jump", Math.abs(tilted[tilted.length - 1].bar.pitch) < 0.05 && Math.abs(tilted[tilted.length - 1].bar.roll) < 0.05 && Math.max(...steps.slice(10)) < 0.09, `before ${f(tilted[20].bar.pitch)}, after ${f(tilted[tilted.length - 1].bar.pitch)}, largest step ${f(Math.max(...steps.slice(10)))}`);
  // N takes the pose at once, also while the hand moves
  const moving = new HandTracker();
  run(moving, 0, 2, (t) => [synthesize({ ...REST, pitch: 0.5, x: 0.4 + 0.1 * Math.sin(3 * t) }, CAMERA, noise)]);
  moving.recenter();
  const after = run(moving, 2, 3.5, (t) => [synthesize({ ...REST, pitch: 0.5, x: 0.4 + 0.1 * Math.sin(3 * t) }, CAMERA, noise)]);
  check("N takes the current pose without waiting for a pause", after[after.length - 1].calibrated && Math.abs(after[after.length - 1].bar.pitch) < 0.06, f(after[after.length - 1].bar.pitch));
  // A level palm is nearly edge-on to the camera and may tip through it: the tilt carries on, it does not turn back
  let handed = 0;
  const pose = (pitch: number) => {
    const shown = toDisplay(synthesize({ ...REST, pitch }), true);
    const result = palmPose(shown.image, shown.world, CAMERA.aspect, handed);
    handed = result.handed;
    return result;
  };
  const rest = pose(0.9);
  const through = [1.2, 1.45, 1.7, 1.95].map((pitch) => tiltBetween(rest.quat, pose(pitch).quat).pitch);
  check("tipping through edge-on: the tilt keeps growing", through.every((v, i) => Math.abs(v - (0.3 + 0.25 * i)) < 0.12), through.map((v) => f(v, 2)).join(" "));
}

console.log("3 depth: quick reach acts, a new seat is absorbed");
{
  const tracker = attached();
  // The player reaches towards the screen: the puppet goes upstage (−z)
  const expected = -TUNING.depth.gain * Math.log(0.6 / 0.48);
  const out = run(tracker, 2, 40, (t) => [synthesize({ ...REST, distance: 0.6 - 0.12 * ramp(t, 3, 3.3) })]);
  const at = (t: number) => out[Math.round((t - 2) * FPS)].bar.z;
  check("reach of 12 cm in 0.3 s: ≥ 80 % of the move 0.2 s later", at(3.5) < 0.8 * (expected + TUNING.depth.gain * TUNING.depth.dead), `z ${f(at(3.5))} of ${f(expected)} m`);
  check("held there: back near the middle after 30 s", Math.abs(at(33)) < 0.03, `z ${f(at(33))} m; after 5 s ${f(at(8))}, 10 s ${f(at(13))}`);
  const seat = attached();
  const drift = run(seat, 2, 62, (t) => [synthesize({ ...REST, distance: 0.6 - 0.1 * ramp(t, 2, 62) })]);
  const worst = Math.max(...drift.map((o) => Math.abs(o.bar.z)));
  check("player leans in 10 cm over a minute: puppet stays within 5 cm", worst < 0.05, `max |z| ${f(worst)} m`);
}

console.log("4 hand roles");
{
  const tracker = new HandTracker();
  const order = gaussian(5);
  const first: SyntheticHand = { hand: "right", x: 0.3, y: 0.5, distance: 0.6 };
  const other: SyntheticHand = { hand: "left", x: 0.7, y: 0.5, distance: 0.6 };
  const out: TrackerOutput[] = [];
  let swaps = 0;
  let wrong = 0;
  let jump = 0;
  let lastX = NaN;
  for (let i = 0; i < 6 * FPS; i++) {
    const t = i / FPS;
    const hands = [synthesize({ ...first, x: 0.3 + 0.05 * Math.sin(t) })];
    if (t > 1) hands.push(synthesize({ ...other, x: 0.7 + 0.05 * Math.cos(t) }));
    if (hands.length === 2 && order() > 0) {
      hands.reverse();
      swaps++;
    }
    const o = tracker.update(t * 1000, hands, CAMERA.aspect);
    out.push(o);
    if (o.cross && o.cross.hand !== "right") wrong++;
    if (t > 1.5 && (!o.second || o.second.hand !== "left")) wrong++;
    if (t > 0.5 && !Number.isNaN(lastX)) jump = Math.max(jump, Math.abs(o.bar.x - lastX)); // after the first attach
    lastX = o.bar.x;
  }
  check("first hand stays the cross hand while MediaPipe's order swaps", wrong === 0 && jump < 0.02, `${swaps} swaps, ${wrong} wrong frames, largest bar step ${f(jump * 1000, 1)} mm`);
  // The two hands cross over each other: nearest-palm alone would be ambiguous, handedness breaks the tie
  const crossing = new HandTracker();
  let lost = 0;
  for (let i = 0; i < 6 * FPS; i++) {
    const t = i / FPS;
    const a = 0.3 + 0.4 * ramp(t, 2, 4);
    const o = crossing.update(t * 1000, [synthesize({ ...other, x: 1 - a, y: 0.62 }), synthesize({ ...first, x: a, y: 0.38 })], CAMERA.aspect);
    if (t > 0.5 && o.cross?.hand !== (i === 0 ? o.cross?.hand : "left")) lost++;
  }
  check("hands passing each other keep their roles", lost === 0, `${lost} frames with the wrong cross hand`);
}

console.log("5 dropouts");
{
  const tracker = attached({ ...REST, roll: 0 });
  const posed: SyntheticHand = { ...REST, x: 0.55, index: 0.8 };
  run(tracker, 2, 4, (t) => [synthesize({ ...REST, x: 0.4 + 0.15 * ramp(t, 2, 3), index: 0.8 * ramp(t, 2, 3) })]);
  const before = snapshot(tracker.update(4000, [synthesize(posed)], CAMERA.aspect));
  const short = run(tracker, 4 + 1 / FPS, 4.3, () => []);
  const held = short.every((o) => o.status === "attached" && o.bar.x === before.bar.x && o.rock.legs === before.rock.legs);
  check("0.3 s without the hand: everything is held", held && Math.abs(before.rock.legs) > 0.5, `legs ${f(before.rock.legs, 2)} held`);
  const long = run(tracker, 4.3, 5.2, () => []);
  const last = long[long.length - 1];
  check("1.2 s without it: rockers level, cross stays in place", last.status === "lost" && last.rock.legs === 0 && last.bar.x === before.bar.x);
  const back = run(tracker, 5.2, 6.1, () => [synthesize(posed)]);
  check("it comes back: attached again with the same rest pose", back[back.length - 1].status === "attached" && Math.abs(back[back.length - 1].rock.legs) > 0.5);
  // … and the outputs go over to it, they do not jump (the hand comes back 0.1 of the picture further on)
  run(tracker, 6.1, 6.5, () => []);
  const moved = run(tracker, 6.5, 7.4, () => [synthesize({ ...posed, x: 0.45 })]);
  const steps = moved.slice(1).map((o, i) => Math.abs(o.bar.x - moved[i].bar.x));
  check("back somewhere else: the cross moves over, no jump", Math.abs(moved[moved.length - 1].bar.x - back[back.length - 1].bar.x) > 0.1 && Math.max(...steps) < 0.02, `largest step ${f(Math.max(...steps) * 1000, 1)} mm per frame`);
  const gone = run(tracker, 7.4, 9.3, () => []);
  check("gone for 1.9 s: role released", gone[gone.length - 1].status === "none");
  const again = run(tracker, 9.3, 10.8, () => [synthesize(posed)]);
  check("a new hand settles and attaches with a new rest pose", again[2].status !== "attached" && again[again.length - 1].status === "attached" && Math.abs(again[again.length - 1].rock.legs) < 0.05);
  // A ghost detection of one frame must not become the cross hand
  const ghost = new HandTracker();
  const o = [ghost.update(0, [synthesize(REST)], CAMERA.aspect).status, ghost.update(33, [], CAMERA.aspect).status];
  check("a one-frame ghost detection is ignored", o[0] === "none" && o[1] === "none");
}

console.log("6 mirror");
{
  const script = (t: number): SyntheticHand => ({
    ...REST, x: 0.4 - 0.1 * ramp(t, 2, 3), y: 0.5 - 0.1 * ramp(t, 2, 3), distance: 0.6 - 0.1 * ramp(t, 3, 3.3),
    roll: 0.3 * ramp(t, 2, 3), yaw: 0.3 * ramp(t, 2, 3), pitch: 0.3 * ramp(t, 2, 3), index: 0.7 * ramp(t, 3.3, 3.6), ring: 0.8 * ramp(t, 3.6, 3.9), pinky: 0.8 * ramp(t, 3.6, 3.9),
  });
  const results = [false, true].map((mirror) => {
    const tracker = new HandTracker();
    tracker.mirror = mirror;
    const out = run(tracker, 0, 3.9, (t) => [synthesize(script(t))]);
    return { legs: out[Math.round(3.6 * FPS) - 1].rock.legs, last: out[out.length - 1] };
  });
  // The two modes are the same mapping turned half round about the vertical (the
  // player in front of the screen, or on the far side of the stage): everything
  // sideways and front-to-back flips, up and turning about the vertical stay.
  // Pitch stays too: tipping the hand forward bows the puppet in both (TUNING.tipForwardBows)
  const [face, selfie] = results;
  const flips: [string, number, number][] = [
    ["x", face.last.bar.x, selfie.last.bar.x], ["z", face.last.bar.z, selfie.last.bar.z], ["roll", face.last.bar.roll, selfie.last.bar.roll],
    ["legs", face.legs, selfie.legs], ["head", face.last.rock.head, selfie.last.rock.head],
  ];
  for (const [name, a, b] of flips) check(`${name} flips`, Math.abs(a) > 0.1 && Math.abs(a + b) < 0.03, `${f(a)} / ${f(b)}`);
  const same: [string, number, number][] = [["y", face.last.bar.y, selfie.last.bar.y], ["yaw", face.last.bar.yaw, selfie.last.bar.yaw], ["pitch", face.last.bar.pitch, selfie.last.bar.pitch]];
  const restHeight = new HandTracker().restHeight;
  for (const [name, a, b] of same) check(`${name} stays`, Math.abs(a - b) < 0.03 && Math.abs(a - (name === "y" ? restHeight : 0)) > 0.05, `${f(a)} / ${f(b)}`);
  // In front of the screen (mirror, the default): the hand moves to the image's left = the player's own right
  // = screen right (stage +x); it comes closer to the camera = towards the screen = upstage (−z)
  check("mirror: the player's right is stage +x, towards the screen is upstage", selfie.last.bar.x > 0.1 && selfie.last.bar.z < -0.05, `x ${f(selfie.last.bar.x)} z ${f(selfie.last.bar.z)}`);
  check("mirror is the default", new HandTracker().mirror);
  check("far side of the stage: image left = stage −x, closer = downstage", face.last.bar.x < -0.1 && face.last.bar.z > 0.05);
  const frame = synthesize(REST);
  check("toDisplay(mirror) reflects image and world x", toDisplay(frame, true).image[0].x === 1 - frame.image[0].x && toDisplay(frame, true).world[5].x === -frame.world[5].x);
}

console.log("7 fingers do not cross-trigger");
{
  const cases: [string, Partial<SyntheticHand>, (o: Snapshot) => boolean][] = [
    ["index alone → legs only", { index: 0.8 }, (o) => Math.abs(o.rock.legs) > 0.6 && Math.abs(o.rock.head) < 0.05 && !o.grip],
    ["middle alone → legs the other way", { middle: 0.8 }, (o) => Math.abs(o.rock.legs) > 0.6 && Math.abs(o.rock.head) < 0.05 && !o.grip],
    ["ring + pinky → head only", { ring: 0.8, pinky: 0.8 }, (o) => Math.abs(o.rock.head) > 0.6 && Math.abs(o.rock.legs) < 0.05 && !o.grip],
    ["thumb tucked → head the other way", { thumb: 0.9 }, (o) => Math.abs(o.rock.head) > 0.6 && Math.abs(o.rock.legs) < 0.05 && !o.grip],
    ["fist → grip only", { index: 1, middle: 1, ring: 1, pinky: 1, thumb: 0.6 }, (o) => o.grip && Math.abs(o.rock.legs) < 0.05 && Math.abs(o.rock.head) < 0.05],
    ["all four fingers half closed together → no rocker", { index: 0.35, middle: 0.35, ring: 0.35, pinky: 0.35 }, (o) => !o.grip && Math.abs(o.rock.legs) < 0.1 && Math.abs(o.rock.head) < 0.1],
    ["moving and tilting the hand → no finger function", { x: 0.6, y: 0.35, distance: 0.5, roll: 0.5, pitch: 0.4, yaw: 0.4 }, (o) => !o.grip && Math.abs(o.rock.legs) < 0.05 && Math.abs(o.rock.head) < 0.05],
  ];
  const signs: number[] = [];
  for (const [name, pose, expect] of cases) {
    const noise = gaussian(6);
    const tracker = attached(REST, noise);
    const out = run(tracker, 2, 4, (t) => {
      const k = ramp(t, 2, 3);
      const blend = Object.fromEntries(Object.entries(pose).map(([key, v]) => [key, (REST[key as keyof SyntheticHand] as number ?? 0) * (1 - k) + (v as number) * k]));
      return [synthesize({ ...REST, ...blend }, CAMERA, noise)];
    });
    const last = out[out.length - 1];
    const transient = Math.max(...out.map((o) => Math.max(Math.abs(o.rock.legs), Math.abs(o.rock.head))));
    signs.push(Math.sign(last.rock.legs), Math.sign(last.rock.head));
    check(name, expect(last), `legs ${f(last.rock.legs, 2)} head ${f(last.rock.head, 2)} grip ${last.grip}; largest rock on the way ${f(transient, 2)}`);
  }
  check("index / middle and ring+pinky / thumb pull opposite ways", signs[0] === -signs[2] && signs[5] === -signs[7]);
  check("mapping table names the rockers", MAPPING.rock.legs !== null && MAPPING.rock.head !== null);
}

console.log("8 second hand takes the hand bar");
{
  check("hysteresis: no flicker between the thresholds", [0.5, 0.6, 0.5, 0.6].every((v) => !hysteresis(false, v, MAPPING.grab)) && [0.5, 0.6, 0.5].every((v) => hysteresis(true, v, MAPPING.grab)));
  const noise = gaussian(8);
  const start = () => {
    const tracker = attached({ ...REST, x: 0.3 }, noise);
    const magnet = tracker.update(2000, [synthesize({ ...REST, x: 0.3 }, CAMERA, noise)], CAMERA.aspect).handBar.magnet;
    // The handle is in the mirrored picture; the synthetic hands are placed in the raw camera image
    return { tracker, near: { x: 1 - magnet.x / CAMERA.aspect + 0.03, y: magnet.y + 0.1 } };
  };
  const cross = () => synthesize({ ...REST, x: 0.3 }, CAMERA, noise);
  {
    const { tracker, near } = start();
    const second = (t: number): SyntheticHand => ({
      hand: "left", distance: 0.6, x: near.x + 0.1 * ramp(t, 4, 5), y: near.y - 0.1 * ramp(t, 4, 5), roll: 0.5 * ramp(t, 5, 6),
      pinch: ramp(t, 3, 3.3) - ramp(t, 7, 7.3),
    });
    const out = run(tracker, 2.1, 8, (t) => [synthesize(second(t), CAMERA, noise), cross()]);
    const at = (t: number) => out[Math.round((t - 2.1) * FPS)];
    const grabbed = out.findIndex((o) => o.handBar.detached);
    let toggles = 0;
    for (let i = 1; i < out.length; i++) if (out[i].handBar.detached !== out[i - 1].handBar.detached) toggles++;
    check("pinch within reach detaches the bar, opening lets it go, no flicker", at(3.6).handBar.detached && !at(7.6).handBar.detached && toggles === 2, `detached at ${f(2.1 + grabbed / FPS, 2)} s, ${toggles} changes`);
    const first = out[grabbed].handBar;
    check("no jump at the moment of the grab", Math.hypot(first.x, first.y, first.z) < 0.005 && Math.abs(first.roll) < 0.05, `offset ${f(Math.hypot(first.x, first.y, first.z) * 1000, 1)} mm`);
    const moved = at(6.8).handBar;
    // Hand moved 0.1 of the width (right in the camera image = left for the player) and 0.1 of the height up, then rolled 0.5 rad in the image
    check("the free bar follows the second hand", Math.abs(moved.x + 0.1 * CAMERA.aspect * TUNING.handBar.gain) < 0.01 && Math.abs(moved.y - 0.1 * TUNING.handBar.gain) < 0.01 && Math.abs(Math.abs(moved.roll) - 0.5) < 0.08, `x ${f(moved.x)} y ${f(moved.y)} z ${f(moved.z)} roll ${f(moved.roll)}`);
    check("the cross hand is not disturbed by the second", out.every((o) => o.status === "attached" && Math.abs(o.rock.legs) < 0.05 && !o.grip));
  }
  {
    const { tracker, near } = start();
    const FAR = { x: 0.9, y: 0.2 }; // well outside the reach of the handles
    const far = run(tracker, 2.1, 5, (t) => [cross(), synthesize({ hand: "left", distance: 0.6, ...FAR, pinch: ramp(t, 3, 3.3) }, CAMERA, noise)]);
    check("closing the hand far from the bar takes nothing", far.every((o) => !o.handBar.detached) && !far[far.length - 1].handBar.near);
    const sweep = run(tracker, 5, 7, (t) => [cross(), synthesize({ hand: "left", distance: 0.6, x: FAR.x + (near.x - FAR.x) * ramp(t, 5, 6), y: FAR.y + (near.y - FAR.y) * ramp(t, 5, 6), pinch: 1 }, CAMERA, noise)]);
    check("a closed hand passing the bar takes nothing", sweep.every((o) => !o.handBar.detached) && sweep[sweep.length - 1].handBar.near);
  }
  {
    const { tracker, near } = start();
    run(tracker, 2.1, 4, (t) => [cross(), synthesize({ hand: "left", distance: 0.6, ...near, pinch: ramp(t, 3, 3.3) }, CAMERA, noise)]);
    const short = run(tracker, 4, 4.3, () => [cross()]);
    const long = run(tracker, 4.3, 5, () => [cross()]);
    check("second hand lost: bar held for 0.5 s, then back on the magnet", short.every((o) => o.handBar.detached) && !long[long.length - 1].handBar.detached);
  }
}

console.log("8b second hand: head bar, back string, a pinch that dips");
{
  const noise = gaussian(9);
  // The cross hand as it is held in play: palm level, leaning 0.9 rad from flat to the camera
  const CROSS: SyntheticHand = { ...REST, x: 0.3, pitch: 0.9 };
  const cross = (extra: Partial<SyntheticHand> = {}) => synthesize({ ...CROSS, ...extra }, CAMERA, noise);
  const start = () => {
    const tracker = attached(CROSS, noise);
    const out = tracker.update(2000, [cross()], CAMERA.aspect);
    // Handles and string are in the mirrored picture; the synthetic hands are placed in the raw camera image
    const raw = (p: { x: number; y: number }) => ({ x: 1 - p.x / CAMERA.aspect, y: p.y });
    const pinching = synthesize({ hand: "left", x: 0, y: 0, distance: 0.6, pinch: 1 }).image;
    const fingers = { x: (pinching[4].x + pinching[8].x) / 2, y: (pinching[4].y + pinching[8].y) / 2 };
    const at = (handle: { x: number; y: number }) => ({ x: raw(handle).x - fingers.x, y: handle.y - fingers.y });
    return { tracker, hand: at(out.handBar.magnet), head: at(out.headBar.handle), line: { ...out.hook.line, x: raw({ x: out.hook.line.x, y: 0 }).x }, unit: out.gizmo.unit, calibrated: out.calibrated };
  };
  {
    const { tracker, hand, head, calibrated } = start();
    check("the two handles are far enough apart to tell", calibrated && Math.hypot((hand.x - head.x) * CAMERA.aspect, hand.y - head.y) > 0.12, `${f(Math.hypot((hand.x - head.x) * CAMERA.aspect, hand.y - head.y))} image heights`);
    // Pinch at the head bar's handle, turn the hand 0.5 rad one way, let go
    const second = (t: number): SyntheticHand => ({ hand: "left", distance: 0.6, ...head, roll: 0.5 * ramp(t, 4, 5), pinch: ramp(t, 3, 3.3) - ramp(t, 6, 6.3) });
    const out = run(tracker, 2.1, 8, (t) => [synthesize(second(t), CAMERA, noise), cross()]);
    const at = (t: number) => out[Math.round((t - 2.1) * FPS)];
    const steps = out.slice(1).map((o, i) => Math.abs(o.rock.head - out[i].rock.head));
    check("pinch at the head bar's handle takes the head bar, not the hand bar", at(3.8).headBar.held && out.every((o) => !o.handBar.detached));
    check("turning the hand rocks the head bar", Math.abs(at(5.5).rock.head) > 0.5 && Math.abs(at(3.8).rock.head) < 0.1, `${f(at(5.5).rock.head, 2)} of the bar's range for 0.5 rad`);
    check("let go: back to the fingers without a jump", !at(7.9).headBar.held && Math.abs(at(7.9).rock.head) < 0.05 && Math.max(...steps) < 0.12, `largest step ${f(Math.max(...steps), 2)} per frame; head ${f(at(7.9).rock.head, 2)} afterwards`);
    // The cross hand's own fingers still rock it while the second hand does not hold it
    const fingersOnly = run(tracker, 8, 9.5, (t) => [cross({ ring: 0.3 * ramp(t, 8, 8.5), pinky: 0.3 * ramp(t, 8, 8.5) })]);
    check("the cross hand's ring + little finger still rock it", Math.abs(fingersOnly[fingersOnly.length - 1].rock.head) > 0.5, f(fingersOnly[fingersOnly.length - 1].rock.head, 2));
  }
  {
    // The pinch reading dips for a few frames while the bar is carried: it must not drop
    const { tracker, hand } = start();
    const second = (t: number): SyntheticHand => ({ hand: "left", distance: 0.6, ...hand, pinch: ramp(t, 3, 3.3) * (t > 4 && t < 4.17 ? 0.3 : 1) });
    const out = run(tracker, 2.1, 5, (t) => [synthesize(second(t), CAMERA, noise), cross()]);
    const from = out.findIndex((o) => o.handBar.detached);
    check("a pinch that opens for 5 frames keeps the bar", from > 0 && out.slice(from).every((o) => o.handBar.detached));
  }
  {
    // An open hand below the cross hand moves in from the side, pushes the back string and draws back
    const { tracker, line, unit } = start();
    const y = line.top + 1.5 * unit;
    const second = (t: number): SyntheticHand => ({ hand: "left", distance: 0.6, x: line.x + 0.25 - 0.3 * ramp(t, 3, 4) + 0.3 * ramp(t, 5, 6), y });
    const out = run(tracker, 2.1, 7, (t) => [synthesize(second(t), CAMERA, noise), cross()]);
    const at = (t: number) => out[Math.round((t - 2.1) * FPS)];
    const hook = (t: number) => at(t).hook;
    check("an open hand moving against the back string pushes it", hook(4.5).active && !hook(2.5).active, `push ${f(hook(4.5).push)} m at ${f(hook(4.5).along, 2)} of its length`);
    // In the raw image the hand moves towards smaller x = to the right in the mirrored picture = stage +x
    check("pushed the way the hand moves, further as it goes on", hook(4.5).push > 0.03 && hook(4.5).push > hook(3.6).push);
    check("drawing back lets it go", !hook(6.5).active && hook(6.5).push === 0);
    check("nothing else is taken", out.every((o) => !o.handBar.detached && !o.headBar.held && Math.abs(o.rock.legs) < 0.05));
    // A hand that shows up on top of the string has not caught it
    const { tracker: other, line: l2, unit: u2 } = start();
    const onTop = run(other, 2.1, 4, () => [synthesize({ hand: "left", distance: 0.6, x: l2.x, y: l2.top + 1.5 * u2 }, CAMERA, noise), cross()]);
    check("a hand first seen on the string does not push it", onTop.every((o) => !o.hook.active));
  }
}

console.log("8c fingers as angles, height, pitch correction");
{
  // The same bend of the index finger at different leans of the palm: about the same rock
  const legs = [0.5, 0.8, 1.1, 1.3].map((lean) => {
    const level: SyntheticHand = { ...REST, pitch: lean };
    const tracker = attached(level);
    const out = run(tracker, 2, 4, (t) => [synthesize({ ...level, index: 0.1 * ramp(t, 2, 3) })]);
    const half = run(attached(level), 2, 4, (t) => [synthesize({ ...level, index: 0.05 * ramp(t, 2, 3) })]);
    return [Math.abs(out[out.length - 1].rock.legs), Math.abs(half[half.length - 1].rock.legs)];
  });
  const full = legs.map((l) => l[0]);
  check("the same finger bend rocks the leg bar alike at leans 0.5 … 1.3", Math.min(...full) > 0.2 && Math.max(...full) < 1 && Math.max(...full) / Math.min(...full) < 1.5, full.map((v) => f(v, 2)).join(" "));
  check("half the bend gives clearly less: graded, not a switch", legs.every(([whole, half]) => half > 0.03 && half < 0.6 * whole), legs.map((l) => f(l[1], 2)).join(" "));
  // A left cross hand is the mirror image: the same bend, the same rock the other way
  const leftRight = (["right", "left"] as const).map((hand) => {
    const level: SyntheticHand = { ...REST, hand, pitch: 0.9 };
    const out = run(attached(level), 2, 4, (t) => [synthesize({ ...level, index: 0.1 * ramp(t, 2, 3) })]);
    return out[out.length - 1].rock.legs;
  });
  check("left and right cross hand: the same bend rocks alike, mirrored", Math.abs(leftRight[0]) > 0.25 && Math.abs(leftRight[0] + leftRight[1]) < 0.03, leftRight.map((v) => f(v, 2)).join(" / "));
  // Legs and head together: index down for a step while ring and little finger tilt the head
  const both = run(attached({ ...REST, pitch: 0.9 }), 2, 4, (t) => [synthesize({ ...REST, pitch: 0.9, index: 0.2 * ramp(t, 2, 3), ring: 0.2 * ramp(t, 2, 3), pinky: 0.2 * ramp(t, 2, 3) })]);
  check("leg bar and head bar can be rocked together", Math.abs(both[both.length - 1].rock.legs) > 0.5 && Math.abs(both[both.length - 1].rock.head) > 0.3, `legs ${f(both[both.length - 1].rock.legs, 2)} head ${f(both[both.length - 1].rock.head, 2)}`);

  // Height is relative to where the hand rests: high or low in the picture, the cross is at its rest height
  const rest = new HandTracker().restHeight;
  for (const y of [0.3, 0.7]) {
    const tracker = attached({ ...REST, y });
    const out = run(tracker, 2, 4, (t) => [synthesize({ ...REST, y: y - 0.1 * ramp(t, 2.5, 3) })]);
    check(`hand resting at y ${y}: cross at its rest height, 0.1 up lifts it ${f(0.1 * TUNING.position.yGain, 2)} m`, Math.abs(out[0].bar.y - rest) < 0.005 && Math.abs(out[out.length - 1].bar.y - rest - 0.1 * TUNING.position.yGain) < 0.01, `${f(out[0].bar.y)} → ${f(out[out.length - 1].bar.y)}`);
  }
  // A hand that comes up into the picture and only then pauses must not fling the puppet up
  const rising = new HandTracker();
  const up = run(rising, 0, 6, (t) => [synthesize({ ...REST, y: 0.9 - 0.45 * ramp(t, 0.2, 3) })]);
  const highest = Math.max(...up.map((o) => o.bar.y));
  check("a hand rising 0.45 of the picture before it pauses lifts the cross far less", highest - rest < 0.25 * 0.45 * TUNING.position.yGain && Math.abs(up[up.length - 1].bar.y - rest) < 0.01, `peak +${f(highest - rest)} m of ${f(0.45 * TUNING.position.yGain)}, then ${f(up[up.length - 1].bar.y - rest)}`);

  // The player's pitch correction adds to the cross's pitch and survives a new rest pose
  const trimmed = attached();
  trimmed.pitchTrim = 0.3;
  const before = run(trimmed, 2, 2.5, () => [synthesize(REST)]);
  trimmed.recenter();
  const after = run(trimmed, 2.5, 3.5, () => [synthesize(REST)]);
  trimmed.heightTrim = -0.05;
  const lowered = run(trimmed, 3.5, 4, () => [synthesize(REST)]);
  check("height correction lowers the cross with the hand at rest", Math.abs(lowered[lowered.length - 1].bar.y - rest + 0.05) < 0.005, f(lowered[lowered.length - 1].bar.y - rest));
  check("pitch correction is added, and N does not swallow it", Math.abs(before[before.length - 1].bar.pitch - 0.3) < 0.02 && Math.abs(after[after.length - 1].bar.pitch - 0.3) < 0.02, `${f(before[before.length - 1].bar.pitch)} / ${f(after[after.length - 1].bar.pitch)}`);
}

console.log("9 demo recording end to end");
{
  const recording = demoRecording();
  const tracker = new HandTracker();
  const out = recording.frames.map((frame) => snapshot(tracker.update(frame.t, frame.hands, recording.aspect)));
  const range = (pick: (o: Snapshot) => number) => [Math.min(...out.map(pick)), Math.max(...out.map(pick))];
  const spans: [string, number[], number][] = [
    ["bar x", range((o) => o.bar.x), 0.2], ["bar y", range((o) => o.bar.y), 0.05], ["bar z", range((o) => o.bar.z), 0.12],
    // The hand is held level (leaning 0.8 rad from flat to the camera): turning it in the picture is part roll, part yaw of the cross
    ["roll + yaw", range((o) => o.bar.roll + o.bar.yaw), 0.6], ["pitch", range((o) => o.bar.pitch), 0.6], ["legs", range((o) => o.rock.legs), 1.5], ["head", range((o) => o.rock.head), 1.5],
  ];
  for (const [name, [min, max], span] of spans) check(`${name} moves`, max - min > span, `${f(min, 2)} … ${f(max, 2)}`);
  check("grip closes and opens", out.some((o) => o.grip) && !out[out.length - 1].grip);
  const detached = out.filter((o) => o.handBar.detached).length / FPS;
  check("hand bar is taken and returns", detached > 3 && !out[out.length - 1].handBar.detached, `${f(detached, 1)} s detached`);
  const headHeld = out.filter((o) => o.headBar.held);
  check("head bar is taken, turned and let go", headHeld.length / FPS > 2 && Math.max(...headHeld.map((o) => Math.abs(o.rock.head))) > 0.4 && !out[out.length - 1].headBar.held, `${f(headHeld.length / FPS, 1)} s held`);
  const pushed = out.filter((o) => o.hook.active);
  check("back string is pushed and let go", pushed.length / FPS > 1 && Math.max(...pushed.map((o) => Math.abs(o.hook.push))) > 0.03 && !out[out.length - 1].hook.active, `${f(pushed.length / FPS, 1)} s, up to ${f(Math.max(0, ...pushed.map((o) => Math.abs(o.hook.push))))} m`);
  check("frames have 21 landmarks each", recording.frames.every((frame) => frame.hands.every((h) => h.image.length === 21 && h.world.length === 21)));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
if (failures) throw new Error(`${failures} hand-tracking check(s) failed`);
