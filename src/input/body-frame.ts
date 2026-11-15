// The hand's height, worked out so that it does not depend on where the camera
// is or how it is pitched (BodyFrame, second half of this file), and what the
// body models see of the player in one camera frame: face, face mesh and
// body, next to the hands (the types in the first half; recorded with
// ?record, recording format 2, see Recording in hand-synthetic.ts).
//
// Pure: no DOM, no MediaPipe and no import of hand-tracking.ts (which imports
// this file), because node runs it directly (scripts/replay-recording.mjs,
// scripts/test-body-frame.ts). The body models themselves are run by
// body-source.ts, and only while recording: in play the model has the hand
// alone, and everything about faces and bodies below is checked on synthetic
// scenes only.
//
// All image points are in the raw camera image (not mirrored), as the hand
// landmarks are: x to the right and y down, each 0…1 of the image's width
// and height. "Right" and "left" in the names below are the person's own, so
// facing the camera their right eye is the one on the left of the raw image.

/** [x, y] in the raw camera image, each 0…1 */
export type ImagePoint = [x: number, y: number];

/** One face as the face detector (BlazeFace short-range) reports it */
export interface FaceKeypoints {
  /** Six points: 0 right eye, 1 left eye, 2 nose tip, 3 mouth centre, 4 right ear (tragion), 5 left ear */
  kp: ImagePoint[];
  /** The face's box [x, y, width, height]: top-left corner and size, 0…1 of the image's width and height */
  box: [x: number, y: number, width: number, height: number];
  /** How sure the detector is, 0…1 */
  score: number;
}

/**
 * The face mesh (FaceLandmarker) of the first face, reduced to what a height
 * model can use: its 478 points are not kept.
 */
export interface FaceMesh {
  /**
   * MediaPipe's facial transformation matrix, 4 × 4, column-major (the
   * translation is in elements 12…14): from its canonical face model (cm) to
   * the face as seen, in a camera space with x right, y up and z towards the
   * viewer (a face in front of the camera has a negative z). It is fitted for
   * a camera MediaPipe assumes, not for the real one, so its distances are
   * only a first guess.
   */
  matrix: number[];
  /**
   * Ten mesh points, in this order (their index in the 478-point mesh):
   * 0 right eye, outer corner (33) · 1 right eye, inner corner (133) ·
   * 2 left eye, inner corner (362) · 3 left eye, outer corner (263) ·
   * 4 nose tip (1) · 5 mouth centre, between the lips (13) · 6 chin (152) ·
   * 7 forehead, top of the face's outline (10) · 8 right side of the face,
   * in front of the ear (234) · 9 left side (454).
   * An eye's centre is the middle of its two corners: the corners do not
   * move with the gaze, as the iris points do.
   */
  points: ImagePoint[];
}

/** One body as the PoseLandmarker (BlazePose) reports it */
export interface PoseLandmarks {
  /**
   * 33 landmarks, each [x, y, z, visibility]: x, y an image point (outside
   * 0…1 where the model places a joint beyond the picture), z the depth
   * against the middle of the hips on about the scale of x (smaller is closer
   * to the camera), visibility 0…1.
   * 0 nose · 1–3 left eye (inner, centre, outer) · 4–6 right eye · 7 / 8 left /
   * right ear · 9 / 10 mouth · 11 / 12 shoulders · 13 / 14 elbows · 15 / 16
   * wrists · 17–22 fingers · 23 / 24 hips · 25 / 26 knees · 27 / 28 ankles ·
   * 29–32 heels and toes; the odd index is the left side from 11 on.
   */
  lm: [x: number, y: number, z: number, visibility: number][];
}

/**
 * What the body models saw in one camera frame. A key is there when its model
 * ran on that frame: `faces: []` and `poses: []` say that it looked and found
 * nobody (`mesh` is simply missing then).
 */
export interface BodyObservation {
  /** ms, the clock of the hand frames */
  t: number;
  faces?: FaceKeypoints[];
  mesh?: FaceMesh;
  poses?: PoseLandmarks[];
}

/** A BodyObservation as it is stored on a recorded frame, which has the time itself */
export type BodySeen = Omit<BodyObservation, "t">;

// ---------------------------------------------------------------------------
// The height model
// ---------------------------------------------------------------------------
//
// What the cross needs is how far the hand is above the height at which the
// puppet just stands, in metres. A picture gives rows; what turns a row into
// metres is the palm's size in it, and what that leaves open is the camera:
//
//     m     = P / s                    metres per image height at the hand (P the
//                                      palm's length in metres, s in image heights)
//     H     = c · (y_h − row) · m      the hand above the camera's horizontal plane
//     value = H − H0 − b − trim        above the standing height
//
// y_h is the horizon row: the row of the picture at the camera's own height,
// ½ for a level camera and ½ + f · tan θ for one pitched up by θ; c = cos θ.
// The first line is exact for any pitch (a point H above the camera's plane at
// depth z along its axis appears f · H / (c · z) rows above the horizon, and
// the palm measures z / f). Of the camera only y_h is needed, and for the
// zero not even the focal length: c differs from 1 by 3 % at 15°, and is taken
// from y_h with an assumed focal length.
//
// H0 is the zero: H at the moment the player held the hand where the puppet is
// to stand (the guided capture below). It is kept as the row and scale of that
// moment, not as metres, so that a horizon learnt later moves it along and the
// value at that distance stays 0.
//
// A face or a body (an Anchor) gives a second height the same way, with its
// own ruler (the eyes' distance, or the shoulders' width). It serves three
// things: a first guess of the zero before any capture (the hand is taken to
// play a fixed distance below the eyes), the body shift b (the player sits
// down: the zero goes along), and the horizon itself (HorizonFit).

