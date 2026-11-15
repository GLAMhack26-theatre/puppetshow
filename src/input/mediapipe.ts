import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { Quaternion, Vector3 } from "@iwsdk/core";
import type { RigController } from "../puppet/rig";
import { addHandSettings } from "../ui/hand-settings";
import { createReleaseTimer } from "../ui/release-timer";
import { MAX_ROCK, controlInput, puppetState, type RockId } from "./control-input";
import { createHandOverlay } from "./hand-overlay";
import { createHandRelease, type HandSample } from "./hand-release";
import { HorizonHolds, type BodyObservation } from "./body-frame.ts";
import type { BodyModel, BodySource } from "./body-source.ts";
import { demoRecording, type Recording, type RecordingFrame, type RecordingMeta, type RecordingSetup } from "./hand-synthetic.ts";
import { HandTracker, TUNING, quatFromTilt, type HandFrame, type TrackerOutput } from "./hand-tracking.ts";

// MediaPipe hands → ControlInput. This file is the camera and DOM side: it
// runs the HandLandmarker on each camera frame (requestVideoFrameCallback,
// apart from the render loop), hands the landmarks to the HandTracker
// (hand-tracking.ts: all the mapping and filtering, testable without a
// browser), writes its output to ControlInput and draws the overlay.
//
// Connecting (hand-release.ts): a hand above the low zone of the picture
// connects to the puppet; a hand that leaves the picture lets go (the cross
// stays, the puppet's hands open). Nothing is written to ControlInput while
// no hand is connected. The player's own settings (ui/hand-settings.ts): a
// button that sets the cross right, and sliders for the height at which the
// puppet stands, the tilt of the cross and the length of the strings.
//
// Height (body-frame.ts, inside the tracker): the puppet stands where a new
// player first holds the hand still (the hand window guides them there, once
// the puppet has flown in). What this file adds is the camera's side: the
// horizon row, measured once per camera with "Kamera einmessen" in the debug
// panel and remembered for that camera and resolution, or given with ?horizon=.
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
//   ?horizon=<row>     the picture's row at the camera's own height, 0 top … 1 bottom
//                      (0.5 for a level camera; wins over the measured one, is not stored)
//   ?record            keep the landmark frames; R downloads them as JSON (format 2,
//                      Recording in hand-synthetic.ts). Next to the hands the body
//                      models run (body-source.ts: face, face mesh, pose) and what
//                      they see is kept on each frame; a form in the debug panel
//                      takes notes on the set-up. Needs ?debug for the form and
//                      the save button. While recording, what the body models
//                      see also goes into the height (as it does when such a
//                      recording is replayed); in play no body model runs.
//   ?record=video      also keeps the camera's video (MediaRecorder), saved next to
//                      the JSON, so that models can be run on it again later
//   ?body=face,mesh,pose  with ?record: only these body models (all three if left
//                      out; "off" for none; "cpu" in the list keeps them off the GPU)
//   ?replay=synthetic  play the built-in synthetic session instead of the camera
//   ?replay=<url>      play a recorded session (the JSON from ?record, format 1 or 2)
// Keys: M mirror, N take the current hand pose as the new rest pose (and the
// hand's height as the height at which the puppet stands).
// Sliders (remembered): the player's own corrections of the cross's pitch and
// of the standing height (HandTracker.pitchTrim, height.trim). The hand window
// has a switch for the camera's resolution (640 × 480 / 1280 × 720, remembered;
// ?res= wins).

export interface HandTrackingOptions {
  /** The cross of the puppet being played: limits of its rocking bars, and what the overlay draws */
  controller?: RigController;
  /** Stage z the puppet may be moved between, m */
  depthRange?: [number, number];
  /** Status lines shown by the page */
  hud?: Record<string, string>;
  /** Where the buttons go */
  panel?: HTMLElement;
  /**
   * A new player's hand has connected (after a while without any hand): the
   * puppet makes a new entrance. If it returns a promise, the guided capture
   * of the standing height waits until that has settled (the puppet has landed).
   */
  onNewPlayer?: () => void | Promise<unknown>;
}

const MAX_RECORDING = 5 * 60 * 30; // frames: about five minutes
/** ?record=video stops after this long: the video is kept in memory until it is saved */
const MAX_VIDEO_MS = 5 * 60 * 1000;
const HAND_MODEL = "hand_landmarker.task";
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
let cameraStream: MediaStream | null = null;
let cameraMirrorAllowed = true;

