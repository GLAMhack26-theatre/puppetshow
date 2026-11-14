import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { Quaternion, Vector3 } from "@iwsdk/core";
import type { RigController } from "../puppet/rig";
import { createReleaseTimer } from "../ui/release-timer";
import { MAX_ROCK, controlInput, type RockId } from "./control-input";
import { createHandOverlay } from "./hand-overlay";
import { createHandRelease, type HandSample } from "./hand-release";
import { demoRecording, type Recording } from "./hand-synthetic.ts";
import { HandTracker, TUNING, quatFromTilt, type HandFrame, type TrackerOutput } from "./hand-tracking.ts";

// MediaPipe hands → ControlInput. This file is the camera and DOM side: it
// runs the HandLandmarker on each camera frame (requestVideoFrameCallback,
// apart from the render loop), hands the landmarks to the HandTracker
// (hand-tracking.ts: all the mapping and filtering, testable without a
// browser), writes its output to ControlInput and draws the overlay.
//
// Letting go (hand-release.ts): the cross hand's fist grips at once; held for
// 3 s it lets go of the puppet instead (the cross stays, the puppet's hands
// open), and after a countdown a hand above the low zone connects again.
// Nothing is written to ControlInput while no hand is connected.
//
// Two calls: startHandTracking() starts the camera, straight from a user
// gesture (the click on a sign, main.ts), possibly before the puppet has
// loaded; setupHandTracking() connects the puppet once it is there, and adds
// the camera button (or C) for ?test=nocurtain and for a second try.
//
// URL parameters:
//   ?mirror=0          the player is not in front of the screen facing the camera
//                      (HandTracker.mirror; key M toggles)
//   ?res=320 | 1280    320 × 240 or 1280 × 720 camera instead of 640 × 480
//   ?camera=environment  the back camera of a phone (never mirrored)
//   ?record            keep the landmark frames; R downloads them as JSON
//   ?replay=synthetic  play the built-in synthetic session instead of the camera
//   ?replay=<url>      play a recorded session (the JSON from ?record)
// Keys: M mirror, N take the current hand pose as the new rest pose.
// Sliders (remembered): the player's own corrections of the cross's pitch and
// height (HandTracker.pitchTrim, heightTrim).

export interface HandTrackingOptions {
  /** The cross of the puppet being played: limits of its rocking bars, and what the overlay draws */
  controller?: RigController;
  /** Stage z the puppet may be moved between, m */
  depthRange?: [number, number];
  /** Status lines shown by the page */
  hud?: Record<string, string>;
  /** Where the buttons go */
  panel?: HTMLElement;
}

const MAX_RECORDING = 5 * 60 * 30; // frames: about five minutes
/** Without a frame for this long the hand counts as gone (stalled camera or inference) */
const STALE_MS = 300;
/** How much of the hand's push against the back string goes sideways on the stage (the rest draws the string back) */
const HOOK_SIDEWAYS = 0.3;

const params = new URLSearchParams(location.search);
/** Until setupHandTracking() passes the page's HUD (camera errors can come first) */
let hud: Record<string, string> = {};
/** Created by setupHandTracking(); camera frames before it are dropped */
let session: Session | null = null;
/** The camera's video once it runs: the overlay goes up when both it and the session exist */
let cameraVideo: HTMLVideoElement | null = null;
let cameraMirrorAllowed = true;

let tracking: Promise<void> | null = null;
let landmarker: Promise<HandLandmarker> | null = null;
const cameraButton = Object.assign(document.createElement("button"), { textContent: "Kamera starten (C)" });

/**
 * Starts the camera and the hand tracking; safe to call again. Must be called
 * straight from a user gesture. On an error (no permission, no camera) the
 * mouse keeps control and the camera button comes back.
 */
export function startHandTracking() {
  if (params.get("replay")) return Promise.resolve(); // the replay is the hand
  cameraButton.hidden = true;
  tracking ??= runCamera().catch((e) => {
    console.warn("Hand tracking did not start", e);
    hud.camera = `error: ${e instanceof Error ? e.message : e}`;
    tracking = null;
    cameraButton.hidden = false;
  });
  return tracking;
}

/** Connects the puppet to the hands; call once, when the puppet has loaded. */
export function setupHandTracking(options: HandTrackingOptions = {}) {
  if (session) return;
  hud = Object.assign(options.hud ?? {}, hud);
  const panel = options.panel ?? document.body;
  session = createSession(options, panel);
  startReleaseLoop();

  const replay = params.get("replay");
  if (replay) {
    // No camera and no permission: starts by itself
    loadRecording(replay)
      .then((recording) => playRecording(recording, session!))
      .catch((e) => (hud.camera = `replay: ${e instanceof Error ? e.message : e}`));
    return;
  }
  cameraButton.addEventListener("click", () => void startHandTracking());
  addEventListener("keydown", (e) => e.key === "c" && void startHandTracking());
  // Already started by the sign click: the button only comes back on an error
  cameraButton.hidden = tracking !== null;
  panel.prepend(cameraButton);
  if (cameraVideo) showCamera();
}

