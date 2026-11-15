// Runs a recorded hand session (the JSON from ?record, key R; format 1 or 2)
// through the tracker without a browser and writes what came out, frame by
// frame, as CSV: for tuning src/input/hand-tracking.ts on a real hand.
//     node scripts/replay-recording.mjs <recording.json> [out.csv] [options]
//     node scripts/replay-recording.mjs --self-test
// Columns: raw measurements of the first hand (palm position, size, lean,
// finger signals) next to the tracker's outputs (bar pose, the cross hand's
// finger angles, leg bar, the head's turn with the thumb's measure behind it, the hand's
// height (see below), what the second hand holds or pushes, and its fist away from the
// handles: `grasp` the magnet in the puppet's hands, `grasp_phase` 0 idle / 1
// a fist that may still become a release / 2 the magnet, `releases` the count
// of quick fist/opens. There is no stage here, so the puppet is taken to catch
// a prop whenever the magnet is on and to drop it at a release).
// A format 2 recording also holds what the body models saw (src/input/
// body-frame.ts). For each of them that the file contains, columns follow:
// whether a face / a face mesh / a body was seen in the frame (empty: the
// model did not run on it), the row of the eyes and their distance, the row
// of the shoulders and their width (rows 0 top … 1 bottom, distances in
// image heights).
// The hand's height (the model in src/input/body-frame.ts): `height` how far
// the hand is above the height at which the puppet stands, m; `height_sigma`
// how far that zero may be off; `height_sources` what it rests on (hand, face
// or pose, where the zero comes from, where the horizon row comes from);
// `horizon_row` the horizon row in use; `hand_above_camera` and
// `anchor_above_camera` the hand and the face or body above the camera's own
// height, m; `body_shift` how far the zero has gone along with the body;
// `stand_row` the row at which the puppet stands; `guide` the guided capture's
// state while it is offered.
// It also lists the largest steps of the cross from one frame to the next:
// where a jerk comes from the tracking, it shows here.
// Options:
//   --mirror=0|1       the player's picture was not / was mirrored (default: as
//                      the recording says, else mirrored)
//   --pitch=<deg> --focal=<f>   the session as a camera pitched by that angle
//                      (positive looks up) with that focal length (in image
//                      heights, default the synthetic camera's) would have seen
//                      it: see pitchedCamera() below. The height model has to
//                      give the same hand height whatever the camera's pitch,
//                      once it is told the horizon row.
//   --horizon=<row>    the picture's row at the camera's own height, 0 top … 1 bottom
//                      (what the installer's step measures; with --pitch a level
//                      camera's is ½ + focal · tan(pitch), printed at the end).
//                      Without it a level camera is assumed, or the row is
//                      fitted from a face that walks.
//   --body=off|face|mesh|pose   which of the body models the height model gets to
//                      see (default: all the file has), and which body columns are written
//   --guide=0          no guided capture of the zero (it is offered as in the page
//                      otherwise, and takes the height where the hand first holds
//                      still in the band). For comparing runs: the band is in
//                      rows of the picture, so a pitched replay may take the zero
//                      at another moment, or not at all.
//   --self-test        checks the re-projection of --pitch and ends
import fs from "node:fs";
// Plain JavaScript (the project has no Node typings); Node 24 loads the TypeScript tracker directly
import { CAMERA } from "../src/input/hand-synthetic.ts";
import { HandTracker, fingerChannels, palmInImage, palmPose, toDisplay } from "../src/input/hand-tracking.ts";