/** Every number of the height model, in one place */
export const HEIGHT = {
  /** m from wrist to middle knuckle: the hand's ruler. Palms differ by ±15 %, which scales travel by as much and leaves the zero where it is */
  palm: 0.095,
  /** Focal length the cosine of the camera's pitch is taken with, image heights (a webcam's is 0.9 … 1.5: at a pitch of 15° that is up to 3 % of H) */
  focal: 1.1,
  /**
   * The body's rulers, m: between the pupils, from the eyes' line to the mouth,
   * between the shoulder joints, from the shoulders' line to the hips'. Adult
   * means; a child's are smaller, which reads its height above the camera's
   * plane too large by as much.
   */
  ruler: { eyes: 0.063, eyesToMouth: 0.068, shoulders: 0.36, torso: 0.5 },
  /**
   * How far below the eyes, or below the shoulders, a player holds the playing
   * hand, m: the zero before any capture. ASSUMPTIONS, not measured: to be
   * taken from recordings with a face or a body in them.
   */
  below: { face: 0.42, pose: 0.22 },
  /**
   * Which faces count. score: the detector's (it reported faces on a test
   * pattern in 45 % of frames, so the weak ones are left out). size: the eyes'
   * distance in image heights, a face between 0.3 and 4.5 m from a webcam.
   * near: m the face may be in front of the hand's … behind it, in units of m
   * per image height (the hand is held in front of the body, at most an arm
   * away). aside: m it may be to the side of the hand. gate: m an anchor may
   * have moved since it was last seen to count as the same one.
   */
  face: { score: 0.7, size: [0.015, 0.25] as [number, number], near: [0.75, 1] as [number, number], aside: 0.8, gate: 0.3 },
  /** Palm lengths a pose's wrist may be from the palm's centre to be this hand's */
  wrist: 2,
  /**
   * How far the zero may be off, m (HeightReading.sigma), by where it comes
   * from (calibrated: taken by the player; prior: guessed from an anchor;
   * default: neither), and what the rest adds. measured / fit / unknown: rows
   * the horizon row may be off when it was measured, fitted (at least) or is
   * not known. scale: the share of H by which the palm's size may be off at
   * rest. anchor: m a face adds while it is followed. trusted: a horizon row
   * off by this many rows or more counts as unknown (w = 1), and the less it
   * is off the more it is trusted (w → 0); full: sigma at which the
   * confidence is 0.
   */
  sigma: { calibrated: 0.005, prior: 0.06, default: 0.15, measured: 0.01, fit: 0.015, unknown: 0.15, scale: 0.015, anchor: 0.02, trusted: 0.05, full: 0.1 },
  /**
   * No jumps. time / speed: any change of the zero comes in over this long, s,
   * and no faster than this, m/s. horizon: rows per second the horizon row may
   * move while a hand plays. sigma: s over which sigma follows.
   */
  ease: { time: 0.5, speed: 0.3, horizon: 0.05, sigma: 0.4 },
  /**
   * The body shift. lowPass: s, the anchor's row and size before anything is
   * taken from them. With the horizon known the zero only follows a change of
   * more than `threshold` m that has lasted `hold` s (sitting down, standing
   * up; nods and the bob of walking are left alone), over `ease` s, until it
   * is within `settled` m; a shift that ends up under the threshold is not
   * kept (it is the anchor's noise, or what a walk looked like before the
   * horizon row was known). With the horizon row unknown the zero follows
   * every change, `follow` s behind (the anchor's row and size come in steps,
   * a few times a second). lost: s without the anchor after which the shift
   * is frozen; steady / sightings: for how long and how often an anchor has
   * to be seen before it counts (one sighting of a face 20 px wide is off by
   * centimetres). pixel: rows an anchor's points are taken to be off by (1.5
   * px of a 480 px picture, an assumption): the threshold is at least three
   * times what that makes of the anchor's height, so that a small face's
   * noise is not taken for sitting down (a face 14 px wide, 60 cm above the
   * camera's height: 19 cm).
   */
  shift: { lowPass: 0.5, threshold: 0.08, hold: 1, ease: 0.7, settled: 0.005, follow: 0.1, lost: 0.6, steady: 0.4, sightings: 4, pixel: 0.003 },
  /**
   * The guided capture. rows: the rows of the picture a zero is taken in; near:
   * and, with an anchor, within this many m of the guess. time: s it is offered
   * for. close: a palm longer than this (image heights) is too near the camera;
   * edge: a palm leaning further than this from flat (rad) is seen edge-on.
   * done: s the confirmation stays.
   */
  guide: { rows: [0.35, 0.7] as [number, number], near: 0.2, time: 8, close: 0.25, edge: 1.2, done: 1.5 },
  /**
   * Who is it. gap: s without a hand after which the next one is a new player.
   * Within it: the same player if their face (or body) stayed in view, never
   * missing for more than `left` s and its size within `anchor`; with no
   * anchor, if the palm's size is within `palm`.
   */
  player: { gap: 5, left: 1, anchor: 0.25, palm: 0.3 },
};

/** The cross hand in one frame, as the tracker has measured and smoothed it */
export interface HandSample {
  /** s */
  t: number;
  /** Palm centre in the RAW camera image (not mirrored, as the body observations are): x in image heights, row 0 top … 1 bottom */
  x: number;
  row: number;
  /** Palm length as if seen flat, image heights */
  palm: number;
  /** How far the palm leans from flat to the camera, rad */
  lean: number;
  /** Palm lengths/s */
  speed: number;
  /** s the hand has held still (0 while it moves) */
  still: number;
}

/** What a reading rests on: the hand, an anchor if one is in use, where the zero comes from, where the horizon row comes from */
export type HeightSource = "hand" | "face" | "pose" | "calibrated" | "body-prior" | "default" | "horizon-measured" | "horizon-fit" | "horizon-default";

/** The guided capture as the hand window shows it */
export interface HeightGuide {
  /**
   * place: the hand is outside the band (arrow: +1 up, −1 down) · back: too
   * close to the camera · tilt: seen edge-on · hold: all good, the zero is
   * taken when progress reaches 1 · done: taken · flying: the puppet is still
   * on its way down, the clock has not started
   */
  state: "place" | "back" | "tilt" | "hold" | "done" | "flying";
  /** Rows of the picture between which a zero is taken (top, bottom) */
  band: [number, number];
  /** 0…1 */
  progress: number;
  arrow: -1 | 0 | 1;
}

