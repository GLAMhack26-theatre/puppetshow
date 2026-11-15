import type { BodySeen, FaceKeypoints, ImagePoint, PoseLandmarks } from "./body-frame.ts";
import { posedHand, type HandPose } from "./hand-synthetic.ts";
import type { HandFrame, Point } from "./hand-tracking.ts";

// A synthetic scene: a camera somewhere in a room, pitched up or down, and in
// front of it a player with a hand held out, all in metres. Projected to what
// the models would report: the hand's landmarks (the hand model of
// hand-synthetic.ts) and the body observations of body-frame.ts.
//
// hand-synthetic.ts poses its hand in the picture (image position and depth),
// which cannot say "the same hand, seen by a camera 30 cm lower and pitched
// up". The height model (BodyFrame) is about exactly that, so its tests
// (scripts/test-body-frame.ts) need a room. Like the synthetic hand it proves
// the maths, not the models' accuracy: the body's proportions below are the
// scene's own, and no face or body detector has been compared with them.
//
// Room axes: x to the right as the raw (not mirrored) picture shows it, y up
// from the floor, z away from the camera along the floor. The camera is at
// (0, height, 0).

export interface SceneCamera {
  /** The lens above the floor, m */
  height: number;
  /** rad; positive looks up (as a recording's "Kameraneigung") */
  pitch: number;
  /** Focal length, image heights */
  focal: number;
  /** Image width / height */
  aspect: number;
}

export interface SceneHand extends HandPose {
  /** Where the hand turns about (in its palm): m to the right of the camera's axis, m above the floor, m in front of the camera */
  x: number;
  height: number;
  distance: number;
  /**
   * HandPose's turns are in the room here, not in the camera's axes: pitch 0
   * is a palm upright facing the camera's wall, π/2 a level palm with the
   * fingers towards it. A pitched camera sees it at another lean, as a real one would.
   */
  /** Size against the model hand's 9.5 cm palm (a child's: about 0.73) */
  scale?: number;
}

export interface ScenePlayer {
  /** Body height, m */
  stature: number;
  /** Where the body is (eyes and shoulders alike): m to the right of the camera's axis, m in front of the camera */
  x: number;
  distance: number;
  /** m the whole upper body is lower than when standing: sitting (sitDrop) */
  drop?: number;
  /** The head alone: m lower (a nod, the bob of a step), turned about the vertical and tipped forward, rad */
  headDrop?: number;
  headYaw?: number;
  headPitch?: number;
  /** m between the pupils; the face's other measures scale with it (adult 0.063, a child of eight about 0.055) */
  eyes?: number;
}

/**
 * The scene's body, as shares of the stature (standing): eyes, shoulder
 * joints and hips above the floor, half the shoulders' and the hips' width,
 * where a hanging wrist is, and how much lower the upper body is when seated.
 * Round textbook proportions, not measured on anyone.
 */
export const BODY = { eyes: 0.936, shoulders: 0.818, hips: 0.53, halfShoulders: 0.103, halfHips: 0.055, wrist: 0.47, sitDrop: 0.235 };
/** m the upper body comes down when a player of this stature sits (0.4 m for 1.7 m) */
export const sitDrop = (stature: number) => BODY.sitDrop * stature;
/** The eyes above the floor, m */
export const eyeHeight = (player: ScenePlayer) => BODY.eyes * player.stature - (player.drop ?? 0) - (player.headDrop ?? 0);

type V3 = [number, number, number];

/**
 * The face around the middle between the pupils, for eyes 0.063 m apart: x to
 * the picture's right for a player who faces the camera, y up, z towards the
 * camera. The mouth is 0.066 m below the eyes' line, not the height model's
 * 0.068: faces differ, and the scene should not agree with the model by
 * construction.
 */