// --- letting go --------------------------------------------------------------

const release = createHandRelease();
/** The cross hand in the last frame; null if there was none */
let sample: HandSample | null = null;
let sampleAt = 0;
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
    const state = release.update(now - sampleAt < STALE_MS ? sample : null, now);
    if (before === "attached" && state.phase !== "attached") letGo();
    timer.show(state);
    requestAnimationFrame(tick);
  };
  tick();
}

/** The cross stays where it is (nothing writes the bar any more); hands open, bars level, the hand bar goes back, the back string is let go */
function letGo() {
  controlInput.grip.left = controlInput.grip.right = false;
  controlInput.rock.legs = controlInput.rock.head = controlInput.rock.hands = 0;
  controlInput.handBar.detached = false;
  controlInput.hook.id = null; // the engine eases the back string out
}

// --- tracker → ControlInput --------------------------------------------------

/** Everything after the landmarks: tracker → ControlInput → overlay (and the recorder) */
function createSession(options: HandTrackingOptions, panel: HTMLElement) {
  const tracker = new HandTracker();
  const overlay = createHandOverlay(options.controller);
  if (options.depthRange) TUNING.depth.range = options.depthRange;

  // What the tracker needs to know about this puppet's cross
  const bars = options.controller?.bars ?? [];
  const limit = (input: RockId) => bars.find((b) => b.input === input)?.limit ?? MAX_ROCK;
  const limits = { legs: limit("legs"), head: limit("head"), hands: limit("hands") };
  const mainBar = bars.find((b) => !b.parent);
  const handBar = bars.find((b) => b.detachable);
  const headBar = bars.find((b) => b.input === "head");
  if (mainBar) {
    // Front is +z: the main bar's rear end is its stick end with the smallest z
    const rear = mainBar.pivot.z - Math.min(...mainBar.sticks.flatMap((s) => [s.a.z, s.b.z]));
    const fromPivot = (v: Vector3) => v.clone().sub(mainBar.pivot).toArray();
    tracker.geometry = {
      rear,
      handBar: handBar ? fromPivot(handBar.pivot) : tracker.geometry.handBar,
      headBar: headBar ? fromPivot(headBar.pivot) : tracker.geometry.headBar,
      backEye: [0, 0, -rear], // the back string leaves the cross at its rear end
    };
    tracker.restHeight = mainBar.pivot.y;
  }
  tracker.headLimit = limits.head;
  // The player's corrections. Pitch: for a camera that looks at the hand from
  // above or below, or a hand held tilted because it tracks better that way.
  // Height: when the puppet hangs in the air or sags with the hand at rest.
  addTrimSlider(panel, "Kreuz heben", "hand-height-trim", 20, "cm", (cm) => (tracker.heightTrim = cm / 100));
  addTrimSlider(panel, "Kreuz neigen", "hand-pitch-trim", 45, "°", (degrees) => (tracker.pitchTrim = (degrees * Math.PI) / 180));

  let mirrorAllowed = true;
  const setMirror = (on: boolean) => {
    tracker.mirror = on && mirrorAllowed;
    hud.mirror = tracker.mirror ? "Spiegel (M)" : "Gegenüber (M)";
  };
  setMirror(params.get("mirror") !== "0");
  addEventListener("keydown", (e) => {
    if (e.key === "m") setMirror(!tracker.mirror);
    if (e.key === "n") tracker.recenter();
  });

  const recording: Recording | undefined = params.has("record") ? { version: 1, aspect: 4 / 3, frames: [] } : undefined;
  if (recording) {
    Object.assign(globalThis, { handRecording: recording }); // also reachable from the console
    const save = Object.assign(document.createElement("button"), { textContent: "Aufnahme speichern (R)" });
    const download = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(recording)], { type: "application/json" }));
      Object.assign(document.createElement("a"), { href: url, download: `hand-recording-${Date.now()}.json` }).click();
      URL.revokeObjectURL(url);
    };
    save.addEventListener("click", download);
    addEventListener("keydown", (e) => e.key === "r" && download());
    panel.prepend(save);
  }

  const turn = new Quaternion();
  const grab = { position: new Vector3(), rotation: new Quaternion() };
  let wasDetached = false;
  let everAttached = false;

  function apply(out: TrackerOutput) {
    controlInput.source = "mediapipe";
    // Until a hand has shown up the cross stays at its rest place
    everAttached ||= out.status !== "none";
    if (everAttached) {
      controlInput.bar.position.set(out.bar.x, out.bar.y, out.bar.z);
      controlInput.bar.rotation.fromArray(quatFromTilt(out.bar));
    }
    controlInput.rock.legs = out.rock.legs * limits.legs;
    controlInput.rock.head = out.rock.head * limits.head;
    controlInput.rock.hands = out.rock.hands * limits.hands;
    controlInput.grip.left = controlInput.grip.right = out.grip;

    // Hand bar in the second hand: its pose when it was taken, plus how the hand has moved since
    const bar = controlInput.handBar;
    const detached = out.handBar.detached && !!handBar;
    if (detached && !wasDetached) {
      grab.position.copy(bar.position); // kept there by the engine while the bar sits on the cross
      grab.rotation.copy(bar.rotation);
    }
    if (detached) {
      bar.position.set(out.handBar.x, out.handBar.y, out.handBar.z).add(grab.position);
      bar.rotation.copy(turn.fromArray(quatFromTilt(out.handBar))).multiply(grab.rotation);
    }
    bar.detached = wasDetached = detached;

    // The second hand against the back string: pushed sideways, where the hand is along it
    const hook = controlInput.hook;
    hook.id = out.hook.active ? "back" : null;
    if (out.hook.active) {
      hook.along = out.hook.along;
      // The camera only sees the hand go sideways. On the stage the string is
      // drawn back with it (upstage, away from the puppet's back) and only a
      // little to the side: a push straight sideways swung and rolled the
      // puppet (44° for 10 cm), drawn back the same push is a clean bow
      hook.offset.set(HOOK_SIDEWAYS * out.hook.push, 0, -Math.abs(out.hook.push));
    }
  }

  /** What the overlay says while no hand is connected */
  function releaseNote() {
    const { phase, countdown } = release.state;
    if (phase === "released") return `Losgelassen – ${Math.ceil(countdown)} s`;
    if (phase === "waiting") return "Hand höher heben zum Spielen";
    return undefined;
  }

  return {
    /** Called before the first frame: the back camera of a phone is never mirrored */
    allowMirror(allowed: boolean) {
      mirrorAllowed = allowed;
      setMirror(tracker.mirror);
    },
    canvas: overlay.canvas,
    frame(timeMs: number, hands: HandFrame[], aspect: number, video?: HTMLVideoElement, note?: string) {
      if (recording && recording.frames.length < MAX_RECORDING) {
        recording.aspect = aspect;
        recording.frames.push({ t: Math.round(timeMs), hands: hands.map(compact) });
      }
      // The tracker always runs, so its filters and roles stay current while the puppet hangs free
      const out = tracker.update(timeMs, hands, aspect);
      const cross = out.cross && !out.cross.held ? out.cross : undefined;
      // The cross hand's fist (the grip) is also the gesture that lets go when held
      sample = cross ? { fist: out.grip, wristY: cross.landmarks[0].y } : null;
      sampleAt = performance.now();
      if (release.state.phase === "attached") apply(out);
      hud.hand = `${release.state.phase}: ${out.status}${out.second ? " + 2" : ""}${out.handBar.detached ? " Handkreuz" : ""}${out.headBar.held ? " Kopfkreuz" : ""}${out.hook.active ? " Rückenfaden" : ""}`;
      const recNote = recording ? `Aufnahme ${recording.frames.length}` : undefined;
      overlay.draw(video, aspect, out, { mirror: tracker.mirror, note: releaseNote() ?? recNote ?? note });
    },
  };
}
type Session = ReturnType<typeof createSession>;