export interface HeightReading {
  /** m the hand is above the height at which the puppet just stands (metres of hand travel under a palm of HEIGHT.palm) */
  value: number;
  /** m the zero may be off: a slow error, not frame noise */
  sigma: number;
  /** 1 − sigma / HEIGHT.sigma.full, 0…1 */
  confidence: number;
  sources: HeightSource[];
  /** The row of the picture at which the puppet stands for a hand at this distance, 0 top … 1 bottom */
  standRow: number;
  /** The horizon row in use */
  horizonRow: number;
  /** While the capture is offered */
  guide?: HeightGuide;
  /** For looking into it (replay-recording.mjs): the hand and the anchor above the camera's plane, m, and the body shift */
  hand: number;
  anchor?: number;
  shift: number;
}

/** A face or a body the hand's height can be held against */
export interface Anchor {
  kind: "face" | "pose";
  /** s */
  t: number;
  /** The eyes' row, or the shoulders'; x in image heights (raw image) */
  row: number;
  x: number;
  /** Its ruler in the image, image heights: the eyes' distance, or the shoulders' width (rulerSize of the two below) */
  size: number;
  /** m per image height at the anchor */
  m: number;
  /**
   * The two measures the size is taken from, both as the ruler's length in
   * the image: across (the eyes' distance, the shoulders' width) and along
   * (eyes to mouth, shoulders to hips; 0 if not seen). Kept apart so that a
   * caller can smooth them before combining them.
   */
  across: number;
  along: number;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const smoothstep = (v: number) => {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
};
/** cos θ of the camera's pitch, from its horizon row */
const cosine = (horizon: number) => 1 / Math.hypot(1, (horizon - 0.5) / HEIGHT.focal);
const between = (a: ImagePoint, b: ImagePoint, aspect: number) => Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]);
const middle = (a: ImagePoint, b: ImagePoint): ImagePoint => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/**
 * The ruler's length in the image from its two measures: the larger one, as
 * turning the head (or the body) shortens the one across but not the one
 * along. The one along only once it is clearly the larger (by 10 … 30 %): the
 * larger of two noisy measures of the same length is too large on average, by
 * more the smaller the face is in the picture, which bends the horizon fit's
 * line.
 */
export const rulerSize = (across: number, along: number) => across + (along - across) * smoothstep((along / (across || 1e-9) - 1.1) / 0.2);

/** A face from its eyes and mouth, if it has a plausible size */
function faceAnchor(t: number, rightEye: ImagePoint, leftEye: ImagePoint, mouth: ImagePoint | undefined, aspect: number): Anchor | undefined {
  const centre = middle(rightEye, leftEye);
  const eyes = between(rightEye, leftEye, aspect);
  const toMouth = mouth ? (between(centre, mouth, aspect) * HEIGHT.ruler.eyes) / HEIGHT.ruler.eyesToMouth : 0;
  const size = rulerSize(eyes, toMouth);
  if (!(size >= HEIGHT.face.size[0] && size <= HEIGHT.face.size[1])) return undefined;
  return { kind: "face", t, row: centre[1], x: centre[0] * aspect, size, m: HEIGHT.ruler.eyes / size, across: eyes, along: toMouth };
}

/** A body from its shoulders (and hips), and how far its nearer wrist is from the hand, palm lengths (undefined: no wrist seen, or no hand) */
function poseAnchor(t: number, pose: PoseLandmarks, aspect: number, hand?: HandSample): { anchor: Anchor; wrist?: number } | undefined {
  const lm = pose.lm;
  const seen = (i: number) => lm[i] !== undefined && lm[i][3] >= 0.5;
  if (!seen(11) || !seen(12)) return undefined;
  const at = (i: number): ImagePoint => [lm[i][0], lm[i][1]];
  const centre = middle(at(11), at(12));
  // As for the face: a body turned sideways shows narrow shoulders and its full length
  const torso = seen(23) && seen(24) ? (between(centre, middle(at(23), at(24)), aspect) * HEIGHT.ruler.shoulders) / HEIGHT.ruler.torso : 0;
  const width = between(at(11), at(12), aspect);
  const size = rulerSize(width, torso);
  if (!(size > 0.05 && size < 2)) return undefined;
  let wrist: number | undefined;
  if (hand) for (const i of [15, 16]) if (seen(i)) wrist = Math.min(wrist ?? Infinity, Math.hypot(lm[i][0] * aspect - hand.x, lm[i][1] - hand.row) / hand.palm);
  return { anchor: { kind: "pose", t, row: centre[1], x: centre[0] * aspect, size, m: HEIGHT.ruler.shoulders / size, across: width, along: torso }, wrist };
}

/** Above the hand, at a plausible distance behind it and not far to its side: how far to its side, m (undefined: not this hand's body) */
function belongsTo(hand: HandSample, anchor: Anchor) {
  const m = HEIGHT.palm / hand.palm;
  if (anchor.row > hand.row + 0.5 * hand.palm) return undefined;
  if (anchor.m < HEIGHT.face.near[0] * m || anchor.m - m > HEIGHT.face.near[1]) return undefined;
  const aside = Math.abs(anchor.x - hand.x) * anchor.m;
  return aside <= HEIGHT.face.aside ? aside : undefined;
}

/**
 * The anchor of the player whose hand this is, from what the body models saw
 * in one frame: a face if there is one (the mesh's points where it lies on
 * the chosen face: they are steadier than the detector's), else a body.
 *
 * Of several faces: the one that continues `previous` (the anchor last in
 * use, if the caller still trusts it); else the one above the hand, at a
 * plausible distance behind it, nearest to its side. Of several bodies: the
 * one whose wrist is at the hand. Without a hand only `previous` can choose.
 * aspect: image width / height.
 */
