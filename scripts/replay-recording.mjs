// Runs a recorded hand session (the JSON from ?test=mediapipe&record, key R)
// through the tracker without a browser and writes what came out, frame by
// frame, as CSV: for tuning src/input/hand-tracking.ts on a real hand.
//     node scripts/replay-recording.mjs <recording.json> [out.csv] [--mirror=0]
// Columns: raw measurements of the first hand (palm position, size, lean,
// finger signals) next to the tracker's outputs (bar pose, rockers, grip).
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
  "x", "y", "z", "pitch", "yaw", "roll", "legs", "head", "grip", "log_size", "baseline", "second", "detached",
];
const rows = [columns.join(",")];
const count = {};
let grips = 0;
let lastGrip = false;
for (const frame of recording.frames) {
  const o = tracker.update(frame.t, frame.hands, recording.aspect);
  const row = {
    t: frame.t / 1000, hands: frame.hands.length, status: o.status,
    x: o.bar.x, y: o.bar.y, z: o.bar.z, pitch: o.bar.pitch, yaw: o.bar.yaw, roll: o.bar.roll,
    legs: o.rock.legs, head: o.rock.head, grip: +o.grip, log_size: o.depth.scale, baseline: o.depth.baseline, second: +!!o.second, detached: +o.handBar.detached,
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
