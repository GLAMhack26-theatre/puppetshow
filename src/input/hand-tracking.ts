// Hand tracking → marionette control, as pure functions and one small state
// machine (no DOM, no camera, no three.js: runs under plain Node for
// scripts/test-hand-tracking.ts). MediaPipe hand landmarks in, a plain
// TrackerOutput out; src/input/mediapipe.ts feeds it and writes ControlInput.
//
// How a hand drives the cross (docs/architecture.md §3.1):
//  - The first hand seen is the cross hand; a second hand can take the hand bar
//    or the head bar at its end, or push against the back string.
//  - Palm centre → bar x; the hand's height in metres against the height at
//    which the puppet stands (a player's setting) → bar y. Palm size in the
//    image against its size at the rest pose → bar z. Palm orientation relative
//    to its rest pose → bar pitch / yaw / roll. Finger flexion → leg bar and
//    grip, thumb and index closing → the head goes forward (MAPPING).
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
const PALM_OUTLINE: [number, number][] = [[0, 0], [-0.271, 0.929], [0, 1], [0.252, 0.95], [0.477, 0.807]];
/** Its centroid: where the palm centre (palmInImage) lies, seen from the wrist */
const PALM_CENTRE = [0, 1].map((k) => PALM_OUTLINE.reduce((sum, p) => sum + p[k], 0) / PALM_OUTLINE.length);
const PALM_SHAPE: [number, number][] = PALM_OUTLINE.map(([x, y]) => [x - PALM_CENTRE[0], y - PALM_CENTRE[1]]);
/** Knuckle and tip of each finger */
const FINGERS = { index: [5, 8], middle: [9, 12], ring: [13, 16], pinky: [17, 20] } as const;

// ---------------------------------------------------------------------------
// Tuning: every number that shapes the feel, in one place
// ---------------------------------------------------------------------------

/** Finger signals, each 0…1 */
export type Channel = "index" | "middle" | "ring" | "pinky" | "ringPinky" | "thumb" | "closed" | "fist" | "pinch";
export type Finger = "index" | "middle" | "ring" | "pinky";

interface RockMapping {
  /** rock = gain × (plus − minus), measured from the rest pose; the side each sits on gives the sign */
  plus: Finger;
  minus: Finger;
  /**
   * Per rad, while the plus finger is bent further … while the minus finger is.
   * 2.2 with the dead zone below = full rock for a finger bent 30° further than
   * the other; 4 = at 18°
   */
  gain: [number, number];
  /** rad */
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
    // "Walking fingers": index and middle alternate. The middle finger counts
    // for more: bent on its own it does not go far (on a real session it read
    // 0.2…0.55 rad where the index read 0.5…1.0), so with one gain for both its
    // leg hardly ever reached a full step
    legs: { plus: "index", minus: "middle", gain: [2.2, 4], dead: 0.06, sides: [INDEX_MCP, MIDDLE_MCP] },
    // Head bar and hand bar are the second hand's: no finger of the cross hand rocks them
    head: null,
    hands: null,
  } as Record<"legs" | "head" | "hands", RockMapping | null>,
  /**
   * Thumb tip towards index tip: the head goes forward, the closer the more.
   * The gap between the two tips is measured in the image against its width at
   * the rest pose (1 = as at rest, 0 = touching). dead: how much of the way
   * does not count (the gap changes by a fifth with every move of the thumb or
   * a step of the index; measured on a real session), and `still` more of it
   * while the thumb has not moved: a deeply bent index alone comes close to the
   * thumb too. full: the head is fully forward (tips that touch still read as
   * 0.15…0.25 palm lengths apart); minRest: palm lengths, the least gap a rest
   * pose is taken to have.
   * closing: the nod fades out while the other three fingers close as well (a
   * fist puts the thumb on the index too), rad.
   * legs: the leg bar fades out over this part of the way: a pinch bends the
   * index, which is a step otherwise. Sooner (legsThumb) while the thumb has
   * moved in the palm by `thumb` palm lengths (not at all … for sure): then it
   * is a pinch and not a step. (On a real session without a pinch the thumb
   * read as moved by up to 0.2 while the hand tilted, and by 0.4…0.6 when it
   * was tucked in; a step closed the gap by 0.15…0.25.) Rather late than
   * early: a hand turned away from its rest pose reads as a little closed and
   * its thumb as a little moved, and steps must not die there; the price is
   * that the leg bar twitches on the way into a pinch.
   */
  nod: {
    dead: 0.3, still: 0.15, full: 0.75, minRest: 0.5, closing: [0.4, 0.7] as [number, number],
    legs: [0.35, 0.6] as [number, number], legsThumb: [0.2, 0.4] as [number, number], thumb: [0.2, 0.35] as [number, number],
  },
  /** Cross hand: a fist closes both puppet hands */
  grip: { channel: "fist" as Channel, on: 0.68, off: 0.5 },
  /**
   * Second hand: pinch or fist takes a bar at its handle. It keeps the bar
   * until it is seen open: the four fingers curled by less than `open` on
   * average and no pinch. Not "until the fist reading drops": a fist that
   * moves or turns reads as open for moments (it needs the 3D landmarks to
   * agree, and cannot be read edge-on), which let the bar go and took the next
   * one the fist came by.
   */
  grab: { channels: ["pinch", "fist"] as Channel[], on: 0.7, off: 0.45, open: 0.35 },
  /**
   * Rockers fade out while all four fingers bend together (the least bent one
   * between these, rad from its rest), so that gripping does not make the puppet
   * kick. Not sooner (say, on three fingers): the ring finger goes along with
   * the middle finger on many hands.
   */
  fistFade: [0.25, 0.45] as [number, number],
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
    fingerWorld: { minCutoff: 0.7, beta: 1.2 } as FilterTuning, // rad: finger angles from the 3D landmarks, whose depth is their noisiest part
    landmark: { minCutoff: 2, beta: 12 } as FilterTuning, // drawing only
    outline: { minCutoff: 2, beta: 2 } as FilterTuning, // the palm's outline (dimensionless, ±1), before the lean is taken from it
    /**
     * A small hand (far from the camera) is filtered harder: the same pixel of
     * landmark noise is a larger share of the palm, so the tilt and the finger
     * angles shake more the further away the hand is. Below `palm` (palm length
     * in image heights; 0.12 = 58 px of a 480 px picture) the cutoffs of the
     * outline, finger and tilt filters shrink with the palm, down to `least`
     * of their value.
     */
    small: { palm: 0.12, least: 0.35 },
    /**
     * Single frames that are far off (a wrist or a fingertip that jumps and is
     * back in the next frame) are left out: a palm outline that differs from
     * the smoothed one by more than `outline` (dimensionless), or a finger by
     * more than `finger` (palm lengths), per 1/30 s, is not taken unless it
     * stays for more than `frames` frames. A real move that fast only arrives
     * that much later.
     */
    glitch: { outline: 0.3, finger: 0.35, frames: 2 },
  },
  position: {
    /** Bar x: the inner part of the image spans the whole range, so the hand never has to leave the frame */
    imageSpan: 0.8,
    x: 0.55,
    /**
     * Bar y follows the hand's real height: with the hand at the standing
     * height (HandTracker.standHeight, the player's slider) the cross is at its
     * rest height and the puppet just stands; below it the strings go slack,
     * above it they lift the puppet. The hand's height in metres comes from the
     * picture and the palm's size in it (a palm of gizmo.palm metres that is s
     * image heights long is (0.5 − y) · palm / s metres above the camera's
     * axis), so a step towards the camera does not change it.
     * camera: how high the camera is taken to be above the floor, m (the one
     * thing the picture cannot tell; the slider makes up for it).
     * yGain: m of cross per m of hand; down / up: how far the cross may go
     * below (the puppet sinks down) and above its rest height, m
     */
    camera: 1,
    yGain: 1,
    down: 0.25,
    up: 0.4,
  },
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
     * Palm speeds (palm lengths/s) between which the size measure is trusted
     * fully … hardly: MediaPipe's box lags a hand that moves across the image,
     * which reads as a few percent of false size change (measured: +6 %)
     */
    steady: [0.8, 3.2] as [number, number],
    range: [-0.2, 0.25] as [number, number], // set from the stage floor at start
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
    /**
     * "Still": the palm slower than this, palm lengths/s … In palm lengths, not
     * in image heights: a hand three times further away moves a third as fast
     * across the picture, counted as still all the time and had its rest pose
     * taken in the middle of a bow (a real session replayed at a third of its size)
     */
    speed: 0.63,
    turn: 0.08, // … and its orientation not drifting: short and long average within this, rad
    /**
     * The stand-in: a palm held level in front of the screen, fingers towards
     * it, as a webcam below the hand sees it; rad from flat to the camera
     * (measured on a real session: 0.9)
     */
    lean: 0.9,
    ease: 0.5, // s: the cross moves over to a newly taken rest pose, it does not jump
    /** s after reset() until the hand's pose is taken as the rest pose: its averages have to fill again first */
    reset: 0.4,
    /**
     * A hand that attaches, or comes back after `gap` s without it, finds the
     * cross where it was left: level, or wherever the hand vanished. The cross
     * goes over to the hand within `blend` s. (Measured on a real session: at
     * the first frame the cross jumped 0.4 rad, and so at every re-attach.)
     */
    blend: 0.6,
    gap: 0.25,
  },
  /**
   * Hand lean (rad from flat to the camera) between which the palm's orientation
   * is taken from MediaPipe's 3D landmarks … from its outline in the image (palmPose)
   */
  pose: { flat: [0.3, 0.6] as [number, number] },
  /**
   * Hand lean (rad from flat to the camera) above which a fist cannot be told
   * from an open hand in the image (fingers that point at the camera all look
   * curled): the grip keeps its state there, and the second hand's fist does not count
   */
  flatFade: [1.2, 1.4] as [number, number],
  /**
   * Hand lean between which the rockers fade out. Later than flatFade: the
   * finger angles (fingerFlexion) hold until the palm is nearly a line
   */
  rockFade: [1.35, 1.5] as [number, number],
  /**
   * A palm flat to the camera (an open hand shown to it): a finger bending
   * towards the camera hardly changes its length in the image there, so the
   * angle taken from the image (fingerFlexion) is mostly noise for small bends,
   * and the first version put a dead zone of 0.25 rad on it: walking fingers
   * were not read unless bent a long way. Below these leans the angle comes
   * from MediaPipe's 3D landmarks instead (fingerFlexionWorld; flat-on is where
   * they are at their best, as for the palm's orientation), fading over to the
   * image between them. extra: the dead zone that is left there, rad.
   */
  flatDead: { extra: 0.1, lean: [0.3, 0.6] as [number, number] },
  handBar: {
    /** Grab radius around a bar's handle, in palm lengths of the cross hand (generous: landmarks of two near hands are shaky) */
    radius: 0.9,
    /** Image heights → m for the free bar; larger than the stage mapping, the puppet's arms are short */
    gain: 0.5,
    depthGain: 0.4,
    maxTurn: 1.5, // rad
    /**
     * s the second hand has to be seen open (MAPPING.grab.open) before a bar is
     * let go: its pinch reading dips for a frame or two while it moves, which
     * used to drop the bar
     */
    release: 0.3,
    /** s: the head bar goes level again when the second hand lets it go, it does not jump */
    blend: 0.25,
  },
  /**
   * The cross as drawn on the cross hand: it lies in the palm, rear end at the
   * wrist, front tip at the fingertips. palm: m from wrist to middle knuckle
   * (the cross is drawn at the hand's own scale); maxUnit: a hand close to the
   * camera must not push the cross out of the picture (image heights per palm
   * length). handle: the second hand takes a bar this far out from the main
   * bar, m: beyond the bars' ends and clear of the cross hand's outline and
   * thumb, MediaPipe loses hands that overlap.
   */
  gizmo: { palm: 0.095, maxUnit: 0.22, handle: 0.125 },
  /** The back string as the second hand can push it */
  hook: {
    /** Drawn length below its eye, and where a hand can first catch it, palm lengths of the cross hand */
    length: 4.5,
    clear: 0.6,
    /** Half the width of the pushing hand, in its own palm lengths */
    width: 0.4,
    /**
     * Image heights → m of push, and the most a hand can push, m. The puppet
     * answers steeply: 5 cm hardly moves it, 10 cm is a deep bow (pelvis
     * pitched 48°), so the range ends just beyond that
     */
    gain: 0.5,
    max: 0.12,
  },
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