/**
 * A slider for one of the player's own corrections (± max around 0, whole
 * units), remembered across visits; a double click puts it back to 0, like
 * the overlay's place.
 */
function addTrimSlider(panel: HTMLElement, text: string, key: string, max: number, unit: string, apply: (value: number) => void) {
  let stored = 0;
  try {
    stored = Number(localStorage.getItem(key)) || 0;
  } catch {
    // No storage (private mode): starts at 0
  }
  stored = Math.max(-max, Math.min(max, stored));
  const label = document.createElement("label");
  const slider = Object.assign(document.createElement("input"), { type: "range", min: String(-max), max: String(max), step: "1", value: String(stored) });
  const shown = document.createElement("span");
  const set = (value: number) => {
    apply(value);
    shown.textContent = `${value > 0 ? "+" : ""}${value}${unit === "°" ? "" : " "}${unit}`;
  };
  set(stored);
  slider.addEventListener("input", () => {
    set(Number(slider.value));
    try {
      localStorage.setItem(key, slider.value);
    } catch {
      // Not remembered then
    }
  });
  label.addEventListener("dblclick", () => {
    slider.value = "0";
    slider.dispatchEvent(new Event("input"));
  });
  label.append(text, slider, shown);
  panel.prepend(label);
}

/** Five decimals are far below landmark noise and keep recordings small */
const round = (v: number) => Math.round(v * 1e5) / 1e5;
const compact = (hand: HandFrame): HandFrame => ({
  ...hand,
  image: hand.image.map((p) => ({ x: round(p.x), y: round(p.y), z: round(p.z) })),
  world: hand.world.map((p) => ({ x: round(p.x), y: round(p.y), z: round(p.z) })),
});