const USAGE = "usage: node scripts/replay-recording.mjs <recording.json> [out.csv] [--mirror=0|1] [--pitch=<deg> --focal=<f>] [--horizon=<row>] [--body=off|face|mesh|pose] [--guide=0] | --self-test";
const args = process.argv.slice(2);
/** The value of --name=value; undefined if the option is not there */
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const number = (name) => {
  const value = option(name);
  if (value === undefined) return undefined;
  if (value === "" || !Number.isFinite(Number(value))) throw new Error(`--${name}=${value}: not a number\n${USAGE}`);
  return Number(value);
};
if (args.includes("--self-test")) {
  selfTest();
  process.exit(0);
}
const [file, out] = args.filter((a) => !a.startsWith("--"));
if (!file) throw new Error(USAGE);
/** @type {import("../src/input/hand-synthetic.ts").Recording} */
const recording = JSON.parse(fs.readFileSync(file, "utf8"));
if ((recording.version !== 1 && recording.version !== 2) || !Array.isArray(recording.frames)) throw new Error(`${file}: not a hand recording (format 1 or 2)`);
const aspect = recording.aspect;
const tracker = new HandTracker();
tracker.mirror = option("mirror") !== undefined ? option("mirror") !== "0" : recording.meta?.mirror ?? true;

// --pitch: every frame as the pitched camera would have seen it
const pitch = number("pitch");
const focal = number("focal") ?? CAMERA.focal;
const camera = pitch ? pitchedCamera((pitch * Math.PI) / 180, focal, aspect) : undefined;

// The height model (src/input/body-frame.ts, inside the tracker): the horizon
// row if given, whether the zero's guided capture is offered, and per frame
// what the chosen body models saw (`observation` in the loop below),
// re-projected by --pitch like the hands.
const bodySource = option("body");
if (bodySource !== undefined && !["off", "face", "mesh", "pose"].includes(bodySource)) throw new Error(`--body=${bodySource}\n${USAGE}`);
const horizon = number("horizon");
if (horizon !== undefined) tracker.height.setHorizon(horizon);
if (option("guide") === "0") tracker.height.guide = false;

/** The body models the file has anything from, and of those the ones --body lets through */
const BODY_KEYS = { face: "faces", mesh: "mesh", pose: "poses" };
const bodyModels = Object.keys(BODY_KEYS).filter(
  (model) => bodySource !== "off" && (!bodySource || bodySource === model) && recording.frames.some((f) => f.body?.[BODY_KEYS[model]] !== undefined),
);
const BODY_COLUMNS = { face: ["face", "eye_row", "eye_dist"], mesh: ["mesh", "mesh_eye_row", "mesh_eye_dist"], pose: ["pose", "shoulder_row", "shoulder_width"] };

