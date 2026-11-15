import { Vector3 } from "@iwsdk/core";
import type { RigController } from "../puppet/rig";
import { controlInput, puppetState } from "./control-input";
import { HEIGHT, type HeightGuide, type HeightSource } from "./body-frame.ts";
import { HAND_BONES, TUNING, rotateByTilt, type HandView, type TrackerOutput } from "./hand-tracking.ts";

// The picture above the camera feed: how the hands hold the cross. It draws
// the tracked hands, the cross lying in the cross hand (rear end at the wrist,
// front tip at the fingertips; every bar as the rig defines it, rocked as
// ControlInput says), the handles where the second hand takes the hand bar,
// the head bar or the leg bar, the back string it can push, the height at
// which the puppet stands (and, for a new player, the guided capture of that
// height: a band to hold the hand in, one hint at a time), and meters for
// depth, the leg bar and the head's turn. One colour per
// function: the fingers that drive something have its colour, so a glance
// shows what moves what.

const COLOR = {
  cross: "#f0d49a", // main bar, shoulder bar, palm of the cross hand
  legs: "#ff8a3d", // index + middle finger, leg bar
  head: "#4fd1ff", // thumb and little finger (the head turns to the side of the one pressed), head bar
  hands: "#9be36b", // second hand, hand bar
  active: "#ffe14d",
  text: "#f3e9dc",
  dim: "#f3e9dc66",
};
/** Finger of each landmark: 0 palm, then thumb, index, middle, ring, little */
const fingerOf = (landmark: number) => (landmark === 0 ? 0 : Math.ceil(landmark / 4));
const FINGER_COLOR = [COLOR.cross, COLOR.head, COLOR.legs, COLOR.legs, COLOR.cross, COLOR.head];
const STATUS = { none: "Hand zeigen", attached: "verbunden", lost: "Hand verloren" };
/** Shown until the hand has paused once: only then is the cross level in the player's own hand pose */
const REST_HINT = "Hand flach und kurz ruhig halten: Kreuz waagrecht, Finger aktiv";
/** The guided capture of the height at which the puppet stands: one hint at a time (HeightGuide.state; "place" says which way) */
const GUIDE_HINT: Record<HeightGuide["state"], string> = {
  place: "",
  back: "Bitte einen Schritt zurück",
  tilt: "Fingerspitzen leicht zur Kamera neigen",
  hold: "Ruhig halten …",
  done: "So steht die Puppe",
  flying: "Die Puppe kommt …",
};
/** What the hand's height rests on, as the sources line says it */
const SOURCE: Record<HeightSource, string> = {
  hand: "Hand", face: "Gesicht", pose: "Körper",
  calibrated: "gesetzt", "body-prior": "geschätzt", default: "nicht gesetzt",
  "horizon-measured": "Kamera eingemessen", "horizon-fit": "Kamera geschätzt", "horizon-default": "Kamera nicht eingemessen",
};

export interface OverlayState {
  mirror: boolean;
  /** Extra line under the status (recording, replay) */
  note?: string;
  /** In place of the height guide's hint: what the installer's step asks for ("Kamera einmessen"), and how far the hold in progress is, 0…1 */
  hint?: { text: string; progress: number };
}

const PLACE_KEY = "hand-overlay-place";

/**
 * The overlay starts at the top centre (index.html) and can be dragged
 * anywhere, so it never has to cover what the player is looking at; the place
 * is remembered, a double click puts it back.
 */
function makeMovable(canvas: HTMLElement) {
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
    if ((e.target as Element).closest("button")) return; // a control in the window, not a drag
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
  canvas.addEventListener("dblclick", (e) => {
    if ((e.target as Element).closest("button")) return;
    Object.assign(canvas.style, { left: "", top: "", transform: "" });
    stored = null;
    try {
      localStorage.removeItem(PLACE_KEY);
    } catch {
      // Nothing was stored
    }
  });
}

/** A choice in the window's footer (the camera's resolution) */
export interface OverlayChoice {
  label: string;
  title: string;
  choices: { value: string; label: string; title: string }[];
  choose(value: string): void;
}

