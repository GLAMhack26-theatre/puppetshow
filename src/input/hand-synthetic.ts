import { projectCross, type HandFrame, type Point } from "./hand-tracking.ts";

// A synthetic hand: a simple articulated hand model posed in front of a
// pinhole camera, reported the way MediaPipe reports a hand. No camera is
// needed to exercise the tracking with it: scripts/test-hand-tracking.ts
// checks the pipeline on it, and ?replay=synthetic plays demoRecording()
// through the real page. It proves the maths, not MediaPipe's accuracy.

export interface SyntheticHand {
  /** The player's hand */
  hand: "left" | "right";
  /** Palm position: normalized image x / y, and metres from the camera */
  x: number;
  y: number;
  distance: number;
  /** Rotation in camera axes (x right, y down, z away), rad, applied yaw · pitch · roll */
  pitch?: number;
  yaw?: number;
  roll?: number;
  /** 0 straight … 1 curled */
  index?: number;
  middle?: number;
  ring?: number;
  pinky?: number;
  /** 0 spread out … 1 tucked across the palm */
  thumb?: number;
  /** 0…1: thumb tip onto the index tip */
  pinch?: number;
}

export interface Camera {
  aspect: number;
  /** Focal length in image heights (1.2 ≈ 45° vertical field of view) */
  focal: number;
}
export const CAMERA: Camera = { aspect: 4 / 3, focal: 1.2 };

type V3 = [number, number, number];
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

// Right hand, palm towards the camera, fingers up: x right (thumb side), y
// down, z away from the camera; metres from the wrist
// Knuckles in the proportions of a real palm (the tracker's PALM_SHAPE, palm length 9.5 cm)
const FINGERS: { mcp: V3; lengths: V3 }[] = [
  { mcp: [0.0257, -0.0883, 0], lengths: [0.04, 0.025, 0.02] }, // index
  { mcp: [0, -0.095, 0], lengths: [0.045, 0.028, 0.02] }, // middle
  { mcp: [-0.0239, -0.0903, 0], lengths: [0.04, 0.026, 0.02] }, // ring
  { mcp: [-0.0453, -0.0767, 0], lengths: [0.032, 0.02, 0.018] }, // pinky
];
const BEND = [1.4, 1.75, 1.05]; // rad at knuckle, middle and end joint of a closed finger

/** The 21 landmarks in the hand's own frame (right hand) */
function handShape(h: SyntheticHand): V3[] {
  const points: V3[] = [[0, 0, 0]];
  // Thumb: swings from spread out to tucked across the palm
  const tuck = h.thumb ?? 0;
  const cmc: V3 = [0.02, -0.02, -0.005];
  const mcp = add(cmc, unit(lerp([0.75, -0.65, -0.1], [0.1, -0.9, -0.4], tuck)), 0.04);
  const direction = unit(lerp([0.75, -0.65, -0.1], [-0.85, -0.35, -0.4], tuck));
  points.push(cmc, mcp, add(mcp, direction, 0.033), add(mcp, direction, 0.06));
  const pinch = h.pinch ?? 0;
  [h.index, h.middle, h.ring, h.pinky].forEach((curl = 0, f) => {
    const { mcp: knuckle, lengths } = FINGERS[f];
    const amount = f === 0 ? Math.max(curl, 0.45 * pinch) : curl; // the index comes to meet the thumb
    points.push(knuckle);
    let bend = 0;
    let joint = knuckle;
    for (let i = 0; i < 3; i++) {
      bend += BEND[i] * amount;
      // Fingers curl towards the palm side, which faces the camera (−z)
      joint = add(joint, [0, -Math.cos(bend), -Math.sin(bend)], lengths[i]);
      points.push(joint);
    }
  });
  if (pinch > 0) {
    const tip = points[8];
    points[3] = lerp(points[3], lerp(points[2], tip, 0.55), pinch);
    points[4] = lerp(points[4], tip, pinch);
  }
  return points;
}

/** The hand as MediaPipe would report it for the raw (not mirrored) camera image */
export function synthesize(h: SyntheticHand, camera = CAMERA, noise?: () => number): HandFrame {
  const [cz, sz, cx, sx, cy, sy] = [Math.cos(h.roll ?? 0), Math.sin(h.roll ?? 0), Math.cos(h.pitch ?? 0), Math.sin(h.pitch ?? 0), Math.cos(h.yaw ?? 0), Math.sin(h.yaw ?? 0)];
  const centre: V3 = [0, -0.06, 0]; // turn about the palm, not the wrist
  const posed = handShape(h).map(([px, py, pz]): V3 => {
    // The player's left hand is the mirror image of the right
    let [x, y, z] = [(h.hand === "left" ? -px : px) - centre[0], py - centre[1], pz - centre[2]];
    [x, y] = [x * cz - y * sz, x * sz + y * cz];
    [y, z] = [y * cx - z * sx, y * sx + z * cx];
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    return [x, y, z];
  });
  const jitter = (sigma: number) => (noise ? noise() * sigma : 0);
  const wristDepth = h.distance + posed[0][2];
  const image: Point[] = posed.map(([x, y, z]) => {
    const depth = h.distance + z;
    return {
      x: h.x + (camera.focal * x) / depth / camera.aspect + jitter(0.003),
      y: h.y + (camera.focal * y) / depth + jitter(0.004),
      z: ((depth - wristDepth) * camera.focal) / wristDepth / camera.aspect,
    };
  });
  // World landmarks: metres around the hand's centre; MediaPipe's depth is the noisiest part
  const mean = posed.reduce((m, p) => add(m, p, 1 / posed.length), [0, 0, 0] as V3);
  const world: Point[] = posed.map(([x, y, z]) => ({ x: x - mean[0] + jitter(0.0015), y: y - mean[1] + jitter(0.0015), z: z - mean[2] + jitter(0.004) }));
  // On the raw image MediaPipe's label is the subject's own hand (see playerHand)
  return { image, world, handedness: h.hand === "right" ? "Right" : "Left", score: 0.95 };
}