const FACE = {
  rightEye: [-0.0315, 0, 0], leftEye: [0.0315, 0, 0], nose: [0, -0.035, 0.035], mouth: [0, -0.066, 0.012],
  rightEar: [-0.073, -0.008, -0.085], leftEar: [0.073, -0.008, -0.085],
  rightOuter: [-0.0445, 0, -0.004], rightInner: [-0.0185, 0, 0], leftInner: [0.0185, 0, 0], leftOuter: [0.0445, 0, -0.004],
  lips: [0, -0.066, 0.012], chin: [0, -0.118, 0.002], forehead: [0, 0.072, -0.002], rightSide: [-0.07, -0.02, -0.06], leftSide: [0.07, -0.02, -0.06],
} satisfies Record<string, V3>;
/** Where the head turns about, in the same frame (the top of the neck) */
const NECK: V3 = [0, -0.04, -0.09];

export interface Scene {
  hand?: SceneHand;
  player?: ScenePlayer;
}

export interface SceneNoise {
  /** Gaussian source (hand-synthetic.ts gaussian) */
  random: () => number;
  /** σ of each body point, rows (0.002 is about a pixel of a 480 px picture); the hand's landmarks get the synthetic hand's own noise */
  body?: number;
}

export interface SceneView {
  /** The hand as MediaPipe would report it (raw image), if the scene has one */
  hands: HandFrame[];
  /** What all three body models would report, if the scene has a player */
  body?: BodySeen;
  /** What is really there: the palm's centre (what the tracker measures as the hand's place), the eyes and the shoulders, m above the floor */
  truth: { palm?: number; eyes?: number; shoulders?: number };
}

/** A point of the room in the camera's picture: x, y each 0…1, and its depth along the camera's axis, m */
export function projectPoint(camera: SceneCamera, [x, y, z]: V3) {
  const [c, s] = [Math.cos(camera.pitch), Math.sin(camera.pitch)];
  // Camera axes: x right, y down, z away; pitched up, its "away" rises
  const down = -(y - camera.height) * c + z * s;
  const depth = (y - camera.height) * s + z * c;
  return { x: 0.5 + (camera.focal * x) / depth / camera.aspect, y: 0.5 + (camera.focal * down) / depth, depth };
}

/** The picture's row at the camera's own height */
export const horizonRow = (camera: SceneCamera) => 0.5 + camera.focal * Math.tan(camera.pitch);