// --- camera ------------------------------------------------------------------

async function createLandmarker() {
  // Loaded on demand: the library is not needed before the camera starts
  const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: "/mediapipe/hand_landmarker.task", delegate },
    runningMode: "VIDEO" as const,
    numHands: 2, // cross hand + the hand that takes the hand bar
  });
  try {
    hud.delegate = "GPU";
    return await HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (e) {
    console.warn("MediaPipe GPU delegate failed, using CPU", e);
    hud.delegate = "CPU";
    return HandLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

/** Overlay up, mirroring decided: once both the camera and the session are there */
function showCamera() {
  if (!session || !cameraVideo) return;
  session.allowMirror(cameraMirrorAllowed);
  document.body.append(session.canvas);
}

async function runCamera() {
  if (!navigator.mediaDevices) throw new Error("no camera access (needs HTTPS)");
  // 1280 × 720 gives the landmark model more pixels of a hand held far from the camera (not the default: untested on phones)
  const [width, height] = { "320": [320, 240], "1280": [1280, 720] }[params.get("res") ?? ""] ?? [640, 480];
  const facingMode = params.get("camera") === "environment" ? "environment" : "user";
  // First, before any await: iOS only allows it inside the user gesture
  const streamRequest = navigator.mediaDevices.getUserMedia({ video: { width, height, facingMode }, audio: false });
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
  hud.camera = `${video.videoWidth}×${video.videoHeight}`;
  // Mirroring is about facing the screen: a camera that looks away from the player keeps its picture
  cameraMirrorAllowed = stream.getVideoTracks()[0]?.getSettings().facingMode !== "environment" && facingMode === "user";
  cameraVideo = video;
  showCamera();

  let inferences = 0;
  let windowStart = performance.now();
  const onFrame = () => {
    const now = performance.now();
    const result = hands.detectForVideo(video, now);
    const frame: HandFrame[] = result.landmarks.map((image, i) => ({
      image,
      world: result.worldLandmarks[i],
      handedness: result.handedness[i]?.[0]?.categoryName === "Left" ? "Left" : "Right",
      score: result.handedness[i]?.[0]?.score ?? 0,
    }));
    session?.frame(now, frame, video.videoWidth / video.videoHeight, video);

    inferences++;
    if (now - windowStart > 1000) {
      hud.mp = `${((inferences * 1000) / (now - windowStart)).toFixed(0)} Hz`;
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

// --- replay ------------------------------------------------------------------

async function loadRecording(source: string): Promise<Recording> {
  if (source === "synthetic") return demoRecording();
  const response = await fetch(source);
  if (!response.ok) throw new Error(`${source}: ${response.status}`);
  const recording = (await response.json()) as Recording;
  if (recording.version !== 1 || !Array.isArray(recording.frames)) throw new Error("not a hand recording");
  return recording;
}

/** Feed a recording through the same pipeline as the camera, at its own pace, in a loop */
function playRecording(recording: Recording, session: Session) {
  document.body.append(session.canvas);
  const frames = recording.frames;
  if (!frames.length) return;
  const first = frames[0].t;
  const duration = frames[frames.length - 1].t - first + 2000; // a pause with no hands before it starts again
  const start = performance.now();
  let loop = 0;
  let next = 0;
  const tick = () => {
    const elapsed = performance.now() - start - loop * duration;
    // Every frame that is due, so the filters see the recording's own timestamps even if the page stalls
    while (next < frames.length && frames[next].t - first <= elapsed) {
      const frame = frames[next++];
      session.frame(frame.t - first + loop * duration, frame.hands, recording.aspect, undefined, `Wiedergabe ${((frame.t - first) / 1000).toFixed(1)} s`);
    }
    if (next >= frames.length) {
      // The pause: a camera would go on delivering frames without hands
      session.frame(elapsed + loop * duration, [], recording.aspect, undefined, "Wiedergabe: Pause");
      if (elapsed > duration) {
        loop++;
        next = 0;
      }
    }
    requestAnimationFrame(tick);
  };
  tick();
}