export function createHandOverlay(controller?: RigController, choice?: OverlayChoice) {
  // The window: the picture, and under it a small footer with the camera's
  // resolution (a segment control). The window is what is dragged about.
  const element = Object.assign(document.createElement("div"), { id: "preview" });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  element.append(canvas);
  const buttons = new Map<string, HTMLButtonElement>();
  const footer = Object.assign(document.createElement("div"), { className: "preview-footer", hidden: true });
  if (choice) {
    const group = Object.assign(document.createElement("div"), { className: "preview-segments", title: choice.title });
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", choice.title);
    for (const c of choice.choices) {
      const button = Object.assign(document.createElement("button"), { type: "button", textContent: c.label, title: c.title });
      button.addEventListener("click", () => {
        choice.choose(c.value);
        button.blur(); // keys go to the stage again
      });
      buttons.set(c.value, button);
      group.append(button);
    }
    footer.append(Object.assign(document.createElement("span"), { textContent: choice.label }), group);
    element.append(footer);
  }
  makeMovable(element);
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
      // Above the hand: below it are the arm and the back string
      const top = Math.min(...view.landmarks.map((p) => p.y));
      text(label, view.landmarks[9].x * width, Math.max(36 * unit, top * height - 6 * unit), colors[0], "center", 8);
    };
    const drawStick = (a: { x: number; y: number }, b: { x: number; y: number }, color: string, thickness: number) => {
      line(a.x, a.y, b.x, b.y, "#000c", thickness + 2);
      line(a.x, a.y, b.x, b.y, color, thickness);
    };
    const handName = (view: HandView) => (view.hand === "left" ? "linke Hand" : "rechte Hand");

    const { handBar: bar, headBar: head, legBar: legs, hook, handles, gizmo } = out;
    if (out.second) {
      const busy = bar.detached || head.held || legs.held || hook.active;
      const label = bar.detached ? "hält das Handkreuz" : head.held ? "dreht den Kopf" : legs.held ? "kippt das Beinkreuz" : hook.active ? "drückt den Rückenfaden" : `2. Hand · ${handName(out.second)}`;
      hand(out.second, Array(6).fill(busy ? COLOR.active : COLOR.hands), label);
    }
    if (out.cross) {
      hand(out.cross, FINGER_COLOR, `Kreuz · ${handName(out.cross)}`);
      const attached = out.status === "attached" || out.status === "lost";
      // The cross lies in the cross hand: a point of the main bar's frame (m) → picture
      const offset = ([x, y, z]: [number, number, number]) => ({
        x: (x * gizmo.x[0] + y * gizmo.y[0] + z * gizmo.z[0]) * height,
        y: (x * gizmo.x[1] + y * gizmo.y[1] + z * gizmo.z[1]) * height,
      });
      const project = (p: [number, number, number]) => {
        const q = offset(p);
        return { x: gizmo.origin.x * height + q.x, y: gizmo.origin.y * height + q.y };
      };
      const palm = gizmo.unit * height; // px per palm length
      const ring = (at: { x: number; y: number }, radius: number, color: string, thickness: number, dashed = false) => {
        if (dashed) ctx.setLineDash([4 * unit, 4 * unit]);
        ctx.strokeStyle = color;
        ctx.lineWidth = thickness * unit;
        ctx.beginPath();
        ctx.arc(at.x, at.y, radius, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]);
      };

      if (controller && mainBar && attached) {
        // The back string: it hangs down from the rear end; a hand moving against it bends it
        const top = { x: hook.line.x * height, y: hook.line.top * height };
        const bottom = { x: hook.line.x * height, y: hook.line.bottom * height };
        if (hook.active) {
          const edge = { x: hook.edge.x * height, y: hook.edge.y * height };
          line(top.x, top.y, edge.x, edge.y, COLOR.active, 1.5);
          line(edge.x, edge.y, bottom.x, bottom.y, COLOR.active, 1.5);
        } else {
          line(top.x, top.y, bottom.x, bottom.y, out.second ? COLOR.cross : COLOR.dim, 1);
        }

        // The cross, bar by bar; a short string hangs from each end of the rocking bars
        for (const b of controller.bars) {
          const color = b.input ? COLOR[b.input] : COLOR.cross;
          const free = b.detachable && bar.detached && out.second;
          const which = b.detachable ? "hand" : b.input === "head" ? "head" : b.input === "legs" ? "legs" : undefined;
          const held = free || (which === "head" && head.held) || (which === "legs" && legs.held);
          const handle = which === "hand" ? bar.magnet : which === "head" ? head.handle : which === "legs" ? legs.handle : undefined;
          const at = handle && { x: handle.x * height, y: handle.y * height };
          for (const stick of b.sticks) {
            let ends;
            if (free) {
              // Taken off: drawn in the second hand, turned as the hand has turned it since
              const grip = [out.second!.landmarks[4], out.second!.landmarks[8]];
              const centre = { x: ((grip[0].x + grip[1].x) / 2) * width, y: ((grip[0].y + grip[1].y) / 2) * height };
              ends = [stick.a, stick.b].map((end) => {
                point.copy(end).sub(b.pivot);
                const q = offset(rotateByTilt([point.x, point.y, point.z], bar));
                return { x: centre.x + q.x, y: centre.y + q.y };
              });
              if (at) line(at.x, at.y, centre.x, centre.y, COLOR.dim, 1);
            } else {
              ends = [stick.a, stick.b].map((end) => project(inBarFrame(b, end)));
              // The handle: beyond the bar's end, clear of the cross hand
              if (at) {
                const near = ends[0].x * handles.side > ends[1].x * handles.side ? ends[0] : ends[1];
                ctx.setLineDash([2 * unit, 3 * unit]);
                line(near.x, near.y, at.x, at.y, held ? COLOR.active : color, 1);
                ctx.setLineDash([]);
              }
            }
            if (b.input) for (const end of ends) line(end.x, end.y, end.x, end.y + 0.45 * palm, COLOR.dim, 1);
            drawStick(ends[0], ends[1], held ? COLOR.active : color, b.input ? 4 : 3);
          }
          if (at) {
            // A ring where the second hand takes this bar; its reach is shown while that hand is in the picture
            const near = handles.near === which;
            ring(at, 4.5 * unit, held ? COLOR.active : color, near ? 2.5 : 1.5);
            if (out.second && (near || !handles.near)) ring(at, handles.radius * height, held ? COLOR.active : near ? color : COLOR.dim, near ? 1.5 : 1, true);
          }
        }
      }
    }

    // Where the puppet stands: the row of the picture the hand has to be at, at its distance. For a new
    // player first the band in which that height is taken (the guided capture), with one hint at a time
    const guide = out.status === "attached" ? out.height.guide : undefined;
    if (out.status === "attached") {
      const reading = out.height;
      const row = reading.standRow * height;
      const inView = row > 30 * unit && row < height - 56 * unit;
      if (guide) {
        // The band: soft, with its edges marked; it closes onto the standing line once the height is taken
        const [top, bottom] = [guide.band[0] * height, guide.band[1] * height];
        ctx.fillStyle = guide.state === "hold" || guide.state === "done" ? "#ffe14d2e" : "#f3e9dc24";
        ctx.fillRect(22 * unit, top, width - 30 * unit, Math.max(bottom - top, 1.5 * unit));
        ctx.setLineDash([6 * unit, 5 * unit]);
        for (const edge of [top, bottom]) line(22 * unit, edge, width - 8 * unit, edge, guide.state === "hold" || guide.state === "done" ? COLOR.active : COLOR.dim, 1);
        ctx.setLineDash([]);
      } else {
        // Standing is a band (TUNING.position.dead above and below the line, more while the height is not sure): within it the cross keeps its height
        const dead = TUNING.position.dead + Math.max(0, Math.min(reading.sigma - HEIGHT.sigma.calibrated, TUNING.position.unsure));
        const band = out.cross ? ((dead * out.cross.palmLength) / TUNING.gizmo.palm) * height : 0;
        if (inView && band > 0) {
          ctx.fillStyle = "#f3e9dc1c";
          ctx.fillRect(22 * unit, row - band, width - 30 * unit, 2 * band);
        }
        // How far the hand is above (+) or below the height at which the puppet stands
        const centimetres = Math.round(reading.value * 100);
        const label = `Puppe steht${inView ? "" : row < height / 2 ? " ↑ (über dem Bild)" : " ↓ (unter dem Bild)"} · Hand ${centimetres > 0 ? "+" : centimetres < 0 ? "−" : ""}${Math.abs(centimetres)} cm`;
        const y = Math.max(30 * unit, Math.min(height - 56 * unit, row));
        if (inView) {
          ctx.setLineDash([6 * unit, 5 * unit]);
          line(22 * unit, row, width - 8 * unit, row, COLOR.dim, 1);
          ctx.setLineDash([]);
        }
        text(label, width - 8 * unit, y - 4 * unit, COLOR.dim, "right", 7.5);
      }
      // What the height rests on, small, above the lines at the bottom right
      text(`Höhe: ${reading.sources.map((source) => SOURCE[source]).join(" · ")}`, width - 8 * unit, height - 38 * unit, reading.confidence > 0.5 ? COLOR.dim : COLOR.active, "right", 7);
    }
    // One hint, in the lower half of the picture, clear of the top edge (in impro mode the director bar lies over it)
    // and of the meters: the height guide's, or the installer's while the camera is measured
    const hint = state.hint ?? (guide && { text: guide.state === "place" ? (guide.arrow > 0 ? "Hand etwas höher  ↑" : "Hand etwas tiefer  ↓") : GUIDE_HINT[guide.state], progress: guide.state === "hold" ? guide.progress : -1 });
    if (hint) {
      // Under the band (which is where the hand is: once the height is taken, well under it), or just inside its
      // lower edge where there is no room below; right above the meters while there is no band
      const lowest = height - (hint.progress >= 0 ? 70 : 60) * unit;
      const under = guide ? guide.band[1] * height + (guide.state === "done" ? 44 : 14) * unit : lowest;
      const y = !guide || under <= lowest ? under : guide.state === "done" ? lowest : Math.min(lowest, guide.band[1] * height - (hint.progress >= 0 ? 16 : 6) * unit);
      text(hint.text, width / 2, y, COLOR.active, "center", state.hint ? 8.5 : 11);
      if (hint.progress >= 0) {
        // The hold: a bar that fills while the hand keeps still
        const [left, right] = [width / 2 - 60 * unit, width / 2 + 60 * unit];
        line(left, y + 8 * unit, right, y + 8 * unit, "#000a", 6);
        line(left, y + 8 * unit, right, y + 8 * unit, COLOR.dim, 4);
        if (hint.progress > 0) line(left, y + 8 * unit, left + (right - left) * Math.min(1, hint.progress), y + 8 * unit, COLOR.active, 4);
      }
    }

    // Status, top left
    text(`${STATUS[out.status]} · ${state.mirror ? "Spiegel" : "Gegenüber"}`, 8 * unit, 14 * unit, out.status === "attached" ? COLOR.text : COLOR.active, "left", 10);
    if (state.note) text(state.note, 8 * unit, 26 * unit, COLOR.dim);
    // (not next to the height guide: it asks for the same pause, in its band)
    if (out.status === "attached" && !out.calibrated && !guide && !state.hint) text(REST_HINT, width / 2, 40 * unit, COLOR.active, "center", 8);
    // Top right: the magnet in the puppet's hands (the second hand's fist away
    // from the handles), and what the engine says about the hands (puppetState)
    const holding = puppetState.holding.left ?? puppetState.holding.right;
    // Something is in reach of a free puppet hand, and the second hand is free to close
    const canGrab = !!(puppetState.inReach.left ?? puppetState.inReach.right) && !!out.second && !bar.detached && !head.held && !legs.held && !hook.active;
    {
      const [x, y] = [width - 8 * unit, 14 * unit];
      if (out.grasp.phase === "click") {
        // A fist made while the puppet holds something lets go if it opens again in time: the ring drains with the time that is left
        text("öffnen: loslassen", x - 14 * unit, y, COLOR.active, "right", 10);
        ctx.strokeStyle = COLOR.active;
        ctx.lineWidth = 2 * unit;
        ctx.beginPath();
        ctx.arc(x - 5 * unit, y - 3.5 * unit, 4.5 * unit, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * (1 - out.grasp.window));
        ctx.stroke();
      } else if (holding) {
        text(`hält: ${holding}`, x, y, COLOR.active, "right", 10);
        text("kurz Faust auf/zu: loslassen", x, y + 11 * unit, COLOR.dim, "right", 7.5);
      } else if (out.grasp.phase === "fist") {
        text("Magnet an", x, y, COLOR.active, "right", 10);
      } else if (canGrab) {
        text("Faust: greifen", x, y, COLOR.hands, "right", 10);
      }
    }

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

    // Meters, bottom: the leg bar from −limit to +limit, the head's turn from
    // left to right (each from the cross hand's fingers, or from the second
    // hand while it holds that bar), and the cross's tilt
    const meters: [string, number, string, boolean][] = [
      legs.held ? ["Beine · 2. Hand kippt", out.rock.legs, COLOR.active, true] : ["Beine · Zeige- / Mittelfinger", out.rock.legs, COLOR.legs, true],
      head.held ? ["Kopf drehen · 2. Hand", out.turn, COLOR.active, true] : ["Kopf drehen · Daumen / kleiner Finger", out.turn, COLOR.head, true],
    ];
    meters.forEach(([label, value, color, centred], i) => {
      const y = height - (36 - i * 18) * unit;
      const [left, right] = [8 * unit, 150 * unit];
      const zero = centred ? (left + right) / 2 : left;
      text(label, left, y - 5 * unit, color, "left", 7.5);
      line(left, y, right, y, COLOR.dim, 3);
      line(zero, y - 3 * unit, zero, y + 3 * unit, COLOR.text, 1);
      line(zero, y, zero + value * (right - zero), y, color, 3);
    });
    const degrees = (rad: number) => `${rad >= 0 ? "+" : "−"}${Math.abs((rad * 180) / Math.PI).toFixed(0)}°`;
    const tilt = `neigen ${degrees(out.bar.pitch)}   kippen ${degrees(out.bar.roll)}   drehen ${degrees(out.bar.yaw)}`;
    text(tilt, width - 8 * unit, height - 24 * unit, COLOR.cross, "right", 8);
    // What the second hand does, or can do. The magnet is said here as well as
    // top right: in impro mode the director bar lies over the overlay's top edge
    const grasping = out.grasp.phase === "click" ? "öffnen: loslassen" : out.grasp.on ? "Magnet an · 2. Hand als Faust" : holding ? `hält: ${holding} · kurz Faust auf/zu: loslassen` : canGrab ? "Faust abseits der Ringe: greifen" : "";
    const secondHand = bar.detached ? "Handkreuz · frei in der 2. Hand" : head.held ? "Kopf · 2. Hand drehen" : legs.held ? "Beinkreuz · 2. Hand drehen" : hook.active ? "Rückenfaden · gedrückt" : grasping || "2. Hand: am Ring greifen · offen gegen den Rückenfaden · Faust abseits: Magnet";
    text(secondHand, width - 8 * unit, height - 10 * unit, bar.detached || head.held || legs.held || hook.active || grasping ? COLOR.active : COLOR.hands, "right", 7.5);
  }

  return {
    /** The window to put into the page */
    element,
    draw,
    /** Which choice is on (the footer shows once one is; null hides it: no camera to choose for) */
    setChoice(value: string | null, busy = false) {
      footer.hidden = value === null;
      for (const [v, button] of buttons) {
        button.setAttribute("aria-pressed", String(v === value));
        button.disabled = busy;
      }
    },
  };
}
