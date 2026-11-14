import {
  BufferGeometry,
  CylinderGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SkeletonHelper,
  SphereGeometry,
  Vector3,
  type Object3D,
} from "@iwsdk/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadMarionette } from "../puppet/marionette";
import type { RigDescription } from "../puppet/rig";
import { createHandDemo, handIcon } from "./hand-demo";
import { lineIcon } from "./icons";
import { OBJECTS } from "./objects";
import { addView } from "./views";

// The three slides (English) and their 3D content.

export const REPO_URL = "https://github.com/GLAMhack26-theatre/puppetshow";

// Optional until the static QR code is committed (assets/presentation/qr-github.svg):
// without it, slide 3 shows only the URL
const qrCode = Object.values(
  import.meta.glob<string>("../../assets/presentation/qr-github.svg", { eager: true, query: "?url", import: "default" }),
)[0];

/** Colours of the control cross's bars (export/marionette_rig.json, controller.bars) */
const BAR_COLOURS: Record<string, number> = {
  CTRL_bar: 0xd4a73a, // main bar: head, shoulders, back
  CTRL_handbar: 0x4f8fd6,
  CTRL_legbar: 0x5fbf6a,
};

const html = (tag: string, className: string, content: string | Node[] = "") => {
  const el = document.createElement(tag);
  el.className = className;
  if (typeof content === "string") el.innerHTML = content;
  else el.append(...content);
  return el;
};

/** Small seeded random generator (mulberry32): the same "random" layout on every open */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spot { x: number; y: number; size: number; angle: number; z: number; featured: boolean }

/** Item centres stay this far (% of the area's height) from the top and bottom edge */
const EDGE_Y = 17;
const CENTER_CELL = 4;
/** The featured item (the marionette): size in % of the area's width, always on top */
const FEATURED_SIZE = 46;
/** Its centre, % of the area's height: a bit high, into the empty cell above it */
const FEATURED_Y = 42;

/**
 * A scattered layout that never piles up: a jittered grid. Item 0 is
 * featured: bigger, in the centre cell of a 3 × 3 grid. Every other item
 * gets one of the outer cells (spare cells stay empty), then a random
 * offset, size and angle inside it. x, y: the item's centre in % of the
 * area; size: % of its width (capped by its height in the CSS).
 */
function scatter(count: number, seed: number, sizes: [number, number], maxAngle: number, jitterRange = 0.12): Spot[] {
  const rnd = random(seed);
  // Fisher–Yates over the outer cells: which object lands where is random too
  const outer = Array.from({ length: 9 }, (_, i) => i).filter((c) => c !== CENTER_CELL);
  for (let i = outer.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [outer[i], outer[j]] = [outer[j], outer[i]];
  }
  // The tall featured item reaches into the cell above it: that cell stays
  // empty (its item moves to the spare cell), so nothing there is covered
  const used = outer.slice(0, count - 1);
  const above = used.indexOf(CENTER_CELL - 3);
  if (above >= 0 && outer.length > used.length) used[above] = outer[used.length];
  const cells = [CENTER_CELL, ...used];
  return cells.map((cell, i) => {
    const featured = i === 0;
    const randomSize = sizes[0] + rnd() * (sizes[1] - sizes[0]); // drawn for every item: same sequence on both sides
    const size = featured ? FEATURED_SIZE : randomSize;
    const cx = ((cell % 3) + 0.5) / 3;
    const cy = (Math.floor(cell / 3) + 0.5) / 3;
    const jitter = () => (rnd() - 0.5) * jitterRange;
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    return {
      // Centres kept inside, so no item sticks out of the area (the slide can't scroll)
      x: clamp((cx + jitter()) * 100, size / 2 + 1, 99 - size / 2),
      y: featured ? (jitter(), FEATURED_Y) : clamp((cy + jitter()) * 100, EDGE_Y, 100 - EDGE_Y), // jitter() drawn anyway: same sequence
      size,
      angle: (rnd() - 0.5) * 2 * maxAngle,
      z: featured ? 10 : Math.floor(rnd() * 10),
      featured,
    };
  });
}

/** Position and size go to CSS variables; the CSS centres the item and caps its size. */
const place = (el: HTMLElement, spot: Spot, rotate: boolean) => {
  el.style.left = `${spot.x}%`;
  el.style.top = `${spot.y}%`;
  el.style.setProperty("--size", String(spot.size));
  // 3D views are drawn into their screen rectangle (views.ts): never rotate them
  el.style.setProperty("--angle", `${rotate ? spot.angle : 0}deg`);
  el.style.zIndex = String(spot.z);
  el.classList.toggle("featured", spot.featured);
  return el;
};