export function viewScene(camera: SceneCamera, scene: Scene, noise?: SceneNoise): SceneView {
  const view: SceneView = { hands: [], truth: {} };
  const jitter = (sigma: number) => (noise ? noise.random() * sigma : 0);
  let wrist: V3 | undefined;

  if (scene.hand) {
    const hand = scene.hand;
    const scale = hand.scale ?? 1;
    // The posed hand's offsets are in the axes of a level camera (x right, y down, z away): the room's with y turned over
    const offsets = posedHand(hand).map(([x, y, z]): V3 => [x * scale, y * scale, z * scale]);
    const room = offsets.map(([x, y, z]): V3 => [hand.x + x, hand.height - y, hand.distance + z]);
    wrist = room[0];
    const seen = room.map((p) => projectPoint(camera, p));
    const image: Point[] = seen.map((p) => ({
      x: p.x + jitter(0.003),
      y: p.y + jitter(0.004),
      z: ((p.depth - seen[0].depth) * camera.focal) / seen[0].depth / camera.aspect,
    }));
    // World landmarks: metres around the hand's centre, in the camera's own axes
    const [c, s] = [Math.cos(camera.pitch), Math.sin(camera.pitch)];
    const turned = offsets.map(([x, y, z]): V3 => [x, y * c + z * s, -y * s + z * c]);
    const mean = turned.reduce((m, p) => [m[0] + p[0] / turned.length, m[1] + p[1] / turned.length, m[2] + p[2] / turned.length], [0, 0, 0] as V3);
    const world: Point[] = turned.map(([x, y, z]) => ({ x: x - mean[0] + jitter(0.0015), y: y - mean[1] + jitter(0.0015), z: z - mean[2] + jitter(0.004) }));
    view.hands.push({ image, world, handedness: hand.hand === "right" ? "Right" : "Left", score: 0.95 });
    // Wrist and the four knuckles: the palm whose centre the tracker takes
    view.truth.palm = [0, 5, 9, 13, 17].reduce((sum, i) => sum + room[i][1] / 5, 0);
  }

  if (scene.player) {
    const player = scene.player;
    const sigma = noise?.body ?? 0.002;
    const eyes = eyeHeight(player);
    const lowered = player.drop ?? 0;
    const k = (player.eyes ?? 0.063) / 0.063;
    const [cy, sy, cp, sp] = [Math.cos(player.headYaw ?? 0), Math.sin(player.headYaw ?? 0), Math.cos(player.headPitch ?? 0), Math.sin(player.headPitch ?? 0)];
    /** A point of the face in the picture: turned about the neck, then put into the room (the face looks at the camera: its z is the room's −z) */
    const face = (p: V3): ImagePoint => {
      let [x, y, z] = [(p[0] - NECK[0]) * k, (p[1] - NECK[1]) * k, (p[2] - NECK[2]) * k];
      [y, z] = [y * cp - z * sp, y * sp + z * cp]; // tipped forward: the forehead comes towards the camera and down
      [x, z] = [x * cy + z * sy, -x * sy + z * cy];
      const seen = projectPoint(camera, [player.x + x + NECK[0] * k, eyes + y + NECK[1] * k, player.distance - z - NECK[2] * k]);
      return [seen.x + jitter(sigma), seen.y + jitter(sigma)];
    };
    const body = (x: number, y: number, z = player.distance): ImagePoint => {
      const seen = projectPoint(camera, [x, y, z]);
      return [seen.x + jitter(sigma), seen.y + jitter(sigma)];
    };

    // The face detector's six points, and a box around the face
    const kp = [FACE.rightEye, FACE.leftEye, FACE.nose, FACE.mouth, FACE.rightEar, FACE.leftEar].map(face);
    const [top, bottom] = [face(FACE.forehead), face(FACE.chin)];
    const xs = kp.map((p) => p[0]);
    const detected: FaceKeypoints = { kp, box: [Math.min(...xs), top[1], Math.max(...xs) - Math.min(...xs), bottom[1] - top[1]], score: 0.92 };
    const mesh = [FACE.rightOuter, FACE.rightInner, FACE.leftInner, FACE.leftOuter, FACE.nose, FACE.lips, FACE.chin, FACE.forehead, FACE.rightSide, FACE.leftSide].map(face);

    // The pose's landmarks that anything reads; the rest is not seen. The player's left is the picture's right
    const S = player.stature;
    const shoulders = BODY.shoulders * S - lowered;
    const lm: PoseLandmarks["lm"] = Array.from({ length: 33 }, () => [0.5, 1.2, 0, 0]);
    const put = (i: number, [x, y]: ImagePoint) => (lm[i] = [x, y, 0, 0.95]);
    put(0, face(FACE.nose));
    [FACE.leftInner, FACE.leftEye, FACE.leftOuter, FACE.rightInner, FACE.rightEye, FACE.rightOuter, FACE.leftEar, FACE.rightEar].forEach((p, i) => put(1 + i, face(p)));
    put(9, face([0.02, FACE.mouth[1], FACE.mouth[2]]));
    put(10, face([-0.02, FACE.mouth[1], FACE.mouth[2]]));
    put(11, body(player.x + BODY.halfShoulders * S, shoulders));
    put(12, body(player.x - BODY.halfShoulders * S, shoulders));
    put(23, body(player.x + BODY.halfHips * S, BODY.hips * S - lowered));
    put(24, body(player.x - BODY.halfHips * S, BODY.hips * S - lowered));
    // Wrists: the playing hand's is the hand's own, the other hangs
    const playing = scene.hand?.hand === "left" ? 15 : 16;
    for (const i of [15, 16]) {
      const side = i === 15 ? 1 : -1;
      if (i === playing && wrist) put(i, body(wrist[0], wrist[1], wrist[2]));
      else put(i, body(player.x + side * (BODY.halfShoulders * S + 0.05), BODY.wrist * S - lowered));
    }
    view.body = { faces: [detected], mesh: { matrix: [], points: mesh }, poses: [{ lm }] };
    view.truth.eyes = eyes;
    view.truth.shoulders = shoulders;
  }
  return view;
}