export function anchorFrom(body: BodyObservation, hand: HandSample | undefined, aspect: number, previous?: Anchor): Anchor | undefined {
  const t = body.t / 1000;
  const continues = (anchors: Anchor[]) => {
    let best: Anchor | undefined;
    let least = HEIGHT.face.gate;
    for (const a of anchors) {
      if (!previous || previous.kind !== a.kind) continue;
      const moved = Math.hypot(a.x - previous.x, a.row - previous.row) * previous.m;
      const ratio = a.size / previous.size;
      if (moved < least && ratio > 1 / 1.4 && ratio < 1.4) [best, least] = [a, moved];
    }
    return best;
  };
  const nearest = (anchors: Anchor[]) => {
    let best: Anchor | undefined;
    let least = Infinity;
    for (const a of anchors) {
      const aside = hand && belongsTo(hand, a);
      if (aside !== undefined && aside < least) [best, least] = [a, aside];
    }
    return best;
  };

  const faces: Anchor[] = [];
  for (const face of body.faces ?? []) {
    if (face.score < HEIGHT.face.score || face.kp.length < 4) continue;
    const anchor = faceAnchor(t, face.kp[0], face.kp[1], face.kp[3], aspect);
    if (anchor) faces.push(anchor);
  }
  const points = body.mesh?.points;
  const mesh = points && points.length >= 6 ? faceAnchor(t, middle(points[0], points[1]), middle(points[3], points[2]), points[5], aspect) : undefined;
  if (mesh) {
    // The mesh is of one face, and not said to be of which: it stands in for the detector's face it lies on, or counts as a face of its own
    const same = faces.findIndex((f) => Math.hypot(f.x - mesh.x, f.row - mesh.row) < Math.max(f.size, mesh.size));
    if (same >= 0) faces[same] = mesh;
    else faces.push(mesh);
  }
  const face = continues(faces) ?? nearest(faces);
  if (face) return face;

  const bodies = (body.poses ?? []).map((pose) => poseAnchor(t, pose, aspect, hand)).filter((b) => b !== undefined);
  // The body whose wrist is at the hand; one that shows no wrist counts like a face
  const held = bodies.filter((b) => b.wrist !== undefined && b.wrist <= HEIGHT.wrist).sort((a, b) => a.wrist! - b.wrist!)[0];
  if (held) return held.anchor;
  const others = bodies.filter((b) => b.wrist === undefined || !hand).map((b) => b.anchor);
  return continues(others) ?? nearest(others);
}

/**
 * The horizon row from the hand held at ONE height at two distances from the
 * camera (the installer's step): at the horizon row a hand at the camera's
 * own height stays put whatever its distance, so the two holds
 *     (y_h − row_a) / palm_a = (y_h − row_b) / palm_b
 * give y_h. row: the palm's row; palm: its length, image heights.
 */
export function horizonFromTwoHolds(a: { row: number; palm: number }, b: { row: number; palm: number }): number {
  return (a.row * b.palm - b.row * a.palm) / (b.palm - a.palm);
}

/** Least squares line through points with weights: its value at x = 0, and what is needed to say how sure that is */
function lineAtZero(points: { x: number; y: number; weight: number }[]) {
  let [W, mx, my] = [0, 0, 0];
  for (const p of points) {
    W += p.weight;
    mx += p.weight * p.x;
    my += p.weight * p.y;
  }
  mx /= W;
  my /= W;
  let [sxx, sxy] = [0, 0];
  for (const p of points) {
    sxx += p.weight * (p.x - mx) ** 2;
    sxy += p.weight * (p.x - mx) * (p.y - my);
  }
  if (!(sxx > 0)) return undefined;
  const slope = sxy / sxx;
  const at = my - slope * mx;
  let residual = 0;
  for (const p of points) residual += p.weight * (p.y - at - slope * p.x) ** 2;
  return { at, residual: Math.sqrt(residual / W), mean: mx, variance: sxx / W };
}

const mergeEstimates = (a: { row: number; sigma: number } | undefined, b: { row: number; sigma: number }) => {
  if (!a) return b;
  const [wa, wb] = [1 / (a.sigma * a.sigma), 1 / (b.sigma * b.sigma)];
  return { row: (a.row * wa + b.row * wb) / (wa + wb), sigma: Math.max(0.01, 1 / Math.sqrt(wa + wb)) };
};

/**
 * The horizon row from an anchor that keeps its height while the player walks
 * towards the camera or away from it: its row is then a straight line in its
 * size,
 *     row = y_h − (H_a / (c · ruler)) · size,
 * and the line's value at size 0 (the anchor infinitely far away) is the
 * horizon row. Samples are averaged in bins of the size (10 % wide), so that
 * standing in one place for long does not outweigh the walk; an estimate is
 * given only once the sizes spread by 1.5 times over at least four bins. A
 * player who sits down in the middle bends the line: the caller restarts the
 * fit then, as for a new player. What was estimated before a restart is kept
 * and averaged in.
 */
export class HorizonFit {
  /** The horizon row and how far it may be off, rows; undefined until the sizes have spread enough */
  estimate?: { row: number; sigma: number };
  private bins = new Map<number, { n: number; row: number; size: number }>();
  private kept?: { row: number; sigma: number };
  private own?: { row: number; sigma: number };
  private last = -Infinity;

  /** row: the anchor's row; size: its ruler in the image, image heights (both smoothed by the caller); t in s */
  add(row: number, size: number, t: number) {
    if (!(size > 0) || t - this.last < 0.05) return;
    this.last = t;
    const key = Math.round(Math.log(size) / 0.1);
    const bin = this.bins.get(key);
    if (!bin) this.bins.set(key, { n: 1, row, size });
    else {
      bin.n++;
      const share = 1 / Math.min(bin.n, 30);
      bin.row += (row - bin.row) * share;
      bin.size += (size - bin.size) * share;
    }
    this.solve();
  }

  /** Another player, or another posture: the line starts anew; the estimate so far stays */
  restart() {
    if (this.own) this.kept = mergeEstimates(this.kept, this.own);
    this.own = undefined;
    this.bins.clear();
    this.estimate = this.kept;
  }