/** Deterministic Gaussian noise (mulberry32 + Box–Muller), so tests repeat exactly */
export function gaussian(seed: number) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let v = Math.imul(state ^ (state >>> 15), 1 | state);
    v = (v + Math.imul(v ^ (v >>> 7), 61 | v)) ^ v;
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform() || 1e-9)) * Math.cos(2 * Math.PI * uniform());
}

export interface Recording {
  version: 1;
  /** Image width / height */
  aspect: number;
  frames: { t: number; hands: HandFrame[] }[];
}

/**
 * A scripted session at 30 fps with jitter: one hand attaches, moves, tilts,
 * reaches forward, walks the leg bar, tilts the head bar and grips; then a
 * second hand takes the hand bar, moves and turns it and lets it go.
 */
export function demoRecording(): Recording {
  const noise = gaussian(7);
  const frames: Recording["frames"] = [];
  const ramp = (t: number, from: number, to: number) => Math.max(0, Math.min(1, (t - from) / (to - from)));
  const pulse = (t: number, from: number, to: number) => Math.sin(Math.PI * ramp(t, from, to)); // 0 → 1 → 0
  const wave = (t: number, from: number, to: number, cycles: number) => (t > from && t < to ? Math.sin(2 * Math.PI * cycles * ramp(t, from, to)) : 0);
  for (let i = 0; i < 30 * 30; i++) {
    const t = i / 30;
    const hands: HandFrame[] = [];
    // Cross hand: the player's right hand, on the image's left
    const cross: SyntheticHand = {
      hand: "right",
      x: 0.34 + 0.1 * wave(t, 2, 5, 1),
      y: 0.45 - 0.08 * pulse(t, 2, 5),
      distance: 0.6 - 0.14 * pulse(t, 11, 14),
      roll: 0.4 * wave(t, 5, 8, 1),
      pitch: 0.45 * wave(t, 8, 11, 1),
      index: Math.max(0, wave(t, 14, 17, 2)) * 0.8 + pulse(t, 20, 22),
      middle: Math.max(0, -wave(t, 14, 17, 2)) * 0.8 + pulse(t, 20, 22),
      ring: 0.8 * pulse(t, 17, 18.5) + pulse(t, 20, 22),
      pinky: 0.8 * pulse(t, 17, 18.5) + pulse(t, 20, 22),
      thumb: 0.9 * pulse(t, 18.5, 20) + 0.6 * pulse(t, 20, 22),
    };
    if (t > 0.3) hands.push(synthesize(cross, CAMERA, noise));
    // Second hand: comes in at 22 s, pinches at the magnet point, carries the bar away and lets go
    if (t > 22 && t < 29.5) {
      // Where the tracker draws the magnet for a level cross with this hand on the left …
      const palm = 0.09 * (CAMERA.focal / 0.6); // image heights: palm length at 0.6 m
      const tip = projectCross([0, 0, 0.1395], { pitch: 0, yaw: 0, roll: 0 }, 1);
      const magnet = { x: cross.x + (tip.x * palm) / CAMERA.aspect, y: cross.y - 0.06 + tip.y * palm };
      // … and where this hand has to be for its pinching fingers to be there
      const pinching = synthesize({ hand: "left", x: 0, y: 0, distance: 0.6, pinch: 1 }).image;
      const fingers = { x: (pinching[4].x + pinching[8].x) / 2, y: (pinching[4].y + pinching[8].y) / 2 };
      const carry = pulse(t, 24, 28);
      hands.unshift(
        synthesize(
          {
            hand: "left",
            x: magnet.x - fingers.x + 0.02 + 0.12 * carry,
            y: magnet.y - fingers.y + 0.02 - 0.12 * carry,
            distance: 0.6,
            roll: 0.5 * wave(t, 25, 27, 1),
            pinch: ramp(t, 23, 23.5) - ramp(t, 28, 28.5),
          },
          CAMERA,
          noise,
        ),
      );
    }
    frames.push({ t: t * 1000, hands });
  }
  return { version: 1, aspect: CAMERA.aspect, frames };
}