let tracking: Promise<void> | null = null;
let landmarker: Promise<HandLandmarker> | null = null;
/** What the hand landmarker runs on, once it has loaded */
let handDelegate: "GPU" | "CPU" | undefined;
/** The body models next to the hands; only with ?record, see startBodyModels() */
let body: BodySource | null = null;
/** Settles once the body models have loaded or given up (also when there are none): the page is quiet again */
let bodyModelsSettled = () => {};
const bodyModelsReady = new Promise<void>((resolve) => (bodyModelsSettled = resolve));
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
/** The tracker's count of players (TrackerOutput.player), and its value when a hand last connected */
let latestPlayer = 0;
let connectedPlayer = 0;
let onNewPlayer: HandTrackingOptions["onNewPlayer"];
/**
 * New players' puppets that are still on their way down. Counted, not a flag:
 * an entrance that is overtaken by the next one ends early, while that one
 * still flies.
 */
let flights = 0;

// The release state runs on its own frame loop, not on camera frames: a
// stalled camera must count as "no hand"
function startReleaseLoop() {
  if (releaseLoop) return;
  releaseLoop = true;
  const timer = createReleaseTimer();
  const tick = () => {
    const now = performance.now();
    const before = release.state.phase;
    const state = release.update(now - sampleAt < STALE_MS ? sample : null, now);
    if (before === "attached" && state.phase !== "attached") letGo();
    // A hand connects. If it is a new player's (the tracker counts them), the
    // puppet makes a new entrance. Here and not when the count goes up: a hand
    // comes into the picture through the low zone, where it is not connected yet
    if (before !== "attached" && state.phase === "attached" && latestPlayer !== connectedPlayer) {
      connectedPlayer = latestPlayer;
      // Counted at once, in this tick: the next camera frame must already find the puppet flying
      flights++;
      void Promise.resolve(onNewPlayer?.()).catch(() => undefined).then(() => flights--);
    }
    timer.show(state);
    requestAnimationFrame(tick);
  };
  tick();
}

/**
 * The cross stays where it is (nothing writes the bar any more); bars level,
 * head straight, the hand bar goes back, the back string is let go. The
 * magnets in the puppet's hands go off, but what they hold stays in them
 * (ControlInput.release is left alone): a hand that leaves the picture must
 * not drop the prop.
 */
function letGo() {
  // In WebXR the player's own body drives the puppet: nothing of it is the camera hand's to reset
  if (controlInput.body.active) return;
  controlInput.grip.left = controlInput.grip.right = false;
  controlInput.rock.legs = controlInput.rock.head = controlInput.rock.hands = 0;
  controlInput.turn = 0;
  controlInput.handBar.detached = false;
  controlInput.hook.id = null; // the engine eases the back string out
}

// --- tracker → ControlInput --------------------------------------------------

// The horizon row of each camera it was measured for, by the camera's label and the picture's size (another
// resolution is often another crop of the sensor, with the camera's height on another row)
const HORIZON_KEY = "hand-horizon";
function storedHorizons(): Record<string, number> {
  try {
    const stored = JSON.parse(localStorage.getItem(HORIZON_KEY) ?? "{}");
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {}; // no storage (private mode), or nothing readable in it
  }
}
function storeHorizon(camera: string, row: number | undefined) {
  const all = storedHorizons();
  if (row === undefined) delete all[camera];
  else all[camera] = Math.round(row * 1e4) / 1e4;
  try {
    localStorage.setItem(HORIZON_KEY, JSON.stringify(all));
  } catch {
    // Not remembered then
  }
}
/** What a horizon row is remembered by: the camera's label (its id where it has none) and the picture's size */
function cameraKeyOf(stream: MediaStream | null, video: HTMLVideoElement) {
  const track = stream?.getVideoTracks()[0];
  const name = track?.label || track?.getSettings().deviceId;
  return name ? `${name}|${video.videoWidth}x${video.videoHeight}` : undefined;
}