  private solve() {
    // A bin with one sample may be a single bad frame: it counts from two on (a face seen five times a second
    // passes through a bin in half a second of walking)
    const bins = [...this.bins.values()].filter((b) => b.n >= 2);
    const sizes = bins.map((b) => b.size);
    if (bins.length < 4 || Math.max(...sizes) < 1.5 * Math.min(...sizes)) return;
    const line = lineAtZero(bins.map((b) => ({ x: b.size, y: b.row, weight: Math.min(b.n, 15) })));
    if (!line) return;
    // The bins are what is independent here (neighbouring samples are not: they are smoothed, and a head bobs for half a second)
    const sigma = (Math.max(line.residual, 0.004) / Math.sqrt(bins.length)) * Math.sqrt(1 + (line.mean * line.mean) / line.variance);
    if (sigma > 0.05) return;
    this.own = { row: line.at, sigma };
    this.estimate = mergeEstimates(this.kept, this.own);
  }
}

/**
 * The installer's step ("Kamera einmessen"): the hand is laid at one fixed
 * height (a table's edge, a stick) and held still, near the camera and then
 * further away. Every hold is one point; from two on, with palm sizes at
 * least 1.3 times apart, they give the horizon row (horizonFromTwoHolds; more
 * holds: the line through all of them).
 */
export class HorizonHolds {
  readonly holds: { row: number; palm: number }[] = [];
  /** The horizon row, once two holds far enough apart are there */
  row?: number;
  /** 0…1: how much of the hold in progress is done (0 while the hand moves, or still rests where the last hold was taken) */
  progress = 0;
  private window: { t: number; row: number; palm: number }[] = [];

  /** One frame of the cross hand (undefined: none in this frame); true when a hold was taken */
  add(sample?: { t: number; row: number; palm: number }): boolean {
    this.progress = 0;
    if (!sample) {
      this.window = [];
      return false;
    }
    const window = this.window;
    window.push(sample);
    // The longest stretch up to now in which the hand stayed put: within 2 cm in height (and what the
    // landmarks of a far hand shake by) and 8 % in size. Loose: the hold is the average of the stretch
    const steady = () => {
      const rows = window.map((s) => s.row);
      const palms = window.map((s) => s.palm);
      return Math.max(...rows) - Math.min(...rows) <= 0.2 * sample.palm + 0.006 && Math.max(...palms) <= 1.08 * Math.min(...palms);
    };
    while (window.length > 1 && (sample.t - window[0].t > HORIZON_HOLD + 0.2 || !steady())) window.shift();
    // The same place as the last hold is no new point: the hand has to go nearer or further first
    const last = this.holds[this.holds.length - 1];
    if (last && Math.max(sample.palm / last.palm, last.palm / sample.palm) < 1.15) return false;
    this.progress = clamp((sample.t - window[0].t) / HORIZON_HOLD, 0, 1);
    if (this.progress < 1) return false;
    const mean = (pick: (s: { row: number; palm: number }) => number) => window.reduce((sum, s) => sum + pick(s), 0) / window.length;
    this.holds.push({ row: mean((s) => s.row), palm: mean((s) => s.palm) });
    this.window = [];
    this.progress = 0;
    const palms = this.holds.map((h) => h.palm);
    if (this.holds.length >= 2 && Math.max(...palms) >= 1.3 * Math.min(...palms)) {
      this.row = this.holds.length === 2 ? horizonFromTwoHolds(this.holds[0], this.holds[1]) : lineAtZero(this.holds.map((h) => ({ x: h.palm, y: h.row, weight: 1 })))?.at ?? this.row;
    }
    return true;
  }
}
/** s the hand has to rest for a hold */
const HORIZON_HOLD = 1;

/** A height above the camera's plane kept as the row and scale it was seen at (plus metres), so that it moves along when the horizon row does */
interface Level {
  row: number;
  m: number;
  offset: number;
}
type ZeroKind = "calibrated" | "body-prior" | "default";

/**
 * The height model's state: the camera's (the horizon row; it stays when the
 * player changes) and the player's (the zero, the body shift, the guided
 * capture). Fed by the tracker once per camera frame: update() with the cross
 * hand, watch() while there is none; handAppeared() / handGone() when the
 * cross hand's role is taken or given up.
 */
export class BodyFrame {
  /** The player's own correction, m: the puppet stands this much higher (+) or lower than where the zero was taken */
  trim = 0;
  /** Offer the guided capture to each new player */
  guide = true;
  /** Image width / height (for the body's points, which are normalized to each) */
  aspect = 4 / 3;
  /**
   * From the page, as far as it knows (a script leaves them alone): whether
   * the hand moves the puppet at all (a hand in the low zone of the picture
   * does not, hand-release.ts), and whether a new player's puppet is still on
   * its way down. The capture's clock only runs while connected and landed.
   */
  connected = true;
  flying = false;
  /** s the hand has to hold still for the zero to be taken (the tracker's own time for a rest pose) */
  settle = 1;
  /** Counts the players: up by one with every hand that is not the last player's coming back */
  player = 0;
  /** The horizon row as fitted from an anchor (page session only) */
  readonly fit = new HorizonFit();

  // The camera
  private measured?: number;
  private horizon = 0.5;
  /** No hand is being read: the next reading takes the horizon row as it is then, without moving there */
  private snap = true;
  // The player
  private kind: ZeroKind = "default";
  private zero: Level = { row: 0.5, m: 0, offset: 0 };
  /**
   * The body shift is the anchor's height where the zero has followed it to
   * (`at`) less its height when the zero was taken (`ref`, or when it was last
   * found again). Both are kept as levels, not as metres, so that a shift
   * followed under a wrong horizon row (a walk towards the camera looks like
   * the body rising) comes out right once the row is known.
   */
  private ref?: Level;
  private at?: Level;
  private reref = false;
  private following = false;
  private over = 0;
  /** Changes of the zero that are still coming in: each a step taken back at first and then let go */
  private blends: { amount: number; start: number; time: number }[] = [];
  private appliedTrim = 0;
  private sigma?: number;
  /** held: the hand's row and size averaged over the hold in progress (n frames): what the zero is taken from */
  private guiding?: { elapsed: number; fresh: boolean; holdSince: number; doneAt?: number; band: [number, number]; held: { n: number; row: number; palm: number } };
  /** The cross hand as last read: a short average of its row and size (a zero is taken from it), the time, and the size of the anchor in use then */
  private hand?: { t: number; row: number; palm: number; anchor?: number };
  /** row, across, along: averaged, and size from the two averages; seen: when it was last found; since, count: for how long and how often in this stretch */
  private anchor?: { kind: Anchor["kind"]; last: Anchor; row: number; size: number; across: number; along: number; seen: number; since: number; count: number };
  private lookedAt?: number;
  /** While there is no cross hand: when it was last seen, its size then, the anchor's size then and whether that anchor has stayed */
  private gone?: { t: number; palm: number; anchor?: number; kept: boolean };
  /** The last reading (update() returns this same object, changed in place) */
  readonly reading: HeightReading = { value: 0, sigma: HEIGHT.sigma.default, confidence: 0, sources: ["hand", "default", "horizon-default"], standRow: 0.5, horizonRow: 0.5, hand: 0, shift: 0 };

