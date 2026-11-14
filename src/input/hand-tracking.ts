// Hand tracking → marionette control, as pure functions and one small state
// machine (no DOM, no camera, no three.js: runs under plain Node for
// scripts/test-hand-tracking.ts). MediaPipe hand landmarks in, a plain
// TrackerOutput out; src/input/mediapipe.ts feeds it and writes ControlInput.
//
// How a hand drives the cross (docs/architecture.md §3.1):
//  - The first hand seen is the cross hand; a second hand can take the hand bar.
//  - Palm centre → bar x / y. Palm size in the image against a slowly adapting
//    baseline → bar z. Palm orientation relative to the pose it had when it
//    attached → bar pitch / yaw / roll. Finger flexion → rocking bars and grip
//    (MAPPING).
//  - Size and orientation come from the outline of the rigid palm in the image
//    (palmPose), not from MediaPipe's 3D landmarks: on a real recording those
//    shrank by a third and flipped between leaning forward and back whenever
//    the hand was seen at a slant, which is how a hand holding a cross is held.
//  - Everything is filtered with time-aware One Euro filters and held over
//    short dropouts, because raw landmarks jitter and hands vanish for frames.
//
// Frames: landmarks are first turned into DISPLAY coordinates (x mirrored for
// a camera that faces the player, see toDisplay), so that display right =
// stage +x in both modes; what else differs between the modes is in one place
// (HandTracker.facing).

export interface Point {
  x: number;
  y: number;
  z: number;
}

/** One detected hand as MediaPipe reports it (raw camera image, not mirrored) */
export interface HandFrame {
  /** 21 landmarks, normalized image coordinates (x right, y down) */
  image: Point[];
  /** 21 landmarks in metres around the hand's centre, same axes, z away from the camera */
  world: Point[];
  /** MediaPipe's label for the raw image; see playerHand() */
  handedness: "Left" | "Right";
  score: number;
}

// Landmark indices
const WRIST = 0;
const THUMB_MCP = 2;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const RING_MCP = 13;
const PINKY_MCP = 17;
const PALM = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP]; // rigid: steadier than any single joint
/** Bones of the hand skeleton (also drawn by the overlay) */
export const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
/**
 * The rigid palm as a flat shape: wrist and the four knuckles (PALM), x across
 * the palm, y from the wrist to the middle knuckle (= 1), centred. Measured on
 * a real hand held flat to the camera; length / width 1.32. Hands differ by a
 * few percent, which shows as a few degrees of tilt error, not as a jump.
 */
const PALM_SHAPE: [number, number][] = (() => {
  const shape: [number, number][] = [[0, 0], [-0.271, 0.929], [0, 1], [0.252, 0.95], [0.477, 0.807]];
  const mean = [0, 1].map((k) => shape.reduce((sum, p) => sum + p[k], 0) / shape.length);
  return shape.map(([x, y]) => [x - mean[0], y - mean[1]]);
})();
/** Knuckle and tip of each finger */
const FINGERS = { index: [5, 8], middle: [9, 12], ring: [13, 16], pinky: [17, 20] } as const;

// ---------------------------------------------------------------------------
// Tuning: every number that shapes the feel, in one place
// ---------------------------------------------------------------------------

/** Finger signals, each 0…1 */
export type Channel = "index" | "middle" | "ring" | "pinky" | "ringPinky" | "thumb" | "closed" | "fist" | "pinch";

interface RockMapping {
  /** rock = gain × (plus − minus), measured from the attach pose; the side each sits on gives the sign */
  plus: Channel;
  minus: Channel;
  gain: number;
  dead: number;
  /** Landmarks whose display x tells which side of the hand plus / minus are on */
  sides: [number, number];
}

/**
 * Which finger drives what. Rockers are differences of two finger signals, so
 * moving the whole hand or closing all fingers together leaves them at rest;
 * the bar end on the side of the curled finger goes up ("pull it up").
 */
export const MAPPING = {
  rock: {
    // "Walking fingers": index and middle alternate
    legs: { plus: "index", minus: "middle", gain: 1.8, dead: 0.08, sides: [INDEX_MCP, MIDDLE_MCP] },
    // Ring + pinky curl against tucking the thumb in
    head: { plus: "ringPinky", minus: "thumb", gain: 1.8, dead: 0.1, sides: [PINKY_MCP, THUMB_MCP] },
    // The hand bar is the second hand's: no finger of the cross hand rocks it
    hands: null,
  } as Record<"legs" | "head" | "hands", RockMapping | null>,
  /** Cross hand: a fist closes both puppet hands */
  grip: { channel: "fist" as Channel, on: 0.68, off: 0.5 },
  /** Second hand: pinch or fist takes the hand bar */
  grab: { channels: ["pinch", "fist"] as Channel[], on: 0.7, off: 0.45 },
  /**
   * Rockers fade out while all four fingers close ("closed" between these), so
   * that gripping, or a half-closed hand coming into view, does not make the puppet kick
   */
  fistFade: [0.42, 0.66] as [number, number], // well above an open hand (0 … 0.15)
};

interface FilterTuning {
  /** Hz: cutoff at rest (lower = steadier, more lag) */
  minCutoff: number;
  /** Cutoff gain per unit of speed (higher = less lag when moving) */
  beta: number;
}

