import { HandLandmarker } from "@mediapipe/tasks-vision";

// A synthetic MediaPipe hand for slide 2: the 21 hand landmarks in a looped
// demo (move, tilt, pinch, lift), drawn like the MediaPipe test's preview.
// The state drives the scripted puppet in slides.ts with the app's real
// mapping (spike/mediapipe.ts): wrist → move the cross, roll → tilt, pinch → grab.

type Point = [number, number];

/** Open right hand, palm to the camera (mirrored selfie view), wrist at the origin, about 1 unit long */
const REST: Point[] = [
  [0, 0],
  [-0.12, -0.1], [-0.22, -0.2], [-0.3, -0.3], [-0.36, -0.4], // thumb
  [-0.1, -0.42], [-0.12, -0.6], [-0.13, -0.72], [-0.14, -0.82], // index
  [0, -0.45], [0, -0.65], [0, -0.78], [0, -0.89], // middle
  [0.09, -0.42], [0.1, -0.6], [0.11, -0.71], [0.12, -0.8], // ring
  [0.17, -0.36], [0.2, -0.5], [0.22, -0.59], [0.23, -0.67], // pinky
];
const THUMB = [3, 4];
const INDEX = [7, 8];

export interface HandState {
  /** Sideways and up/down, −1…1 */
  x: number;
  y: number;
  /** Hand roll, rad */
  roll: number;
  /** 0 open … 1 thumb and index touch */
  pinch: number;
  label: string;
}

// Keyframes [time s, x, y, roll, pinch, label]; eased in between, looped
const KEYS: [number, number, number, number, number, string][] = [
  [0, 0, 0, 0, 0, "move the hand"],
  [1.5, -0.8, 0, 0, 0, "move the hand"],
  [3, 0.8, 0, 0, 0, "move the hand"],
  [4.2, 0, 0, 0, 0, "tilt the hand"],
  [5.2, 0, 0, 0.45, 0, "tilt the hand"],
  [6.4, 0, 0, -0.45, 0, "tilt the hand"],
  [7.2, 0, 0, 0, 0, "pinch = grab"],
  [8.2, 0, 0, 0, 1, "pinch = grab"],
  [9.2, 0, 0.6, 0, 1, "lift"],
  [10, 0, 0, 0, 0, "move the hand"],
];
const PERIOD = KEYS[KEYS.length - 1][0];

const ease = (t: number) => t * t * (3 - 2 * t);

function stateAt(time: number): HandState {
  const t = time % PERIOD;
  const i = KEYS.findIndex((k, n) => n < KEYS.length - 1 && t >= k[0] && t < KEYS[n + 1][0]);
  const [t0, x0, y0, r0, p0, label] = KEYS[i];
  const [t1, x1, y1, r1, p1] = KEYS[i + 1];
  const f = ease((t - t0) / (t1 - t0));
  const mix = (a: number, b: number) => a + (b - a) * f;
  return { x: mix(x0, x1), y: mix(y0, y1), roll: mix(r0, r1), pinch: mix(p0, p1), label };
}

/** The hand's landmarks in image space (0…1, y down), like MediaPipe's NormalizedLandmark */
function landmarks(state: HandState): Point[] {
  const points = REST.map((p) => [...p] as Point);
  // Pinch: thumb and index tips meet halfway
  const meet: Point = [(REST[4][0] + REST[8][0]) / 2, (REST[4][1] + REST[8][1]) / 2 + 0.05];
  for (const [i, weight] of [[THUMB[0], 0.5], [THUMB[1], 1], [INDEX[0], 0.5], [INDEX[1], 1]] as const) {
    points[i][0] += (meet[0] - points[i][0]) * state.pinch * weight;
    points[i][1] += (meet[1] - points[i][1]) * state.pinch * weight;
  }
  const cos = Math.cos(state.roll);
  const sin = Math.sin(state.roll);
  const scale = 0.55;
  return points.map(([x, y]) => [
    0.5 + state.x * 0.22 + (x * cos - y * sin) * scale,
    0.82 - state.y * 0.15 + (x * sin + y * cos) * scale,
  ]);
}

const ICON_STATES: Record<"move" | "tilt" | "pinch", HandState> = {
  move: { x: 0, y: 0, roll: 0, pinch: 0, label: "" },
  tilt: { x: 0, y: 0, roll: 0.4, pinch: 0, label: "" },
  pinch: { x: 0, y: 0, roll: 0, pinch: 1, label: "" },
};

/**
 * A gesture as a small line drawing of the same MediaPipe hand skeleton the
 * demo animates (slide 2's list), plus a hint arrow. Colours come from CSS:
 * the lines use currentColor, the points the --point colour.
 */
export function handIcon(kind: keyof typeof ICON_STATES) {
  const points = landmarks(ICON_STATES[kind]).map(([x, y]) => [x * 100, y * 100]);
  const lines = HandLandmarker.HAND_CONNECTIONS.map(
    ({ start, end }) => `<line x1="${points[start][0]}" y1="${points[start][1]}" x2="${points[end][0]}" y2="${points[end][1]}"/>`,
  ).join("");
  const dots = points.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.4"/>`).join("");
  const [tx, ty] = points[THUMB[1]];
  const hints = {
    move: `<path d="M30 92 H70 M30 92 l5 -3.5 M30 92 l5 3.5 M70 92 l-5 -3.5 M70 92 l-5 3.5"/>`,
    tilt: `<path d="M28 30 A30 30 0 0 1 72 30 M72 30 l-6 -1 M72 30 l-1.5 -6"/>`,
    pinch: `<circle class="touch" cx="${tx}" cy="${ty}" r="4.5"/>`,
  };
  return `<svg class="hand-icon" viewBox="15 20 70 78" aria-hidden="true">
    <g class="bones">${lines}</g><g class="joints">${dots}</g><g class="hint">${hints[kind]}</g>
  </svg>`;
}

export function createHandDemo(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  let time = 0;

  const draw = (state: HandState) => {
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const points = landmarks(state).map(([x, y]) => [x * width, y * height] as Point);
    ctx.lineWidth = Math.max(1.5, width / 140);
    ctx.strokeStyle = "#7fdcffaa";
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(...points[start]);
      ctx.lineTo(...points[end]);
      ctx.stroke();
    }
    ctx.fillStyle = state.pinch > 0.8 ? "#ffcc33" : "#7fdcff";
    const r = Math.max(2, width / 90);
    for (const [x, y] of points) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#f3e9dc";
    ctx.font = `${Math.round(height / 11)}px "Geist Serif", Georgia, serif`; // as the slide text (presentation.css)
    ctx.fillText(state.label, width * 0.05, height * 0.12);
  };

  return {
    /** Advances the loop, redraws the hand and returns its state */
    update(dt: number) {
      time += dt;
      // Match the canvas resolution to its displayed size
      const w = Math.round(canvas.clientWidth * devicePixelRatio);
      const h = Math.round(canvas.clientHeight * devicePixelRatio);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const state = stateAt(time);
      draw(state);
      return state;
    },
  };
}