/** Everything after the landmarks: tracker → ControlInput → overlay (and the recorder) */
function createSession(options: HandTrackingOptions, panel: HTMLElement) {
  const tracker = new HandTracker();
  onNewPlayer = options.onNewPlayer;
  const overlay = createHandOverlay(options.controller, {
    label: "Kamera",
    title: "Auflösung der Kamera: 1280 gibt der Handerkennung mehr Bildpunkte, wenn die Hand weit weg ist",
    choices: [
      { value: "640", label: "640", title: "640 × 480" },
      { value: "1280", label: "1280", title: "1280 × 720" },
    ],
    choose: (value) => void setResolution(value),
  });
  if (options.depthRange) TUNING.depth.range = options.depthRange;

  // What the tracker needs to know about this puppet's cross
  const bars = options.controller?.bars ?? [];
  const limit = (input: RockId) => bars.find((b) => b.input === input)?.limit ?? MAX_ROCK;
  const limits = { legs: limit("legs"), head: limit("head"), hands: limit("hands") };
  const mainBar = bars.find((b) => !b.parent);
  const handBar = bars.find((b) => b.detachable);
  const headBar = bars.find((b) => b.input === "head");
  const legBar = bars.find((b) => b.input === "legs");
  if (mainBar) {
    // Front is +z: the main bar's rear end is its stick end with the smallest z
    const rear = mainBar.pivot.z - Math.min(...mainBar.sticks.flatMap((s) => [s.a.z, s.b.z]));
    const fromPivot = (v: Vector3) => v.clone().sub(mainBar.pivot).toArray();
    tracker.geometry = {
      rear,
      handBar: handBar ? fromPivot(handBar.pivot) : tracker.geometry.handBar,
      headBar: headBar ? fromPivot(headBar.pivot) : tracker.geometry.headBar,
      legBar: legBar ? fromPivot(legBar.pivot) : tracker.geometry.legBar,
      backEye: [0, 0, -rear], // the back string leaves the cross at its rear end
    };
    tracker.restHeight = mainBar.pivot.y;
  }
  tracker.legLimit = limits.legs; // the second hand at the leg bar's handle: turned this far, the bar is rocked fully
  // The player's settings, always in view (the debug panel is hidden in play).
  // Height: the puppet stands where the hand was first held still (the guided
  // capture), and this moves that height up or down; below it the strings go
  // slack, above it they lift the puppet. Tilt: for a camera that looks at the
  // hand from above or below, or a hand held tilted because it tracks better
  // that way. String length: how far above the puppet the cross hangs.
  addHandSettings({
    reset: () => tracker.reset(),
    sliders: [
      {
        // A new key: the old slider's values were metres above the floor (0.4 … 1.6), which must not come back as a correction
        label: "Spielhöhe", title: "Die Puppe steht dort, wo die Hand am Anfang ruhig gehalten wurde. Hier lässt sich diese Höhe verschieben: nach rechts steht die Puppe erst bei höherer Hand, nach links schon bei tieferer",
        key: "hand-height-trim", min: -0.3, max: 0.3, step: 0.01, initial: 0,
        format: (m) => `${m > 0 ? "+" : m < 0 ? "−" : ""}${Math.abs(Math.round(m * 100))} cm`,
        apply: (m) => (tracker.height.trim = m),
      },
      {
        label: "Kreuz neigen", title: "Neigt das Kreuz nach vorn oder hinten: gleicht eine Kamera aus, die von oben oder unten auf die Hand schaut",
        key: "hand-pitch-trim", min: -45, max: 45, step: 1, initial: 0,
        format: (degrees) => `${degrees > 0 ? "+" : ""}${degrees}°`,
        apply: (degrees) => (tracker.pitchTrim = (degrees * Math.PI) / 180),
      },
      {
        label: "Fadenlänge", title: "Längere Fäden: das Kreuz hängt höher über der Puppe",
        key: "string-extra", min: 0, max: 0.4, step: 0.01, initial: 0.15,
        format: (m) => `+${Math.round(m * 100)} cm`,
        apply: (m) => (controlInput.stringExtra = m),
      },
    ],
  });

  let mirrorAllowed = true;
  const setMirror = (on: boolean) => {
    tracker.mirror = on && mirrorAllowed;
    hud.mirror = tracker.mirror ? "Spiegel (M)" : "Gegenüber (M)";
  };
  setMirror(params.get("mirror") !== "0");
  addEventListener("keydown", (e) => {
    if (e.key === "m") setMirror(!tracker.mirror);
    if (e.key === "n") tracker.reset();
  });

  const recorder = params.has("record") ? createRecorder(panel, () => tracker.mirror) : undefined;

  // The camera's horizon row (the picture's row at the camera's own height): what the hand's height needs to
  // know of the camera. From the URL, else as measured for this camera before (remembered), else not known.
  const horizonFromUrl = params.has("horizon") && params.get("horizon") !== "" && Number.isFinite(Number(params.get("horizon"))) ? Number(params.get("horizon")) : undefined;
  /** Which camera the horizon row is remembered for (undefined: none, as in a replay) */
  let cameraKey: string | undefined;
  const useHorizon = () => {
    const row = horizonFromUrl ?? (cameraKey ? storedHorizons()[cameraKey] : undefined);
    tracker.height.setHorizon(row);
    hud.horizon = row === undefined ? "nicht eingemessen (waagrechte Kamera angenommen)" : `Zeile ${row.toFixed(3)}${horizonFromUrl !== undefined ? " (?horizon)" : " (eingemessen)"}`;
  };
  useHorizon();

  // The installer's step: the hand laid at one fixed height, held still near the camera and then further
  // away, gives the horizon row (HorizonHolds). In the debug panel: it is done once per camera, not by players.
  let measuring: HorizonHolds | undefined;
  const measureButton = Object.assign(document.createElement("button"), { textContent: "Kamera einmessen", title: "Misst, auf welcher Bildzeile die Kamerahöhe liegt (einmal je Kamera und Auflösung): die Hand auf eine feste Höhe legen und ruhig halten, erst nah an der Kamera, dann weiter weg" });
  const forgetButton = Object.assign(document.createElement("button"), { textContent: "Einmessung löschen", title: "Vergisst die eingemessene Bildzeile dieser Kamera: sie gilt wieder als waagrecht" });
  const showMeasuring = () => {
    measureButton.textContent = measuring ? "Einmessen beenden" : "Kamera einmessen";
    forgetButton.hidden = !cameraKey || storedHorizons()[cameraKey] === undefined;
  };
  measureButton.addEventListener("click", () => {
    measuring = measuring ? undefined : new HorizonHolds();
    showMeasuring();
    measureButton.blur(); // keys go to the stage again
  });
  forgetButton.addEventListener("click", () => {
    if (cameraKey) storeHorizon(cameraKey, undefined);
    measuring = undefined;
    useHorizon();
    showMeasuring();
    forgetButton.blur();
  });
  showMeasuring();
  panel.prepend(measureButton, forgetButton);
  /** One frame of the installer's step: takes the holds, and says what to do next */
  const measure = (timeMs: number, out: TrackerOutput) => {
    if (!measuring) return undefined;
    const cross = out.cross && !out.cross.held ? out.cross : undefined;
    if (measuring.add(cross && { t: timeMs / 1000, row: cross.palm.y, palm: cross.palmLength }) && measuring.row !== undefined) {
      // Two holds are enough; every further one is averaged in. In use and remembered at once
      if (cameraKey) storeHorizon(cameraKey, measuring.row);
      if (horizonFromUrl === undefined) tracker.height.setHorizon(measuring.row);
      hud.horizon = `Zeile ${measuring.row.toFixed(3)} (eingemessen, ${measuring.holds.length} Punkte)${horizonFromUrl !== undefined ? ", ?horizon gilt" : cameraKey ? "" : ", nicht gespeichert"}`;
      showMeasuring();
    }
    const text =
      measuring.row !== undefined ? `Horizont: Zeile ${measuring.row.toFixed(2).replace(".", ",")} · ${measuring.holds.length} Punkte · weitere verbessern`
      : measuring.holds.length ? "Einmessen 2/2: jetzt weiter weg, gleiche Höhe, ruhig halten"
      : "Einmessen 1/2: Hand auf feste Höhe (Tischkante), nah, ruhig halten";
    return { text, progress: measuring.progress };
  };

  const turn = new Quaternion();
  const grab = { position: new Vector3(), rotation: new Quaternion() };
  let wasDetached = false;
  let everAttached = false;
  /** TrackerOutput.grasp.releases as it was in the last frame: only what comes on top while a hand is connected lets go */
  let releasesSeen = 0;

  function apply(out: TrackerOutput) {
    // In WebXR the player's own body drives the puppet (src/xr/): the camera hand stands by
    if (controlInput.body.active) return;
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
    controlInput.turn = out.turn;
    // The second hand's fist away from the handles: the magnet in both of the puppet's hands
    controlInput.grip.left = controlInput.grip.right = out.grasp.on;

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
  const releaseNote = () => (release.state.phase === "waiting" ? "Hand höher heben zum Spielen" : undefined);

  return {
    /** Called before the first frame: the back camera of a phone is never mirrored */
    allowMirror(allowed: boolean) {
      mirrorAllowed = allowed;
      setMirror(tracker.mirror);
    },
    element: overlay.element,
    /** Which camera resolution the window's switch shows (null: none, as in a replay) */
    setChoice: overlay.setChoice,
    /** The hand as it is held now is the level cross (after the camera's picture changed) */
    reset: () => tracker.reset(),
    recorder,
    /**
     * The camera whose picture this is, or undefined for none (a replay): the
     * horizon row measured for it before is taken into use
     */
    setCamera(key: string | undefined) {
      cameraKey = key;
      useHorizon();
      showMeasuring();
    },
    /**
     * Returns the frame as it was recorded (?record), for the caller to add
     * what else it knows about it. body: what the body models saw, if any ran
     * (while recording, or in the replay of such a recording).
     */
    frame(timeMs: number, hands: HandFrame[], aspect: number, video?: HTMLVideoElement, note?: string, body?: BodyObservation) {
      const recorded = recorder?.add(timeMs, hands, aspect);
      // What the second hand's fist means depends on whether the puppet holds something (the engine says)
      tracker.puppetHolds = puppetState.holding.left !== null || puppetState.holding.right !== null;
      // For the guided capture of the standing height: its clock runs only while the hand leads the puppet and the puppet has landed
      tracker.connected = release.state.phase === "attached";
      tracker.flying = flights > 0;
      // The tracker always runs, so its filters and roles stay current while the puppet hangs free
      const out = tracker.update(timeMs, hands, aspect, body);
      latestPlayer = out.player;
      const cross = out.cross && !out.cross.held ? out.cross : undefined;
      sample = cross ? { wristY: cross.landmarks[0].y } : null;
      sampleAt = performance.now();
      if (release.state.phase === "attached") {
        apply(out);
        // A quick fist/open: both of the puppet's hands let go. Counted up, not
        // set: the engine acts on the change, at its own pace
        controlInput.release.left += out.grasp.releases - releasesSeen;
        controlInput.release.right += out.grasp.releases - releasesSeen;
      }
      // Also while no hand is connected, so that nothing is let go when one connects again
      releasesSeen = out.grasp.releases;
      hud.hand = `${release.state.phase}: ${out.status}${out.second ? " + 2" : ""}${out.handBar.detached ? " Handkreuz" : ""}${out.headBar.held ? " Kopfkreuz" : ""}${out.legBar.held ? " Beinkreuz" : ""}${out.hook.active ? " Rückenfaden" : ""}${out.grasp.on ? " Magnet" : out.grasp.phase === "click" ? " loslassen?" : ""}`;
      const height = out.height;
      hud.height = out.status === "attached" ? `${height.value >= 0 ? "+" : "−"}${Math.abs(height.value * 100).toFixed(1)} cm ± ${(height.sigma * 100).toFixed(1)} · ${height.sources.join(", ")}${height.guide ? ` · ${height.guide.state}` : ""}` : "–";
      overlay.draw(video, aspect, out, { mirror: tracker.mirror, note: releaseNote() ?? recorder?.note() ?? note, hint: measure(timeMs, out) });
      return recorded;
    },
  };
}
type Session = ReturnType<typeof createSession>;

// --- recording (?record) -------------------------------------------------------

/** Five decimals are far below landmark noise and keep recordings small */
const round = (v: number) => Math.round(v * 1e5) / 1e5;
const compact = (hand: HandFrame): HandFrame => ({
  ...hand,
  image: hand.image.map((p) => ({ x: round(p.x), y: round(p.y), z: round(p.z) })),
  world: hand.world.map((p) => ({ x: round(p.x), y: round(p.y), z: round(p.z) })),
});

/**
 * Keeps the session's frames (recording format 2) and saves them on R or the
 * button: the JSON, and with ?record=video the camera's video next to it
 * under the same name. Saving does not stop the recording: a later save holds
 * everything from the start again.
 */
function createRecorder(panel: HTMLElement, mirrored: () => boolean) {
  const meta: RecordingMeta = { userAgent: navigator.userAgent, models: {}, delegate: {} };
  const recording: Recording = { version: 2, aspect: 4 / 3, meta, frames: [] };
  Object.assign(globalThis, { handRecording: recording }); // also reachable from the console
  const setup = createSetupForm();
  let film: ReturnType<typeof filmCamera>;
  let filming = false;
  /** Said in the overlay next to the frame count, with ?record=video */
  let filmNote = "";

  /** Which models run changes while the session runs (a body model loads late, fails, goes over to the CPU): called on every such change and at each save */
  const describe = () => {
    meta.models = {};
    meta.delegate = {};
    if (handDelegate) {
      meta.models.hand = HAND_MODEL;
      meta.delegate.hand = handDelegate;
    }
    for (const [model, { file, delegate }] of Object.entries(body?.running() ?? {})) {
      meta.models[model] = file;
      meta.delegate[model] = delegate;
    }
    meta.mirror = mirrored();
    meta.setup = setup.read();
  };

  const save = async () => {
    const name = `hand-recording-${Date.now()}`;
    describe();
    if (film) meta.video = { file: `${name}.${film.extension}`, mimeType: film.mimeType, ...film.start };
    saveFile(new Blob([JSON.stringify(recording)], { type: "application/json" }), `${name}.json`);
    // The video second: its last moments have to be asked from the MediaRecorder first
    if (film && meta.video) saveFile(await film.blob(), meta.video.file);
  };
  const button = Object.assign(document.createElement("button"), { textContent: "Aufnahme speichern (R)" });
  button.addEventListener("click", () => void save());
  // Not while someone types in a field elsewhere on the page (the form's own fields keep their keys to themselves)
  const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  addEventListener("keydown", (e) => e.key === "r" && !e.repeat && !typing(e) && void save());
  panel.prepend(button, setup.form);

  return {
    recording,
    describe,
    /** For the overlay: how much is recorded, and whether the video is */
    note: () => `Aufnahme ${recording.frames.length}${recording.frames.length >= MAX_RECORDING ? " (voll)" : ""}${filmNote}`,
    /** The frame as it is kept, or undefined once the recording is full */
    add(timeMs: number, hands: HandFrame[], aspect: number): RecordingFrame | undefined {
      if (recording.frames.length >= MAX_RECORDING) return undefined;
      recording.aspect = aspect;
      const frame: RecordingFrame = { t: Math.round(timeMs), hands: hands.map(compact) };
      recording.frames.push(frame);
      return frame;
    },
    /** Once the camera runs: what it is, and with ?record=video its picture */
    camera(stream: MediaStream, video: HTMLVideoElement) {
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings() ?? {};
      meta.camera = {
        label: track?.label ?? "",
        width: settings.width ?? video.videoWidth,
        height: settings.height ?? video.videoHeight,
        facingMode: settings.facingMode,
        frameRate: settings.frameRate,
      };
      describe();
      if (params.get("record") !== "video" || filming) return;
      filming = true;
      hud.video = "wartet auf die Körpermodelle";
      // Only once the body models have loaded. Their start holds the page up for
      // a second or two, and a MediaRecorder running through that stopped the
      // camera for good in headless Chrome (with a video file as the camera; the
      // hands froze with it). The video also has little to show before then.
      void bodyModelsReady.then(() => {
        film = filmCamera(stream, video);
        // Without a MediaRecorder the landmarks are still recorded: said in the overlay, which the player sees
        filmNote = film ? " + Video" : ", ohne Video (nicht unterstützt)";
        hud.video = film?.mimeType ?? "nicht unterstützt: nur Landmarken";
      });
    },
  };
}

function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  // Not at once: a large video may not have been read yet
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * ?record=video: the camera's picture through a MediaRecorder, kept in memory
 * until it is saved. webm where the browser can (Chrome, Firefox), mp4
 * otherwise (Safari); undefined where it can do neither, then only the
 * landmarks are recorded.
 */
function filmCamera(stream: MediaStream, video: HTMLVideoElement) {
  if (typeof MediaRecorder === "undefined") return undefined;
  const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) return undefined;
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (e) {
    console.warn("The camera's video is not recorded", e);
    return undefined;
  }
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (e) => e.data.size > 0 && chunks.push(e.data));
  // Where the file starts on the frames' two clocks (RecordingMeta.video)
  const start = { t: Math.round(performance.now()), mediaTime: round(video.currentTime) };
  recorder.addEventListener("start", () => Object.assign(start, { t: Math.round(performance.now()), mediaTime: round(video.currentTime) }));
  recorder.addEventListener("stop", () => (hud.video = `${mimeType}: nach ${MAX_VIDEO_MS / 60_000} min angehalten`));
  recorder.start(1000); // a chunk per second
  setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_VIDEO_MS);
  return {
    mimeType,
    extension: mimeType.includes("mp4") ? "mp4" : "webm",
    start,
    /** Everything from the start until now; the recorder goes on */
    async blob() {
      if (recorder.state === "recording") {
        // After the listener above, so the chunk is in the list when this resolves
        const flushed = new Promise((resolve) => recorder.addEventListener("dataavailable", resolve, { once: true }));
        recorder.requestData();
        await flushed;
      }
      return new Blob(chunks, { type: mimeType });
    },
  };
}

