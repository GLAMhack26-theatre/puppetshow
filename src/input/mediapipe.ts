import type { HandLandmarker, Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { Euler } from "@iwsdk/core";
import { hudLines } from "../spike/world";
import { createReleaseTimer } from "../ui/release-timer";
import { controlInput } from "./control-input";
import { LOW_ZONE, createHandRelease, type HandSample } from "./hand-release";

// MediaPipe HandLandmarker on the camera drives the puppet: wrist → control
// bar, thumb–index pinch → grip, a fist held for 3 s lets go of the puppet
// (hand-release.ts). Inference runs on requestVideoFrameCallback (once per
// camera frame), apart from the render loop. ?res=320 for 320×240 instead of
// 640×480.
//
// Started by the click on a sign (main.ts), which is the user gesture camera
// access needs on iOS; the button (or C) is for ?test=nocurtain and to try
// again after an error.

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_KNUCKLE = 9;
/** [middle joint, tip] of index, middle, ring and little finger */
const FINGERS = [[6, 8], [10, 12], [14, 16], [18, 20]];
const MAX_ROLL = 0.8; // rad
const PINCH = 0.06; // normalized image units
const SMOOTHING = 0.5; // 0: frozen, 1: raw landmarks (jitter)
/** Without a camera frame for this long the hand counts as gone (stalled camera or inference) */
const STALE_MS = 300;

const release = createHandRelease();
/** The hand in the last camera frame; null if there was none */
let sample: HandSample | null = null;
let sampleAt = 0;
/** Development: a pretended hand from the keyboard, see debugKeys() */
let debugHand: HandSample | null = null;

let tracking: Promise<void> | null = null;
let landmarker: Promise<HandLandmarker> | null = null;
const cameraButton = Object.assign(document.createElement("button"), { textContent: "Kamera starten (C)" });

/**
 * Starts the camera and the hand tracking; safe to call again. Must be called
 * straight from a user gesture. On an error (no permission, no camera) the
 * mouse keeps control and the camera button comes back.
 */
export function startHandTracking() {
  cameraButton.hidden = true;
  tracking ??= run().catch((e) => {
    console.warn("Hand tracking did not start", e);
    hudLines.camera = `error: ${e instanceof Error ? e.message : e}`;
    tracking = null;
    cameraButton.hidden = false;
  });
  return tracking;
}

/** The manual start, in the debug panel. */
export function addCameraButton() {
  cameraButton.addEventListener("click", startHandTracking);
  addEventListener("keydown", (e) => e.key === "c" && startHandTracking());
  document.getElementById("panel")!.prepend(cameraButton);
  if (import.meta.env.DEV) debugKeys();
}

async function createLandmarker() {
  // Loaded on demand: the library is not needed before the camera starts
  const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: "/mediapipe/hand_landmarker.task", delegate },
    runningMode: "VIDEO" as const,
    numHands: 1,
  });
  try {
    hudLines.delegate = "GPU";
    return await HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (e) {
    console.warn("MediaPipe GPU delegate failed, using CPU", e);
    hudLines.delegate = "CPU";
    return HandLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

async function run() {
  if (!navigator.mediaDevices) throw new Error("no camera access (needs HTTPS)");
  const width = new URLSearchParams(location.search).get("res") === "320" ? 320 : 640;
  // First, before any await: iOS only allows it inside the user gesture
  const streamRequest = navigator.mediaDevices.getUserMedia({
    video: { width, height: (width * 3) / 4, facingMode: "user" },
    audio: false,
  });
  // The model loads while the permission prompt is open; kept for a second try
  landmarker ??= createLandmarker();
  landmarker.catch(() => (landmarker = null));
  const stream = await streamRequest;
  let hands: HandLandmarker;
  try {
    hands = await landmarker;
  } catch (e) {
    for (const track of stream.getTracks()) track.stop();
    throw e;
  }
  const video = Object.assign(document.createElement("video"), { srcObject: stream, muted: true, playsInline: true });
  await video.play();
  controlInput.source = "mediapipe";
  hudLines.camera = `${video.videoWidth}×${video.videoHeight}`;
  startReleaseLoop();

  const preview = Object.assign(document.createElement("canvas"), { id: "preview", width: 160, height: 120 });
  document.body.append(preview);
  const ctx = preview.getContext("2d")!;

  let inferences = 0;
  let windowStart = performance.now();
  const onFrame = () => {
    const now = performance.now();
    const result = hands.detectForVideo(video, now);
    const hand = result.landmarks[0];
    const fist = !!hand && isFist(result.worldLandmarks[0] ?? hand);
    sample = hand ? { fist, wristY: hand[WRIST].y } : null;
    sampleAt = now;
    const attached = release.state.phase === "attached";
    if (hand && attached) apply(hand, fist);
    draw(ctx, video, attached, hand);

    inferences++;
    if (now - windowStart > 1000) {
      hudLines.mp = `${((inferences * 1000) / (now - windowStart)).toFixed(0)} Hz`;
      inferences = 0;
      windowStart = now;
    }
    schedule();
  };
  // requestVideoFrameCallback: Safari 15.4+, Chrome; rAF as the fallback
  const schedule = () =>
    "requestVideoFrameCallback" in video ? video.requestVideoFrameCallback(onFrame) : requestAnimationFrame(onFrame);
  schedule();
}

let releaseLoop = false;

// The release state runs on its own frame loop, not on camera frames: the
// countdown must go on when the camera stalls, and a stalled camera must
// count as "no hand"
function startReleaseLoop() {
  if (releaseLoop) return;
  releaseLoop = true;
  const timer = createReleaseTimer();
  const tick = () => {
    const now = performance.now();
    const before = release.state.phase;
    const state = release.update(debugHand ?? (now - sampleAt < STALE_MS ? sample : null), now);
    // Let go: the cross stays where it is (nothing writes the bar any more),
    // and the puppet's hands open
    if (before === "attached" && state.phase !== "attached") controlInput.grip.left = controlInput.grip.right = false;
    hudLines.hand = state.phase;
    timer.show(state);
    requestAnimationFrame(tick);
  };
  tick();
}

// Development, without a camera or a hand in front of it: hold Z for an open
// hand held up, X for a fist. Only the release state and its timer react;
// the cross itself needs real landmarks.
function debugKeys() {
  const hands: Record<string, HandSample> = { z: { fist: false, wristY: 0.5 }, x: { fist: true, wristY: 0.5 } };
  addEventListener("keydown", (e) => {
    if (!hands[e.key]) return;
    debugHand = hands[e.key];
    startReleaseLoop();
  });
  addEventListener("keyup", (e) => hands[e.key] && (debugHand = null));
}

// A fist: all four fingers curled, their tips nearer to the wrist than their
// middle joints. World landmarks (metres, 3D), so it also holds when the hand
// is turned or tilted towards the camera.
function isFist(points: Landmark[]) {
  const wrist = points[WRIST];
  const distance = (i: number) => Math.hypot(points[i].x - wrist.x, points[i].y - wrist.y, points[i].z - wrist.z);
  return FINGERS.every(([joint, tip]) => distance(tip) < distance(joint));
}

const tilt = new Euler();

function apply(hand: NormalizedLandmark[], fist: boolean) {
  const wrist = hand[WRIST];
  // Mirrored (selfie view); the image maps onto x −0.5…0.5, y 0.35…1.0 (real scale)
  const x = (0.5 - wrist.x) * 1.0;
  const y = 0.35 + (1 - wrist.y) * 0.65;
  const bar = controlInput.bar.position;
  bar.set(bar.x + (x - bar.x) * SMOOTHING, bar.y + (y - bar.y) * SMOOTHING, 0);
  // Tilting the hand (wrist → middle knuckle) rolls the bar; mirrored like x
  const knuckle = hand[MIDDLE_KNUCKLE];
  const roll = Math.max(-MAX_ROLL, Math.min(MAX_ROLL, Math.atan2(-(knuckle.x - wrist.x), wrist.y - knuckle.y)));
  tilt.z += (roll - tilt.z) * SMOOTHING;
  controlInput.bar.rotation.setFromEuler(tilt);
  // A closing fist brings thumb and index together too: it is the gesture
  // for letting go of the puppet, not a grip
  const pinch = Math.hypot(hand[THUMB_TIP].x - hand[INDEX_TIP].x, hand[THUMB_TIP].y - hand[INDEX_TIP].y);
  controlInput.grip.right = !fist && pinch < PINCH;
}

function draw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, attached: boolean, hand?: NormalizedLandmark[]) {
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(video, -width, 0, width, height);
  ctx.restore();
  // The low zone, where a hand does not connect
  ctx.fillStyle = "#0006";
  ctx.fillRect(0, LOW_ZONE * height, width, height);
  if (!hand) return;
  // Grey: seen, but not connected to the puppet
  ctx.fillStyle = !attached ? "#bbbbbb" : controlInput.grip.right ? "#ffcc33" : "#7fdcff";
  for (const p of hand) ctx.fillRect((1 - p.x) * width - 1.5, p.y * height - 1.5, 3, 3);
}
