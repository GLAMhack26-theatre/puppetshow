import { Vector3 } from "@iwsdk/core";
import type { RigController } from "../puppet/rig";
import { controlInput } from "./control-input";
import { HAND_BONES, TUNING, projectCross, tiltFromQuat, type HandView, type Tilt, type TrackerOutput } from "./hand-tracking.ts";

// The picture above the camera feed: how the hands hold the cross. It draws
// the tracked hands, the cross on the cross hand in its live pose (every bar
// as the rig defines it, rocked as ControlInput says), and meters for depth
// and the rocking bars. One colour per function: the fingers that drive a bar
// have the bar's colour, so a glance shows what moves what.

const COLOR = {
  cross: "#f0d49a", // main bar, shoulder bar, palm of the cross hand
  legs: "#ff8a3d", // index + middle finger, leg bar
  head: "#4fd1ff", // ring + little finger and thumb, head bar
  hands: "#9be36b", // second hand, hand bar
  active: "#ffe14d",
  text: "#f3e9dc",
  dim: "#f3e9dc66",
};
/** Finger of each landmark: 0 palm, then thumb, index, middle, ring, little */
const fingerOf = (landmark: number) => (landmark === 0 ? 0 : Math.ceil(landmark / 4));
const FINGER_COLOR = [COLOR.cross, COLOR.head, COLOR.legs, COLOR.legs, COLOR.head, COLOR.head];
const STATUS = { none: "Hand zeigen", attached: "verbunden", lost: "Hand verloren" };
/** Shown until the hand has paused once: only then is the cross level in the player's own hand pose */
const REST_HINT = "Hand flach und kurz ruhig halten: Kreuz waagrecht, Finger aktiv (N: neu)";

export interface OverlayState {
  mirror: boolean;
  /** Extra line under the status (recording, replay) */
  note?: string;
}

const PLACE_KEY = "hand-overlay-place";

/**
 * The overlay starts at the top centre (index.html) and can be dragged
 * anywhere, so it never has to cover what the player is looking at; the place
 * is remembered, a double click puts it back.
 */
function makeMovable(canvas: HTMLCanvasElement) {
  const place = (left: number, top: number) => {
    // Kept inside the window, also after the window was resized
    const x = Math.max(0, Math.min(innerWidth - canvas.offsetWidth, left));
    const y = Math.max(0, Math.min(innerHeight - canvas.offsetHeight, top));
    Object.assign(canvas.style, { left: `${x}px`, top: `${y}px`, transform: "none" });
    return { x, y };
  };
  let stored: { x: number; y: number } | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null");
  } catch {
    // No storage (private mode): it just starts at the top centre
  }
  // Placed once it is in the page and has a size
  if (stored) requestAnimationFrame(function wait() {
    if (canvas.isConnected && canvas.offsetWidth) place(stored!.x, stored!.y);
    else requestAnimationFrame(wait);
  });

  let grab: { x: number; y: number } | undefined;
  canvas.addEventListener("pointerdown", (e) => {
    const rect = canvas.getBoundingClientRect();
    grab = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (grab) stored = place(e.clientX - grab.x, e.clientY - grab.y);
  });
  const release = () => {
    if (!grab) return;
    grab = undefined;
    try {
      if (stored) localStorage.setItem(PLACE_KEY, JSON.stringify(stored));
    } catch {
      // Not remembered then
    }
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("dblclick", () => {
    Object.assign(canvas.style, { left: "", top: "", transform: "" });
    stored = null;
    try {
      localStorage.removeItem(PLACE_KEY);
    } catch {
      // Nothing was stored
    }
  });
}