export const TUNING = {
  filter: {
    palm: { minCutoff: 1.2, beta: 8 } as FilterTuning, // image heights
    angle: { minCutoff: 0.9, beta: 1.2 } as FilterTuning, // rad
    scale: { minCutoff: 0.6, beta: 1.5 } as FilterTuning, // log palm size: depth is the slowest move
    finger: { minCutoff: 1.5, beta: 3 } as FilterTuning, // 0…1
    landmark: { minCutoff: 2, beta: 12 } as FilterTuning, // drawing only
    outline: { minCutoff: 2, beta: 2 } as FilterTuning, // the palm's outline (dimensionless, ±1), before the lean is taken from it
  },
  /** Bar x / y: the inner part of the image spans the whole range, so the hand never has to leave the frame */
  position: { imageSpan: 0.8, x: 0.55, y: [0.35, 1.0] as [number, number] },
  /**
   * The player in front of the screen tips the hand forward (fingertips down):
   * true = the front of the cross goes down and the puppet bows, as with a real
   * cross in the hand (the hand is the cross, fingers at its front). false =
   * the cross tips the way the hand is seen to tip (its far end goes down).
   */
  tipForwardBows: true,
  /** Bar tilt, rad; yaw gets a larger dead zone: it rests on the noisiest landmark depth */
  tilt: {
    pitch: { gain: 1, max: 0.8, dead: 0.04 },
    roll: { gain: 1, max: 0.8, dead: 0.04 },
    yaw: { gain: 1, max: 1.0, dead: 0.07 },
  },
  depth: {
    /** m of stage depth per unit of log hand scale (hand 30 % closer ≈ 0.26 → 0.2 m) */
    gain: 0.75,
    /**
     * Palm speeds (image heights/s) between which the size measure is trusted
     * fully … hardly: MediaPipe's box lags a hand that moves across the image,
     * which reads as a few percent of false size change (measured: +6 %)
     */
    steady: [0.15, 0.6] as [number, number],
    range: [-0.2, 0.25] as [number, number], // set from the stage floor at start
    /** s: the baseline is the median hand scale over this window … */
    window: 10,
    /** … followed with this time constant, s: a quick reach moves the puppet, a new seat is absorbed */
    follow: 2.5,
    dead: 0.015, // log scale
  },
  roles: {
    /**
     * Frames thrown away after a hand is (re)detected: MediaPipe's first two
     * results come from the rough palm-detector box and are far off (measured:
     * size +30 %, tilt 0.5 rad), before its tracking has settled on the hand
     */
    warmup: 2,
    confirm: 0.1, // s a new hand must stay before it counts (ghost detections)
    hold: 0.5, // s a hand may vanish while its outputs are held
    release: 1.5, // s until a lost cross hand gives up its role
    gate: 0.3, // image heights a hand may jump between frames …
    gateSpeed: 1.5, // … plus this per second since it was seen
    handednessPenalty: 0.12, // image heights: a hint, not a rule (labels flicker)
    duplicate: 0.6, // palm lengths: two detections closer than this are one hand
  },
  attach: {
    /**
     * The rest pose (cross level) is the hand's own pose the first time it
     * holds still for this long, s. Until then a usual pose stands in (lean), so
     * the cross answers from the first frame: on a real session the player
     * moved for 11 s before pausing, and a pose taken on a timer caught the
     * hand on its way into a bow.
     */
    settle: 1.0,
    speed: 0.12, // "still": the palm slower than this, image heights/s …
    turn: 0.08, // … and its orientation not drifting: short and long average within this, rad
    /**
     * The stand-in: a palm held level in front of the screen, fingers towards
     * it, as a webcam below the hand sees it; rad from flat to the camera
     * (measured on a real session: 0.9)
     */
    lean: 0.9,
    ease: 0.5, // s: the cross moves over to a newly taken rest pose, it does not jump
  },
  /**
   * Hand lean (rad from flat to the camera) between which the palm's orientation
   * is taken from MediaPipe's 3D landmarks … from its outline in the image (palmPose)
   */
  pose: { flat: [0.3, 0.6] as [number, number] },
  /**
   * Hand lean (rad from flat to the camera) between which the rockers fade out
   * and above which the grip is held: fingers that point at the camera cannot
   * be read, they all look curled
   */
  flatFade: [1.2, 1.4] as [number, number],
  handBar: {
    /** Grab radius around the magnet point, in palm lengths of the cross hand (generous: landmarks of two near hands are shaky) */
    radius: 1.3,
    /** Image heights → m for the free bar; larger than the stage mapping, the puppet's arms are short */
    gain: 0.5,
    depthGain: 0.4,
    maxTurn: 1.5, // rad
  },
  /**
   * The cross as drawn on the hand: palm lengths per metre, and the fixed view
   * it is seen from, rad. Mostly from the side, so that the front tip, where
   * the second hand takes the hand bar, lies well clear of the cross hand:
   * MediaPipe loses hands that overlap.
   */
  gizmo: { scale: 18, elevation: 0.25, azimuth: 1.1, maxUnit: 0.22 }, // maxUnit: a hand close to the camera must not push the cross out of the picture (image heights per palm length)
};

// ---------------------------------------------------------------------------
// Small math (plain arrays: no allocation-heavy classes on the hot path)
// ---------------------------------------------------------------------------

type V3 = [number, number, number];
/** x, y, z, w */
export type Quat = [number, number, number, number];

const sub = (a: Point, b: Point): V3 => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: V3): V3 => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Dead zone without a step: zero inside, then continuous */
const deadZone = (v: number, dead: number) => Math.sign(v) * Math.max(0, Math.abs(v) - dead);

const quatMultiply = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const quatConjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
/** Normalized blend from a to b (short way round); fine for the small steps of a low-pass */
const quatBlend = (a: Quat, b: Quat, t: number): Quat => {
  const sign = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q = a.map((v, i) => v + (sign * b[i] - v) * t);
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

/** Unit quaternion of the rotation whose matrix columns are the orthonormal x, y, z */
function quatFromBasis(x: V3, y: V3, z: V3): Quat {
  const trace = x[0] + y[1] + z[2];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(y[2] - z[1]) * s, (z[0] - x[2]) * s, (x[1] - y[0]) * s, 0.25 / s];
  }
  if (x[0] > y[1] && x[0] > z[2]) {
    const s = 2 * Math.sqrt(1 + x[0] - y[1] - z[2]);
    return [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  }
  if (y[1] > z[2]) {
    const s = 2 * Math.sqrt(1 + y[1] - x[0] - z[2]);
    return [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  }
  const s = 2 * Math.sqrt(1 + z[2] - x[0] - y[1]);
  return [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s];
}

export interface Tilt {
  pitch: number;
  yaw: number;
  roll: number;
}

/**
 * Quaternion → rotation vector (axis × angle), its x / y / z named pitch / yaw
 * / roll. Not Euler angles: those lock up when the hand tilts towards 90°
 * (measured: yaw and roll jumped to ±2 rad while the hand only pitched).
 */
export function tiltFromQuat([x, y, z, w]: Quat): Tilt {
  if (w < 0) [x, y, z, w] = [-x, -y, -z, -w]; // the short way round
  const sin = Math.hypot(x, y, z);
  const k = sin < 1e-9 ? 2 : (2 * Math.atan2(sin, w)) / sin;
  return { pitch: x * k, yaw: y * k, roll: z * k };
}

/** Rotation vector → quaternion */
export function quatFromTilt({ pitch, yaw, roll }: Tilt): Quat {
  const angle = Math.hypot(pitch, yaw, roll);
  const k = angle < 1e-9 ? 0.5 : Math.sin(angle / 2) / angle;
  return [pitch * k, yaw * k, roll * k, Math.cos(angle / 2)];
}

/** Rotate a stage-frame vector by a tilt (rotation vector): for drawing the cross */
export function rotateByTilt(v: V3, tilt: Tilt): V3 {
  const [x, y, z, w] = quatFromTilt(tilt);
  const u: V3 = [x, y, z];
  const t = cross(u, v).map((c) => 2 * c) as V3;
  const s = cross(u, t);
  return [v[0] + w * t[0] + s[0], v[1] + w * t[1] + s[1], v[2] + w * t[2] + s[2]];
}

// ---------------------------------------------------------------------------
// One Euro filter (Casiez et al. 2012): a low-pass whose cutoff rises with
// speed, so a resting hand is steady and a moving hand does not lag. It uses
// the real time between samples: camera frames do not arrive evenly.
// ---------------------------------------------------------------------------

export class OneEuro {
  private value = 0;
  private rate = 0;
  private time = -1;
  private readonly tuning: FilterTuning;

  constructor(tuning: FilterTuning) {
    this.tuning = tuning;
  }

  /** t in seconds */
  filter(v: number, t: number) {
    if (this.time < 0 || t <= this.time) {
      if (this.time < 0) this.value = v;
      this.time = Math.max(this.time, t);
      return this.value;
    }
    const dt = t - this.time;
    this.time = t;
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const rate = (v - this.value) / dt;
    this.rate += alpha(1) * (rate - this.rate); // 1 Hz on the speed estimate
    this.value += alpha(this.tuning.minCutoff + this.tuning.beta * Math.abs(this.rate)) * (v - this.value);
    return this.value;
  }

  /** Speed of the filtered signal, units/s */
  get speed() {
    return Math.abs(this.rate);
  }

  reset() {
    this.time = -1;
    this.rate = 0;
  }
}

// ---------------------------------------------------------------------------
// Per-hand measurements (stateless)
// ---------------------------------------------------------------------------

/**
 * Raw camera frame → display frame. A camera that faces the player (mirror
 * on) shows them from the front, so the picture is flipped sideways: the
 * player then sees their hand as in a mirror and moves the puppet the way
 * they move the hand. Which side a finger is on flips with it, without any
 * further sign handling downstream.
 */
export function toDisplay(hand: HandFrame, mirror: boolean): HandFrame {
  if (!mirror) return hand;
  return {
    ...hand,
    image: hand.image.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })),
    world: hand.world.map((p) => ({ x: -p.x, y: p.y, z: p.z })),
  };
}