  /**
   * The horizon row as measured for this camera (the installer's step, or
   * ?horizon=): the picture's row at the camera's own height, 0 top … 1
   * bottom. undefined: not measured (a fitted one, or ½, is used).
   */
  setHorizon(row: number | undefined) {
    this.measured = row !== undefined && Number.isFinite(row) ? row : undefined;
  }

  /**
   * A hand has taken the cross hand's role (first frame in which it counts).
   * The same player as before, or a new one? A new one starts without a zero
   * and is offered the capture; what is known about the camera stays.
   */
  handAppeared(t: number, hand: HandSample) {
    const gone = this.gone;
    this.gone = undefined;
    this.snap = true;
    let same = !!gone && t - gone.t < HEIGHT.player.gap;
    if (same && gone) {
      const a = this.anchor;
      if (gone.anchor !== undefined) same = gone.kept && !!a && t - a.seen <= HEIGHT.player.left && Math.abs(a.size / gone.anchor - 1) <= HEIGHT.player.anchor;
      else same = Math.max(hand.palm / gone.palm, gone.palm / hand.palm) <= 1 + HEIGHT.player.palm;
    }
    if (same) return;
    this.player++;
    this.kind = "default";
    this.zero = { row: 0.5, m: 0, offset: 0 };
    this.ref = this.at = undefined;
    this.reref = false;
    this.following = false;
    this.over = 0;
    this.blends = [];
    this.appliedTrim = this.trim;
    this.sigma = undefined;
    this.guiding = this.guide ? { elapsed: 0, fresh: true, holdSince: Infinity, band: [...HEIGHT.guide.rows], held: { n: 0, row: 0, palm: 0 } } : undefined;
    // The last player's face says nothing about this one's, and their walk nothing about this one's height
    this.anchor = undefined;
    this.fit.restart();
  }

  /** The cross hand's role was given up (a while after it was last seen); t: when it was last seen, s */
  handGone(t: number) {
    if (!this.hand) return;
    // The anchor as it was when the hand was last read, and whether it has stayed since (watch() goes on asking)
    const [a, before] = [this.anchor, this.hand.anchor];
    const stayed = before === undefined || (!!a && (this.lookedAt ?? t) - a.seen <= HEIGHT.player.left && Math.abs(a.size / before - 1) <= HEIGHT.player.anchor);
    this.gone = { t, palm: this.hand.palm, anchor: before, kept: stayed };
    this.hand = undefined;
    if (this.guiding) this.guiding.holdSince = Infinity;
  }

  /** A frame without a cross hand: the anchor is followed on, so that a hand coming back can be told from a new player's */
  watch(t: number, body?: BodyObservation) {
    this.see(t, body);
    const gone = this.gone;
    if (gone?.anchor === undefined || !gone.kept) return;
    const a = this.anchor;
    if (!a || t - a.seen > HEIGHT.player.left || Math.abs(a.size / gone.anchor - 1) > HEIGHT.player.anchor) gone.kept = false;
  }

  /**
   * The hand as it is held now is where the puppet stands (the reset button):
   * taken at once, wherever it is. eased: false if the caller moves its own
   * output over (the tracker does after a reset: the whole cross goes over
   * to the new rest pose in one move, and two moves on top of each other
   * would be faster than either).
   */
  capture(eased = true) {
    if (!this.hand) return;
    const t = this.hand.t;
    this.take(t, this.usable(t));
    if (!eased) this.blends = [];
    if (this.guide) this.guiding = { elapsed: 0, fresh: false, holdSince: Infinity, doneAt: t, band: this.guiding?.band ?? [this.reading.standRow, this.reading.standRow], held: { n: 0, row: 0, palm: 0 } };
  }

