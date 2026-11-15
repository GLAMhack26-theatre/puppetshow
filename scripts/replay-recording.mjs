// Runs a recorded hand session (the JSON from ?test=mediapipe&record, key R)
// through the tracker without a browser and writes what came out, frame by
// frame, as CSV: for tuning src/input/hand-tracking.ts on a real hand.
//     node scripts/replay-recording.mjs <recording.json> [out.csv] [--mirror=0]
// Columns: raw measurements of the first hand (palm position, size, lean,
// finger signals) next to the tracker's outputs (bar pose, the cross hand's
// finger angles, leg bar, nod with the thumb-to-index gap behind it, the hand's
// height, grip, what the second hand holds or pushes).
// It also lists the largest steps of the cross from one frame to the next:
// where a jerk comes from the tracking, it shows here.
import fs from "node:fs";
// Plain JavaScript (the project has no Node typings); Node 24 loads the TypeScript tracker directly
import { HandTracker, fingerChannels, palmInImage, palmPose, toDisplay } from "../src/input/hand-tracking.ts";

const [file, out] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!file) throw new Error("usage: node scripts/replay-recording.mjs <recording.json> [out.csv] [--mirror=0]");
/** @type {{ aspect: number; frames: { t: number; hands: import("../src/input/hand-tracking.ts").HandFrame[] }[] }} */
const recording = JSON.parse(fs.readFileSync(file, "utf8"));
const tracker = new HandTracker();
tracker.mirror = !process.argv.includes("--mirror=0");

const columns = [
  "t", "hands", "status", "handedness", "score", "palm_x", "palm_y", "raw_log_size", "raw_lean",
  "index", "middle", "ring", "pinky", "thumb", "fist", "pinch",
  "x", "y", "z", "pitch", "yaw", "roll", "flex_index", "flex_middle", "flex_ring", "flex_pinky", "legs", "head", "nod", "gap", "thumb_moved", "hand_height", "grip", "log_size", "baseline",
  "second", "detached", "head_held", "hook_push",
];
const rows = [columns.join(",")];
const count = {};
let grips = 0;
let lastGrip = false;
/** @type {{ t: number; what: string; step: number }[]} */
const steps = [];
let before;
for (const frame of recording.frames) {
  const o = tracker.update(frame.t, frame.hands, recording.aspect);
  // m and rad on the same scale: 10 cm of travel counts like 0.5 rad of tilt
  const now = { x: o.bar.x * 5, y: o.bar.y * 5, z: o.bar.z * 5, pitch: o.bar.pitch, yaw: o.bar.yaw, roll: o.bar.roll };
  if (before) for (const key of Object.keys(now)) steps.push({ t: frame.t / 1000, what: key, step: Math.abs(now[key] - before[key]) });
  before = now;
  const row = {
    t: frame.t / 1000, hands: frame.hands.length, status: o.status,
    x: o.bar.x, y: o.bar.y, z: o.bar.z, pitch: o.bar.pitch, yaw: o.bar.yaw, roll: o.bar.roll,
    flex_index: o.cross?.flex.index, flex_middle: o.cross?.flex.middle, flex_ring: o.cross?.flex.ring, flex_pinky: o.cross?.flex.pinky,
    legs: o.rock.legs, head: o.rock.head, nod: o.nod, gap: o.cross?.gap, thumb_moved: o.cross?.thumbMoved, hand_height: o.height.hand, grip: +o.grip, log_size: o.depth.scale, baseline: o.depth.baseline,
    second: +!!o.second, detached: +o.handBar.detached, head_held: +o.headBar.held, hook_push: o.hook.push,
  };
  const hand = frame.hands[0];
  if (hand) {
    const shown = toDisplay(hand, tracker.mirror);
    const pose = palmPose(shown.image, shown.world, recording.aspect);
    const palm = palmInImage(shown.image, recording.aspect);
    Object.assign(row, fingerChannels(shown.image, recording.aspect, undefined, shown.world), {
      handedness: hand.handedness, score: hand.score, palm_x: palm.x / recording.aspect, palm_y: palm.y, raw_log_size: Math.log(pose.scale), raw_lean: pose.lean,
    });
  }
  rows.push(columns.map((c) => (typeof row[c] === "number" ? row[c].toFixed(5) : row[c] ?? "")).join(","));
  count[o.status] = (count[o.status] ?? 0) + 1;
  if (o.grip && !lastGrip) grips++;
  lastGrip = o.grip;
}
if (out) fs.writeFileSync(out, rows.join("\n"));
const seconds = (recording.frames[recording.frames.length - 1].t - recording.frames[0].t) / 1000;
console.log(`${recording.frames.length} frames, ${seconds.toFixed(1)} s, ${(recording.frames.length / seconds).toFixed(0)} Hz; mirror ${tracker.mirror ? "on" : "off"}`);
console.log("status frames:", count, "| grips:", grips, out ? `| written to ${out}` : "");
steps.sort((a, b) => b.step - a.step);
console.log("largest steps of the cross per frame (rad, or m × 5):", steps.slice(0, 6).map((s) => `${s.what} ${s.step.toFixed(3)} @ ${s.t.toFixed(2)} s`).join(", "));