export function createHandOverlay(controller?: RigController) {
  const canvas = Object.assign(document.createElement("canvas"), { id: "preview" });
  const ctx = canvas.getContext("2d")!;
  makeMovable(canvas);
  const mainBar = controller?.bars.find((b) => !b.parent);
  const point = new Vector3();

  /** Stick end → bar frame (stage axes, metres from the main bar's pivot), with the bar's live rocking angle */
  const inBarFrame = (bar: RigController["bars"][number], end: Vector3): [number, number, number] => {
    point.copy(end);
    if (bar.parent && bar.axis && bar.input) {
      const angle = Math.max(-bar.limit, Math.min(bar.limit, controlInput.rock[bar.input] ?? 0));
      point.sub(bar.pivot).applyAxisAngle(bar.axis, angle).add(bar.pivot);
    }
    point.sub(mainBar!.pivot);
    return [point.x, point.y, point.z];
  };

  function draw(video: HTMLVideoElement | undefined, aspect: number, out: TrackerOutput, state: OverlayState) {
    // Twice the CSS size: sharp lines and text on dense screens
    const width = Math.round(canvas.clientWidth * 2) || 640;
    const height = Math.round(width / aspect);
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const unit = height / 240; // sizes below are in px of a 320 × 240 picture
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Camera picture, in the display frame the tracking uses (mirrored for a camera that faces the player), dimmed for contrast
    ctx.fillStyle = "#17110e";
    ctx.fillRect(0, 0, width, height);
    if (video) {
      ctx.save();
      if (state.mirror) ctx.setTransform(-1, 0, 0, 1, width, 0);
      ctx.drawImage(video, 0, 0, width, height);
      ctx.restore();
      ctx.fillStyle = "#0009";
      ctx.fillRect(0, 0, width, height);
    }
    // Darker still behind the meters, so they read on any camera picture
    ctx.fillStyle = "#0007";
    ctx.fillRect(0, height - 50 * unit, width, 50 * unit);

    const line = (ax: number, ay: number, bx: number, by: number, color: string, thickness: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = thickness * unit;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    };
    const text = (label: string, x: number, y: number, color = COLOR.text, align: CanvasTextAlign = "left", size = 9) => {
      ctx.font = `${size * unit}px system-ui, sans-serif`;
      ctx.textAlign = align;
      ctx.lineWidth = 2.5 * unit;
      ctx.strokeStyle = "#000a";
      ctx.strokeText(label, x, y);
      ctx.fillStyle = color;
      ctx.fillText(label, x, y);
    };

    // Hands are drawn thin with a dot on each fingertip, the cross thick with a
    // dark edge: the two must not be mistaken for each other where they overlap
    const hand = (view: HandView, colors: string[], label: string) => {
      ctx.globalAlpha = view.held ? 0.35 : 0.85; // not seen in this frame: held
      for (const [a, b] of HAND_BONES) {
        const [p, q] = [view.landmarks[a], view.landmarks[b]];
        const finger = fingerOf(b);
        line(p.x * width, p.y * height, q.x * width, q.y * height, colors[fingerOf(a) === finger ? finger : 0], 1.4);
      }
      for (const tip of [4, 8, 12, 16, 20]) {
        ctx.fillStyle = colors[fingerOf(tip)];
        ctx.beginPath();
        ctx.arc(view.landmarks[tip].x * width, view.landmarks[tip].y * height, 2.6 * unit, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // Above the hand: below it is the arm, and the cross is drawn beside it
      const top = Math.min(...view.landmarks.map((p) => p.y));
      text(label, view.landmarks[9].x * width, Math.max(36 * unit, top * height - 6 * unit), colors[0], "center", 8);
    };
    const drawStick = (a: { x: number; y: number }, b: { x: number; y: number }, color: string, thickness: number) => {
      line(a.x, a.y, b.x, b.y, "#000c", thickness + 2);
      line(a.x, a.y, b.x, b.y, color, thickness);
    };
    const handName = (view: HandView) => (view.hand === "left" ? "linke Hand" : "rechte Hand");

    const bar = out.handBar;
    if (out.second) {
      const color = bar.detached ? COLOR.active : COLOR.hands;
      hand(out.second, Array(6).fill(color), bar.detached ? "hält das Handkreuz" : `2. Hand · ${handName(out.second)}`);
    }
    if (out.cross) {
      hand(out.cross, FINGER_COLOR, `Kreuz · ${handName(out.cross)}`);
      const attached = out.status === "attached" || out.status === "lost";
      const origin = { x: out.cross.palm.x * height, y: out.cross.palm.y * height };
      const scale = bar.unit * height; // px per palm length
      const project = (p: [number, number, number], tilt: Tilt) => {
        const q = projectCross(p, tilt, bar.side);
        return { x: origin.x + q.x * scale, y: origin.y + q.y * scale };
      };

      // Magnet point and reach: where the second hand takes the hand bar
      const magnet = { x: bar.magnet.x * height, y: bar.magnet.y * height };
      if (attached && (out.second || bar.detached)) {
        ctx.setLineDash([4 * unit, 4 * unit]);
        ctx.strokeStyle = bar.detached ? COLOR.active : bar.near ? COLOR.hands : COLOR.dim;
        ctx.lineWidth = (bar.near ? 1.5 : 1) * unit;
        ctx.beginPath();
        ctx.arc(magnet.x, magnet.y, bar.radius * height, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // The cross, bar by bar; a short string hangs from each end of the rocking bars
      if (controller && mainBar && attached) {
        for (const b of controller.bars) {
          const color = b.input ? COLOR[b.input] : COLOR.cross;
          const free = b.detachable && bar.detached && out.second;
          for (const stick of b.sticks) {
            let ends;
            if (free) {
              // Taken off: drawn in the second hand, turned as the free bar is turned
              const grip = [out.second!.landmarks[4], out.second!.landmarks[8]];
              const centre = { x: ((grip[0].x + grip[1].x) / 2) * width, y: ((grip[0].y + grip[1].y) / 2) * height };
              const turn = tiltFromQuat(controlInput.handBar.rotation.toArray() as [number, number, number, number]);
              ends = [stick.a, stick.b].map((end) => {
                point.copy(end).sub(b.pivot);
                const q = projectCross([point.x, point.y, point.z], turn, bar.side);
                return { x: centre.x + q.x * scale, y: centre.y + q.y * scale };
              });
              line(magnet.x, magnet.y, centre.x, centre.y, COLOR.dim, 1);
            } else {
              ends = [stick.a, stick.b].map((end) => project(inBarFrame(b, end), out.bar));
            }
            if (b.input) for (const end of ends) line(end.x, end.y, end.x, end.y + 0.45 * scale, COLOR.dim, 1);
            drawStick(ends[0], ends[1], free ? COLOR.active : color, b.input ? 4 : 3);
          }
        }
      }
      if (attached) {
        // The magnet: a ring where the hand bar sits, empty while the bar is away
        ctx.strokeStyle = COLOR.hands;
        ctx.lineWidth = 1.5 * unit;
        ctx.beginPath();
        ctx.arc(magnet.x, magnet.y, 5 * unit, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }

    // Status, top left
    text(`${STATUS[out.status]} · ${state.mirror ? "Spiegel" : "Gegenüber"}`, 8 * unit, 14 * unit, out.status === "attached" ? COLOR.text : COLOR.active, "left", 10);
    if (state.note) text(state.note, 8 * unit, 26 * unit, COLOR.dim);
    if (out.status === "attached" && !out.calibrated) text(REST_HINT, width / 2, 40 * unit, COLOR.active, "center", 8);
    if (out.grip) text("Griff", width - 8 * unit, 14 * unit, COLOR.active, "right", 10);

    // Depth gauge, left edge: the puppet's place between back and front of the stage
    const [zMin, zMax] = TUNING.depth.range;
    const gauge = { x: 10 * unit, top: 44 * unit, bottom: height - 62 * unit };
    const zToY = (z: number) => gauge.bottom - ((z - zMin) / (zMax - zMin)) * (gauge.bottom - gauge.top);
    line(gauge.x, gauge.top, gauge.x, gauge.bottom, COLOR.dim, 3);
    line(gauge.x - 4 * unit, zToY(0), gauge.x + 4 * unit, zToY(0), COLOR.text, 1); // the baseline: where the hand rests
    text("vorn", gauge.x - 4 * unit, gauge.top - 5 * unit, COLOR.dim, "left", 7);
    text("hinten", gauge.x - 4 * unit, gauge.bottom + 11 * unit, COLOR.dim, "left", 7);
    ctx.fillStyle = COLOR.cross;
    ctx.beginPath();
    ctx.arc(gauge.x, zToY(out.bar.z), 4.5 * unit, 0, 2 * Math.PI);
    ctx.fill();
    text(`${(out.bar.z * 100).toFixed(0)} cm`, gauge.x + 8 * unit, zToY(out.bar.z) + 3 * unit, COLOR.cross, "left", 8);

    // Meters, bottom: each rocker from −limit to +limit, and the cross's tilt
    const meters: [string, number, string][] = [
      ["Beine · Zeige- / Mittelfinger", out.rock.legs, COLOR.legs],
      ["Kopf · Ring + kl. Finger / Daumen", out.rock.head, COLOR.head],
    ];
    meters.forEach(([label, value, color], i) => {
      const y = height - (36 - i * 18) * unit;
      const [left, right] = [8 * unit, 150 * unit];
      const middle = (left + right) / 2;
      text(label, left, y - 5 * unit, color, "left", 7.5);
      line(left, y, right, y, COLOR.dim, 3);
      line(middle, y - 3 * unit, middle, y + 3 * unit, COLOR.text, 1);
      line(middle, y, middle + (value * (right - left)) / 2, y, color, 3);
    });
    const degrees = (rad: number) => `${rad >= 0 ? "+" : "−"}${Math.abs((rad * 180) / Math.PI).toFixed(0)}°`;
    const tilt = `neigen ${degrees(out.bar.pitch)}   kippen ${degrees(out.bar.roll)}   drehen ${degrees(out.bar.yaw)}`;
    text(tilt, width - 8 * unit, height - 24 * unit, COLOR.cross, "right", 8);
    text(bar.detached ? "Handkreuz · frei in der 2. Hand" : "Handkreuz · 2. Hand greift am Punkt", width - 8 * unit, height - 10 * unit, bar.detached ? COLOR.active : COLOR.hands, "right", 7.5);
  }

  return { canvas, draw };
}
