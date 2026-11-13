import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { Euler, type World } from "@iwsdk/core";
import { controlInput } from "../input/control-input";
import { setupPuppet } from "./puppet";
import { hudLines } from "./world";

// T3: MediaPipe HandLandmarker on the camera drives the T2 puppet:
// wrist → control bar, thumb–index pinch → grip. Inference runs on
// requestVideoFrameCallback (once per camera frame), apart from the render
// loop. ?res=320 for 320×240 instead of 640×480.

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_KNUCKLE = 9;
const MAX_ROLL = 0.8; // rad
const PINCH = 0.06; // normalized image units
const SMOOTHING = 0.5; // 0: frozen, 1: raw landmarks (jitter)

export async function setupMediaPipe(world: World) {
  await setupPuppet(world);
  const start = Object.assign(document.createElement("button"), { textContent: "Kamera starten" });
  start.addEventListener("click", () => {
    start.remove();
    run().catch((e) => (hudLines.camera = `error: ${e instanceof Error ? e.message : e}`));
  });
  document.getElementById("panel")!.prepend(start);
}

async function createLandmarker() {
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
  const width = new URLSearchParams(location.search).get("res") === "320" ? 320 : 640;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width, height: (width * 3) / 4, facingMode: "user" },
    audio: false,
  });
  const video = Object.assign(document.createElement("video"), { srcObject: stream, muted: true, playsInline: true });
  await video.play();
  const landmarker = await createLandmarker();
  controlInput.source = "mediapipe";
  hudLines.camera = `${video.videoWidth}×${video.videoHeight}`;

  const preview = Object.assign(document.createElement("canvas"), { id: "preview", width: 160, height: 120 });
  document.body.append(preview);
  const ctx = preview.getContext("2d")!;

  let inferences = 0;
  let windowStart = performance.now();
  const onFrame = () => {
    const now = performance.now();
    const result = landmarker.detectForVideo(video, now);
    const hand = result.landmarks[0];
    if (hand) apply(hand);
    draw(ctx, video, hand);

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

const tilt = new Euler();

function apply(hand: NormalizedLandmark[]) {
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
  const pinch = Math.hypot(hand[THUMB_TIP].x - hand[INDEX_TIP].x, hand[THUMB_TIP].y - hand[INDEX_TIP].y);
  controlInput.grip.right = pinch < PINCH;
}

function draw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, hand?: NormalizedLandmark[]) {
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(video, -width, 0, width, height);
  ctx.restore();
  if (!hand) return;
  ctx.fillStyle = controlInput.grip.right ? "#ffcc33" : "#7fdcff";
  for (const p of hand) ctx.fillRect((1 - p.x) * width - 1.5, p.y * height - 1.5, 3, 3);
}