const columns = [
  "t", "hands", "status", "handedness", "score", "palm_x", "palm_y", "raw_log_size", "raw_lean",
  "index", "middle", "ring", "pinky", "thumb", "fist", "pinch",
  "x", "y", "z", "pitch", "yaw", "roll", "flex_index", "flex_middle", "flex_ring", "flex_pinky", "legs", "head", "turn", "thumb_press", "thumb_moved", "player", "log_size", "baseline",
  "height", "height_sigma", "height_sources", "horizon_row", "hand_above_camera", "anchor_above_camera", "body_shift", "stand_row", "guide",
  "second", "detached", "head_held", "hook_push", "grasp", "grasp_phase", "releases",
  // Only for a format 2 recording with body frames: a format 1 file gives the columns above and nothing else
  ...bodyModels.flatMap((model) => BODY_COLUMNS[model]),
];
const rows = [columns.join(",")];
const count = {};
let magnets = 0;
let magnetOn = false;
let releases = 0;
/** @type {{ t: number; what: string; step: number }[]} */
const steps = [];
let before;
const seen = { face: 0, mesh: 0, pose: 0 };
/** For the summary: how many frames rested on what, and when the guided capture took the zero */
const heights = { sources: {}, taken: [] };
let observedBefore;
for (const frame of recording.frames) {
  const hands = camera ? frame.hands.map(camera.hand) : frame.hands;
  const body = frame.body && (camera ? camera.body(frame.body) : frame.body);
  // What the height model gets to see of the player in this frame (a model that did not run on it is left out)
  /** @type {import("../src/input/body-frame.ts").BodyObservation | undefined} */
  let observation;
  if (body && bodySource !== "off") {
    const seenHere = bodySource ? (body[BODY_KEYS[bodySource]] !== undefined ? { [BODY_KEYS[bodySource]]: body[BODY_KEYS[bodySource]] } : undefined) : body;
    if (seenHere) observation = { t: frame.t, ...seenHere };
  }
  // … with the next frame's hands, as the page got it while recording (the body models run after the tracker)
  const o = tracker.update(frame.t, hands, recording.aspect, observedBefore);
  observedBefore = observation;
  // m and rad on the same scale: 10 cm of travel counts like 0.5 rad of tilt
  const now = { x: o.bar.x * 5, y: o.bar.y * 5, z: o.bar.z * 5, pitch: o.bar.pitch, yaw: o.bar.yaw, roll: o.bar.roll };
  if (before) for (const key of Object.keys(now)) steps.push({ t: frame.t / 1000, what: key, step: Math.abs(now[key] - before[key]) });
  before = now;
  const row = {
    t: frame.t / 1000, hands: hands.length, status: o.status,
    x: o.bar.x, y: o.bar.y, z: o.bar.z, pitch: o.bar.pitch, yaw: o.bar.yaw, roll: o.bar.roll,
    flex_index: o.cross?.flex.index, flex_middle: o.cross?.flex.middle, flex_ring: o.cross?.flex.ring, flex_pinky: o.cross?.flex.pinky,
    legs: o.rock.legs, head: o.rock.head, turn: o.turn, thumb_press: o.cross?.thumbPress, thumb_moved: o.cross?.thumbMoved, player: o.player, log_size: o.depth.scale, baseline: o.depth.baseline,
    second: +!!o.second, detached: +o.handBar.detached, head_held: +o.headBar.held, hook_push: o.hook.push,
    grasp: +o.grasp.on, grasp_phase: ["idle", "click", "fist"].indexOf(o.grasp.phase), releases: o.grasp.releases,
  };
  // The height only says something while the cross hand is read
  if (o.status === "attached") {
    Object.assign(row, {
      height: o.height.value, height_sigma: o.height.sigma, height_sources: o.height.sources.join("+"), horizon_row: o.height.horizonRow,
      hand_above_camera: o.height.hand, anchor_above_camera: o.height.anchor, body_shift: o.height.shift, stand_row: o.height.standRow, guide: o.height.guide?.state,
    });
    heights.sources[row.height_sources] = (heights.sources[row.height_sources] ?? 0) + 1;
    if (o.height.guide?.state === "done" && !heights.taken.length) heights.taken.push(frame.t / 1000);
  }
  Object.assign(row, bodyColumns(body, bodyModels, aspect));
  for (const model of bodyModels) seen[model] += row[model] ?? 0;
  const hand = hands[0];
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
  if (o.grasp.on && !magnetOn) magnets++;
  magnetOn = o.grasp.on;
  // What a stage with a prop always in reach would answer (HandTracker.puppetHolds)
  if (o.grasp.on) tracker.puppetHolds = true;
  if (o.grasp.releases !== releases) tracker.puppetHolds = false;
  releases = o.grasp.releases;
}
if (out) fs.writeFileSync(out, rows.join("\n"));
const seconds = (recording.frames[recording.frames.length - 1].t - recording.frames[0].t) / 1000;
console.log(`format ${recording.version}: ${recording.frames.length} frames, ${seconds.toFixed(1)} s, ${(recording.frames.length / seconds).toFixed(0)} Hz; mirror ${tracker.mirror ? "on" : "off"}`);
if (recording.meta) console.log("camera:", recording.meta.camera ?? "none", "| models:", recording.meta.delegate, "| set-up:", recording.meta.setup ?? "no notes");
if (camera) console.log(`re-projected: camera pitched ${pitch}° (positive looks up), focal length ${focal} image heights; a level camera's horizon would be at row ${(0.5 + focal * Math.tan((pitch * Math.PI) / 180)).toFixed(3)}`);
console.log(`height: horizon row ${horizon ?? "not given"}; guided capture ${tracker.height.guide ? (heights.taken.length ? `took the zero at ${heights.taken[0].toFixed(2)} s` : "took no zero") : "off"}; frames by what the height rested on:`, heights.sources);
if (recording.version === 2) console.log("body frames:", bodyModels.length ? bodyModels.map((model) => `${model} seen in ${seen[model]}`).join(", ") : "none written", `of ${recording.frames.length}`);
console.log("status frames:", count, "| magnet on:", magnets, "times, releases:", releases, out ? `| written to ${out}` : "");
steps.sort((a, b) => b.step - a.step);
console.log("largest steps of the cross per frame (rad, or m × 5):", steps.slice(0, 6).map((s) => `${s.what} ${s.step.toFixed(3)} @ ${s.t.toFixed(2)} s`).join(", "));