/**
 * The player's own hand. MediaPipe always gets the raw camera image here
 * (mirroring happens afterwards, in toDisplay), and on a raw image its label
 * is the subject's real hand: checked with @mediapipe/tasks-vision 1.2 on
 * its own test photos (left_hands.jpg → "Left"; the same photo flipped →
 * "Right"). Older MediaPipe docs say the opposite, for the legacy solution.
 */
export const playerHand = (handedness: "Left" | "Right"): "left" | "right" => (handedness === "Left" ? "left" : "right");

/** Palm centre in the image, x in image heights (aspect-corrected), and the palm's length there */
export function palmInImage(image: Point[], aspect: number) {
  let x = 0;
  let y = 0;
  for (const i of PALM) {
    x += image[i].x;
    y += image[i].y;
  }
  const length = Math.hypot((image[MIDDLE_MCP].x - image[WRIST].x) * aspect, image[MIDDLE_MCP].y - image[WRIST].y);
  return { x: (x / PALM.length) * aspect, y: y / PALM.length, length };
}

export interface PalmPose {
  /** Orientation of the palm, display-camera axes (x right, y down, z away from the camera) */
  quat: Quat;
  /** Palm length (wrist to middle knuckle) in the image as if seen flat, image heights: ∝ 1 / distance */
  scale: number;
  /** How far the palm leans away from flat to the camera, rad (0 … π/2) */
  lean: number;
  /** ±1: which way round the outline runs (left or right hand, palm or back towards the camera) */
  handed: number;
}

/**
 * Size and orientation of the palm from its outline in the image alone. The
 * rigid palm is a flat shape (PALM_SHAPE); seen at a slant it is squeezed
 * along one direction and keeps its size along the other. So the least-squares
 * map shape → image has the true size as its larger stretch, whatever the
 * slant, and the ratio of the two stretches is the cosine of the lean.
 *
 * What the outline cannot tell is which way the palm leans (towards the camera
 * or away look the same). A hand that holds a cross leans its fingers towards
 * the screen, so that is assumed; MediaPipe's 3D landmarks only decide while
 * the fingers do not clearly lean, and they give the whole orientation while
 * the palm is close to flat to the camera.
 *
 * handed: the result of the first frame of this hand, kept for its life (see
 * palmFit). Unfiltered: the tracker runs the two halves itself, with a filter
 * in between.
 */
export function palmPose(image: Point[], world: Point[], aspect: number, handed = 0): PalmPose {
  const fit = palmFit(image, aspect, handed);
  return { ...poseFromFit(fit.outline, world), scale: fit.scale, handed: fit.handed };
}

/** The palm's outline as a 2 × 2 map, size taken out: [xx, xy, yx, yy], columns = where "across" and "along" point in the image */
export type Outline = [number, number, number, number];

/**
 * First half of palmPose: the least-squares map shape → image, split into the
 * size and the rest. The tracker smooths the outline before the second half:
 * the lean is the arc cosine of a ratio near 1 for a palm flat to the camera,
 * which turns a little landmark noise into degrees unless it is filtered first.
 */
export function palmFit(image: Point[], aspect: number, handed = 0): { outline: Outline; scale: number; handed: number } {
  let [mx, my] = [0, 0];
  for (const i of PALM) {
    mx += image[i].x / PALM.length;
    my += image[i].y / PALM.length;
  }
  // Least squares: image ≈ M · shape, M = (Σ image shapeᵀ)(Σ shape shapeᵀ)⁻¹
  let [ixx, ixy, iyx, iyy, pxx, pxy, pyy] = [0, 0, 0, 0, 0, 0, 0];
  PALM.forEach((i, k) => {
    const [x, y] = [(image[i].x - mx) * aspect, image[i].y - my];
    const [px, py] = PALM_SHAPE[k];
    ixx += x * px;
    ixy += x * py;
    iyx += y * px;
    iyy += y * py;
    pxx += px * px;
    pxy += px * py;
    pyy += py * py;
  });
  const d = pxx * pyy - pxy * pxy;
  // Columns of M: where the shape's x (across the palm) and y (wrist → fingers) go in the image
  let m00 = (ixx * pyy - ixy * pxy) / d;
  const m01 = (ixy * pxx - ixx * pxy) / d;
  let m10 = (iyx * pyy - iyy * pxy) / d;
  const m11 = (iyy * pxx - iyx * pxy) / d;
  const { large: scale } = stretches(m00, m01, m10, m11);
  // The outline of the other hand runs the other way round: use the mirrored
  // shape for it. Chosen when the hand is first seen and then kept: a palm held
  // level is close to edge-on and may tip through it, which turns its outline
  // over; with the shape kept, the orientation simply carries on to the other side.
  if (!handed) handed = m00 * m11 - m01 * m10 < 0 ? -1 : 1;
  if (handed < 0) [m00, m10] = [-m00, -m10];
  return { outline: [m00 / scale, m01 / scale, m10 / scale, m11 / scale], scale, handed };
}