  /** One camera frame with the cross hand in it */
  update(hand: HandSample, body?: BodyObservation): HeightReading {
    const t = hand.t;
    const dt = this.hand ? clamp(t - this.hand.t, 0, 0.25) : 0;
    if (!this.hand) this.hand = { t, row: hand.row, palm: hand.palm };
    else {
      // A few frames' average: one frame alone is noisy, and a zero is for good
      const share = 1 - Math.exp(-dt / 0.08);
      this.hand.row += (hand.row - this.hand.row) * share;
      this.hand.palm += (hand.palm - this.hand.palm) * share;
      this.hand.t = t;
    }
    this.see(t, body, hand);

    // The horizon row: measured, else fitted, else a level camera's
    const S = HEIGHT.sigma;
    const fitted = this.fit.estimate;
    const target: { row: number; sigma: number; source: HeightSource } =
      this.measured !== undefined ? { row: this.measured, sigma: S.measured, source: "horizon-measured" }
      : fitted ? { row: fitted.row, sigma: Math.max(fitted.sigma, S.fit), source: "horizon-fit" }
      : { row: 0.5, sigma: S.unknown, source: "horizon-default" };
    if (this.snap) [this.horizon, this.snap] = [target.row, false];
    else this.horizon += clamp(target.row - this.horizon, -HEIGHT.ease.horizon * dt, HEIGHT.ease.horizon * dt);
    const horizon = this.horizon;
    // How far the row in use may be off: as far as its source says, and for as long as it is still on its way there
    const sigmaH = Math.hypot(target.sigma, target.row - horizon);
    const c = cosine(horizon);
    const m = HEIGHT.palm / hand.palm;
    const H = c * (horizon - hand.row) * m;
    const a = this.usable(t);
    this.hand.anchor = a?.size;
    const anchorM = a ? RULER[a.kind] / a.size : 0;
    const Ha = a ? c * (horizon - a.row) * anchorM : undefined;

    // Before any capture: the hand is taken to play a fixed way below the eyes (or the shoulders)
    if (this.kind === "default" && a) this.setZero(t, "body-prior", { row: a.row, m: anchorM, offset: -HEIGHT.below[a.kind] }, a);
    if (this.trim !== this.appliedTrim) {
      this.blend(t, this.trim - this.appliedTrim);
      this.appliedTrim = this.trim;
    }

    const guide = this.runGuide(t, dt, hand, m, c, a && Ha !== undefined ? Ha - HEIGHT.below[a.kind] : undefined);

    // The body shift: the zero goes along with the body
    const w = clamp(sigmaH / S.trusted, 0, 1);
    if (a && Ha !== undefined) {
      const here: Level = { row: a.row, m: anchorM, offset: 0 };
      if (!this.ref || !this.at) [this.ref, this.at] = [here, here];
      // Found again after it was lost: counted from here on, with what was applied so far left as it is
      else if (this.reref) [this.ref, this.at] = [{ ...here, offset: -this.bodyShift() }, here];
      this.reref = false;
      const tuning = HEIGHT.shift;
      // How far the zero is behind the body
      let behind = Ha - this.level(this.ref) - this.bodyShift();
      const threshold = (1 - w) * Math.max(tuning.threshold, (3 * Math.abs(Ha) * tuning.pixel) / a.size);
      if (!this.following) {
        // With the horizon row known (w = 0) only a change that is large and lasts is followed: sitting down,
        // standing up. Unknown (w = 1), every change is: the anchor then shows the same false rise as the
        // hand when the player walks towards the camera, and following it cancels that
        if (Math.abs(behind) > threshold) {
          this.over += dt;
          if (this.over >= tuning.hold * (1 - w)) {
            this.following = true;
            // Another posture: the anchor is at another height, which bends the horizon fit's line
            if (w < 1) this.fit.restart();
          }
        } else this.over = 0;
      }
      if (this.following) {
        const most = HEIGHT.ease.speed * dt;
        behind -= clamp(behind * (1 - Math.exp(-dt / Math.max(tuning.follow, (tuning.ease * (1 - w)) / 4))), -most, most);
        this.at = { ...here, offset: -behind };
        if (w < 1 && Math.abs(behind) < tuning.settled) [this.following, this.over] = [false, 0];
      }
      // Not following, and what was followed is less than what would be followed now: not a change of posture. Let go of it
      const kept = this.bodyShift();
      if (!this.following && kept !== 0 && Math.abs(kept) < threshold) {
        this.at = this.ref;
        this.blend(t, -kept);
      }
    }
    const shift = this.bodyShift();

    // Changes of the zero come in over a while: each is taken back at first, and the taking back fades
    let easing = 0;
    this.blends = this.blends.filter((b) => t - b.start < b.time);
    for (const b of this.blends) easing += b.amount * (1 - smoothstep((t - b.start) / b.time));
    const zero = this.level(this.zero) + shift + this.appliedTrim - easing;

    const scale = S.scale * (1 + 3 * clamp((hand.speed - 0.8) / 2.4, 0, 1)) * Math.max(1, 0.12 / hand.palm);
    // How far an error of the horizon row reaches: it cancels at the scale the zero was taken at, and as far as the anchor was followed
    const lever = m - this.zero.m - (this.ref && this.at ? this.at.m - this.ref.m : 0);
    const raw = Math.hypot(S[this.kind === "body-prior" ? "prior" : this.kind], lever * sigmaH, H * scale, a && this.following ? w * S.anchor : 0);
    this.sigma = this.sigma === undefined ? raw : this.sigma + (raw - this.sigma) * (1 - Math.exp(-dt / HEIGHT.ease.sigma));

    const reading = this.reading;
    reading.value = H - zero;
    reading.sigma = this.sigma;
    reading.confidence = clamp(1 - this.sigma / S.full, 0, 1);
    reading.sources = a ? ["hand", a.kind, this.kind, target.source] : ["hand", this.kind, target.source];
    reading.standRow = horizon - zero / (c * m);
    reading.horizonRow = horizon;
    reading.hand = H;
    reading.anchor = Ha;
    reading.shift = shift;
    reading.guide = guide;
    if (guide?.state === "done" && this.guiding) {
      // The band closes onto the line at which the puppet stands
      const k = smoothstep((t - this.guiding.doneAt!) / 0.6);
      guide.band = [this.guiding.band[0] + (reading.standRow - this.guiding.band[0]) * k, this.guiding.band[1] + (reading.standRow - this.guiding.band[1]) * k];
    }
    return reading;
  }