/** Builds the slide DOM; `view` placeholders get their 3D content from load3D(). */
export function buildSlides() {
  const objectViews = OBJECTS.map(() => html("div", "view"));
  // Photos at most one cell wide (a third of the area) and only slightly
  // offset: scattered, but at most touching at their turned corners
  // The marionette (OBJECTS[0]) is featured in the centre, the others around it
  const photoSpots = scatter(OBJECTS.length, 7, [24, 28], 8, 0.06);
  // Same seed and offset: each model sits where its photo sits on the left
  const modelSpots = scatter(OBJECTS.length, 7, [24, 28], 0, 0.06);

  const collection = html("section", "slide", [
    html("h1", "", "From the SKKG collection"),
    html("div", "columns", [
      html("div", "scatter photos", OBJECTS.map((o, i) => place(html("figure", "print", [
        Object.assign(document.createElement("img"), { src: o.photo, alt: o.title, loading: "lazy" }),
      ]), photoSpots[i], true))),
      html("div", "scatter models", OBJECTS.map((o, i) => place(html("figure", "float", [
        objectViews[i],
      ]), modelSpots[i], false))),
    ]),
  ]);

  const marionetteView = html("div", "view large");
  // The synthetic MediaPipe hand (hand-demo.ts), bottom right of the puppet
  const handCanvas = Object.assign(document.createElement("canvas"), { className: "hand-demo" });
  marionetteView.append(handCanvas);
  const controls = html("section", "slide", [
    html("h1", "", "Playing the marionette"),
    html("div", "columns", [
      marionetteView,
      // For the audience: what you do and what the puppet does, nothing more
      html("div", "text", `
        <p class="lead">A 100-year-old puppet,<br>played by <b>hand tracking</b>.</p>
        <ul class="gestures">
          <li><span>${handIcon("move")}</span><div><b>Move your hand</b><small>the puppet follows</small></div></li>
          <li><span>${handIcon("tilt")}</span><div><b>Tilt your hand</b><small>it leans</small></div></li>
          <li><span>${handIcon("pinch")}</span><div><b>Pinch</b><small>it grabs</small></div></li>
        </ul>`),
    ]),
  ]);

  const outlook = html("section", "slide", [
    html("h1", "", "Some ideas for next steps"),
    // Ideas on the left, the QR code on the right, a faint rule between them
    html("div", "columns split", [
      html("div", "text", `
        <ul class="gestures">
          <li><span>${lineIcon("together")}</span><div><b>Play together</b></div></li>
          <li><span>${lineIcon("vr")}</span><div><b>Step inside</b></div></li>
          <li><span>${lineIcon("tasks")}</span><div><b>Playful tasks</b></div></li>
          <li><span>${lineIcon("stories")}</span><div><b>Tell stories</b></div></li>
          <li><span>${lineIcon("collection")}</span><div><b>Any collection on stage</b></div></li>
        </ul>`),
      html("div", "qr", [
        ...(qrCode ? [Object.assign(document.createElement("img"), { src: qrCode, alt: `QR code: ${REPO_URL}` })] : []),
        html("p", "url", REPO_URL.replace(/^https:\/\//, "")),
      ]),
    ]),
  ]);

  return { slides: [collection, controls, outlook], objectViews, marionetteView, handCanvas };
}

/** Loads all models (once) into the views. */
export async function load3D(objectViews: HTMLElement[], marionetteView: HTMLElement, handCanvas: HTMLCanvasElement) {
  const loader = new GLTFLoader();
  const marionette = loadMarionette();
  const rnd = random(41);
  await Promise.all(OBJECTS.map(async (o, i) => {
    // Each model turns at its own speed and direction, from its own start angle
    const spin = (0.18 + rnd() * 0.25) * (rnd() < 0.3 ? -1 : 1);
    const angle = rnd() * Math.PI * 2;
    try {
      const model = o.model ? (await loader.loadAsync(o.model)).scene : (await marionette).root;
      // The marionette (featured, tall and narrow): closer, so it fills its portrait frame
      addView(objectViews[i], model, { spin, angle, distance: o.model ? undefined : 1.95 });
    } catch (e) {
      console.warn(`Presentation: ${o.title} failed to load`, e);
      objectViews[i].classList.add("failed");
    }
  }));

  const { root, description } = await marionette;
  const puppet = clone(root); // the slide 1 instance stays where it is
  const demo = demoPuppet(puppet, description, createHandDemo(handCanvas));
  // No turning here: a fixed three-quarter view keeps the hand demo readable
  addView(marionetteView, demo.group, { spin: 0, angle: 0.35, overlay: [skeleton(puppet)], update: demo.update });
}

function skeleton(puppet: Object3D) {
  const helper = new SkeletonHelper(puppet);
  const material = helper.material as LineBasicMaterial;
  material.depthTest = false; // drawn over the mesh
  material.transparent = true;
  material.opacity = 0.8;
  helper.renderOrder = 1;
  return helper;
}

// Scripted puppet motion (no physics): the hand moves (MOVE, LIFT, in m) and
// tilts the cross; the puppet hangs from the cross's centre and swings after
// it like a damped pendulum
const MOVE = 0.08;
const LIFT = 0.05;
const GRAVITY = 9.81;
const DAMPING = 2.2; // 1/s
const LEAN = 0.35; // how far the puppet follows the cross's tilt

/**
 * The puppet with its 9 string sockets, the strings and the control cross,
 * coloured by bar, played by the demo hand.
 */
function demoPuppet(puppet: Object3D, description: RigDescription, hand: ReturnType<typeof createHandDemo>) {
  const colour = (bar: string) => BAR_COLOURS[bar] ?? 0xf3e9dc;
  const mainBar = description.controller.bars.find((b) => !b.parent);
  const center = mainBar?.pivot.clone() ?? description.strings[0].barPoint.clone();

  // group (moves with the hand) ⊃ cross (tilts around the centre)
  //                             ⊃ swing (the puppet, swinging around the centre)
  const group = new Group();
  const cross = new Group();
  const swing = new Group();
  cross.position.copy(center);
  swing.position.copy(center);
  const hanging = new Group();
  hanging.position.copy(center).negate();
  hanging.add(puppet);
  swing.add(hanging);
  group.add(cross, swing);

  const radius = description.controller.stickSize / 2;
  const up = new Vector3(0, 1, 0);
  for (const bar of description.controller.bars) {
    const material = new MeshBasicMaterial({ color: colour(bar.name) });
    for (const stick of bar.sticks) {
      const direction = stick.b.clone().sub(stick.a);
      const mesh = new Mesh(new CylinderGeometry(radius, radius, direction.length(), 8), material);
      mesh.position.copy(stick.a).add(stick.b).multiplyScalar(0.5).sub(center);
      mesh.quaternion.copy(new Quaternion().setFromUnitVectors(up, direction.normalize()));
      cross.add(mesh);
    }
  }

  // Sockets swing with the puppet; the strings are redrawn every frame from
  // the cross's eye to the socket
  const strings = description.strings.map((s) => {
    const socket = new Mesh(new SphereGeometry(0.005, 12, 8), new MeshBasicMaterial({ color: colour(s.bar), depthTest: false }));
    socket.position.copy(s.position);
    socket.renderOrder = 2;
    hanging.add(socket);
    const line = new Line(
      new BufferGeometry().setFromPoints([s.barPoint, s.position]),
      new LineBasicMaterial({ color: colour(s.bar), transparent: true, opacity: 0.7 }),
    );
    group.add(line);
    return { s, line, top: s.barPoint.clone().sub(center), bottom: s.position.clone().sub(center) };
  });

  const length = center.y - (description.bones.find((b) => b.name === "pelvis")?.head.y ?? 0); // pendulum length
  let angle = 0;
  let velocity = 0;
  let lastX = 0;
  let lastSpeed = 0;
  const p = new Vector3();

  const update = (dt: number) => {
    const state = hand.update(dt);
    const x = state.x * MOVE;
    group.position.set(x, state.y * LIFT, 0);
    cross.rotation.z = -state.roll; // mirrored like the app's MediaPipe mapping

    // Pendulum, driven by the cross's sideways acceleration (a few substeps
    // keep it stable when a frame takes long)
    const speed = dt > 0 ? (x - lastX) / dt : 0;
    const acceleration = dt > 0 ? (speed - lastSpeed) / dt : 0;
    lastX = x;
    lastSpeed = speed;
    const rest = cross.rotation.z * LEAN;
    for (let i = 0, h = dt / 4; i < 4; i++) {
      const a = -(GRAVITY / length) * Math.sin(angle - rest) - DAMPING * velocity - (acceleration / length) * Math.cos(angle);
      velocity += a * h;
      angle += velocity * h;
    }
    swing.rotation.z = angle;

    for (const { line, top, bottom } of strings) {
      const position = line.geometry.getAttribute("position");
      p.copy(top).applyAxisAngle(Z, cross.rotation.z).add(center);
      position.setXYZ(0, p.x, p.y, p.z);
      p.copy(bottom).applyAxisAngle(Z, angle).add(center);
      position.setXYZ(1, p.x, p.y, p.z);
      position.needsUpdate = true;
    }
  };
  return { group, update };
}

const Z = new Vector3(0, 0, 1);