const SETUP_KEY = "record-setup";
const SETUP_NUMBERS: { key: Exclude<keyof RecordingSetup, "notes">; label: string; title: string }[] = [
  { key: "cameraHeightCm", label: "Kamerahöhe cm", title: "Höhe der Kameralinse über dem Boden" },
  { key: "pitchDeg", label: "Kameraneigung °", title: "Neigung der Kamera: positiv schaut sie nach oben, negativ nach unten, 0 ist waagrecht" },
  { key: "playerHeightCm", label: "Körpergrösse cm", title: "Körpergrösse der Person, die spielt" },
  { key: "markHeightCm", label: "Markenhöhe cm", title: "Höhe der Marke über dem Boden, an die die Hand gehalten wird" },
];

/**
 * Notes on the set-up, typed in by whoever records and stored with the
 * recording when it is saved: what a height worked out from the frames is
 * checked against. Remembered in the browser, so a series of recordings needs
 * only what changes.
 */
function createSetupForm() {
  let stored: RecordingSetup = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETUP_KEY) ?? "{}") ?? {};
  } catch {
    // No storage (private mode) or nothing readable in it: starts empty
  }
  const form = document.createElement("form");
  form.style.display = "contents"; // its fields line up with the panel's buttons
  form.addEventListener("submit", (e) => e.preventDefault());
  // The page's keys (R saves, M mirrors, N resets the cross, …) must not act while someone types here
  for (const type of ["keydown", "keyup"]) form.addEventListener(type, (e) => e.stopPropagation());

  const field = (label: string, title: string, input: HTMLInputElement, value: unknown) => {
    input.value = value === undefined || value === null ? "" : String(value);
    const row = Object.assign(document.createElement("label"), { title });
    row.append(label, input);
    form.append(row);
    return input;
  };
  const numbers = SETUP_NUMBERS.map(({ key, label, title }) => {
    const input = Object.assign(document.createElement("input"), { type: "number", step: "any", inputMode: "decimal" });
    input.style.width = "4.5em";
    return { key, input: field(label, title, input, stored[key]) };
  });
  const notes = field("Notizen", "Was sonst zur Aufnahme gehört: Kamera, Raum, Abstand, was gezeigt wird", Object.assign(document.createElement("input"), { type: "text" }), stored.notes);
  notes.style.width = "14em";

  const read = (): RecordingSetup => {
    const setup: RecordingSetup = {};
    for (const { key, input } of numbers) {
      // An empty field is not 0: it is left out
      if (input.value.trim() !== "" && Number.isFinite(Number(input.value))) setup[key] = Number(input.value);
    }
    if (notes.value.trim()) setup.notes = notes.value.trim();
    return setup;
  };
  form.addEventListener("input", () => {
    try {
      localStorage.setItem(SETUP_KEY, JSON.stringify(read()));
    } catch {
      // Not remembered then
    }
  });
  return { form, read };
}