// --- body columns ------------------------------------------------------------

/**
 * The CSV's body columns for one frame. 1 / 0: the model saw someone or not;
 * no value: it did not run on this frame. Distances are in image heights, so
 * the step across the picture counts aspect times its normalized size.
 */
function bodyColumns(body, models, aspect) {
  const row = {};
  const between = (a, b) => Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]);
  const middle = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (models.includes("face") && body?.faces) {
    // Of several faces the largest: the person nearest to the camera, taken to be the player. Its points 0 and 1 are the eyes
    const face = body.faces.reduce((largest, f) => (!largest || f.box[2] * f.box[3] > largest.box[2] * largest.box[3] ? f : largest), undefined);
    row.face = face ? 1 : 0;
    if (face) Object.assign(row, { eye_row: (face.kp[0][1] + face.kp[1][1]) / 2, eye_dist: between(face.kp[0], face.kp[1]) });
  }
  if (models.includes("mesh") && body) {
    // The mesh is left out of a frame both when it found no face and when it did not run: told apart by the frame having any body entry
    const points = body.mesh?.points;
    row.mesh = points ? 1 : 0;
    if (points) {
      // An eye's centre: the middle of its outer and inner corner (points 0, 1 and 3, 2)
      const [right, left] = [middle(points[0], points[1]), middle(points[3], points[2])];
      Object.assign(row, { mesh_eye_row: (right[1] + left[1]) / 2, mesh_eye_dist: between(right, left) });
    }
  }
  if (models.includes("pose") && body?.poses) {
    const pose = body.poses[0];
    row.pose = pose ? 1 : 0;
    // Landmarks 11 and 12 are the shoulders
    if (pose) Object.assign(row, { shoulder_row: (pose.lm[11][1] + pose.lm[12][1]) / 2, shoulder_width: between(pose.lm[11], pose.lm[12]) });
  }
  return row;
}

// --- --pitch: the picture of a pitched camera ----------------------------------

/**
 * The same scene as a camera pitched by `pitch` (rad) would have taken it
 * from the same place. A camera that only turns sees every point along the
 * same viewing ray as before, so no depth is needed: the picture changes by a
 * fixed map of its points.
 *
 * With the picture measured in image heights, a point (x, y; each 0…1) lies
 * on the ray
 *     d = ((x − ½) · aspect, y − ½, f)
 * in the camera's axes (x right, y down, z away; f the focal length in image
 * heights). A camera pitched up by θ has its axes turned about x: in the old
 * axes its "away" is (0, −sin θ, cos θ) and its "down" (0, cos θ, sin θ). The
 * same ray in the new axes is therefore
 *     d′ = (dx, dy · cos θ + dz · sin θ, −dy · sin θ + dz · cos θ)
 * and meets the picture at
 *     x′ = ½ + f · d′x / d′z / aspect,   y′ = ½ + f · d′y / d′z
 *
 * θ > 0 looks up, as "Kameraneigung" in a recording's set-up notes: what was
 * on the optical axis (½, ½) is then f · tan θ rows further down. Offsets in
 * the camera's axes turn the same way: the hands' world landmarks, and the z
 * of their image landmarks (a depth against the wrist in image widths, next
 * to the offset in y in the same unit).
 *
 * Not turned: the z of the pose landmarks and the face mesh's matrix, which
 * MediaPipe fits for a camera of its own. A height model that uses them with
 * --pitch has to turn them itself.
 */
