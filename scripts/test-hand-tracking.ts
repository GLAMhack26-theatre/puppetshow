// Checks the hand-tracking pipeline (src/input/hand-tracking.ts) on synthetic
// hands (src/input/hand-synthetic.ts). No camera, no browser:
//     node scripts/test-hand-tracking.ts
// Node 24 runs TypeScript directly. It proves the maths and the state machine,
// not MediaPipe's accuracy on a real hand.
import {
  HandTracker, MAPPING, TUNING, hysteresis, palmInImage, palmPose, tiltBetween, toDisplay,
  type HandFrame, type TrackerOutput,
} from "../src/input/hand-tracking.ts";
import { CAMERA, DEMO_LEAD, demoRecording, gaussian, synthesize, type SyntheticHand } from "../src/input/hand-synthetic.ts";

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
const snapshot = (out: TrackerOutput) => structuredClone({ status: out.status, calibrated: out.calibrated, player: out.player, bar: out.bar, rock: out.rock, turn: out.turn, grasp: out.grasp, handBar: out.handBar, headBar: out.headBar, legBar: out.legBar, hook: out.hook });
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
  // The reset button (N) takes the pose without a pause, also while the hand moves
  const moving = new HandTracker();
  run(moving, 0, 2, (t) => [synthesize({ ...REST, pitch: 0.5, x: 0.4 + 0.1 * Math.sin(3 * t) }, CAMERA, noise)]);
  moving.reset();
  const after = run(moving, 2, 3.5, (t) => [synthesize({ ...REST, pitch: 0.5, x: 0.4 + 0.1 * Math.sin(3 * t) }, CAMERA, noise)]);
  const resetSteps = after.slice(1).map((o, i) => Math.abs(o.bar.pitch - after[i].bar.pitch));
  check("reset takes the current pose without waiting for a pause, and the cross goes level without a jump", after[after.length - 1].calibrated && Math.abs(after[after.length - 1].bar.pitch) < 0.06 && Math.max(...resetSteps) < 0.06, `pitch ${f(after[0].bar.pitch)} → ${f(after[after.length - 1].bar.pitch)}, largest step ${f(Math.max(...resetSteps))}`);
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

console.log("3 depth: closer is the front of the stage, and stays it");
{
  const tracker = attached();
  // The player steps towards the camera: the puppet comes to the front of the stage (+z)
  const expected = TUNING.depth.gain * (Math.log(0.6 / 0.48) - TUNING.depth.dead);
  const out = run(tracker, 2, 40, (t) => [synthesize({ ...REST, distance: 0.6 - 0.12 * ramp(t, 3, 3.3) })]);
  const at = (t: number) => out[Math.round((t - 2) * FPS)].bar.z;
  check("12 cm closer in 0.3 s: ≥ 80 % of the move 0.2 s later, to the front", at(3.5) > 0.8 * expected, `z ${f(at(3.5))} of ${f(expected)} m`);
  check("held there: the puppet stays at the front", Math.abs(at(8) - expected) < 0.02 && Math.abs(at(39) - expected) < 0.02, `z after 5 s ${f(at(8))}, after 36 s ${f(at(39))}`);
  // The reset button makes where the hand is now the middle of the stage's depth
  tracker.reset();
  const centred = run(tracker, 40, 42, () => [synthesize({ ...REST, distance: 0.48 })]);
  const steps = centred.slice(1).map((o, i) => Math.abs(o.bar.z - centred[i].bar.z));
  check("reset: back to the middle of the depth, without a jump", Math.abs(centred[centred.length - 1].bar.z) < 0.01 && Math.max(...steps) < 0.02, `z ${f(centred[centred.length - 1].bar.z)}, largest step ${f(Math.max(...steps))} m`);
  const back = run(tracker, 42, 44, (t) => [synthesize({ ...REST, distance: 0.48 + 0.2 * ramp(t, 42, 43) })]);
  check("stepping back sends the puppet upstage", back[back.length - 1].bar.z < -0.1, f(back[back.length - 1].bar.z));
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
    ...REST, x: 0.4 - 0.1 * ramp(t, 2, 3), y: 0.5 - 0.2 * ramp(t, 2, 3), distance: 0.6 - 0.1 * ramp(t, 3, 3.3),
    roll: 0.3 * ramp(t, 2, 3), yaw: 0.3 * ramp(t, 2, 3), pitch: 0.3 * ramp(t, 2, 3), index: 0.7 * ramp(t, 3.3, 3.6),
  });
  const results = [false, true].map((mirror) => {
    const tracker = new HandTracker();
    tracker.mirror = mirror;
    const out = run(tracker, 0, 3.9, (t) => [synthesize(script(t))]);
    return { legs: out[Math.round(3.6 * FPS) - 1].rock.legs, last: out[out.length - 1] };
  });
  // The two modes (the player in front of the screen, or on the far side of the
  // stage): everything sideways flips; up, turning about the vertical and depth
  // stay (closer to the camera is the front of the stage for both). Pitch stays
  // too: tipping the hand forward bows the puppet in both (TUNING.tipForwardBows)
  const [face, selfie] = results;
  const flips: [string, number, number][] = [
    ["x", face.last.bar.x, selfie.last.bar.x], ["roll", face.last.bar.roll, selfie.last.bar.roll], ["legs", face.legs, selfie.legs],
  ];
  for (const [name, a, b] of flips) check(`${name} flips`, Math.abs(a) > 0.1 && Math.abs(a + b) < 0.03, `${f(a)} / ${f(b)}`);
  const same: [string, number, number][] = [
    ["y", face.last.bar.y, selfie.last.bar.y], ["z", face.last.bar.z, selfie.last.bar.z], ["yaw", face.last.bar.yaw, selfie.last.bar.yaw], ["pitch", face.last.bar.pitch, selfie.last.bar.pitch],
  ];
  const restHeight = new HandTracker().restHeight;
  // (y: the hand ends 8 cm above where its height was taken, which is 5 cm of cross beyond the standing band)
  for (const [name, a, b] of same) check(`${name} stays`, Math.abs(a - b) < 0.03 && Math.abs(a - (name === "y" ? restHeight : 0)) > (name === "y" ? 0.04 : 0.05), `${f(a)} / ${f(b)}`);
  // In front of the screen (mirror, the default): the hand moves to the image's left = the player's own right
  // = screen right (stage +x); it comes closer to the camera = the front of the stage (+z)
  check("mirror: the player's right is stage +x, closer to the camera is the front of the stage", selfie.last.bar.x > 0.1 && selfie.last.bar.z > 0.05, `x ${f(selfie.last.bar.x)} z ${f(selfie.last.bar.z)}`);
  check("mirror is the default", new HandTracker().mirror);
  check("far side of the stage: image left = stage −x, closer = the front as well", face.last.bar.x < -0.1 && face.last.bar.z > 0.05);
  const frame = synthesize(REST);
  check("toDisplay(mirror) reflects image and world x", toDisplay(frame, true).image[0].x === 1 - frame.image[0].x && toDisplay(frame, true).world[5].x === -frame.world[5].x);
}