  /** The guided capture for this frame: what to show, and the zero when the hand has held still in the band. prior: the guessed zero above the camera's plane, with an anchor */
  private runGuide(t: number, dt: number, hand: HandSample, m: number, c: number, prior?: number): HeightGuide | undefined {
    const g = this.guiding;
    const tuning = HEIGHT.guide;
    if (!g || !this.guide) return undefined;
    if (!this.connected) {
      // The hand does not lead the puppet (yet): nothing is offered, the clock stands, and what it held still for does not count
      [g.fresh, g.holdSince] = [false, Infinity];
      return undefined;
    }
    if (g.doneAt !== undefined) {
      if (t - g.doneAt >= tuning.done) {
        this.guiding = undefined;
        return undefined;
      }
      return { state: "done", band: g.band, progress: 1, arrow: 0 };
    }
    // The rows a zero is taken in: the middle of the picture, where the hand is seen well and has room both ways
    let band: [number, number] = [...tuning.rows];
    if (prior !== undefined) {
      // … and near where this player's hand is expected, so that a hand resting on the way up is not taken
      const rows: [number, number] = [Math.max(band[0], this.horizon - (prior + tuning.near) / (c * m)), Math.min(band[1], this.horizon - (prior - tuning.near) / (c * m))];
      if (rows[1] - rows[0] > 0.05) band = rows; // (a guess that lies outside the picture's middle is no help: the camera is not where it is taken to be)
    }
    g.band = band;
    if (this.flying) {
      [g.fresh, g.holdSince] = [false, Infinity];
      return { state: "flying", band, progress: 0, arrow: 0 };
    }
    g.elapsed += dt;
    if (g.elapsed > tuning.time) {
      // Not taken: the zero stays what it is, and is not taken behind the player's back later
      this.guiding = undefined;
      return undefined;
    }
    const state: HeightGuide["state"] = hand.palm > tuning.close ? "back" : hand.row < band[0] || hand.row > band[1] ? "place" : hand.lean > tuning.edge ? "tilt" : "hold";
    let progress = 0;
    if (state === "hold") {
      // The stillness has to fall into the time the hint is up. A hand that is in the band from its first
      // frame is credited what it has held still already: the tracker takes its rest pose on the same frame
      if (g.holdSince === Infinity) [g.holdSince, g.held.n] = [g.fresh ? t - hand.still : t, 0];
      progress = clamp(Math.min(hand.still, t - g.holdSince + 1e-6) / this.settle, 0, 1);
      // The zero is for good: taken from the whole hold, not from its last frames (a far hand's size shakes by percents)
      const share = 1 / ++g.held.n;
      g.held.row += (hand.row - g.held.row) * share;
      g.held.palm += (hand.palm - g.held.palm) * share;
    } else g.holdSince = Infinity;
    g.fresh = false;
    if (progress >= 1) {
      if (g.held.n >= 10) Object.assign(this.hand!, { row: g.held.row, palm: g.held.palm });
      this.take(t, this.usable(t));
      g.doneAt = t;
      return { state: "done", band, progress: 1, arrow: 0 };
    }
    return { state, band, progress, arrow: state === "place" ? (hand.row > band[1] ? 1 : -1) : 0 };
  }

  /** The hand's present height becomes the zero */
  private take(t: number, a: BodyFrame["anchor"]) {
    if (!this.hand) return;
    this.setZero(t, "calibrated", { row: this.hand.row, m: HEIGHT.palm / this.hand.palm, offset: 0 }, a);
  }

  private setZero(t: number, kind: ZeroKind, zero: Level, a: BodyFrame["anchor"]) {
    const before = this.level(this.zero) + this.bodyShift();
    this.kind = kind;
    this.zero = zero;
    this.following = false;
    this.over = 0;
    this.ref = this.at = a ? { row: a.row, m: RULER[a.kind] / a.size, offset: 0 } : undefined;
    this.reref = false;
    this.blend(t, this.level(zero) - before);
  }

  /** The zero has just changed by `amount`: it comes in over a while, no faster than HEIGHT.ease.speed at its fastest */
  private blend(t: number, amount: number) {
    if (!this.hand || this.sigma === undefined || Math.abs(amount) < 1e-9) return; // nothing shown yet: nothing to ease from
    this.blends.push({ amount, start: t, time: Math.max(HEIGHT.ease.time, (1.5 * Math.abs(amount)) / HEIGHT.ease.speed) });
  }

  /** A kept level above the camera's plane, m, for the horizon row in use */
  private level(level: Level) {
    return cosine(this.horizon) * (this.horizon - level.row) * level.m + level.offset;
  }

  /** How far the zero has gone along with the body, m, for the horizon row in use */
  private bodyShift() {
    return this.ref && this.at ? this.level(this.at) - this.level(this.ref) : 0;
  }

  /** The anchor, if it has been seen lately and for long enough to be averaged */
  private usable(t: number) {
    const a = this.anchor;
    return a && t - a.seen <= HEIGHT.shift.lost && t - a.since >= HEIGHT.shift.steady && a.count >= HEIGHT.shift.sightings ? a : undefined;
  }

  /** What the body models saw in this frame, if they ran: the anchor is found, and its row and size are averaged on */
  private see(t: number, body?: BodyObservation, hand?: HandSample) {
    const dt = this.lookedAt === undefined ? 0 : clamp(t - this.lookedAt, 0, 0.25);
    this.lookedAt = t;
    let a = this.anchor;
    let observed = false;
    if (body) {
      const found = anchorFrom(body, hand, this.aspect, a && t - a.seen < 2 ? a.last : undefined);
      if (found) {
        observed = true;
        if (!a || a.kind !== found.kind || t - a.seen > HEIGHT.shift.lost) {
          // New, of another kind (another ruler: another line), or back after it was lost: averaged anew, and the shift is counted anew
          if (a && a.kind !== found.kind) this.fit.restart();
          a = this.anchor = { kind: found.kind, last: found, row: found.row, size: found.size, across: found.across, along: found.along, seen: t, since: t, count: 1 };
          this.reref = true;
        } else {
          a.last = found;
          a.seen = t;
          a.count++;
        }
      }
    }
    if (!a || t - a.seen > HEIGHT.shift.lost) return;
    // Towards what was last seen, on every frame (the body models may run on few of them). While it is
    // young: the average of what there is. The size, not its inverse: the row is a straight line in it.
    // Its two measures are averaged apart and combined after: which of them is the larger is then
    // asked of the averages, not of every noisy frame
    const share = 1 - Math.exp(-dt / clamp(t - a.since, 0.05, HEIGHT.shift.lowPass));
    a.row += (a.last.row - a.row) * share;
    a.across += (a.last.across - a.across) * share;
    a.along += (a.last.along - a.along) * share;
    a.size = rulerSize(a.across, a.along);
    if (observed && this.usable(t)) this.fit.add(a.row, a.size, t);
  }
}
const RULER = { face: HEIGHT.ruler.eyes, pose: HEIGHT.ruler.shoulders };