/** The larger stretch (singular value) of a 2 × 2 map, and smaller / larger */
function stretches(m00: number, m01: number, m10: number, m11: number) {
  const squares = m00 * m00 + m01 * m01 + m10 * m10 + m11 * m11;
  const det = m00 * m11 - m01 * m10;
  const large = Math.sqrt((squares + Math.sqrt(Math.max(0, squares * squares - 4 * det * det))) / 2) || 1e-6;
  return { large, ratio: Math.min(1, Math.abs(det) / (large * large)) };
}

/**
 * Second half of palmPose: orientation and lean from the (smoothed) outline.
 * steadyLean: a smoothed lean to choose between outline and 3D landmarks by,
 * so that one noisy frame does not swap the source.
 */
export function poseFromFit(outline: Outline, world: Point[], steadyLean?: number): { quat: Quat; lean: number } {
  // The larger stretch is the size (1 here, up to smoothing), the smaller one cos(lean)
  const { large, ratio: cosLean } = stretches(...outline);
  // Outline / size is the top two rows of the palm's rotation; the missing depth
  // components follow from unit length, up to one common sign
  const [a00, a01, a10, a11] = outline.map((v) => v / large);
  let z1 = Math.sqrt(Math.max(0, 1 - a00 * a00 - a10 * a10));
  let z2 = Math.sqrt(Math.max(0, 1 - a01 * a01 - a11 * a11));
  if (a00 * a01 + a10 * a11 > 0) z1 = -z1; // the two axes stay at right angles
  // MediaPipe's 3D landmarks in the same frame: along the fingers, across the
  // palm the way the outline runs (so that the third axis points to the same side of the camera)
  const alongWorld = normalize(sub(world[MIDDLE_MCP], world[WRIST]));
  let acrossWorld = sub(world[PINKY_MCP], world[INDEX_MCP]);
  const slant = dot(acrossWorld, alongWorld);
  acrossWorld = normalize([acrossWorld[0] - slant * alongWorld[0], acrossWorld[1] - slant * alongWorld[1], acrossWorld[2] - slant * alongWorld[2]]);
  if (cross(acrossWorld, alongWorld)[2] * (a00 * a11 - a01 * a10) < 0) acrossWorld = [-acrossWorld[0], -acrossWorld[1], -acrossWorld[2]];
  // The sign. Fingers that clearly lean are taken to lean towards the camera
  // (z2 < 0). While they do not (palm upright, or turned sideways), the 3D
  // landmarks say which side is nearer.
  const upright = 1 - smoothstep(0.2, 0.5, Math.abs(z2));
  if ((1 - upright) * -z2 + upright * (z1 * acrossWorld[2] + z2 * alongWorld[2]) < 0) [z1, z2] = [-z1, -z2];
  // The fingers' direction is kept, across is squared to it (as for the 3D frame above)
  const along = normalize([a01, a11, z2]);
  const k = a00 * along[0] + a10 * along[1] + z1 * along[2];
  const across = normalize([a00 - k * along[0], a10 - k * along[1], z1 - k * along[2]]);
  const lean = Math.acos(cosLean);
  let quat = quatFromBasis(across, along, cross(across, along));
  // Close to flat the outline hardly changes with the lean (cosine), so its
  // depth components are mostly noise there, while the 3D landmarks are at
  // their best: hand over to them.
  const flat = 1 - smoothstep(...TUNING.pose.flat, steadyLean ?? lean);
  if (flat > 0) quat = quatBlend(quat, quatFromBasis(acrossWorld, alongWorld, cross(acrossWorld, alongWorld)), flat);
  return { quat, lean };
}

/**
 * Rotation from one palm pose to another as a stage-frame tilt, for a player
 * who faces the camera from the far side of the stage (stage x = display x, y
 * up, z towards the audience and towards the camera). HandTracker turns it
 * round for a player in front of the screen.
 */
export function tiltBetween(from: Quat, to: Quat): Tilt {
  const { pitch, yaw, roll } = tiltFromQuat(quatMultiply(to, quatConjugate(from)));
  // Camera axes → stage axes is a half turn about x (y and z change sign)
  return { pitch, yaw: -yaw, roll: -roll };
}

/** Length of each straight finger, knuckle to tip, in palm lengths (measured on a real hand, as MediaPipe places the landmarks) */
const FINGER_LENGTH = { index: 1.0, middle: 1.08, ring: 1.0, pinky: 0.74 } as const;

/**
 * Finger signals, read in the image relative to the palm: every landmark is
 * mapped back into the palm's own flat frame (the inverse of the outline fit,
 * so the hand's size, turn and lean are taken out), and a finger's signal is
 * how far its tip has come back towards its knuckle.
 *
 * Not from MediaPipe's 3D landmarks: on a real recording their finger angles
 * shifted by 0.3 and the thumb measure by half its range whenever the hand
 * leaned, which rocked the head bar without a finger moving. In the palm's
 * frame the same session is flat except where a finger really curls.
 *
 * A hand seen edge-on cannot be read this way (the frame is squeezed to a
 * line, and every finger looks curled): the tracker fades the rockers and holds
 * the grip there (flatFade). For the fist the 3D landmarks (world, if given)
 * must agree as well: they are poor at how far a finger is curled, but they do
 * not mistake a flat hand for a fist.
 */
export function fingerChannels(image: Point[], aspect: number, fit = palmFit(image, aspect), world?: Point[]): Record<Channel, number> {
  const [a00, a01, a10, a11] = fit.outline;
  // Never divide by a palm squeezed to less than a fifth: beyond that the result is not used anyway
  const squeeze = a00 * a11 - a01 * a10;
  const det = (squeeze < 0 ? -1 : 1) * Math.max(0.2, Math.abs(squeeze)) * fit.scale;
  /** A landmark in the palm's frame: across the palm and along it (wrist → fingers), palm lengths */
  const inPalm = (i: number) => {
    const [x, y] = [(image[i].x - image[WRIST].x) * aspect, image[i].y - image[WRIST].y];
    return { across: (a11 * x - a01 * y) / det, along: (a00 * y - a10 * x) / det };
  };
  const curl = (finger: keyof typeof FINGERS) => {
    const [knuckle, tip] = FINGERS[finger];
    const extension = (inPalm(tip).along - inPalm(knuckle).along) / FINGER_LENGTH[finger];
    return clamp((0.92 - extension) / 0.8, 0, 1); // straight … tip back at the knuckle
  };
  const index = curl("index");
  const middle = curl("middle");
  const ring = curl("ring");
  const pinky = curl("pinky");
  const [thumbTip, indexTip, indexKnuckle] = [inPalm(THUMB_TIP), inPalm(INDEX_TIP), inPalm(INDEX_MCP)];
  return {
    index,
    middle,
    ring,
    pinky,
    // Against the other two fingers: four fingers closing together (a fist forming,
    // or a hand tipping towards edge-on, which looks the same) are not a signal
    ringPinky: Math.max(0, (ring + pinky) / 2 - Math.min(index, middle)),
    // How far the thumb tip sticks out sideways beyond the index knuckle (for the
    // mirrored outline "across" runs the other way). Measured on a real hand:
    // relaxed 0.83 palm lengths, tucked across the palm 0.28
    thumb: clamp((0.85 - fit.handed * (indexKnuckle.across - thumbTip.across)) / 0.6, 0, 1),
    // All four fingers in together, as the image shows it …
    closed: Math.min(index, middle, ring, pinky),
    // … and a fist, which the 3D landmarks have to confirm
    fist: Math.min(index, middle, ring, pinky, world ? fistInWorld(world) : 1),
    // Thumb tip to index tip: touching … half a palm length apart (touching tips coincide in any view)
    pinch: clamp(1 - Math.hypot(thumbTip.across - indexTip.across, thumbTip.along - indexTip.along) / 0.5, 0, 1),
  };
}