function pitchedCamera(pitch, focal, aspect) {
  const [c, s] = [Math.cos(pitch), Math.sin(pitch)];
  /** An offset in the camera's axes */
  const vector = (x, y, z) => [x, y * c + z * s, -y * s + z * c];
  /** A point of the picture, [x, y] each 0…1 */
  const point = (x, y) => {
    const d = vector((x - 0.5) * aspect, y - 0.5, focal);
    return [0.5 + (focal * d[0]) / d[2] / aspect, 0.5 + (focal * d[1]) / d[2]];
  };
  /** A box [x, y, width, height]: the box around its four corners as they are seen now */
  const box = ([x, y, width, height]) => {
    const corners = [point(x, y), point(x + width, y), point(x, y + height), point(x + width, y + height)];
    const [xs, ys] = [corners.map((p) => p[0]), corners.map((p) => p[1])];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  };
  return {
    point,
    vector,
    /** One hand (HandFrame) */
    hand(hand) {
      const wrist = hand.image[0];
      return {
        ...hand,
        image: hand.image.map((p) => {
          const [x, y] = point(p.x, p.y);
          return { x, y, z: vector(0, (p.y - wrist.y) / aspect, p.z)[2] };
        }),
        world: hand.world.map((p) => {
          const [x, y, z] = vector(p.x, p.y, p.z);
          return { x, y, z };
        }),
      };
    },
    /** What the body models saw in one frame (BodySeen) */
    body(seen) {
      const turned = {};
      if (seen.faces) turned.faces = seen.faces.map((face) => ({ ...face, kp: face.kp.map((p) => point(p[0], p[1])), box: box(face.box) }));
      if (seen.mesh) turned.mesh = { ...seen.mesh, points: seen.mesh.points.map((p) => point(p[0], p[1])) };
      if (seen.poses) turned.poses = seen.poses.map((pose) => ({ lm: pose.lm.map(([x, y, z, visibility]) => [...point(x, y), z, visibility]) }));
      return turned;
    },
  };
}