/** Where a palm's own axes point: across it, along it (wrist → fingers), and across × along (the columns of its rotation) */
function palmAxes([x, y, z, w]: Quat): { across: V3; along: V3; normal: V3 } {
  return {
    across: [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    along: [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
    normal: [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
  };
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

  /** t in seconds; slow (0…1): the share of the cutoff to filter with, for a noisier signal (TUNING.filter.small) */
  filter(v: number, t: number, slow = 1) {
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
    this.value += alpha(slow * (this.tuning.minCutoff + this.tuning.beta * Math.abs(this.rate))) * (v - this.value);
    return this.value;
  }

  /** The filtered value as it stands */
  get current() {
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
  const { quat, lean } = poseFromFit(fit.outline, world);
  return { quat, lean, scale: fit.scale, handed: fit.handed };
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
export function poseFromFit(outline: Outline, world: Point[], steadyLean?: number, previousSide = 0): { quat: Quat; lean: number; side: number } {
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
  const evidence = (1 - upright) * -z2 + upright * (z1 * acrossWorld[2] + z2 * alongWorld[2]);
  // Which of the two it was in the last frame stays unless the evidence is
  // clearly against it: the 3D landmarks waver about which side is nearer, and
  // every change of mind turns the palm over through the image plane (a jump of
  // twice its lean; previousSide is 0 for a hand seen for the first time)
  const side = previousSide && evidence * previousSide > -SIDE_MARGIN ? previousSide : evidence < 0 ? -1 : 1;
  if (side < 0) [z1, z2] = [-z1, -z2];
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
  return { quat, lean, side };
}
/** How clearly the evidence has to point the other way before the palm is turned over (it is a sum of depth components, each 0…1) */
const SIDE_MARGIN = 0.12;

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
 * Finger signals for what closes or touches: thumb tucked in, pinch, fist.
 * Read in the image relative to the palm: every landmark is mapped back into
 * the palm's own flat frame (the inverse of the outline fit, so the hand's
 * size, turn and lean are taken out), and a finger's signal is how far its
 * tip has come back towards its knuckle. (The rockers do not use the four
 * finger signals: a finger bending out of the palm's plane is misread by this
 * map; see fingerFlexion.)
 *
 * Not from MediaPipe's 3D landmarks: on a real recording their finger angles
 * shifted by 0.3 and the thumb measure by half its range whenever the hand
 * leaned, which rocked the head bar without a finger moving.
 *
 * A hand seen edge-on cannot be read this way (the frame is squeezed to a
 * line, and every finger looks curled): the tracker holds the grip there
 * (flatFade). For the fist the 3D landmarks (world, if given) must agree as
 * well: they are poor at how far a finger is curled, but they do not mistake
 * a flat hand for a fist.
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

/** Knuckle-to-tip length of each finger in palm lengths, until the hand's own are measured at its rest pose */
const FINGER_REACH: Record<Finger, number> = { index: 0.86, middle: 0.9, ring: 0.86, pinky: 0.72 };
type V2 = [number, number];

/**
 * Each finger as the image shows it: the vector from its knuckle to its tip,
 * in palm lengths (scale: the palm's length in the image as if seen flat). The
 * raw input of fingerFlexion; the tracker smooths it first.
 */
export function fingerVectors(image: Point[], aspect: number, scale: number): Record<Finger, V2> {
  const vectors = {} as Record<Finger, V2>;
  for (const finger of Object.keys(FINGERS) as Finger[]) {
    const [knuckle, tip] = FINGERS[finger];
    vectors[finger] = [((image[tip].x - image[knuckle].x) * aspect) / scale, (image[tip].y - image[knuckle].y) / scale];
  }
  return vectors;
}

/**
 * A finger that lies in the palm's plane, in the palm's own frame: [across,
 * along], palm lengths. Taken at the rest pose: it holds the finger's length
 * and the direction it fans out in, both of which differ from hand to hand.
 */
export function fingerAtRest(vector: V2, quat: Quat): V2 {
  const { across, along } = palmAxes(quat);
  const det = across[0] * along[1] - across[1] * along[0];
  // Never divide by a palm squeezed to less than a fifth (as in fingerChannels)
  const safe = (det < 0 ? -1 : 1) * Math.max(0.2, Math.abs(det));
  return [(vector[0] * along[1] - vector[1] * along[0]) / safe, (across[0] * vector[1] - across[1] * vector[0]) / safe];
}

/**
 * How far a finger is bent down out of the palm's plane at its knuckle, rad
 * (negative: lifted). A puppeteer's fingers work the bars like piano keys, so
 * this is the angle that counts.
 *
 * The finger is a stick that turns from where it lies at rest (fingerAtRest)
 * towards the palm side. Where the palm's orientation puts such a stick in the
 * image is known for every angle; the angle whose stick fits the finger as
 * seen is taken (`previous` breaks ties: seen flat-on, bending towards and
 * away from the camera look the same).
 *
 * Mapping the fingertip back through the palm's outline instead
 * (fingerChannels) only holds for points in the palm's plane: on a real
 * session the same bent finger read as fully curled with the palm leaning
 * 0.75 rad and as a third of that at 1.1, which made the leg bar an on/off
 * switch in one pose and dead in another.
 *
 * palmSide: which of ± the palm's normal is the palm side (±1).
 */
export function fingerFlexion(vector: V2, rest: V2, quat: Quat, palmSide: number, previous = 0) {
  const { across, along, normal } = palmAxes(quat);
  const length = Math.hypot(rest[0], rest[1]);
  // In the image: the finger at rest (D) and the same stick pointing straight out of the palm (P)
  const D: V2 = [rest[0] * across[0] + rest[1] * along[0], rest[0] * across[1] + rest[1] * along[1]];
  const P: V2 = [palmSide * length * normal[0], palmSide * length * normal[1]];
  const misfit = (angle: number) => {
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    const [x, y] = [vector[0] - c * D[0] - s * P[0], vector[1] - c * D[1] - s * P[1]];
    // Ties go to the angle nearest the last one, and to bent rather than lifted
    return x * x + y * y + length * length * (0.02 * (angle - previous) ** 2 + (angle < 0 ? 0.05 * angle * angle : 0));
  };
  // A coarse scan (the misfit can have two dips), then two rounds of bisection
  let best = 0;
  let least = Infinity;
  for (let angle = FLEX_RANGE[0]; angle <= FLEX_RANGE[1]; angle += 0.1) {
    const m = misfit(angle);
    if (m < least) [best, least] = [angle, m];
  }
  for (let step = 0.05; step > 0.005; step /= 2) {
    for (const angle of [best - step, best + step]) {
      const m = misfit(angle);
      if (m < least) [best, least] = [angle, m];
    }
  }
  return best;
}
/** rad: lifted as far as a finger goes … bent to a fist */
const FLEX_RANGE = [-0.6, 1.9];

/**
 * The same angle from MediaPipe's 3D landmarks: how far the finger rises out
 * of the palm's plane towards the palm side, rad. Used for a
 * palm seen flat-on, where the image hardly shows a finger bending towards the
 * camera (TUNING.flatDead); for a palm at a slant these landmarks shrink and
 * flip (see palmPose), and the image is used.
 */
export function fingerFlexionWorld(world: Point[], finger: Finger, quat: Quat, palmSide: number) {
  const [knuckle, tip] = FINGERS[finger];
  const { normal } = palmAxes(quat);
  const rise = (to: number) => {
    const stick = sub(world[to], world[knuckle]);
    const out = palmSide * dot(stick, normal);
    return Math.atan2(out, Math.sqrt(Math.max(1e-12, dot(stick, stick) - out * out)));
  };
  // Knuckle to tip while the finger is fairly straight (the longest lever, the
  // least noise). The tip of a closing finger comes back to the knuckle and the
  // line between them points anywhere: then knuckle to the last joint instead
  const bones = distance(world[knuckle], world[knuckle + 1]) + distance(world[knuckle + 1], world[knuckle + 2]) + distance(world[knuckle + 2], world[tip]);
  const straight = smoothstep(0.5, 0.75, distance(world[knuckle], world[tip]) / (bones || 1));
  return straight * rise(tip) + (1 - straight) * rise(knuckle + 2);
}

/** On/off with two thresholds, so a value hovering at the edge does not flicker */
export function hysteresis(on: boolean, value: number, thresholds: { on: number; off: number }) {
  return on ? value > thresholds.off : value > thresholds.on;
}


// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/**
 * What the tracker needs to know about the cross it plays. Points are in the
 * main bar's frame: stage axes, metres from its pivot (+x the puppet's left,
 * +y up, +z the front tip). Defaults: the SKKG cross; set from the rig.
 */
export interface CrossGeometry {
  /** How far the main bar reaches behind its pivot: its rear end lies at the wrist */
  rear: number;
  /** Middle of the hand bar and of the head bar */
  handBar: V3;
  headBar: V3;
  /** Where the back string leaves the cross */
  backEye: V3;
}

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
  /** How far each finger is bent down out of the palm, rad from its rest (fingerFlexion) */
  flex: Record<Finger, number>;
  /** Thumb tip to index tip in the image, palm lengths */
  gap: number;
  /** How far the thumb tip is from where it lay in the palm at the rest pose, palm lengths */
  thumbMoved: number;
  /** The fingers' angles from the 3D landmarks, rad from the rest pose (fingerFlexionWorld): what counts for a palm seen flat-on */
  flexWorld: Record<Finger, number>;
}

export type TrackerStatus = "none" | "attached" | "lost";
/** The bars the second hand can take */
export type Handle = "hand" | "head";

export interface TrackerOutput {
  status: TrackerStatus;
  /** The rest pose is the hand's own (it has paused once, or N was pressed); until then a usual pose stands in */
  calibrated: boolean;
  cross?: HandView;
  second?: HandView;
  /** Main bar: stage metres (rig coordinates) and rad (a rotation vector) */
  bar: { x: number; y: number; z: number } & Tilt;
  /** −1…1, to be scaled by each bar's limit */
  rock: { legs: number; head: number; hands: number };
  /** 0…1: the head goes forward (thumb and index of the cross hand closing) */
  nod: number;
  grip: boolean;
  depth: { scale: number; baseline: number };
  /** The cross hand's height above the floor, m (as far as the picture tells), and the row of the picture at which the puppet stands for a hand at this distance (0 top … 1 bottom) */
  height: { hand: number; standRow: number };
  /**
   * How the cross lies in the cross hand, for drawing it there: where its
   * pivot is in the picture and where its axes point (image heights per metre;
   * x in image heights, display frame), and the palm's length, image heights
   */
  gizmo: { origin: { x: number; y: number }; x: [number, number]; y: [number, number]; z: [number, number]; unit: number };
  /** The handles where the second hand takes a bar: which side of the cross hand they are on (±1), their reach, and the one the hand is at or holds */
  handles: { side: number; radius: number; near?: Handle };
  handBar: {
    detached: boolean;
    /** The second hand's grab strength 0…1 and whether it is within reach of this bar's handle */
    grab: number;
    near: boolean;
    /** Movement since the grab: stage metres and rad */
    x: number;
    y: number;
    z: number;
    pitch: number;
    yaw: number;
    roll: number;
    /** Its handle: x in image heights, display frame */
    magnet: { x: number; y: number };
  };
  /** The head bar in the second hand: turning the hand rocks it (rock.head), instead of the cross hand's fingers */
  headBar: { held: boolean; near: boolean; handle: { x: number; y: number } };
  /**
   * The back string pushed sideways by the second hand: where along it (0 at
   * the cross … 1) and how far (stage m, + = stage +x); and, for drawing, the
   * string as it hangs in the picture and the edge of the hand that pushes it
   */
  hook: { active: boolean; along: number; push: number; line: { x: number; top: number; bottom: number }; edge: { x: number; y: number } };
}

interface Measurement {
  frame: HandFrame; // display frame
  palm: { x: number; y: number; length: number };
  aspect: number;
  /** The display frame is the mirrored camera image: a right hand looks like a left one in it */
  mirrored: boolean;
}

const FINGER_NAMES = Object.keys(FINGERS) as Finger[];
/** Frames a new handedness label has to stay before it is believed */
const RELABEL = 10;

class Track {
  /** Last detection of any quality (roles are matched on it) */
  detected = -Infinity;
  /** First and last observation that counted (after the warm-up frames) */
  firstSeen: number;
  lastSeen: number;
  private warmup = 0;
  private valid = false;
  private rawScale = 0;
  private relabel = 0;
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
  private fingerFilters = Object.fromEntries(
    FINGER_NAMES.map((finger) => [finger, [new OneEuro(TUNING.filter.finger), new OneEuro(TUNING.filter.finger)]]),
  ) as Record<Finger, [OneEuro, OneEuro]>;
  private gapFilter = new OneEuro(TUNING.filter.finger);
  /** The fingers' angles from the 3D landmarks: filtered, averaged, and as they were at the rest pose */
  private worldFilters = Object.fromEntries(FINGER_NAMES.map((finger) => [finger, new OneEuro(TUNING.filter.fingerWorld)])) as Record<Finger, OneEuro>;
  private steadyWorld: Record<Finger, number> = { index: 0, middle: 0, ring: 0, pinky: 0 };
  private restWorld: Record<Finger, number> = { index: 0, middle: 0, ring: 0, pinky: 0 };
  /** Frames in a row that were left out as far off (TUNING.filter.glitch): the outline, then each finger */
  private glitches = { outline: 0, index: 0, middle: 0, ring: 0, pinky: 0 };
  /** The share of the filters' cutoff for this hand's size (TUNING.filter.small) */
  slow = 1;
  /** Thumb tip to index tip, palm lengths: averaged like the fingers, and as it was at the rest pose */
  private steadyGap = 1;
  private restGap = 1;
  /** Index knuckle → thumb tip: filtered, averaged, and in the palm's own frame at the rest pose (as the fingers) */
  private thumbFilters = [new OneEuro(TUNING.filter.finger), new OneEuro(TUNING.filter.finger)];
  private steadyThumb: V2 = [0, 0];
  private thumbAtRest?: V2;
  view: HandView;
  // Filtered measurements
  logScale = 0;
  /** Palm orientation, display-camera axes, and how far it leans away from flat to the camera (rad, smoothed) */
  quat: Quat = [0, 0, 0, 1];
  lean = 0;
  /** Each finger's angle at the rest pose: 0 once it could be measured there (takeFingersAtRest) */
  private restFlex: Record<Finger, number> = { index: 0, middle: 0, ring: 0, pinky: 0 };
  /** ±1: which way round the palm's outline runs (palmFit), fixed when the hand is first seen */
  handed = 0;
  /** ±1: which of the two ways the palm leans that its outline allows (poseFromFit), 0 before the first frame */
  private leanSide = 0;
  /** ±1: which of ± the palm's normal is the palm side */
  palmSide = 1;
  /** Since when the hand has held still (palm and orientation): the rest pose waits for that */
  stillSince = Infinity;
  /** The same and the finger signals, averaged over a few tenths of a second: what a rest pose is taken from (one frame alone is noisy) */
  steadyQuat: Quat = [0, 0, 0, 1];
  /** A slower average still: a hand holds still while the two averages agree */
  private slowQuat: Quat = [0, 0, 0, 1];
  steadyChannels: Record<Channel, number>;
  private steadyFingers = Object.fromEntries(FINGER_NAMES.map((finger) => [finger, [0, -FINGER_REACH[finger]]])) as Record<Finger, V2>;
  /** Each finger lying in the palm's plane (fingerAtRest): the hand's own once it has rested (takeFingersAtRest) */
  private fingersAtRest = Object.fromEntries(FINGER_NAMES.map((finger) => [finger, [0, FINGER_REACH[finger]]])) as Record<Finger, V2>;

  constructor(m: Measurement, t: number) {
    this.firstSeen = this.lastSeen = t;
    this.handedness = m.frame.handedness;
    this.palm = m.palm;
    this.frame = m.frame;
    this.steadyChannels = fingerChannels(m.frame.image, m.aspect, undefined, m.frame.world);
    this.view = {
      landmarks: [], palm: m.palm, palmLength: m.palm.length, hand: "left", held: false, channels: this.steadyChannels,
      flex: { index: 0, middle: 0, ring: 0, pinky: 0 }, gap: 1, thumbMoved: 0, flexWorld: { index: 0, middle: 0, ring: 0, pinky: 0 },
    };
  }

  /** Take a new detection: filter what every role needs. previous: time of the frame before this one */
  observe(m: Measurement, t: number, aspect: number, previous: number) {
    if (this.detected < previous) this.warmup = TUNING.roles.warmup; // new, or found again after a gap
    this.detected = t;
    this.palm = m.palm;
    this.frame = m.frame;
    if (this.warmup > 0) {
      this.warmup--;
      if (!this.valid) {
        this.firstSeen = this.lastSeen = t; // a new hand's time counts from its first good frame
        this.handedness = m.frame.handedness; // and so does its label: the first results are the rough ones
      }
      return;
    }
    const dt = t - this.lastSeen;
    this.lastSeen = t;
    // The label flickers on hard poses, and it decides which side of the hand
    // the palm is on (palmSide): a new one has to stay before it is believed
    if (m.frame.score > 0.8 && m.frame.handedness !== this.handedness) {
      if (++this.relabel >= RELABEL || !this.valid) {
        this.handedness = m.frame.handedness;
        this.relabel = 0;
      }
    } else {
      this.relabel = 0;
    }
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
    const { small, glitch } = TUNING.filter;
    const slow = (this.slow = clamp(fit.scale / small.palm, small.least, 1));
    /** A reading this far from the smoothed one is left out, unless it has stayed (TUNING.filter.glitch) */
    const farOff = (key: keyof Track["glitches"], off: number, limit: number) => {
      const out = this.valid && off > limit * Math.max(1, dt * 30) && this.glitches[key] < glitch.frames;
      this.glitches[key] = out ? this.glitches[key] + 1 : 0;
      return out;
    };
    const outlineOff = Math.hypot(...fit.outline.map((v, i) => v - this.outline[i].current));
    const outline = farOff("outline", outlineOff, glitch.outline)
      ? (this.outline.map((filter) => filter.current) as Outline)
      : (fit.outline.map((v, i) => this.outline[i].filter(v, t, slow)) as Outline);
    const pose = poseFromFit(outline, world, this.valid ? this.lean : undefined, this.leanSide);
    this.leanSide = pose.side;
    // Size: taken with less weight while the hand moves across the image (TUNING.depth.steady)
    const size = Math.log(fit.scale);
    const [steady, fast] = TUNING.depth.steady;
    const trust = this.valid ? clamp(1 - (this.palmSpeed - steady) / (fast - steady), 0.1, 1) : 1;
    this.rawScale = this.valid ? this.rawScale + (size - this.rawScale) * (trust < 1 ? 1 - Math.exp((-dt * trust) / 0.1) : 1) : size;
    this.logScale = this.scale.filter(this.rawScale, t, slow);
    this.quat = pose.quat;
    this.steadyQuat = this.valid ? quatBlend(this.steadyQuat, this.quat, 1 - Math.exp(-dt / 0.15)) : this.quat;
    this.slowQuat = this.valid ? quatBlend(this.slowQuat, this.quat, 1 - Math.exp(-dt / 0.5)) : this.quat;
    this.lean = this.valid ? this.lean + (pose.lean - this.lean) * (1 - Math.exp(-dt / 0.15)) : pose.lean;
    if (!this.valid) this.steadyChannels = { ...raw };
    // Finger angles. A palm seen from its palm side: the outline of a right hand
    // runs one way round, that of a left hand (or of a right hand in a mirrored
    // picture) the other; from the back both turn over
    this.palmSide = -this.handed * (this.handedness === "Right" ? 1 : -1) * (m.mirrored ? -1 : 1);
    const vectors = fingerVectors(image, aspect, fit.scale);
    const flex = {} as Record<Finger, number>;
    const flexWorld = {} as Record<Finger, number>;
    const blend = this.valid ? 1 - Math.exp(-dt / 0.25) : 1;
    for (const finger of FINGER_NAMES) {
      // Smoothed before the angle is taken, as the outline is before the lean:
      // seen nearly flat-on, a little noise in a finger's length is degrees of angle
      const [fx, fy] = this.fingerFilters[finger];
      let [vx, vy] = vectors[finger];
      if (farOff(finger, Math.hypot(vx - fx.current, vy - fy.current), glitch.finger)) [vx, vy] = [fx.current, fy.current];
      const smooth: V2 = [fx.filter(vx, t, slow), fy.filter(vy, t, slow)];
      const steady = this.steadyFingers[finger];
      this.steadyFingers[finger] = [steady[0] + (vx - steady[0]) * blend, steady[1] + (vy - steady[1]) * blend];
      flex[finger] = fingerFlexion(smooth, this.fingersAtRest[finger], this.quat, this.palmSide, this.view.flex[finger]);
      const fromWorld = fingerFlexionWorld(world, finger, this.quat, this.palmSide);
      this.steadyWorld[finger] = this.valid ? this.steadyWorld[finger] + (fromWorld - this.steadyWorld[finger]) * blend : fromWorld;
      flexWorld[finger] = this.worldFilters[finger].filter(fromWorld, t, slow) - this.restWorld[finger];
    }
    // Thumb tip to index tip as the picture shows it, in palm lengths. Not through
    // the palm's outline (the pinch channel): that map stretches distances for a
    // palm seen at a slant and only holds at the touch itself
    const [thumbTip, indexTip] = [image[THUMB_TIP], image[INDEX_TIP]];
    const rawGap = Math.hypot((thumbTip.x - indexTip.x) * aspect, thumbTip.y - indexTip.y) / fit.scale;
    const gap = this.gapFilter.filter(rawGap, t, slow);
    this.steadyGap = this.valid ? this.steadyGap + (rawGap - this.steadyGap) * blend : rawGap;
    // The thumb tip against where it would be had it stayed in the palm as at the
    // rest pose (taken to lie in the palm's plane there): it moves for a pinch, not for a step
    const knuckle = image[INDEX_MCP];
    const rawThumb: V2 = [((thumbTip.x - knuckle.x) * aspect) / fit.scale, (thumbTip.y - knuckle.y) / fit.scale];
    const thumb: V2 = [this.thumbFilters[0].filter(rawThumb[0], t, slow), this.thumbFilters[1].filter(rawThumb[1], t, slow)];
    this.steadyThumb = this.valid ? [this.steadyThumb[0] + (rawThumb[0] - this.steadyThumb[0]) * blend, this.steadyThumb[1] + (rawThumb[1] - this.steadyThumb[1]) * blend] : rawThumb;
    let thumbMoved = 0;
    if (this.thumbAtRest) {
      const { across, along } = palmAxes(this.quat);
      const [a, b] = this.thumbAtRest;
      thumbMoved = Math.hypot(thumb[0] - a * across[0] - b * along[0], thumb[1] - a * across[1] - b * along[1]);
    }
    this.valid = true;
    this.view = {
      landmarks: image.map((p, i) => ({ x: this.landmarks[2 * i].filter(p.x, t), y: this.landmarks[2 * i + 1].filter(p.y, t) })),
      palm: { x: this.x.filter(m.palm.x, t), y: this.y.filter(m.palm.y, t) },
      // The size as if seen flat, not the 2D length: the drawn cross does not shrink when the hand tilts
      palmLength: Math.exp(this.logScale),
      hand: playerHand(this.handedness),
      held: false,
      channels,
      flex,
      gap,
      thumbMoved,
      flexWorld,
    };
    // Not frame against average: single frames are too noisy to ever count as still
    const turned = 2 * Math.acos(Math.min(1, Math.abs(quatMultiply(this.steadyQuat, quatConjugate(this.slowQuat))[3])));
    const still = this.palmSpeed < TUNING.attach.speed && turned < TUNING.attach.turn;
    if (!still) this.stillSince = Infinity;
    else if (this.stillSince === Infinity) this.stillSince = t;
  }

  /** Palm lengths/s: the same move of a hand further away is slower across the picture */
  get palmSpeed() {
    return Math.hypot(this.x.speed, this.y.speed) / (this.view.palmLength || 1);
  }

  /**
   * Forget what was decided about this hand from earlier frames: which way
   * round its outline runs, which way it leans, its label, its rest pose and
   * every average. The next frame starts as the first frame of a new hand, in
   * the same role. For HandTracker.reset(): any of these, once wrong, keeps
   * the cross tilted until the hand has left the picture.
   */
  forget() {
    this.valid = false;
    this.handed = 0;
    this.leanSide = 0;
    this.relabel = 0;
    this.stillSince = Infinity;
    this.restFlex = { index: 0, middle: 0, ring: 0, pinky: 0 };
    this.view.flex = { index: 0, middle: 0, ring: 0, pinky: 0 };
    this.view.flexWorld = { index: 0, middle: 0, ring: 0, pinky: 0 };
    this.restWorld = { index: 0, middle: 0, ring: 0, pinky: 0 };
    for (const filter of Object.values(this.worldFilters)) filter.reset();
    this.glitches = { outline: 0, index: 0, middle: 0, ring: 0, pinky: 0 };
    for (const finger of FINGER_NAMES) {
      this.steadyFingers[finger] = [0, -FINGER_REACH[finger]];
      this.fingersAtRest[finger] = [0, FINGER_REACH[finger]];
      for (const filter of this.fingerFilters[finger]) filter.reset();
    }
    this.thumbAtRest = undefined;
    for (const filter of [...this.outline, ...this.fingers.values(), ...this.thumbFilters, this.gapFilter, this.scale, this.pitch, this.yaw, this.roll]) filter.reset();
  }

  /**
   * The fingers as they are now (averaged) lie in the palm's plane: from now on
   * angles are measured against this hand's own fingers. Their lengths and the
   * way they fan out differ from hand to hand, which would read as a constant
   * bend that changes whenever the hand turns.
   */
  takeFingersAtRest() {
    for (const finger of FINGER_NAMES) {
      const [across, along] = fingerAtRest(this.steadyFingers[finger], this.steadyQuat);
      // A length out of all proportion: the finger is curled up as the hand rests, or
      // the palm is too close to edge-on to tell. Keep what there is, and count
      // its angle from the one it reads as now
      const length = Math.hypot(across, along);
      const fits = length > 0.5 * FINGER_REACH[finger] && length < 1.6 * FINGER_REACH[finger];
      if (fits) this.fingersAtRest[finger] = [across, along];
      this.restFlex[finger] = fits ? 0 : this.view.flex[finger];
      this.view.flex[finger] = this.restFlex[finger];
      this.restWorld[finger] = this.steadyWorld[finger];
      this.view.flexWorld[finger] = 0;
    }
    // A hand that rests with thumb and index together has no way left to close: take a least gap
    this.restGap = Math.max(MAPPING.nod.minRest, this.steadyGap);
    this.thumbAtRest = fingerAtRest(this.steadyThumb, this.steadyQuat);
  }

  /**
   * What the rockers read (MAPPING.rock), rad from the rest pose. flat (0…1):
   * how much of each angle is taken from the 3D landmarks instead of the image
   * (a palm seen flat-on); dead: a dead zone on each finger's angle (TUNING.flatDead)
   */
  signals(dead = 0, flat = 0): Record<Finger, number> {
    const [index, middle, ring, pinky] = FINGER_NAMES.map((finger) => {
      const fromImage = this.view.flex[finger] - this.restFlex[finger];
      return deadZone(fromImage + (this.view.flexWorld[finger] - fromImage) * flat, dead);
    });
    return { index, middle, ring, pinky };
  }

  /** How far thumb and index tip have closed since the rest pose: 0 as at rest (or wider) … 1 touching */
  get closing() {
    return clamp(1 - this.view.gap / this.restGap, 0, 1);
  }
}

interface Neutral {
  /** The rest pose in use; it eases towards target when a new one is taken */
  quat: Quat;
  target: Quat;
  /** The palm's size (log) at which the puppet is in the middle of the stage's depth; eases like quat */
  scale: number;
  scaleTarget: number;
  /** The hand's own pose (after its first pause, or N), not the stand-in */
  own: boolean;
  /** plus − minus of each rocker at rest, and the side (±1) its plus finger is on */
  rock: Record<string, { offset: number; side: number }>;
}

export class HandTracker {
  /**
   * The camera faces the player, who stands or sits in front of the screen
   * (the usual case: a webcam). The picture is mirrored (toDisplay) and the
   * hand moves the cross the way the player sees their own hand move: right
   * is right, and the cross tilts as the hand does. Off: the camera looks from
   * the player's own side (a phone's back camera), or the player stands behind
   * the stage facing the audience; sideways and the turns are the other way
   * round then. In both, coming closer to the camera brings the puppet to the
   * front of the stage.
   */
  mirror = true;
  /** The cross being played (set from the rig) */
  geometry: CrossGeometry = { rear: 0.025, handBar: [0, 0, 0.14], headBar: [0, -0.04, 0], backEye: [0, -0.005, -0.025] };
  /** Height of the cross at rest, where the puppet just stands (rig coordinates, m) */
  restHeight = 0.613;
  /** The head bar's range, rad: turning the second hand by this much rocks it fully */
  headLimit = Math.PI / 4;
  /**
   * Added to the cross's pitch, rad: the player's own correction for a camera
   * that looks at the hand from above or below, or for a hand they like to hold
   * tilted because it tracks better. On top of the rest pose, which does not reset it.
   */
  pitchTrim = 0;
  /**
   * The height of the hand above the floor at which the puppet just stands, m
   * (the player's slider). Lower hands let the strings go slack, higher ones
   * lift the puppet. Right in metres for a level camera TUNING.position.camera
   * above the floor; for any other camera it is the slider that is moved until
   * the puppet stands. Not changed by a new rest pose.
   */
  standHeight = 1;
  private cross?: Track;
  private second?: Track;
  private neutral?: Neutral;
  private lastTime = -1;
  private previousTime = -Infinity;
  private grip = false;
  /** When the cross hand was last seen, and the outputs it found when it attached or came back (TUNING.attach.blend) */
  private crossSeen = -Infinity;
  private blend?: { start: number; bar: TrackerOutput["bar"]; legs: number; nod: number };
  /** After reset(): when the hand's pose is taken as the rest pose, still or not */
  private ownAt = Infinity;
  // Second hand
  private closed = false;
  private openSince = Infinity;
  private held?: Handle;
  private grabStart?: { palm: { x: number; y: number }; logScale: number; quat: Quat; head: number };
  /** rock.head as the second hand holds it, and how much of that counts (0…1: it goes level again when the bar is let go) */
  private heldHead = 0;
  private headBlend = 0;
  /** Back string: the side (±1) the pushing hand came from, 0 = not caught; and the side it was last clear of the string on */
  private hookFrom = 0;
  private clearSide = 0;
  private readonly out: TrackerOutput = {
    status: "none",
    calibrated: false,
    bar: { x: 0, y: this.restHeight, z: 0, pitch: 0, yaw: 0, roll: 0 },
    rock: { legs: 0, head: 0, hands: 0 },
    nod: 0,
    grip: false,
    depth: { scale: 0, baseline: 0 },
    height: { hand: 1, standRow: 0.5 },
    gizmo: { origin: { x: 0, y: 0 }, x: [1, 0], y: [0, -1], z: [0, 0], unit: 0.1 },
    handles: { side: 1, radius: 0 },
    handBar: { detached: false, grab: 0, near: false, x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, magnet: { x: 0, y: 0 } },
    headBar: { held: false, near: false, handle: { x: 0, y: 0 } },
    hook: { active: false, along: 0.5, push: 0, line: { x: 0, top: 0, bottom: 0 }, edge: { x: 0, y: 0 } },
  };

  /**
   * Sets the cross right (the reset button, N): the cross hand as it is held
   * now becomes the rest pose (cross level, puppet in the middle of the
   * stage's depth, bars level), and everything decided about the hand from
   * earlier frames is dropped (Track.forget), in case that is what tilted the
   * cross. The cross goes over without a jump; the hand's own pose is taken a
   * moment later (TUNING.attach.reset), once its averages have filled again.
   */
  reset() {
    if (!this.cross) return;
    this.cross.forget();
    this.neutral = undefined;
    this.blend = undefined;
    this.grip = false;
    this.ownAt = this.lastTime + TUNING.attach.reset;
  }

  /** The cross hand's current pose becomes the rest pose (cross level at its rest height, rockers level) */
  private takeRestPose(track: Track, own: boolean) {
    if (own) track.takeFingersAtRest();
    const signals = track.signals();
    const rock: Neutral["rock"] = {};
    for (const [name, map] of Object.entries(MAPPING.rock)) {
      if (!map) continue;
      const [plus, minus] = map.sides;
      rock[name] = {
        offset: own ? signals[map.plus] - signals[map.minus] : 0, // not used before the own pose
        side: Math.sign(track.view.landmarks[plus].x - track.view.landmarks[minus].x) || 1,
      };
    }
    // The stand-in: upright in the picture and leaning its fingers towards the camera (same frame as palmPose)
    const lean = TUNING.attach.lean;
    const target = own ? track.steadyQuat : quatFromBasis([-1, 0, 0], [0, -Math.cos(lean), -Math.sin(lean)], [0, -Math.sin(lean), Math.cos(lean)]);
    // Depth counts from the size the hand has now: the puppet in the middle of the stage's depth
    const scale = track.logScale;
    this.neutral = { quat: this.neutral?.quat ?? target, target, scale: this.neutral?.scale ?? scale, scaleTarget: scale, own, rock };
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
    this.updateSecond(t, dt, aspect);
    return this.out;
  }

  // Hand roles. MediaPipe has no persistent ids and its result order changes
  // from frame to frame, so each detection goes to the role whose hand was
  // last seen nearest to it; the handedness label only breaks ties.
  private assign(t: number, hands: HandFrame[], aspect: number) {
    const roles = TUNING.roles;
    let detections: Measurement[] = hands
      .map((hand) => toDisplay(hand, this.mirror))
      .map((frame) => ({ frame, palm: palmInImage(frame.image, aspect), aspect, mirrored: this.mirror }));
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
   * tiltBetween is for a player on the far side of the stage. The player in
   * front of the screen is that turned half round about the vertical, and
   * their picture is mirrored: together that flips pitch and yaw (see the
   * architecture doc, "MediaPipe hands"), so the cross turns and rolls as
   * they see their hand do. Pitch is flipped back by default: the hand is the
   * cross (TUNING.tipForwardBows). Depth is not turned round with it: closer
   * to the camera is the front of the stage for both.
   */
  private facing(tilt: Tilt): Tilt {
    if (!this.mirror) return tilt;
    return { pitch: TUNING.tipForwardBows ? tilt.pitch : -tilt.pitch, yaw: -tilt.yaw, roll: tilt.roll };
  }

  private dropCross() {
    this.cross = undefined;
    this.neutral = undefined;
    this.ownAt = Infinity;
    this.grip = false;
  }

  private dropSecond() {
    this.second = undefined;
    this.letGo();
  }

  /** The second hand holds and pushes nothing (any more) */
  private letGo() {
    this.closed = false;
    this.openSince = Infinity;
    this.held = undefined;
    this.grabStart = undefined;
    this.hookFrom = this.clearSide = 0;
  }

  private updateCross(t: number, dt: number, aspect: number) {
    const out = this.out;
    const track = this.cross;
    const active = track && track.lastSeen - track.firstSeen >= TUNING.roles.confirm;
    if (!track || !active) {
      // No hand: the cross stays where it is, the rockers go level
      out.status = "none";
      out.cross = undefined;
      out.rock.legs = out.rock.hands = out.nod = 0;
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
        out.rock.legs = out.rock.hands = out.nod = 0;
        out.grip = this.grip = false;
      }
      return;
    }

    // Attaching, or back after a while: the outputs go over to the hand from where they are
    // (after reset() they wait where they are until the hand's own pose is taken)
    if (!this.neutral || t - this.crossSeen > TUNING.attach.gap) {
      this.blend = { start: !this.neutral && this.ownAt < Infinity ? this.ownAt : t, bar: { ...out.bar }, legs: out.rock.legs, nod: out.nod };
    }
    this.crossSeen = t;

    // Rest pose: a usual pose at once, the hand's own the first time it pauses
    if (!this.neutral) {
      this.takeRestPose(track, false);
      for (const filter of [track.pitch, track.yaw, track.roll]) filter.reset();
    }
    if (!this.neutral!.own && t - track.stillSince >= TUNING.attach.settle) this.takeRestPose(track, true);
    if (t >= this.ownAt) {
      // reset(): at once, the blend above carries the cross over
      this.takeRestPose(track, true);
      Object.assign(this.neutral!, { quat: this.neutral!.target, scale: this.neutral!.scaleTarget });
      this.ownAt = Infinity;
    }
    const neutral = this.neutral!;
    const ease = 1 - Math.exp(-dt / TUNING.attach.ease);
    neutral.quat = quatBlend(neutral.quat, neutral.target, ease);
    neutral.scale += (neutral.scaleTarget - neutral.scale) * ease;
    out.calibrated = neutral.own;
    out.status = "attached";

    // Position. Sideways: where the hand is in the picture. Height: the hand's
    // real height against the height at which the puppet stands (TUNING.position)
    const position = TUNING.position;
    const view = track.view;
    out.bar.x = clamp(((view.palm.x / aspect - 0.5) / position.imageSpan) * 2 * position.x, -position.x, position.x);
    const perRow = TUNING.gizmo.palm / view.palmLength; // m per image height at the hand's distance
    out.height.hand = position.camera + (0.5 - view.palm.y) * perRow;
    out.height.standRow = 0.5 - (this.standHeight - position.camera) / perRow;
    out.bar.y = this.restHeight + clamp(position.yGain * (out.height.hand - this.standHeight), -position.down, position.up);

    // Tilt against the rest pose
    const tilt = this.facing(tiltBetween(neutral.quat, track.quat));
    for (const axis of ["pitch", "yaw", "roll"] as const) {
      const { gain, max, dead } = TUNING.tilt[axis];
      out.bar[axis] = clamp(gain * deadZone(track[axis].filter(clamp(tilt[axis], -1.5, 1.5), t, track.slow), dead), -max, max);
    }
    out.bar.pitch += this.pitchTrim;

    // Depth: the hand's size against its size at the rest pose. A hand that
    // comes closer to the camera brings the puppet to the front of the stage,
    // and it stays there (the first version let it drift back to the middle
    // within 10 s, which is wrong for a player who walks up and stays)
    const depth = TUNING.depth;
    out.depth.scale = track.logScale;
    out.depth.baseline = neutral.scale;
    out.bar.z = clamp(depth.gain * deadZone(track.logScale - neutral.scale, depth.dead), depth.range[0], depth.range[1]);

    // Fingers
    // Leg bar and nod wait for the hand's own rest pose: finger lengths and how
    // a relaxed thumb lies differ from hand to hand, so the stand-in has no zero
    // for them (on a real session a bar sat at full rock until the first pause)
    const flat = 1 - smoothstep(TUNING.flatDead.lean[0], TUNING.flatDead.lean[1], track.lean);
    const signals = track.signals(TUNING.flatDead.extra * flat, flat);
    const closing = Math.min(signals.index, signals.middle, signals.ring, signals.pinky);
    const fade =
      (neutral.own ? 1 : 0) *
      (1 - smoothstep(MAPPING.fistFade[0], MAPPING.fistFade[1], closing)) *
      (1 - smoothstep(TUNING.rockFade[0], TUNING.rockFade[1], track.lean));
    // Thumb and index closing: the head goes forward. Not while the other
    // fingers close too (a fist), and the index bending for it is not a step
    const nod = MAPPING.nod;
    const pinching = track.closing;
    const others = Math.min(signals.middle, signals.ring, signals.pinky);
    const thumbMoved = smoothstep(nod.thumb[0], nod.thumb[1], view.thumbMoved);
    const dead = nod.dead + nod.still * (1 - thumbMoved);
    out.nod = (neutral.own ? 1 : 0) * (1 - smoothstep(nod.closing[0], nod.closing[1], others)) * clamp((pinching - dead) / (nod.full - dead), 0, 1);
    const rocked = (name: "legs") => {
      const map = MAPPING.rock[name];
      if (!map) return 0;
      const rest = neutral.rock[name];
      const lead = deadZone(signals[map.plus] - signals[map.minus] - rest.offset, map.dead);
      return clamp(rest.side * fade * map.gain[lead > 0 ? 0 : 1] * lead, -1, 1);
    };
    const pinch = Math.max(smoothstep(nod.legs[0], nod.legs[1], pinching), thumbMoved * smoothstep(nod.legsThumb[0], nod.legsThumb[1], pinching));
    out.rock.legs = rocked("legs") * (1 - pinch);
    out.rock.hands = 0;
    // A hand seen edge-on looks like a fist: the grip keeps its state there, so a bow does not drop the prop
    if (track.lean < TUNING.flatFade[0]) this.grip = hysteresis(this.grip, view.channels[MAPPING.grip.channel], MAPPING.grip);
    out.grip = this.grip;

    if (this.blend) {
      const weight = smoothstep(0, TUNING.attach.blend, t - this.blend.start);
      const mix = (from: number, to: number) => from + (to - from) * weight;
      for (const key of ["x", "y", "z", "pitch", "yaw", "roll"] as const) out.bar[key] = mix(this.blend.bar[key], out.bar[key]);
      out.rock.legs = mix(this.blend.legs, out.rock.legs);
      out.nod = mix(this.blend.nod, out.nod);
      if (weight >= 1) this.blend = undefined;
    }

    this.layOut(track, aspect);
  }

  /**
   * Where the cross lies in the cross hand as the picture shows it: in the
   * palm, its rear end at the wrist, its front tip at the fingertips, its top
   * towards the back of the hand. From that: where the second hand finds the
   * bars' handles and the back string.
   */
  private layOut(track: Track, aspect: number) {
    const { gizmo, handles, hook } = this.out;
    const view = track.view;
    const { across, along, normal } = palmAxes(track.quat);
    const back: V3 = [-track.palmSide * normal[0], -track.palmSide * normal[1], -track.palmSide * normal[2]];
    const right = cross(back, along); // the cross's +x: display right for a palm held level in front of the screen
    gizmo.unit = Math.min(view.palmLength, TUNING.gizmo.maxUnit);
    const perMetre = gizmo.unit / TUNING.gizmo.palm;
    gizmo.x = [right[0] * perMetre, right[1] * perMetre];
    gizmo.y = [back[0] * perMetre, back[1] * perMetre];
    gizmo.z = [along[0] * perMetre, along[1] * perMetre];
    // The pivot lies on the line from the wrist to the middle knuckle; view.palm is the outline's centroid
    const forward = (this.geometry.rear / TUNING.gizmo.palm - PALM_CENTRE[1]) * view.palmLength;
    const sideways = -PALM_CENTRE[0] * track.handed * view.palmLength;
    gizmo.origin = { x: view.palm.x + sideways * across[0] + forward * along[0], y: view.palm.y + sideways * across[1] + forward * along[1] };

    // The handles are on the side the second hand is on; without one, on the side with more room
    const second = this.second;
    if (second && this.out.second) {
      const dx = second.view.palm.x - view.palm.x;
      if (!this.held && Math.abs(dx) > 0.5 * view.palmLength) handles.side = Math.sign(dx);
    } else if (Math.abs(view.palm.x / aspect - 0.5) > 0.12) {
      handles.side = view.palm.x / aspect < 0.5 ? 1 : -1;
    }
    handles.radius = TUNING.handBar.radius * gizmo.unit;
    const project = ([x, y, z]: V3) => ({
      x: gizmo.origin.x + x * gizmo.x[0] + y * gizmo.y[0] + z * gizmo.z[0],
      y: gizmo.origin.y + x * gizmo.x[1] + y * gizmo.y[1] + z * gizmo.z[1],
    });
    const handle = ([, y, z]: V3) => project([handles.side * TUNING.gizmo.handle, y, z]);
    this.out.handBar.magnet = handle(this.geometry.handBar);
    this.out.headBar.handle = handle(this.geometry.headBar);
    // The back string hangs straight down the picture from its eye
    const eye = project(this.geometry.backEye);
    hook.line = { x: eye.x, top: eye.y, bottom: eye.y + TUNING.hook.length * gizmo.unit };
  }

  private updateSecond(t: number, dt: number, aspect: number) {
    const out = this.out;
    const { handBar: bar, headBar: head, hook, handles } = out;
    const track = this.second;
    const active = track && track.lastSeen - track.firstSeen >= TUNING.roles.confirm;
    out.second = active ? track.view : undefined;
    if (!track || !active || !this.cross || out.status === "none") {
      this.letGo();
      bar.grab = 0;
      bar.near = head.near = false;
      handles.near = undefined;
    } else {
      track.view.held = track.lastSeen !== t;
      // Over a short dropout everything is held where it is
      if (!track.view.held) this.readSecond(track, t, aspect);
    }
    bar.detached = this.held === "hand";
    head.held = this.held === "head";
    hook.active = this.hookFrom !== 0;
    if (!hook.active) hook.push = 0;
    // Let go, the head bar goes level again, without a jump
    this.headBlend += ((head.held ? 1 : 0) - this.headBlend) * (1 - Math.exp(-dt / TUNING.handBar.blend));
    if (!head.held && this.headBlend < 1e-3) this.headBlend = 0;
    out.rock.head = this.heldHead * this.headBlend;
  }

  /** The second hand as seen in this frame: taking a bar at its handle, moving it, pushing the back string */
  private readSecond(track: Track, t: number, aspect: number) {
    const out = this.out;
    const { handBar: bar, headBar: head, hook, handles } = out;
    const view = track.view;
    // Touching fingertips can be seen from any side, a fist cannot (an edge-on hand looks like one)
    const readable = 1 - smoothstep(TUNING.flatFade[0], TUNING.flatFade[1], track.lean);
    bar.grab = Math.max(...MAPPING.grab.channels.map((c) => view.channels[c] * (c === "fist" ? readable : 1)));
    // The fingers that take a bar: between thumb tip and index tip
    const [thumb, index] = [view.landmarks[THUMB_TIP], view.landmarks[INDEX_TIP]];
    const fingers = { x: ((thumb.x + index.x) / 2) * aspect, y: (thumb.y + index.y) / 2 };
    const reach = (handle: { x: number; y: number }) => Math.hypot(fingers.x - handle.x, fingers.y - handle.y);
    const [toHand, toHead] = [reach(bar.magnet), reach(head.handle)];
    const near: Handle | undefined = Math.min(toHand, toHead) < handles.radius ? (toHand <= toHead ? "hand" : "head") : undefined;
    bar.near = near === "hand";
    head.near = near === "head";

    // The hand has to close within reach of a handle: a fist passing by takes nothing
    const closed = hysteresis(this.closed, bar.grab, MAPPING.grab);
    if (closed && !this.closed && near && !this.held && out.status === "attached") {
      // Everything is measured from this moment, so nothing jumps when the bar is taken
      this.held = near;
      this.grabStart = { palm: { ...view.palm }, logScale: track.logScale, quat: track.steadyQuat, head: out.rock.head };
      this.heldHead = out.rock.head;
      this.hookFrom = 0;
      for (const filter of [track.pitch, track.yaw, track.roll]) filter.reset();
    }
    // Let go only once the hand has been seen open for a while (MAPPING.grab.open):
    // fingers straight and thumb off the index. A hand seen edge-on reads as
    // curled, so it keeps the bar
    const curl = view.channels;
    const open = !closed && (curl.index + curl.middle + curl.ring + curl.pinky) / 4 < MAPPING.grab.open && curl.pinch < MAPPING.grab.off;
    if (!open) this.openSince = Infinity;
    else if (this.openSince === Infinity) this.openSince = t;
    if (this.held && open && t - this.openSince >= TUNING.handBar.release) this.held = undefined;
    this.closed = closed;
    handles.near = this.held ?? near;

    if (this.held && this.grabStart) {
      const tuning = TUNING.handBar;
      const tilt = this.facing(tiltBetween(this.grabStart.quat, track.quat));
      const roll = track.roll.filter(clamp(tilt.roll, -tuning.maxTurn, tuning.maxTurn), t);
      if (this.held === "hand") {
        bar.x = (view.palm.x - this.grabStart.palm.x) * tuning.gain;
        bar.y = -(view.palm.y - this.grabStart.palm.y) * tuning.gain;
        bar.z = (track.logScale - this.grabStart.logScale) * tuning.depthGain; // closer to the camera = to the front, as for the cross
        bar.pitch = track.pitch.filter(clamp(tilt.pitch, -tuning.maxTurn, tuning.maxTurn), t);
        bar.yaw = track.yaw.filter(clamp(tilt.yaw, -tuning.maxTurn, tuning.maxTurn), t);
        bar.roll = roll;
      } else {
        // Turning the hand rocks the head bar, from the angle it had when it was taken
        this.heldHead = clamp(this.grabStart.head + roll / this.headLimit, -1, 1);
      }
    }

    // The back string. An open hand that comes from one side and reaches the
    // string pushes it along with its leading edge; it lets go by drawing back
    // (or by leaving the string's height). A hand that is first seen on top of
    // the string has not caught it: which way would it push?
    const tuning = TUNING.hook;
    const half = tuning.width * view.palmLength;
    const dx = view.palm.x - hook.line.x;
    const within = view.palm.y > hook.line.top + tuning.clear * out.gizmo.unit && view.palm.y < hook.line.bottom;
    const push = (from: number) => dx - from * half; // how far the edge that leads has gone past the string
    if (this.hookFrom) {
      if (push(this.hookFrom) * this.hookFrom >= 0) {
        this.clearSide = this.hookFrom; // drawn back
        this.hookFrom = 0;
      } else if (!within || this.held || closed) {
        this.hookFrom = this.clearSide = 0;
      }
    } else if (Math.abs(dx) > half) {
      this.clearSide = Math.sign(dx);
    } else if (this.clearSide && within && !this.held && !closed && out.status === "attached") {
      this.hookFrom = this.clearSide;
    }
    if (this.hookFrom) {
      const pushed = push(this.hookFrom);
      hook.along = clamp((view.palm.y - hook.line.top) / (hook.line.bottom - hook.line.top), 0.1, 0.9);
      hook.push = clamp(pushed * tuning.gain, -tuning.max, tuning.max);
      hook.edge = { x: hook.line.x + pushed, y: view.palm.y };
    }
  }
}