console.log("7 fingers do not cross-trigger");
{
  const still = (o: Snapshot) => Math.abs(o.rock.legs) < 0.05 && Math.abs(o.rock.head) < 0.05;
  const straight = (o: Snapshot) => Math.abs(o.turn) < 0.08;
  const cases: [string, Partial<SyntheticHand>, (o: Snapshot) => boolean][] = [
    ["index alone → legs only", { index: 0.5 }, (o) => Math.abs(o.rock.legs) > 0.6 && straight(o) && !o.grasp.on],
    ["middle alone → legs the other way", { middle: 0.8 }, (o) => Math.abs(o.rock.legs) > 0.6 && straight(o) && !o.grasp.on],
    ["middle with the little finger going along by a third → still no turn", { middle: 0.8, ring: 0.5, pinky: 0.27 }, (o) => Math.abs(o.rock.legs) > 0.6 && straight(o) && !o.grasp.on],
    ["ring + pinky → the head turns, no step", { ring: 0.8, pinky: 0.8 }, (o) => still(o) && Math.abs(o.turn) > 0.8 && !o.grasp.on],
    ["little finger half bent → the head turns part of the way", { ring: 0.12, pinky: 0.14 }, (o) => still(o) && Math.abs(o.turn) > 0.15 && Math.abs(o.turn) < 0.8],
    ["thumb tucked → the head turns, no step", { thumb: 0.9 }, (o) => still(o) && Math.abs(o.turn) > 0.8 && !o.grasp.on],
    // The cross hand's fist is no grasp (that is the second hand's): the bars rest, nothing else
    ["fist → the bars rest, no grasp", { index: 1, middle: 1, ring: 1, pinky: 1, thumb: 0.6 }, (o) => still(o) && !o.grasp.on && o.grasp.releases === 0],
    ["fist with the thumb on the index → the bars rest, no grasp", { index: 1, middle: 1, ring: 1, pinky: 1, pinch: 1 }, (o) => still(o) && !o.grasp.on && o.grasp.releases === 0],
    ["all four fingers half closed together → nothing", { index: 0.35, middle: 0.35, ring: 0.35, pinky: 0.35 }, (o) => !o.grasp.on && Math.abs(o.rock.legs) < 0.1],
    ["moving and tilting the hand → no finger function", { x: 0.6, y: 0.35, distance: 0.5, roll: 0.5, pitch: 0.4, yaw: 0.4 }, (o) => !o.grasp.on && still(o)],
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
    const transient = Math.max(...out.map((o) => Math.abs(o.rock.legs)));
    signs.push(Math.sign(last.rock.legs));
    check(name, expect(last), `legs ${f(last.rock.legs, 2)} turn ${f(last.turn, 2)} grasp ${last.grasp.on}; largest leg rock on the way ${f(transient, 2)}`);
  }
  check("index and middle finger pull opposite ways", signs[0] === -signs[1] && signs[0] !== 0);
  {
    // The head turns to the side of the pressed finger, as the player sees it (+ = the puppet's left = right in the picture),
    // for either hand and with the picture mirrored or not
    const rows: string[] = [];
    let ok = true;
    for (const hand of ["right", "left"] as const) for (const mirror of [true, false]) {
      const rest: SyntheticHand = { ...REST, hand };
      const shown = toDisplay(synthesize(rest), mirror).image;
      const thumbSide = Math.sign(shown[4].x - shown[17].x); // thumb tip against the little finger's knuckle, in the picture
      const turns = ([{ thumb: 0.9 }, { ring: 0.8, pinky: 0.8 }] as Partial<SyntheticHand>[]).map((pose) => {
        const tracker = new HandTracker();
        tracker.mirror = mirror;
        run(tracker, 0, 2, () => [synthesize(rest)]);
        const out = run(tracker, 2, 4, (t) => [synthesize({ ...rest, ...Object.fromEntries(Object.entries(pose).map(([k, v]) => [k, (v as number) * ramp(t, 2, 3)])) })]);
        return out[out.length - 1].turn;
      });
      ok &&= Math.sign(turns[0]) === thumbSide && Math.sign(turns[1]) === -thumbSide && Math.abs(turns[0]) > 0.8 && Math.abs(turns[1]) > 0.8;
      rows.push(`${hand} hand, mirror ${mirror ? "on" : "off"}: thumb on the ${thumbSide > 0 ? "right" : "left"}, thumb → ${f(turns[0], 1)}, little finger → ${f(turns[1], 1)}`);
    }
    check("thumb and little finger turn the head to their own side of the picture", ok, rows.join("; "));
  }
  check("mapping table: fingers rock the leg bar only", MAPPING.rock.legs !== null && MAPPING.rock.head === null && MAPPING.rock.hands === null);
  // The pinch that brought the head forward is gone (replaced by the turn): a pinch is a step of the index with the thumb pressed
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
    // Hand moved 0.1 of the width (right in the camera image = left for the player) and 0.1 of the height up, then rolled 0.5 rad in the image (the bar rocks by rockGain times that)
    check("the free bar follows the second hand", Math.abs(moved.x + 0.1 * CAMERA.aspect * TUNING.handBar.gain) < 0.01 && Math.abs(moved.y - 0.1 * TUNING.handBar.gain) < 0.01 && Math.abs(Math.abs(moved.roll) - 0.5 * TUNING.handBar.rockGain) < 0.08, `x ${f(moved.x)} y ${f(moved.y)} z ${f(moved.z)} roll ${f(moved.roll)}`);
    check("the cross hand is not disturbed by the second", out.every((o) => o.status === "attached" && Math.abs(o.rock.legs) < 0.05 && !o.grasp.on), `largest leg rock ${f(Math.max(...out.map((o) => Math.abs(o.rock.legs))))}`);
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
    const steps = out.slice(1).map((o, i) => Math.abs(o.turn - out[i].turn));
    check("pinch at the head bar's handle takes the head bar, not the hand bar", at(3.8).headBar.held && out.every((o) => !o.handBar.detached));
    check("turning the hand turns the head", Math.abs(at(5.5).turn) > 0.35 && Math.abs(at(3.8).turn) < 0.1 && out.every((o) => o.rock.head === 0), `${f(at(5.5).turn, 2)} of the head's turn for 0.5 rad`);
    check("let go: level again without a jump", !at(7.9).headBar.held && Math.abs(at(7.9).turn) < 0.05 && Math.max(...steps) < 0.12, `largest step ${f(Math.max(...steps), 2)} per frame; head ${f(at(7.9).turn, 2)} afterwards`);
    // The head bar is the second hand's alone: the cross hand's fingers do not rock it
    const fingersOnly = run(tracker, 8, 9.5, (t) => [cross({ ring: 0.3 * ramp(t, 8, 8.5), pinky: 0.3 * ramp(t, 8, 8.5) })]);
    check("let go, the cross hand's little finger has the head again", Math.abs(fingersOnly[fingersOnly.length - 1].turn) > 0.3 && fingersOnly.every((o) => o.rock.head === 0), f(fingersOnly[fingersOnly.length - 1].turn, 2));
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
    // A fist that holds the hand bar turns edge-on (unreadable as a fist) on its way
    // over to the head bar's handle and arrives there closed: it keeps the hand bar
    const { tracker, hand, head } = start();
    const fist = { index: 1, middle: 1, ring: 1, pinky: 1, thumb: 0.6 };
    const closing = (t: number) => Object.fromEntries(Object.entries(fist).map(([k, v]) => [k, v * ramp(t, 3, 3.3) * (1 - ramp(t, 8, 8.3))]));
    const move = (t: number) => ramp(t, 4.5, 5.5);
    const second = (t: number): SyntheticHand => ({
      hand: "left", distance: 0.6, x: hand.x + (head.x - hand.x) * move(t), y: hand.y + (head.y - hand.y) * move(t),
      pitch: 1.35 * (ramp(t, 4, 4.4) - ramp(t, 5.6, 6)), ...closing(t),
    });
    const out = run(tracker, 2.1, 9.5, (t) => [synthesize(second(t), CAMERA, noise), cross()]);
    const at = (t: number) => out[Math.round((t - 2.1) * FPS)];
    const from = out.findIndex((o) => o.handBar.detached);
    const until = Math.round((8 - 2.1) * FPS);
    check("a fist moved edge-on into the other handle's circle keeps its bar", from > 0 && out.slice(from, until).every((o) => o.handBar.detached && !o.headBar.held), `taken at ${f(2.1 + from / FPS, 1)} s; at 7 s: hand bar ${at(7).handBar.detached}, head bar ${at(7).headBar.held}`);
    check("opening the hand lets the bar go, and nothing else is taken", !at(9.4).handBar.detached && !at(9.4).headBar.held);
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

console.log("5b players");
{
  // A hand that is gone for 2 s is the same player; after 6 s without a hand the next one is a new player
  const tracker = new HandTracker();
  const hand = () => [synthesize(REST)];
  const players = [run(tracker, 0, 2, hand), run(tracker, 2, 4, () => []), run(tracker, 4, 6, hand), run(tracker, 6, 12, () => []), run(tracker, 12, 14, hand)].map((out) => out[out.length - 1]);
  check("the first hand is player 1; back after 2 s: the same; back after 6 s: the next", players[0].player === 1 && players[2].player === 1 && players[2].status === "attached" && players[4].player === 2, players.map((o) => o.player).join(" "));
}

console.log("8d second hand: leg bar, a hand lost for a moment, turning the fist");
{
  const noise = gaussian(10);
  const FIST = { index: 1, middle: 1, ring: 1, pinky: 1, thumb: 0.6 };
  const fist = (amount: number) => Object.fromEntries(Object.entries(FIST).map(([k, v]) => [k, v * amount]));
  /** A tracker with the cross hand at rest, and where a pinching second hand has to be (raw camera image) to have its fingers at each handle */
  const start = (lean: number) => {
    const CROSS: SyntheticHand = { ...REST, x: 0.3, pitch: lean };
    const cross = (extra: Partial<SyntheticHand> = {}) => synthesize({ ...CROSS, ...extra }, CAMERA, noise);
    const tracker = attached(CROSS, noise);
    const out = tracker.update(2000, [cross()], CAMERA.aspect);
    const fingersOf = (shape: Partial<SyntheticHand>) => {
      const image = synthesize({ hand: "left", x: 0, y: 0, distance: 0.6, ...shape }).image;
      return { x: (image[4].x + image[8].x) / 2, y: (image[4].y + image[8].y) / 2 };
    };
    /** Where a hand of this shape is placed so that its thumb and index tips are at the handle */
    const at = (handle: { x: number; y: number }, shape: Partial<SyntheticHand> = { pinch: 1 }) => ({ x: 1 - handle.x / CAMERA.aspect - fingersOf(shape).x, y: handle.y - fingersOf(shape).y });
    const handles = { hand: { ...out.handBar.magnet }, head: { ...out.headBar.handle }, legs: { ...out.legBar.handle } };
    return { tracker, cross, at, handles, radius: out.handles.radius };
  };
  const held = (o: Snapshot) => (o.handBar.detached ? "hand" : o.headBar.held ? "head" : o.legBar.held ? "legs" : "none");

  // Three handles: each can be told from the other two, at any lean of the cross hand
  for (const lean of [0.3, 0.9, 1.3]) {
    const { handles } = start(lean);
    const apart = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const least = Math.min(apart(handles.hand, handles.head), apart(handles.hand, handles.legs), apart(handles.head, handles.legs));
    const taken = (["hand", "head", "legs"] as const).map((name) => {
      const { tracker, cross, at, handles: h } = start(lean);
      const out = run(tracker, 2.1, 4, (t) => [synthesize({ hand: "left", distance: 0.6, ...at(h[name]), pinch: ramp(t, 3, 3.3) }, CAMERA, noise), cross()]);
      return held(out[out.length - 1]);
    });
    check(`cross hand leaning ${lean} rad: a pinch at each of the three handles takes that bar`, taken.join() === "hand,head,legs" && least > 0.1, `${taken.join(", ")}; nearest two handles ${f(least)} image heights apart`);
  }
  {
    // The leg bar in the second hand: turning the hand rocks it, the cross hand's fingers do not count meanwhile
    const { tracker, cross, at, handles } = start(0.9);
    const second = (t: number): SyntheticHand => ({ hand: "left", distance: 0.6, ...at(handles.legs), spin: 0.5 * ramp(t, 4, 5), pinch: ramp(t, 3, 3.3) - ramp(t, 7, 7.3) });
    const out = run(tracker, 2.1, 9, (t) => [synthesize(second(t), CAMERA, noise), cross({ index: t > 5.5 && t < 6.5 ? 0.15 : 0 })]);
    const point = (t: number) => out[Math.round((t - 2.1) * FPS)];
    const expected = 0.5 / tracker.legLimit;
    check("pinch at the leg bar's handle takes the leg bar; turning the hand rocks it", point(3.8).legBar.held && Math.abs(point(3.8).rock.legs) < 0.08 && Math.abs(Math.abs(point(5.4).rock.legs) - expected) < 0.12, `${f(point(5.4).rock.legs, 2)} of its range for 0.5 rad (expected ${f(expected, 2)})`);
    check("while it is held, a step of the cross hand's index does not move it", Math.abs(point(6.3).rock.legs - point(5.4).rock.legs) < 0.08, `${f(point(5.4).rock.legs, 2)} → ${f(point(6.3).rock.legs, 2)}`);
    const steps = out.slice(1).map((o, i) => Math.abs(o.rock.legs - out[i].rock.legs));
    check("let go: the leg bar goes back to the fingers without a jump", !point(8.9).legBar.held && Math.abs(point(8.9).rock.legs) < 0.08 && Math.max(...steps) < 0.15, `largest step ${f(Math.max(...steps), 2)} per frame; ${f(point(8.9).rock.legs, 2)} afterwards`);
  }
  {
    // The hand that holds the hand bar jumps further than a hand can move between two frames
    // (the tracker takes it for a new hand): the bar stays in it and goes on from where it was
    const { tracker, cross, at, handles } = start(0.9);
    const base = at(handles.hand);
    const second = (t: number): SyntheticHand => ({
      hand: "left", distance: 0.6, x: base.x + (t >= 4.5 ? 0.28 : 0) + 0.05 * ramp(t, 5.5, 6.5), y: base.y - (t >= 4.5 ? 0.3 : 0), pinch: ramp(t, 3, 3.3),
    });
    const out = run(tracker, 2.1, 7, (t) => [synthesize(second(t), CAMERA, noise), cross()]);
    const point = (t: number) => out[Math.round((t - 2.1) * FPS)];
    const from = out.findIndex((o) => o.handBar.detached);
    const steps = out.slice(from + 1).map((o, i) => Math.hypot(o.handBar.x - out[from + i].handBar.x, o.handBar.y - out[from + i].handBar.y));
    check("a held bar survives a jump of its hand", from > 0 && out.slice(from).every((o) => o.handBar.detached && !o.headBar.held && !o.legBar.held));
    check("… the bar does not jump with it, and follows the hand again afterwards", Math.max(...steps) < 0.01 && Math.abs(point(6.9).handBar.x - point(5.4).handBar.x + 0.05 * CAMERA.aspect * TUNING.handBar.gain) < 0.01, `largest step ${f(Math.max(...steps) * 1000, 1)} mm; moved ${f(point(6.9).handBar.x - point(5.4).handBar.x)} m after the jump`);
    // The same jump, but the hand comes back open: the bar is let go
    const { tracker: other, cross: c2, at: at2, handles: h2 } = start(0.9);
    const b2 = at2(h2.hand);
    const opened = run(other, 2.1, 7, (t) => [synthesize({ hand: "left", distance: 0.6, x: b2.x + (t >= 4.5 ? 0.28 : 0), y: b2.y - (t >= 4.5 ? 0.3 : 0), pinch: t >= 4.5 ? 0 : ramp(t, 3, 3.3) }, CAMERA, noise), c2()]);
    const letGoAt = opened.findIndex((o, i) => i > Math.round((4.5 - 2.1) * FPS) && !o.handBar.detached);
    check("a hand that comes back open lets the bar go, after the time an open hand needs", letGoAt > 0 && 2.1 + letGoAt / FPS - 4.5 > 0.4 && 2.1 + letGoAt / FPS - 4.5 < 1.2, `${f(2.1 + letGoAt / FPS - 4.5, 2)} s after the jump`);
  }
  {
    // How long an open hand keeps the bar: 0.4 s open does not drop it, 0.7 s does
    const drops = [0.4, 0.7].map((open) => {
      const { tracker, cross, at, handles } = start(0.9);
      const out = run(tracker, 2.1, 6, (t) => [synthesize({ hand: "left", distance: 0.6, ...at(handles.hand), pinch: t >= 4 && t < 4 + open ? 0 : ramp(t, 3, 3.3) }, CAMERA, noise), cross()]);
      const from = out.findIndex((o) => o.handBar.detached);
      return from > 0 && out.slice(from).some((o) => !o.handBar.detached);
    });
    check(`a hand seen open for 0.4 s keeps the bar, for 0.7 s lets it go (${TUNING.handBar.release} s)`, !drops[0] && drops[1], `dropped: ${drops.join(", ")}`);
  }
  {
    // Turning the fist rocks the held hand bar: in the picture (spin), and from the forearm (twist) with the
    // hand pointing up, which is no turn in the picture. Both the same way, at any lean of the fist.
    const rows: string[] = [];
    let ok = true;
    for (const lean of [0, 0.5, 0.9, 1.2]) {
      const rolls = ([["spin", 0.6], ["twist", 0.6], ["twist", -0.6], ["spin", 0]] as const).map(([kind, amount]) => {
        const { tracker, cross, at, handles } = start(0.9);
        const shape = { ...fist(1), pitch: lean };
        const out = run(tracker, 2.1, 8, (t) => [synthesize({ hand: "left", distance: 0.6, ...at(handles.hand, shape), pitch: lean, ...fist(ramp(t, 3, 3.3)), [kind]: amount * ramp(t, 5, 6) }, CAMERA, noise), cross()]);
        const last = out.slice(-30);
        return last.every((o) => o.handBar.detached) ? last.reduce((sum, o) => sum + o.handBar.roll, 0) / last.length : NaN;
      });
      const [spun, twisted, back, still] = rolls;
      const full = 0.6 * TUNING.handBar.rockGain;
      ok &&= Math.abs(spun - full) < 0.1 && twisted > 0.85 * full && back < -0.85 * full && Math.abs(still) < 0.06;
      rows.push(`lean ${lean}: ${rolls.map((r) => f(r, 2)).join(" / ")}`);
    }
    check("a fist turned 0.6 rad in the picture or from the forearm rocks the hand bar, the same way; held still it does not", ok, rows.join("; "));
  }
}

console.log("8e puppet grasp: the second hand's fist away from the handles");
{
  const FIST = { index: 1, middle: 1, ring: 1, pinky: 1, thumb: 0.6 };
  const fist = (amount: number) => Object.fromEntries(Object.entries(FIST).map(([k, v]) => [k, v * amount]));
  /** 0 → 1 → 0: closes at `from`, opens at `to`, each within `edge` s */
  const closure = (t: number, from: number, to = Infinity, edge = 0.1) => ramp(t, from, from + edge) - (to < Infinity ? ramp(t, to, to + edge) : 0);
  const CROSS: SyntheticHand = { ...REST, x: 0.3, pitch: 0.9 };
  /** Where the second hand is when it is "away from the handles" (raw camera image) */
  const AWAY = { x: 0.88, y: 0.22 };
  /** A tracker with the cross hand at rest. scale: of the landmark noise (1: 1.9 px in a 640 × 480 picture) */
  const start = (seed: number, scale = 1) => {
    const random = gaussian(seed);
    const noise = () => scale * random();
    const cross = (extra: Partial<SyntheticHand> = {}) => synthesize({ ...CROSS, ...extra }, CAMERA, noise);
    const tracker = attached(CROSS, noise);
    const out = tracker.update(2000, [cross()], CAMERA.aspect);
    /** Thumb–index midpoint of a hand of this shape placed at 0, 0 (raw image) */
    const fingersOf = (shape: Partial<SyntheticHand>) => {
      const image = synthesize({ hand: "left", x: 0, y: 0, distance: 0.6, ...shape }).image;
      return { x: (image[4].x + image[8].x) / 2, y: (image[4].y + image[8].y) / 2 };
    };
    /** Where a hand of this shape is placed so that its thumb and index tips are at a point of the mirrored picture (x in image heights) */
    const at = (point: { x: number; y: number }, shape: Partial<SyntheticHand> = { pinch: 1 }) => ({ x: 1 - point.x / CAMERA.aspect - fingersOf(shape).x, y: point.y - fingersOf(shape).y });
    /** And the other way round: where those fingers are in the mirrored picture for a hand placed at `place` */
    const fingersAt = (place: { x: number; y: number }, shape: Partial<SyntheticHand>) => ({ x: (1 - place.x - fingersOf(shape).x) * CAMERA.aspect, y: place.y + fingersOf(shape).y });
    const handles = { hand: { ...out.handBar.magnet }, head: { ...out.headBar.handle }, legs: { ...out.legBar.handle } };
    const second = (shape: Partial<SyntheticHand>) => synthesize({ hand: "left", distance: 0.6, ...AWAY, ...shape }, CAMERA, noise);
    const line = { ...out.hook.line, x: 1 - out.hook.line.x / CAMERA.aspect };
    return { tracker, cross, at, fingersAt, handles, radius: out.handles.radius, second, line, unit: out.gizmo.unit, noise };
  };
  const quiet = (out: Snapshot[]) => out.every((o) => !o.grasp.on && o.grasp.phase === "idle") && out[out.length - 1].grasp.releases === 0;
  const noBar = (out: Snapshot[]) => out.every((o) => !o.handBar.detached && !o.headBar.held && !o.legBar.held && !o.hook.active);
  const firstOn = (out: Snapshot[], from: number) => from + out.findIndex((o) => o.grasp.on) / FPS;
  const last = (out: Snapshot[]) => out[out.length - 1];
  {
    const { fingersAt, handles, radius } = start(12);
    const apart = (shape: Partial<SyntheticHand>) => Math.min(...Object.values(handles).map((h) => Math.hypot(fingersAt(AWAY, shape).x - h.x, fingersAt(AWAY, shape).y - h.y)));
    check("the spot used here is away from the handles, as a fist and as an open hand", Math.min(apart(fist(1)), apart({})) > 1.2 * TUNING.grasp.guard * radius, `${f(Math.min(apart(fist(1)), apart({})) / radius, 1)} ring radii from the nearest (the guard zone ends at ${TUNING.grasp.guard})`);
  }
  {
    // Nothing held: the fist is the magnet, for as long as it is closed
    const { tracker, cross, second } = start(12);
    const out = run(tracker, 2.1, 7.5, (t) => [second(fist(closure(t, 3, 6.2))), cross()]);
    const at = (t: number) => out[Math.round((t - 2.1) * FPS)];
    const on = firstOn(out, 2.1);
    const held = out.slice(Math.round((on - 2.1) * FPS), Math.round((6.2 - 2.1) * FPS));
    check("a fist away from the handles: the magnet is on within 0.2 s of the closed hand", on > 3 && on - 3.1 <= 0.2 + 1e-6, `on ${f(on - 3, 2)} s after the hand began to close (closed after 0.1 s)`);
    check("… stays on for the 3 s the fist is held, and nothing else is taken", held.length > 85 && held.every((o) => o.grasp.on) && noBar(out) && out.every((o) => o.status === "attached" && Math.abs(o.rock.legs) < 0.05));
    check("… and goes off when the hand opens, without a release", !at(6.7).grasp.on && at(6.2).grasp.on && last(out).grasp.releases === 0 && last(out).grasp.phase === "idle", `off ${f(2.1 + out.findIndex((o, i) => i > 100 && !o.grasp.on) / FPS - 6.2, 2)} s after the hand began to open`);
  }
  {
    // Something held: a quick fist/open lets go of it, a fist that stays is the magnet again
    const quick = start(13);
    quick.tracker.puppetHolds = true;
    const out = run(quick.tracker, 2.1, 5, (t) => [quick.second(fist(closure(t, 3, 3.3))), quick.cross()]);
    const released = 2.1 + out.findIndex((o) => o.grasp.releases > 0) / FPS;
    check("holding: a 0.3 s fist/open gives exactly one release, and the magnet is never on", last(out).grasp.releases === 1 && out.every((o) => !o.grasp.on) && out.some((o) => o.grasp.phase === "click" && o.grasp.window > 0.3), `released ${f(released - 3.3, 2)} s after the hand began to open`);
    const long = start(13);
    long.tracker.puppetHolds = true;
    const kept = run(long.tracker, 2.1, 6, (t) => [long.second(fist(closure(t, 3, 4.5))), long.cross()]);
    const on = firstOn(kept, 2.1);
    check(`holding: a 1.5 s fist is the magnet from ${TUNING.grasp.click} s on, and no release`, on - 3 > TUNING.grasp.click - 0.02 && on - 3 < TUNING.grasp.click + 0.2 && last(kept).grasp.releases === 0 && !last(kept).grasp.on, `on ${f(on - 3, 2)} s after the hand began to close`);
  }
  {
    // The fist closes on nothing held, the puppet catches something meanwhile, the hand opens quickly: that is no release
    const { tracker, cross, second } = start(14);
    const out = run(tracker, 2.1, 5, (t) => {
      tracker.puppetHolds = t >= 3.25;
      return [second(fist(closure(t, 3, 3.4))), cross()];
    });
    check("close, catch, quick open: no release", out.some((o) => o.grasp.on) && last(out).grasp.releases === 0 && !last(out).grasp.on);
  }
  {
    // In a ring the closing hand takes the bar, and that is all, whether the puppet holds something or not
    const rows: string[] = [];
    let ok = true;
    for (const holds of [false, true]) for (const [name, shape] of [["fist", fist(1)], ["pinch", { pinch: 1 }]] as const) {
      const { tracker, cross, at, handles, noise } = start(15);
      tracker.puppetHolds = holds;
      const place = at(handles.hand, shape);
      const closing = (t: number) => Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, (v as number) * closure(t, 3, 5)]));
      const out = run(tracker, 2.1, 7, (t) => [synthesize({ hand: "left", distance: 0.6, ...place, ...closing(t) }, CAMERA, noise), cross()]);
      const taken = out.some((o) => o.handBar.detached) && !last(out).handBar.detached;
      ok &&= taken && quiet(out);
      rows.push(`${name}${holds ? ", holding" : ""}: bar ${taken}, grasp ${!quiet(out)}`);
    }
    check("a fist or a pinch in a ring takes the bar and nothing else", ok, rows.join("; "));
  }
  {
    const { tracker, cross, second } = start(16);
    tracker.puppetHolds = true;
    const out = run(tracker, 2.1, 6, (t) => [second({ pinch: closure(t, 3, 3.3) + closure(t, 4, 5.5) }), cross()]);
    check("a pinch away from the handles does nothing, quick or held", quiet(out) && noBar(out));
  }
  {
    // A fist made next to a ring, but outside it: meant for the bar and missed
    const { tracker, cross, at, fingersAt, handles, radius, noise } = start(17);
    tracker.puppetHolds = true;
    const centre = { x: (handles.hand.x + handles.head.x + handles.legs.x) / 3, y: (handles.hand.y + handles.head.y + handles.legs.y) / 3 };
    // From the hand bar's handle straight away from the other two
    const away = Math.hypot(handles.hand.x - centre.x, handles.hand.y - centre.y);
    const spot = { x: handles.hand.x + ((handles.hand.x - centre.x) / away) * 1.3 * radius, y: handles.hand.y + ((handles.hand.y - centre.y) / away) * 1.3 * radius };
    const place = at(spot, fist(1));
    const nearest = Math.min(...Object.values(handles).map((h) => Math.hypot(fingersAt(place, fist(1)).x - h.x, fingersAt(place, fist(1)).y - h.y)));
    const out = run(tracker, 2.1, 6, (t) => [synthesize({ hand: "left", distance: 0.6, ...place, ...fist(closure(t, 3, 3.3) + closure(t, 4, 5.5)) }, CAMERA, noise), cross()]);
    check("a fist in the guard zone around a ring is neither a bar nor a grab", nearest > 1.1 * radius && nearest < TUNING.grasp.guard * radius && quiet(out) && noBar(out), `${f(nearest / radius, 2)} ring radii from the nearest handle`);
  }
  {
    // An open hand on its way to a ring, with single frames in which it is a fist, and 1.5 px of noise
    const { tracker, cross, at, handles, noise } = start(18, 0.78);
    tracker.puppetHolds = true;
    const to = at(handles.hand, {});
    let frame = 0;
    const out = run(tracker, 2.1, 9, (t) => {
      const k = ramp(t, 3, 6) - ramp(t, 6.5, 8.5);
      const glitch = ++frame % 14 === 0; // every 0.47 s
      return [synthesize({ hand: "left", distance: 0.6, x: AWAY.x + (to.x - AWAY.x) * k, y: AWAY.y + (to.y - AWAY.y) * k, ...(glitch ? fist(1) : {}) }, CAMERA, noise), cross()];
    });
    // (No claim about the bar: a single frame read as a fist inside a ring takes it, as before the grasp came in)
    check("an open hand travelling to a ring and back, single frames read as a fist: no magnet, no release", quiet(out) && out.every((o) => !o.hook.active), `the hand bar was taken on the way: ${out.some((o) => o.handBar.detached)}`);
    // The same hand pushing the back string
    const push = start(19, 0.78);
    push.tracker.puppetHolds = true;
    const y = push.line.top + 1.5 * push.unit;
    frame = 0;
    const pushed = run(push.tracker, 2.1, 7, (t) => {
      const glitch = ++frame % 14 === 0;
      return [synthesize({ hand: "left", distance: 0.6, x: push.line.x + 0.25 - 0.3 * ramp(t, 3, 4) + 0.3 * ramp(t, 5, 6), y, ...(glitch ? fist(1) : {}) }, CAMERA, push.noise), push.cross()];
    });
    check("… and the back-string push: the string is pushed, no magnet, no release", pushed.some((o) => o.hook.active) && quiet(pushed) && pushed.every((o) => !o.handBar.detached && !o.headBar.held && !o.legBar.held));
  }
  {
    // Dropouts of the second hand while its fist is the magnet
    const short = start(20);
    const kept = run(short.tracker, 2.1, 6, (t) => [...(t >= 4 && t < 4.3 ? [] : [short.second(fist(closure(t, 3)))]), short.cross()]);
    const on = Math.round((firstOn(kept, 2.1) - 2.1) * FPS);
    check("the fist lost for 0.3 s: the magnet stays on", on > 0 && kept.slice(on).every((o) => o.grasp.on));
    const gone = start(20);
    const lost = run(gone.tracker, 2.1, 9, (t) => [...(t >= 4 && t < 4.8 ? [] : [gone.second(fist(closure(t, 3, 7) + closure(t, 7.5)))]), gone.cross()]);
    const at = (t: number) => lost[Math.round((t - 2.1) * FPS)];
    check("lost for 0.8 s: the magnet goes off, and the fist that comes back does not switch it on", at(3.9).grasp.on && !at(4.75).grasp.on && lost.slice(Math.round((4.6 - 2.1) * FPS), Math.round((7.5 - 2.1) * FPS)).every((o) => !o.grasp.on) && last(lost).grasp.releases === 0);
    check("… until it has been opened and closed again", at(8.5).grasp.on);
    // Something held: the fist closes, is lost for a moment, and is seen open again
    const releases = [0.2, 0.8].map((gap) => {
      const { tracker, cross, second } = start(21);
      tracker.puppetHolds = true;
      const out = run(tracker, 2.1, 6, (t) => [...(t >= 3.3 && t < 3.3 + gap ? [] : [second(fist(closure(t, 3, 3.3)))]), cross()]);
      return last(out).grasp.releases + (out.some((o) => o.grasp.on) ? 100 : 0);
    });
    check("holding: close, a gap of 0.2 s, open again within the time: one release; with a gap of 0.8 s: none", releases[0] === 1 && releases[1] === 0, releases.join(" / "));
  }
  {
    // The fist reads as open for a frame or two, or cannot be read at all for a while: the closure goes on
    const { tracker, cross, second } = start(22);
    const dip = (t: number) => (t >= 4 && t < 4 + 1 / FPS) || (t >= 5 && t < 5 + 2 / FPS);
    const out = run(tracker, 2.1, 7, (t) => [second(dip(t) ? {} : fist(closure(t, 3))), cross()]);
    const on = Math.round((firstOn(out, 2.1) - 2.1) * FPS);
    check("the fist seen open for one frame, and for two: the magnet stays on", on > 0 && out.slice(on).every((o) => o.grasp.on) && last(out).grasp.releases === 0);
    const holding = start(22);
    holding.tracker.puppetHolds = true;
    const click = run(holding.tracker, 2.1, 6, (t) => [holding.second(t >= 3.25 && t < 3.25 + 2 / FPS ? {} : fist(closure(t, 3, 5))), holding.cross()]);
    check("holding: two open frames inside a long fist are no release", last(click).grasp.releases === 0 && click.some((o) => o.grasp.on));
    for (const holds of [false, true]) {
      const edge = start(23);
      edge.tracker.puppetHolds = holds;
      // Tipped until the palm is a line in the picture (as in 8b), for 1 s, and back
      const turned = run(edge.tracker, 2.1, 8, (t) => [edge.second({ ...fist(closure(t, 3, 7)), pitch: 1.45 * (ramp(t, 4, 4.3) - ramp(t, 5.3, 5.6)) }), edge.cross()]);
      const at = (t: number) => turned[Math.round((t - 2.1) * FPS)];
      check(`a fist turned edge-on for 1 s${holds ? ", holding" : ""}: the magnet stays on, no release`, turned.slice(Math.round((3.9 - 2.1) * FPS), Math.round((6.9 - 2.1) * FPS)).every((o) => o.grasp.on) && !at(7.9).grasp.on && last(turned).grasp.releases === 0);
    }
  }
  {
    // A hand that comes into the picture as a fist has not closed on anything
    const { tracker, cross, second } = start(24);
    tracker.puppetHolds = true;
    const out = run(tracker, 2.1, 5, () => [second(fist(1)), cross()]);
    check("a hand first seen as a fist: nothing", quiet(out));
    // The cross hand's fist: the leg bar fades as before, and it is no grasp
    const own = start(25);
    const stepping = run(own.tracker, 2.1, 5, (t) => [own.cross({ index: 0.5 * ramp(t, 2.2, 2.6) + 0.5 * ramp(t, 3.5, 4), middle: ramp(t, 3.5, 4), ring: ramp(t, 3.5, 4), pinky: ramp(t, 3.5, 4), thumb: 0.6 * ramp(t, 3.5, 4) })]);
    const at = (t: number) => stepping[Math.round((t - 2.1) * FPS)];
    check("the cross hand's fist: the leg bar fades out, no grasp", Math.abs(at(3.3).rock.legs) > 0.6 && Math.abs(at(4.9).rock.legs) < 0.1 && quiet(stepping), `leg bar ${f(at(3.3).rock.legs, 2)} → ${f(at(4.9).rock.legs, 2)}`);
  }
}