/** How closed the least curled finger is, from the 3D landmarks: 0 straight … 1 closed fist */
function fistInWorld(world: Point[]) {
  let fist = 1;
  for (const [knuckle, tip] of Object.values(FINGERS)) {
    // The angle between wrist → knuckle and knuckle → tip
    const [a, b] = [sub(world[knuckle], world[WRIST]), sub(world[tip], world[knuckle])];
    const swing = Math.acos(clamp(dot(a, b) / (length(a) * length(b) || 1), -1, 1));
    fist = Math.min(fist, clamp((swing - 0.3) / 1.6, 0, 1));
  }
  return fist;
}

/** On/off with two thresholds, so a value hovering at the edge does not flicker */
export function hysteresis(on: boolean, value: number, thresholds: { on: number; off: number }) {
  return on ? value > thresholds.off : value > thresholds.on;
}

/**
 * Where a point of the cross (main bar frame, stage axes, metres) is drawn,
 * as an offset from the cross hand's palm in palm lengths (display x right, y
 * down). A fixed view from the side and a little above: seen straight from
 * the front, as the camera sees the hand, the main bar would be a dot.
 */
export function projectCross(point: V3, tilt: Tilt, side: number): { x: number; y: number } {
  const { scale, elevation, azimuth } = TUNING.gizmo;
  const [x, y, z] = rotateByTilt(point, tilt);
  const [ca, sa, ce, se] = [Math.cos(azimuth * side), Math.sin(azimuth * side), Math.cos(elevation), Math.sin(elevation)];
  const x1 = x * ca + z * sa; // turn the view to the side …
  const z1 = -x * sa + z * ca;
  return { x: x1 * scale, y: -(y * ce - z1 * se) * scale }; // … and look down on it
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export interface HandView {
  /** 21 smoothed landmarks, display coordinates (x, y normalized) */
  landmarks: { x: number; y: number }[];
  /** Palm centre (x in image heights, i.e. normalized x × aspect) and palm length, image heights */
  palm: { x: number; y: number };
  palmLength: number;
  hand: "left" | "right";
  /** Not seen in this frame: outputs are held */
  held: boolean;
  channels: Record<Channel, number>;
}

export type TrackerStatus = "none" | "attached" | "lost";

export interface TrackerOutput {
  status: TrackerStatus;
  /** The rest pose is the hand's own (it has paused once, or N was pressed); until then a usual pose stands in */
  calibrated: boolean;
  cross?: HandView;
  second?: HandView;
  /** Main bar: stage metres and rad ("YXZ") */
  bar: { x: number; y: number; z: number } & Tilt;
  /** −1…1, to be scaled by each bar's limit */
  rock: { legs: number; head: number; hands: number };
  grip: boolean;
  depth: { scale: number; baseline: number };
  handBar: {
    detached: boolean;
    /** The second hand's grab strength 0…1 and whether it is within reach of the bar */
    grab: number;
    near: boolean;
    /** Movement since the grab: stage metres and rad */
    x: number;
    y: number;
    z: number;
    pitch: number;
    yaw: number;
    roll: number;
    /** Magnet point (where the bar sits on the cross as drawn) and grab radius: x in image heights, display frame */
    magnet: { x: number; y: number };
    radius: number;
    /** ±1: which way the drawn cross is turned, so that its front tip points into the free part of the picture */
    side: number;
    /** Size of the drawn cross: image heights per palm length */
    unit: number;
  };
}

interface Measurement {
  frame: HandFrame; // display frame
  palm: { x: number; y: number; length: number };
  aspect: number;
}

class Track {
  /** Last detection of any quality (roles are matched on it) */
  detected = -Infinity;
  /** First and last observation that counted (after the warm-up frames) */
  firstSeen: number;
  lastSeen: number;
  private warmup = 0;
  private valid = false;
  private rawScale = 0;
  handedness: "Left" | "Right";
  palm: { x: number; y: number; length: number };
  frame: HandFrame;
  // Filters, one per channel
  x = new OneEuro(TUNING.filter.palm);
  y = new OneEuro(TUNING.filter.palm);
  scale = new OneEuro(TUNING.filter.scale);
  pitch = new OneEuro(TUNING.filter.angle);
  yaw = new OneEuro(TUNING.filter.angle);
  roll = new OneEuro(TUNING.filter.angle);
  fingers = new Map<Channel, OneEuro>();
  landmarks = Array.from({ length: 42 }, () => new OneEuro(TUNING.filter.landmark));
  outline = Array.from({ length: 4 }, () => new OneEuro(TUNING.filter.outline));
  view: HandView;
  // Filtered measurements
  logScale = 0;
  /** Palm orientation, display-camera axes, and how far it leans away from flat to the camera (rad, smoothed) */
  quat: Quat = [0, 0, 0, 1];
  lean = 0;
  private handed = 0;
  /** Since when the hand has held still (palm and orientation): the rest pose waits for that */
  stillSince = Infinity;
  /** The same and the finger signals, averaged over a few tenths of a second: what a rest pose is taken from (one frame alone is noisy) */
  steadyQuat: Quat = [0, 0, 0, 1];
  /** A slower average still: a hand holds still while the two averages agree */
  private slowQuat: Quat = [0, 0, 0, 1];
  steadyChannels: Record<Channel, number>;

  constructor(m: Measurement, t: number) {
    this.firstSeen = this.lastSeen = t;
    this.handedness = m.frame.handedness;
    this.palm = m.palm;
    this.frame = m.frame;
    this.steadyChannels = fingerChannels(m.frame.image, m.aspect, undefined, m.frame.world);
    this.view = { landmarks: [], palm: m.palm, palmLength: m.palm.length, hand: "left", held: false, channels: this.steadyChannels };
  }

  /** Take a new detection: filter what every role needs. previous: time of the frame before this one */
  observe(m: Measurement, t: number, aspect: number, previous: number) {
    if (this.detected < previous) this.warmup = TUNING.roles.warmup; // new, or found again after a gap
    this.detected = t;
    this.palm = m.palm;
    this.frame = m.frame;
    if (this.warmup > 0) {
      this.warmup--;
      if (!this.valid) this.firstSeen = this.lastSeen = t; // a new hand's time counts from its first good frame
      return;
    }
    const dt = t - this.lastSeen;
    this.lastSeen = t;
    // The label flickers on hard poses: follow it slowly, so one wrong frame does not count
    if (m.frame.score > 0.8) this.handedness = m.frame.handedness;
    const { image, world } = m.frame;
    const fit = palmFit(image, aspect, this.handed);
    this.handed = fit.handed;
    const raw = fingerChannels(image, aspect, fit, world);
    const channels = {} as Record<Channel, number>;
    for (const key of Object.keys(raw) as Channel[]) {
      let filter = this.fingers.get(key);
      if (!filter) this.fingers.set(key, (filter = new OneEuro(TUNING.filter.finger)));
      channels[key] = filter.filter(raw[key], t);
      this.steadyChannels[key] += (raw[key] - this.steadyChannels[key]) * (1 - Math.exp(-dt / 0.25));
    }
    const pose = poseFromFit(fit.outline.map((v, i) => this.outline[i].filter(v, t)) as Outline, world, this.valid ? this.lean : undefined);
    // Size: taken with less weight while the hand moves across the image (TUNING.depth.steady)
    const size = Math.log(fit.scale);
    const [slow, fast] = TUNING.depth.steady;
    const trust = clamp(1 - (this.palmSpeed - slow) / (fast - slow), 0.1, 1);
    this.rawScale = this.valid ? this.rawScale + (size - this.rawScale) * (trust < 1 ? 1 - Math.exp((-dt * trust) / 0.1) : 1) : size;
    this.logScale = this.scale.filter(this.rawScale, t);
    this.quat = pose.quat;
    this.steadyQuat = this.valid ? quatBlend(this.steadyQuat, this.quat, 1 - Math.exp(-dt / 0.15)) : this.quat;
    this.slowQuat = this.valid ? quatBlend(this.slowQuat, this.quat, 1 - Math.exp(-dt / 0.5)) : this.quat;
    this.lean = this.valid ? this.lean + (pose.lean - this.lean) * (1 - Math.exp(-dt / 0.15)) : pose.lean;
    if (!this.valid) this.steadyChannels = { ...raw };
    this.valid = true;
    this.view = {
      landmarks: image.map((p, i) => ({ x: this.landmarks[2 * i].filter(p.x, t), y: this.landmarks[2 * i + 1].filter(p.y, t) })),
      palm: { x: this.x.filter(m.palm.x, t), y: this.y.filter(m.palm.y, t) },
      // The size as if seen flat, not the 2D length: the drawn cross does not shrink when the hand tilts
      palmLength: Math.exp(this.logScale),
      hand: playerHand(this.handedness),
      held: false,
      channels,
    };
    // Not frame against average: single frames are too noisy to ever count as still
    const turned = 2 * Math.acos(Math.min(1, Math.abs(quatMultiply(this.steadyQuat, quatConjugate(this.slowQuat))[3])));
    const still = this.palmSpeed < TUNING.attach.speed && turned < TUNING.attach.turn;
    if (!still) this.stillSince = Infinity;
    else if (this.stillSince === Infinity) this.stillSince = t;
  }

  get palmSpeed() {
    return Math.hypot(this.x.speed, this.y.speed);
  }
}

interface Neutral {
  /** The rest pose in use; it eases towards target when a new one is taken */
  quat: Quat;
  target: Quat;
  /** The hand's own pose (after its first pause, or N), not the stand-in */
  own: boolean;
  /** plus − minus of each rocker at rest, and the side (±1) its plus finger is on */
  rock: Record<string, { offset: number; side: number }>;
}

export class HandTracker {
  /**
   * The camera faces the player, who sits in front of the screen (the usual
   * case: a webcam). The picture is mirrored (toDisplay) and the hand moves
   * the cross the way the player sees their own hand move: right is right,
   * pushing the hand towards the screen pushes the puppet upstage, and the
   * cross tilts as the hand does. Off: the camera looks from the player's own
   * side (a phone's back camera), or the player stands behind the stage facing
   * the audience; the same mapping turned half round about the vertical.
   */
  mirror = true;
  private cross?: Track;
  private second?: Track;
  private neutral?: Neutral;
  private baseline = 0;
  private scaleWindow: { t: number; v: number }[] = [];
  private lastTime = -1;
  private previousTime = -Infinity;
  private grip = false;
  private closed = false;
  private grabbing = false;
  private grabStart?: { palm: { x: number; y: number }; logScale: number; quat: Quat };
  /** Where the hand bar sits on the main bar (stage axes, m from the main bar's pivot); set from the rig */
  frontTip: V3 = [0, 0, 0.1395];
  private readonly out: TrackerOutput = {
    status: "none",
    calibrated: false,
    bar: { x: 0, y: 0.62, z: 0, pitch: 0, yaw: 0, roll: 0 },
    rock: { legs: 0, head: 0, hands: 0 },
    grip: false,
    depth: { scale: 0, baseline: 0 },
    handBar: { detached: false, grab: 0, near: false, x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, magnet: { x: 0, y: 0 }, radius: 0, side: 1, unit: 0.1 },
  };

  /** Take the current hand pose as the cross's level rest pose again */
  recenter() {
    if (this.cross && this.neutral) this.takeRestPose(this.cross, true);
  }

  /** The cross hand's current pose becomes the rest pose (cross level, rockers level) */
  private takeRestPose(track: Track, own: boolean) {
    const rock: Neutral["rock"] = {};
    for (const [name, map] of Object.entries(MAPPING.rock)) {
      if (!map) continue;
      const [plus, minus] = map.sides;
      rock[name] = {
        offset: own ? track.steadyChannels[map.plus] - track.steadyChannels[map.minus] : 0, // not used before the own pose
        side: Math.sign(track.view.landmarks[plus].x - track.view.landmarks[minus].x) || 1,
      };
    }
    // The stand-in: upright in the picture and leaning its fingers towards the camera (same frame as palmPose)
    const lean = TUNING.attach.lean;
    const target = own ? track.steadyQuat : quatFromBasis([-1, 0, 0], [0, -Math.cos(lean), -Math.sin(lean)], [0, -Math.sin(lean), Math.cos(lean)]);
    this.neutral = { quat: this.neutral?.quat ?? target, target, own, rock };
  }

  /**
   * One camera frame: timeMs is the frame's timestamp, hands are MediaPipe's
   * detections in any order, aspect is image width / height.
   */
  update(timeMs: number, hands: HandFrame[], aspect: number): TrackerOutput {
    const t = timeMs / 1000;
    const dt = this.lastTime < 0 ? 0 : Math.max(0, t - this.lastTime);
    this.lastTime = t;
    this.assign(t, hands, aspect);
    this.updateCross(t, dt, aspect);
    this.updateSecond(t, aspect);
    return this.out;
  }

  // Hand roles. MediaPipe has no persistent ids and its result order changes
  // from frame to frame, so each detection goes to the role whose hand was
  // last seen nearest to it; the handedness label only breaks ties.
  private assign(t: number, hands: HandFrame[], aspect: number) {
    const roles = TUNING.roles;
    let detections: Measurement[] = hands
      .map((hand) => toDisplay(hand, this.mirror))
      .map((frame) => ({ frame, palm: palmInImage(frame.image, aspect), aspect }));
    // The palm detector sometimes reports one hand twice, and the copy is often
    // a wrong pose with a high score (seen on a hand held edge-on: mirrored
    // label, landmarks far off). Keep the one that continues a hand we track.
    const continues = (d: Measurement) => {
      let best = Infinity;
      for (const track of [this.cross, this.second]) {
        if (!track || t - track.detected > 0.2) continue;
        let moved = 0;
        d.frame.image.forEach((p, i) => (moved += Math.hypot((p.x - track.frame.image[i].x) * aspect, p.y - track.frame.image[i].y)));
        best = Math.min(best, moved / d.frame.image.length);
      }
      return best;
    };
    const order = new Map(detections.map((d) => [d, continues(d)]));
    detections.sort((a, b) => order.get(a)! - order.get(b)! || b.frame.score - a.frame.score);
    detections = detections.filter(
      (d, i) => !detections.slice(0, i).some((e) => Math.hypot(d.palm.x - e.palm.x, d.palm.y - e.palm.y) < roles.duplicate * e.palm.length),
    );

    const cost = (track: Track | undefined, d: Measurement) => {
      if (!track) return Infinity;
      const jump = Math.hypot(d.palm.x - track.palm.x, d.palm.y - track.palm.y);
      if (jump > roles.gate + roles.gateSpeed * (t - track.detected)) return Infinity;
      return jump + (d.frame.handedness === track.handedness ? 0 : roles.handednessPenalty);
    };
    // At most 2 × 2: try both pairings and keep the cheaper one
    let best: { total: number; cross?: Measurement; second?: Measurement } = { total: Infinity };
    const options = [undefined, ...detections];
    for (const c of options) {
      for (const s of options) {
        if (c && c === s) continue;
        // An unmatched role costs as much as the largest allowed jump
        const total = (c ? cost(this.cross, c) : this.cross ? roles.gate : 0) + (s ? cost(this.second, s) : this.second ? roles.gate : 0);
        if (total < best.total) best = { total, cross: c, second: s };
      }
    }
    const previous = this.previousTime;
    this.previousTime = t;
    if (best.cross) this.cross!.observe(best.cross, t, aspect, previous);
    if (best.second) this.second!.observe(best.second, t, aspect, previous);
    const fresh = detections.filter((d) => d !== best.cross && d !== best.second);

    // A hand that has not yet stayed for `confirm` and is missing again was a ghost
    const ghost = (track?: Track) => track && track.detected < t && track.lastSeen - track.firstSeen < roles.confirm;
    if (ghost(this.cross)) this.dropCross();
    if (ghost(this.second)) this.dropSecond();
    // Lost for good
    if (this.cross && t - this.cross.lastSeen > roles.release) this.dropCross();
    if (this.second && t - this.second.lastSeen > roles.hold) this.dropSecond();

    for (const d of fresh) {
      const lostCross = this.cross && t - this.cross.lastSeen > roles.hold;
      if (!this.cross) {
        // The only hand in view is always the cross hand: a remaining second hand moves up
        if (this.second) {
          this.cross = this.second;
          this.dropSecond();
          this.cross.firstSeen = t; // settle and take a new rest pose
          this.neutral = undefined;
          this.second = new Track(d, t);
          this.second.observe(d, t, aspect, previous);
        } else {
          this.cross = new Track(d, t);
          this.cross.observe(d, t, aspect, previous);
        }
      } else if (lostCross && (!this.second || d.frame.handedness === this.cross.handedness)) {
        // The cross hand comes back somewhere else (it left the frame): same role, same rest pose
        this.cross.observe(d, t, aspect, previous);
      } else if (!this.second) {
        this.second = new Track(d, t);
        this.second.observe(d, t, aspect, previous);
      }
    }
    // No cross hand left: the second hand takes over (after the cross hand's release time)
    if (!this.cross && this.second) {
      this.cross = this.second;
      this.dropSecond();
      this.cross.firstSeen = t;
      this.neutral = undefined;
    }
  }

  /**
   * Stage +z per unit of the hand coming closer to the camera. The player in
   * front of the screen (mirror) reaches towards the screen, so the puppet goes
   * upstage; a camera on the player's own side sees the hand move away then.
   */
  private get forward() {
    return this.mirror ? -1 : 1;
  }

  /**
   * tiltBetween is for a player on the far side of the stage. The player in
   * front of the screen is that turned half round about the vertical, and
   * their picture is mirrored: together that flips pitch and yaw (see the
   * architecture doc, "MediaPipe hands"), so the cross turns and rolls as
   * they see their hand do. Pitch is flipped back by default: the hand is the
   * cross (TUNING.tipForwardBows).
   */
  private facing(tilt: Tilt): Tilt {
    if (!this.mirror) return tilt;
    return { pitch: TUNING.tipForwardBows ? tilt.pitch : -tilt.pitch, yaw: -tilt.yaw, roll: tilt.roll };
  }

  private dropCross() {
    this.cross = undefined;
    this.neutral = undefined;
    this.scaleWindow = [];
    this.grip = false;
  }

  private dropSecond() {
    this.second = undefined;
    this.closed = this.grabbing = false;
    this.grabStart = undefined;
  }

  private updateCross(t: number, dt: number, aspect: number) {
    const out = this.out;
    const track = this.cross;
    const active = track && track.lastSeen - track.firstSeen >= TUNING.roles.confirm;
    if (!track || !active) {
      // No hand: the cross stays where it is, the rockers go level
      out.status = "none";
      out.cross = undefined;
      out.rock.legs = out.rock.head = out.rock.hands = 0;
      out.grip = false;
      return;
    }
    out.cross = track.view;
    const seen = track.lastSeen === t;
    track.view.held = !seen;
    if (!seen) {
      // Short dropout: hold every output; past that the rockers go level and the grip opens
      if (t - track.lastSeen > TUNING.roles.hold) {
        out.status = "lost";
        out.rock.legs = out.rock.head = out.rock.hands = 0;
        out.grip = this.grip = false;
      }
      return;
    }

    // Position: always live, also before the rest pose is taken
    const position = TUNING.position;
    const view = track.view;
    out.bar.x = clamp(((view.palm.x / aspect - 0.5) / position.imageSpan) * 2 * position.x, -position.x, position.x);
    const [yMin, yMax] = position.y;
    out.bar.y = clamp((yMin + yMax) / 2 + ((0.5 - view.palm.y) / position.imageSpan) * (yMax - yMin), yMin, yMax);

    // Rest pose: a usual pose at once, the hand's own the first time it pauses
    if (!this.neutral) {
      this.takeRestPose(track, false);
      this.baseline = track.logScale;
      this.scaleWindow = [];
      for (const filter of [track.pitch, track.yaw, track.roll]) filter.reset();
    }
    if (!this.neutral!.own && t - track.stillSince >= TUNING.attach.settle) this.takeRestPose(track, true);
    const neutral = this.neutral!;
    neutral.quat = quatBlend(neutral.quat, neutral.target, 1 - Math.exp(-dt / TUNING.attach.ease));
    out.calibrated = neutral.own;
    out.status = "attached";
    // The drawn cross points into the free part of the picture; it only turns over
    // when the hand is well on the other side, and never under a second hand
    const across = view.palm.x / aspect;
    if (!this.second && Math.abs(across - 0.5) > 0.12) out.handBar.side = across < 0.5 ? 1 : -1;

    // Tilt against the rest pose
    const tilt = this.facing(tiltBetween(neutral.quat, track.quat));
    for (const axis of ["pitch", "yaw", "roll"] as const) {
      const { gain, max, dead } = TUNING.tilt[axis];
      out.bar[axis] = clamp(gain * deadZone(track[axis].filter(clamp(tilt[axis], -1.5, 1.5), t), dead), -max, max);
    }

    // Depth: hand scale against the slowly following median of the last seconds
    const depth = TUNING.depth;
    const window = this.scaleWindow;
    if (!window.length || t - window[window.length - 1].t >= 0.1) window.push({ t, v: track.logScale });
    while (window.length && t - window[0].t > depth.window) window.shift();
    const sorted = window.map((s) => s.v).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.baseline += (median - this.baseline) * (1 - Math.exp(-dt / depth.follow));
    out.depth.scale = track.logScale;
    out.depth.baseline = this.baseline;
    out.bar.z = clamp(this.forward * depth.gain * deadZone(track.logScale - this.baseline, depth.dead), depth.range[0], depth.range[1]);

    // Fingers
    // The rockers wait for the hand's own rest pose: how a relaxed thumb and
    // fingers read differs from hand to hand and with the lean, so the stand-in
    // has no zero for them (on a real session the head bar sat at full rock until the first pause)
    const fade =
      (neutral.own ? 1 : 0) *
      (1 - smoothstep(MAPPING.fistFade[0], MAPPING.fistFade[1], view.channels.closed)) *
      (1 - smoothstep(TUNING.flatFade[0], TUNING.flatFade[1], track.lean));
    for (const [name, map] of Object.entries(MAPPING.rock) as [keyof TrackerOutput["rock"], RockMapping | null][]) {
      if (!map) {
        out.rock[name] = 0;
        continue;
      }
      const rest = neutral.rock[name];
      const value = view.channels[map.plus] - view.channels[map.minus] - rest.offset;
      out.rock[name] = clamp(rest.side * fade * map.gain * deadZone(value, map.dead), -1, 1);
    }
    // A hand seen edge-on looks like a fist: the grip keeps its state there, so a bow does not drop the prop
    if (track.lean < TUNING.flatFade[0]) this.grip = hysteresis(this.grip, view.channels[MAPPING.grip.channel], MAPPING.grip);
    out.grip = this.grip;
  }

  private updateSecond(t: number, aspect: number) {
    const bar = this.out.handBar;
    const cross = this.cross;
    const track = this.second;
    // The magnet point: the main bar's front tip as the overlay draws it on the cross hand
    if (cross) {
      const tip = projectCross(this.frontTip, this.out.bar, bar.side);
      bar.unit = Math.min(cross.view.palmLength, TUNING.gizmo.maxUnit);
      bar.magnet = { x: cross.view.palm.x + tip.x * bar.unit, y: cross.view.palm.y + tip.y * bar.unit };
      bar.radius = TUNING.handBar.radius * bar.unit;
    }
    const active = track && track.lastSeen - track.firstSeen >= TUNING.roles.confirm;
    this.out.second = active ? track.view : undefined;
    if (!track || !active || !cross || this.out.status === "none") {
      bar.detached = this.closed = this.grabbing = false;
      bar.grab = 0;
      bar.near = false;
      return;
    }
    track.view.held = track.lastSeen !== t;
    if (track.view.held) return; // hold the bar where it is over a short dropout

    const view = track.view;
    // Touching fingertips can be seen from any side, a fist cannot (an edge-on hand looks like one)
    const readable = 1 - smoothstep(TUNING.flatFade[0], TUNING.flatFade[1], track.lean);
    bar.grab = Math.max(...MAPPING.grab.channels.map((c) => view.channels[c] * (c === "fist" ? readable : 1)));
    // The fingers that take the bar: between thumb tip and index tip
    const [thumb, index] = [view.landmarks[THUMB_TIP], view.landmarks[INDEX_TIP]];
    const reach = Math.hypot(((thumb.x + index.x) / 2) * aspect - bar.magnet.x, (thumb.y + index.y) / 2 - bar.magnet.y);
    bar.near = reach < bar.radius;

    // The hand has to close within reach of the bar: a fist passing by takes nothing
    const closed = hysteresis(this.closed, bar.grab, MAPPING.grab);
    if (closed && !this.closed && bar.near && this.out.status === "attached") {
      // Everything is measured from this moment, so the bar does not jump when it is taken
      this.grabbing = true;
      this.grabStart = { palm: { ...view.palm }, logScale: track.logScale, quat: track.steadyQuat };
      for (const filter of [track.pitch, track.yaw, track.roll]) filter.reset();
    } else if (!closed) {
      this.grabbing = false;
    }
    this.closed = closed;
    bar.detached = this.grabbing;
    if (!this.grabbing || !this.grabStart) return;

    const tuning = TUNING.handBar;
    bar.x = (view.palm.x - this.grabStart.palm.x) * tuning.gain;
    bar.y = -(view.palm.y - this.grabStart.palm.y) * tuning.gain;
    bar.z = this.forward * (track.logScale - this.grabStart.logScale) * tuning.depthGain;
    const tilt = this.facing(tiltBetween(this.grabStart.quat, track.quat));
    bar.pitch = track.pitch.filter(clamp(tilt.pitch, -tuning.maxTurn, tuning.maxTurn), t);
    bar.yaw = track.yaw.filter(clamp(tilt.yaw, -tuning.maxTurn, tuning.maxTurn), t);
    bar.roll = track.roll.filter(clamp(tilt.roll, -tuning.maxTurn, tuning.maxTurn), t);
  }
}