// --- camera ------------------------------------------------------------------

async function createLandmarker() {
  // Loaded on demand: the library is not needed before the camera starts
  const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe/wasm`);
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: `${import.meta.env.BASE_URL}mediapipe/${HAND_MODEL}`, delegate },
    runningMode: "VIDEO" as const,
    numHands: 2, // cross hand + the hand that takes the hand bar
  });
  let hands: HandLandmarker;
  try {
    hud.delegate = "GPU";
    hands = await HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (e) {
    console.warn("MediaPipe GPU delegate failed, using CPU", e);
    hud.delegate = "CPU";
    hands = await HandLandmarker.createFromOptions(fileset, options("CPU"));
  }
  handDelegate = hud.delegate as "GPU" | "CPU"; // for the recording's meta
  return hands;
}

/**
 * With ?record: the body models next to the hands (body-source.ts), in a
 * chunk of their own, so that in play none of it is downloaded. Called once
 * the hand landmarker has run its first frame; nothing here is awaited by the
 * hand tracking, and a failure only shows in the HUD.
 */
async function startBodyModels() {
  const wanted = (params.get("body") ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  const named = (["face", "mesh", "pose"] satisfies BodyModel[]).filter((model) => wanted.includes(model));
  // All three unless some are named; "off" for none; "cpu" says how, not which
  const models: BodyModel[] = wanted.includes("off") ? [] : named.length ? named : ["face", "mesh", "pose"];
  try {
    if (!models.length) {
      hud.body = "off";
      return;
    }
    const { createBodySource } = await import("./body-source.ts");
    body = createBodySource({
      models,
      cpuOnly: wanted.includes("cpu"),
      report(status) {
        hud.body = status;
        session?.recorder?.describe();
      },
    });
    await body.loaded;
  } catch (e) {
    console.warn("The body models did not start", e);
    hud.body = `error: ${e instanceof Error ? e.message : e}`;
  } finally {
    bodyModelsSettled();
  }
}

/** Overlay up, mirroring decided: once both the camera and the session are there */
function showCamera() {
  if (!session || !cameraVideo) return;
  session.allowMirror(cameraMirrorAllowed);
  session.setCamera(cameraKeyOf(cameraStream, cameraVideo));
  document.body.append(session.element);
  // One set-up per page load while recording (?record): no switching then
  session.setChoice(params.has("record") ? null : shownResolution(cameraVideo));
  if (cameraStream) session.recorder?.camera(cameraStream, cameraVideo);
}

// The camera's resolution. 1280 × 720 gives the landmark model more pixels of a
// hand held far from the camera (not the default: untested on phones). Chosen
// with ?res=, or with the switch in the hand window (remembered).
const RESOLUTIONS: Record<string, [number, number]> = { "320": [320, 240], "640": [640, 480], "1280": [1280, 720] };
const RES_KEY = "hand-camera-res";
const facingMode = params.get("camera") === "environment" ? "environment" : "user";

function chosenResolution() {
  const fromUrl = params.get("res");
  if (fromUrl && RESOLUTIONS[fromUrl]) return fromUrl;
  try {
    const stored = localStorage.getItem(RES_KEY);
    if (stored && RESOLUTIONS[stored]) return stored;
  } catch {
    // No storage (private mode): the default
  }
  return "640";
}

/** The switch shows what the camera really delivers, which need not be what was asked for */
const shownResolution = (video: HTMLVideoElement) => (video.videoWidth >= 960 ? "1280" : "640");

/**
 * Switches the running camera to another resolution (the switch in the hand
 * window). First by asking the running track; a camera that does not follow
 * is opened anew. The picture's shape changes with it (4:3 ↔ 16:9, often
 * another crop of the sensor), so the hand has another size and place in it:
 * the tracker takes a new rest pose, or depth and height would jump.
 */
async function setResolution(value: string) {
  const size = RESOLUTIONS[value];
  if (!size) return;
  try {
    localStorage.setItem(RES_KEY, value);
  } catch {
    // Not remembered then
  }
  const video = cameraVideo;
  if (!video || !cameraStream || !session) return;
  if (shownResolution(video) === value) return session.setChoice(value);
  session.setChoice(value, true);
  const [width, height] = size;
  const changed = async () => {
    for (let i = 0; i < 10 && video.videoWidth !== width; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    return video.videoWidth === width;
  };
  try {
    await cameraStream.getVideoTracks()[0]?.applyConstraints({ width: { ideal: width }, height: { ideal: height } });
    if (!(await changed())) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width, height, facingMode }, audio: false });
      const old = cameraStream;
      video.srcObject = stream;
      await video.play();
      cameraStream = stream;
      for (const track of old.getTracks()) track.stop();
      await changed();
    }
  } catch (e) {
    console.warn("Camera resolution not changed", e);
  }
  hud.camera = `${video.videoWidth}×${video.videoHeight}`;
  // Another picture: the horizon row measured for it (if any), and the hand as it is held now is the rest pose and the standing height
  session.setCamera(cameraKeyOf(cameraStream, video));
  session.reset();
  session.setChoice(shownResolution(video));
}

async function runCamera() {
  if (!navigator.mediaDevices) throw new Error("no camera access (needs HTTPS)");
  const [width, height] = RESOLUTIONS[chosenResolution()];
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
  cameraStream = stream;
  showCamera();

  let inferences = 0;
  let windowStart = performance.now();
  let bodyModelsStarted = false;
  /** What the body models saw in the last frame (?record): it goes into the tracker with the next frame's hands */
  let seenBefore: BodyObservation | undefined;
  // metadata: from requestVideoFrameCallback, not from the rAF fallback
  const onFrame = (_time?: number, metadata?: VideoFrameCallbackMetadata) => {
    const now = performance.now();
    const result = hands.detectForVideo(video, now);
    const frame: HandFrame[] = result.landmarks.map((image, i) => ({
      image,
      world: result.worldLandmarks[i],
      handedness: result.handedness[i]?.[0]?.categoryName === "Left" ? "Left" : "Right",
      score: result.handedness[i]?.[0]?.score ?? 0,
    }));
    const recorded = session?.frame(now, frame, video.videoWidth / video.videoHeight, video, undefined, seenBefore);
    seenBefore = undefined;
    if (recorded) {
      // Where this frame is in the video that ?record=video saves
      if (metadata) recorded.mediaTime = round(metadata.mediaTime);
      // After the tracker, so the puppet has its input before the body models
      // take their time. They read the video's picture as it is by then, which
      // can be a frame later than the one the hands were read from. The height
      // model gets what they saw with the next frame (a replay does the same).
      const seen = body?.detect(video, now);
      if (seen) {
        recorded.body = seen;
        seenBefore = { t: now, ...seen };
      }
    }
    if (!bodyModelsStarted && params.has("record")) {
      bodyModelsStarted = true;
      void startBodyModels();
    }

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
  // Format 2 has more on each frame (body, mediaTime) and a meta block; the hands are as in format 1
  if ((recording.version !== 1 && recording.version !== 2) || !Array.isArray(recording.frames)) throw new Error("not a hand recording");
  return recording;
}

/** Feed a recording through the same pipeline as the camera, at its own pace, in a loop */
function playRecording(recording: Recording, session: Session) {
  session.setCamera(undefined); // no camera: only ?horizon= can say where its height was
  document.body.append(session.element);
  const frames = recording.frames;
  if (!frames.length) return;
  /** A format 2 frame's body goes into the tracker with the next frame's hands, as it did while recording (runCamera) */
  let seenBefore: BodyObservation | undefined;
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
      const time = frame.t - first + loop * duration;
      session.frame(time, frame.hands, recording.aspect, undefined, `Wiedergabe ${((frame.t - first) / 1000).toFixed(1)} s`, seenBefore);
      seenBefore = frame.body && { t: time, ...frame.body };
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