console.log("8c fingers as angles, height, pitch correction, far hands");
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
  // An open palm shown to the camera (lean 0) and a palm at 45°: the image hardly shows a finger bending
  // towards the camera there, the 3D landmarks do. The same walking fingers rock the leg bar as for a level palm
  const noisy = (lean: number, finger: "index" | "middle") => {
    const level: SyntheticHand = { ...REST, pitch: lean };
    const noise = gaussian(31);
    const out = run(attached(level, noise), 2, 4.5, (t) => [synthesize({ ...level, [finger]: 0.2 * ramp(t, 2, 3) }, CAMERA, noise)]);
    return Math.abs(out[out.length - 1].rock.legs);
  };
  const byLean = [0, 0.4, 0.78, 1.2].map((lean) => [noisy(lean, "index"), noisy(lean, "middle")]);
  check("walking fingers at an open palm (0), at 0.4, at 45° (0.78) and at a level palm (1.2): the same bend steps alike", byLean.every(([i, m]) => i > 0.6 && m > 0.8), byLean.map(([i, m]) => `${f(i, 2)}/${f(m, 2)}`).join("  "));
  const flatNoise = gaussian(8);
  const idle = run(attached(REST, flatNoise), 2, 22, () => [synthesize(REST, CAMERA, flatNoise)]);
  check("an open palm at rest for 20 s: the leg bar stays level", Math.max(...idle.map((o) => Math.abs(o.rock.legs))) < 0.12, f(Math.max(...idle.map((o) => Math.abs(o.rock.legs))), 2));
  // Rest pose taken with a level palm, the hand then turned to show its palm, without a reset
  // (without the guided capture: it would take the rest pose again where the turned hand next holds still)
  const turned = new HandTracker();
  turned.height.guide = false;
  const turning = run(turned, 0, 7.5, (t) => [synthesize({ ...REST, pitch: 1.2 - 1.2 * ramp(t, 3, 4), index: 0.2 * ramp(t, 5.5, 6.5) })]);
  check("rest pose at a level palm, then the palm turned to the camera: at rest no step, the index still steps", Math.abs(turning[Math.round(5.3 * FPS)].rock.legs) < 0.1 && Math.abs(turning[turning.length - 1].rock.legs) > 0.6, `${f(turning[Math.round(5.3 * FPS)].rock.legs, 2)} → ${f(turning[turning.length - 1].rock.legs, 2)}`);

  // The middle finger does not bend far on its own: it needs less for the same step
  const lead = (finger: "index" | "middle") => {
    const level: SyntheticHand = { ...REST, pitch: 0.9 };
    const out = run(attached(level), 2, 4, (t) => [synthesize({ ...level, [finger]: 0.06 * ramp(t, 2, 3) })]);
    return Math.abs(out[out.length - 1].rock.legs);
  };
  const [byIndex, byMiddle] = [lead("index"), lead("middle")];
  check("the middle finger rocks the leg bar further than the index for the same bend", byIndex > 0.05 && byMiddle > 1.4 * byIndex, `index ${f(byIndex, 2)}, middle ${f(byMiddle, 2)}`);

  // Height follows the hand's real height: the puppet stands where the hand first held still (here: at the camera's height)
  const rest = new HandTracker().restHeight;
  const row = (metres: number, distance: number) => 0.5 - (metres * CAMERA.focal) / distance; // a hand this far above the camera's axis
  for (const distance of [0.6, 1.8]) {
    const out = run(attached({ ...REST, distance }), 2, 4, (t) => [synthesize({ ...REST, distance, y: row(0.1 * ramp(t, 2.5, 3), distance) })]);
    // (the synthetic hand's y is not quite the palm's centre: 1 cm of the hand itself)
    // Standing is a band (TUNING.position.dead): the lift starts at its edge
    check(`${distance} m from the camera: at the standing height the cross is at its rest height, 10 cm up lifts it by 10 cm less the dead band`, Math.abs(out[0].bar.y - rest) < 1e-6 && Math.abs(out[out.length - 1].bar.y - rest - (0.1 - TUNING.position.dead) * TUNING.position.yGain) < 0.015, `${f(out[0].bar.y - rest)} → ${f(out[out.length - 1].bar.y - rest)}`);
  }
  {
    // The band itself: a hand that wanders 2 cm up and down leaves the cross alone; leaving the band is no step
    const wander = run(attached(), 2, 6, (t) => [synthesize({ ...REST, y: row(0.02 * Math.sin((t - 2) * 2), 0.6) })]);
    check("a hand wandering ±2 cm about the standing height does not move the cross", wander.every((o) => Math.abs(o.bar.y - rest) < 1e-6), f(Math.max(...wander.map((o) => Math.abs(o.bar.y - rest))), 4));
    const leave = run(attached(), 2, 5, (t) => [synthesize({ ...REST, y: row(0.08 * ramp(t, 2.5, 4.5), 0.6) })]);
    const steps = leave.slice(1).map((o, i) => Math.abs(o.bar.y - leave[i].bar.y));
    check("leaving the band upwards: the cross starts to rise without a step", leave[leave.length - 1].bar.y - rest > 0.04 && Math.max(...steps) < 0.003, `to +${f(leave[leave.length - 1].bar.y - rest)} m, largest step ${f(Math.max(...steps) * 1000, 1)} mm`);
  }
  // Walking towards the camera with the hand held 15 cm below the camera's height: the height stays.
  // The hand holds still for 3 s first: the guided capture takes that height as the one at which the puppet stands
  const walk = (t: number) => 1.8 - 0.9 * ramp(t, 3, 6);
  const walker = new HandTracker();
  const walking = run(walker, 0, 7, (t) => [synthesize({ ...REST, distance: walk(t), y: row(-0.15, walk(t)) })]).slice(3 * FPS);
  const heights = walking.map((o) => o.bar.y - rest);
  check("walking from 1.8 m to 0.9 m with the hand held low, where its height was taken: the cross stays at its rest height", walker.height.reading.sources.includes("calibrated") && Math.max(...heights.map(Math.abs)) < 0.005, `${f(Math.min(...heights))} … ${f(Math.max(...heights))} m`);
  check("… and the puppet comes to the front", walking[walking.length - 1].bar.z > 0.2, f(walking[walking.length - 1].bar.z));
  // The same without the capture: the zero is the camera's own height (a level camera is assumed), and standing is a band of ±6 cm
  const unguided = new HandTracker();
  unguided.height.guide = false;
  const low = run(unguided, 0, 7, (t) => [synthesize({ ...REST, distance: walk(t), y: row(-0.15, walk(t)) })]).slice(3 * FPS).map((o) => o.bar.y - rest);
  const unsure = TUNING.position.dead + TUNING.position.unsure;
  check("no zero taken: the cross keeps its height 15 cm below the camera's, less the wider band", !unguided.height.reading.sources.includes("calibrated") && Math.abs(low[0] + 0.15 - unsure) < 0.015 && Math.max(...low) - Math.min(...low) < 0.01, `${f(Math.min(...low))} … ${f(Math.max(...low))} m for a hand 0.15 m below (less ${f(unsure, 2)})`);
  // The slider: the player's own correction of the standing height, around where it was taken. It comes in over a
  // while, no faster than 0.3 m/s
  const slider = attached();
  const level = run(slider, 2, 2.1, () => [synthesize(REST)])[0].bar.y;
  slider.height.trim = -0.15; // the puppet stands 15 cm lower: the hand is above that
  const lifted = run(slider, 2.1, 3.5, () => [synthesize(REST)]);
  slider.height.trim = 0.3; // 30 cm higher: the hand is far below
  const slack = run(slider, 3.5, 7, () => [synthesize(REST)]);
  const sliding = [...lifted, ...slack].slice(1).map((o, i, all) => Math.abs(o.bar.y - (i ? all[i - 1] : lifted[0]).bar.y));
  check("standing height trimmed below the hand lifts the cross, far above it lets it down to its limit, without a jump", Math.abs(level - rest) < 1e-6 && Math.abs(lifted[lifted.length - 1].bar.y - rest - (0.15 - TUNING.position.dead)) < 0.005 && Math.abs(slack[slack.length - 1].bar.y - rest + TUNING.position.down) < 0.001 && Math.max(...sliding) < 0.0105, `${f(lifted[lifted.length - 1].bar.y - rest)} / ${f(slack[slack.length - 1].bar.y - rest)}, largest step ${f(Math.max(...sliding) * 1000, 1)} mm per frame`);
  // A hand that attaches high above the standing height: the cross goes up to it, it does not jump
  // (outside the capture's band no zero is taken, so standing is the wider band)
  const high = run(new HandTracker(), 0, 2, () => [synthesize({ ...REST, y: row(0.3, 0.6) })]);
  const rise = high.slice(1).map((o, i) => Math.abs(o.bar.y - high[i].bar.y));
  check("a hand attaching 30 cm above the standing height: the cross rises without a jump", Math.abs(high[high.length - 1].bar.y - rest - (0.3 - unsure)) < 0.02 && Math.max(...rise) < 0.03, `to +${f(high[high.length - 1].bar.y - rest)} m in steps of at most ${f(Math.max(...rise))}`);

  // The player's pitch correction adds to the cross's pitch and survives a reset
  const trimmed = attached();
  trimmed.pitchTrim = 0.3;
  const before = run(trimmed, 2, 2.5, () => [synthesize(REST)]);
  trimmed.reset();
  const after = run(trimmed, 2.5, 4, () => [synthesize(REST)]);
  check("pitch correction is added, and a reset does not swallow it", Math.abs(before[before.length - 1].bar.pitch - 0.3) < 0.02 && Math.abs(after[after.length - 1].bar.pitch - 0.3) < 0.02, `${f(before[before.length - 1].bar.pitch)} / ${f(after[after.length - 1].bar.pitch)}`);

  // A hand three times further away is a third as fast across the picture: it must not count as still while it moves
  const far = new HandTracker();
  const swaying = run(far, 0, 4, (t) => [synthesize({ ...REST, distance: 1.8, x: 0.4 + 0.05 * Math.sin(3 * t), pitch: 0.9 + 0.3 * Math.sin(3 * t) })]);
  const paused = run(far, 4, 6, () => [synthesize({ ...REST, distance: 1.8, x: 0.4, pitch: 0.9 })]);
  check("a far hand that keeps moving has no rest pose taken; its first pause takes it", swaying.every((o) => !o.calibrated) && paused[paused.length - 1].calibrated);
}