/** --self-test: the re-projection of --pitch against what it must do, worked out another way */
function selfTest() {
  let failed = 0;
  const check = (what, ok, detail = "") => {
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  };
  const near = (a, b, tolerance = 1e-12) => Math.abs(a - b) <= tolerance;
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const aspect = 4 / 3;

  // A hand that is not in the middle of the picture, with depth in it
  const hand = {
    handedness: "Right",
    score: 0.9,
    image: Array.from({ length: 21 }, (_, i) => ({ x: 0.3 + 0.012 * i, y: 0.7 - 0.009 * i + 0.002 * (i % 4), z: -0.004 * (i % 5) })),
    world: Array.from({ length: 21 }, (_, i) => ({ x: 0.004 * i - 0.04, y: 0.03 - 0.003 * i, z: 0.002 * (i % 7) - 0.006 })),
  };
  const farthest = (a, b) => Math.max(...a.image.map((p, i) => Math.max(Math.abs(p.x - b.image[i].x), Math.abs(p.y - b.image[i].y), Math.abs(p.z - b.image[i].z))), ...a.world.map((p, i) => Math.max(Math.abs(p.x - b.world[i].x), Math.abs(p.y - b.world[i].y), Math.abs(p.z - b.world[i].z))));

  // 1. No pitch: nothing moves
  const level = pitchedCamera(0, 1.2, aspect);
  check("pitch 0 leaves the hand's landmarks as they are", farthest(level.hand(hand), hand) < 1e-15, `largest change ${farthest(level.hand(hand), hand).toExponential(1)}`);
  check("pitch 0 leaves a point at the edge as it is", near(level.point(0.02, 0.97)[0], 0.02, 1e-15) && near(level.point(0.02, 0.97)[1], 0.97, 1e-15));

  // 2. A point on the optical axis moves by f · tan(pitch) rows: down for a camera that looks up
  for (const [degrees, focal] of [[10, 1.2], [-10, 1.2], [25, 0.8], [-3, 1.6]]) {
    const [x, y] = pitchedCamera(radians(degrees), focal, aspect).point(0.5, 0.5);
    const expected = focal * Math.tan(radians(degrees));
    check(`pitch ${degrees}°, focal ${focal}: the axis point moves ${expected.toFixed(4)} rows`, near(x, 0.5) && near(y - 0.5, expected) && Math.sign(y - 0.5) === Math.sign(degrees), `moved ${(y - 0.5).toFixed(4)}, sideways ${(x - 0.5).toExponential(1)}`);
  }

  // 3. Points away from the axis: a point in space, seen by the level camera and by the pitched
  //    one, each worked out from the camera's own axes (not from the ray as pitchedCamera does).
  //    The same picture point at two depths must land on the same spot: turning shows no parallax.
  {
    const [degrees, focal] = [14, 1.1];
    const theta = radians(degrees);
    const project = ([X, Y, Z]) => [0.5 + (focal * X) / Z / aspect, 0.5 + (focal * Y) / Z];
    // The pitched camera's axes in the level camera's: right, down, away
    const axes = [[1, 0, 0], [0, Math.cos(theta), Math.sin(theta)], [0, -Math.sin(theta), Math.cos(theta)]];
    const inPitched = (P) => axes.map((axis) => axis[0] * P[0] + axis[1] * P[1] + axis[2] * P[2]);
    const pitched = pitchedCamera(theta, focal, aspect);
    let worst = 0;
    for (const P of [[0.31, -0.22, 0.9], [-0.4, 0.12, 0.6], [0.05, 0.3, 2.5], [-0.62, -0.35, 1.4]]) {
      for (const depth of [1, 3]) {
        const there = P.map((v) => v * depth); // further along the same ray
        const got = pitched.point(...project(there));
        const expected = project(inPitched(there));
        worst = Math.max(worst, Math.abs(got[0] - expected[0]), Math.abs(got[1] - expected[1]));
      }
    }
    check(`pitch ${degrees}°: points off the axis land where the pitched camera sees them, at any depth (aspect ${aspect.toFixed(2)})`, worst < 1e-12, `largest error ${worst.toExponential(1)}`);
    // The sideways position must change too for a point off the axis (it would not if the aspect were left out of the ray)
    const [x] = pitched.point(0.9, 0.5);
    check("a point at the side moves sideways as well", Math.abs(x - 0.9) > 1e-3, `x 0.9 → ${x.toFixed(4)}`);
  }

  // 4. There and back: pitched up, then down by the same angle
  {
    const [up, down] = [pitchedCamera(radians(17), 1.3, aspect), pitchedCamera(radians(-17), 1.3, aspect)];
    const back = down.hand(up.hand(hand));
    // The image z is a depth against the wrist under weak perspective: there and back it is only close
    const xy = Math.max(...back.image.map((p, i) => Math.max(Math.abs(p.x - hand.image[i].x), Math.abs(p.y - hand.image[i].y))));
    const world = Math.max(...back.world.map((p, i) => Math.max(Math.abs(p.x - hand.world[i].x), Math.abs(p.y - hand.world[i].y), Math.abs(p.z - hand.world[i].z))));
    const z = Math.max(...back.image.map((p, i) => Math.abs(p.z - hand.image[i].z)));
    check("pitch 17° and back −17°: image points and world landmarks return", xy < 1e-12 && world < 1e-12, `image ${xy.toExponential(1)}, world ${world.toExponential(1)}`);
    check("pitch 17° and back −17°: the image landmarks' depth returns nearly", z < 0.02, `largest difference ${z.toFixed(4)} image widths`);
  }

  // 5. World landmarks turn like the rays: lengths stay, and "away" tips down for a camera that looks up
  {
    const camera = pitchedCamera(radians(20), 1.2, aspect);
    const [x, y, z] = camera.vector(0.03, -0.05, 0.08);
    check("turning keeps a world offset's length", near(Math.hypot(x, y, z), Math.hypot(0.03, -0.05, 0.08)));
    const away = camera.vector(0, 0, 1);
    check("straight away from the level camera is below the pitched camera's axis", near(away[1], Math.sin(radians(20))) && near(away[2], Math.cos(radians(20))));
  }

  // 6. The body's points go through the same map
  {
    const camera = pitchedCamera(radians(10), 1.2, aspect);
    const seen = {
      faces: [{ kp: [[0.46, 0.29], [0.55, 0.28]], box: [0.4, 0.2, 0.2, 0.28], score: 0.9 }],
      mesh: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -50, 1], points: [[0.5, 0.5]] },
      poses: [{ lm: [[0.5, 0.5, -0.1, 0.99]] }],
    };
    const turned = camera.body(seen);
    const expected = camera.point(0.46, 0.29);
    check("face keypoints, mesh points and pose landmarks are re-projected", near(turned.faces[0].kp[0][0], expected[0]) && near(turned.faces[0].kp[0][1], expected[1]) && near(turned.mesh.points[0][1], 0.5 + 1.2 * Math.tan(radians(10))) && near(turned.poses[0].lm[0][1], 0.5 + 1.2 * Math.tan(radians(10))));
    check("the face mesh's matrix and the pose's depth are left as recorded", turned.mesh.matrix === seen.mesh.matrix && turned.poses[0].lm[0][2] === -0.1 && turned.poses[0].lm[0][3] === 0.99);
    const corners = [camera.point(0.4, 0.2), camera.point(0.6, 0.48)];
    check("a face's box still holds its corners", turned.faces[0].box[0] <= corners[0][0] + 1e-12 && turned.faces[0].box[1] <= corners[0][1] + 1e-12 && turned.faces[0].box[0] + turned.faces[0].box[2] >= corners[1][0] - 1e-12 && turned.faces[0].box[1] + turned.faces[0].box[3] >= corners[1][1] - 1e-12);
  }

  // 7. The body columns: distances in image heights
  {
    const row = bodyColumns({ faces: [{ kp: [[0.4, 0.3], [0.5, 0.3]], box: [0, 0, 0, 0], score: 1 }], poses: [] }, ["face", "mesh", "pose"], aspect);
    check("eye distance across the picture counts in image heights", near(row.eye_dist, 0.1 * aspect) && near(row.eye_row, 0.3) && row.face === 1, `0.1 of the width = ${row.eye_dist.toFixed(4)} heights`);
    const two = bodyColumns({ faces: [{ kp: [[0.1, 0.1], [0.12, 0.1]], box: [0.08, 0.06, 0.05, 0.07], score: 0.99 }, { kp: [[0.4, 0.3], [0.5, 0.3]], box: [0.35, 0.2, 0.2, 0.3], score: 0.8 }] }, ["face"], aspect);
    check("of two faces the larger one counts, whatever the order or the score", near(two.eye_row, 0.3) && near(two.eye_dist, 0.1 * aspect));
    check("a model that ran and saw nobody gives 0, one that did not run gives nothing", row.pose === 0 && row.mesh === 0 && bodyColumns(undefined, ["face", "mesh", "pose"], aspect).face === undefined && bodyColumns({ poses: [] }, ["face"], aspect).face === undefined);
  }

  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  if (failed) process.exit(1);
}