console.log("9 demo recording end to end");
{
  const recording = demoRecording();
  const tracker = new HandTracker();
  // What the engine would say: the magnet catches a prop as soon as it is on, a release drops it
  let releases = 0;
  const out = recording.frames.map((frame) => {
    const o = snapshot(tracker.update(frame.t, frame.hands, recording.aspect));
    if (o.grasp.on) tracker.puppetHolds = true;
    if (o.grasp.releases !== releases) tracker.puppetHolds = false;
    releases = o.grasp.releases;
    return o;
  });
  const range = (pick: (o: Snapshot) => number) => [Math.min(...out.map(pick)), Math.max(...out.map(pick))];
  const spans: [string, number[], number][] = [
    ["bar x", range((o) => o.bar.x), 0.2], ["bar y", range((o) => o.bar.y), 0.05], ["bar z", range((o) => o.bar.z), 0.12],
    // The hand is held level (leaning 0.8 rad from flat to the camera): turning it in the picture is part roll, part yaw of the cross
    ["roll + yaw", range((o) => o.bar.roll + o.bar.yaw), 0.6], ["pitch", range((o) => o.bar.pitch), 0.6], ["legs", range((o) => o.rock.legs), 1.5], ["head turn", range((o) => o.turn), 1.5],
  ];
  for (const [name, [min, max], span] of spans) check(`${name} moves`, max - min > span, `${f(min, 2)} … ${f(max, 2)}`);
  const magnet = out.filter((o) => o.grasp.on).length / FPS;
  check("the second hand's fist is the magnet, and its quick fist/open a release", magnet > 1 && !out[out.length - 1].grasp.on && out[out.length - 1].grasp.releases === 1 && !tracker.puppetHolds, `${f(magnet, 1)} s on, ${out[out.length - 1].grasp.releases} release(s)`);
  check("the cross hand's fist (20…22 s of the script) is no grasp", out.filter((_, i) => recording.frames[i].t < (40 + DEMO_LEAD) * 1000).every((o) => !o.grasp.on && o.grasp.releases === 0));
  const detached = out.filter((o) => o.handBar.detached).length / FPS;
  check("hand bar is taken and returns", detached > 3 && !out[out.length - 1].handBar.detached, `${f(detached, 1)} s detached`);
  const headHeld = out.filter((o) => o.headBar.held);
  check("head bar is taken, turned and let go", headHeld.length / FPS > 2 && Math.max(...headHeld.map((o) => Math.abs(o.turn))) > 0.4 && !out[out.length - 1].headBar.held, `${f(headHeld.length / FPS, 1)} s held`);
  const pushed = out.filter((o) => o.hook.active);
  check("back string is pushed and let go", pushed.length / FPS > 1 && Math.max(...pushed.map((o) => Math.abs(o.hook.push))) > 0.03 && !out[out.length - 1].hook.active, `${f(pushed.length / FPS, 1)} s, up to ${f(Math.max(0, ...pushed.map((o) => Math.abs(o.hook.push))))} m`);
  check("frames have 21 landmarks each", recording.frames.every((frame) => frame.hands.every((h) => h.image.length === 21 && h.world.length === 21)));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
if (failures) throw new Error(`${failures} hand-tracking check(s) failed`);
