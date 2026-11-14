import {
  CanvasTexture,
  MathUtils,
  type Material,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  createSystem,
  type World,
} from "@iwsdk/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import froschkoenigUrl from "../../assets/stage_parts/Sign_Froschkoenig.glb?url";
import haenselUrl from "../../assets/stage_parts/Sign_Haensel.glb?url";
import improUrl from "../../assets/stage_parts/Sign_Impro.glb?url";
import { listPlays, loadPlay, type Play as PlayFile } from "../plays/plays";
import { curtainLift, isMainCurtainDown, raiseMainCurtain } from "./main-curtain";
import "./signs.css";

// Hanging signs in front of the main curtain: the plays to choose from.
// Shortly after start they drop in one after another, overshoot a little and
// settle, swinging gently. Hover makes a sign slightly bigger; a click on one
// raises the curtain, and the signs go up with it.
//
// The first row is always the three painted signs (Hänsel, Froschkönig,
// Impro). Every further play in assets/plays/ (made with the director bar)
// gets a sign painted at runtime with its name; they hang three to a row, and
// a golden "mehr" arrow under the signs pulls the next row down ("zurück"
// the previous one). The list is read anew each time the choice is shown.
//
// Like the curtain they live in camera space, so the row fits every aspect
// ratio (phone portrait included). Each sign casts a soft fake shadow on the
// curtain: the curtain is unlit and drawn over the scene, so real shadow
// maps would mean an extra light and shadow pass just for this.

/** The painted signs of the first row, left to right, and the play behind each. */
const FIXED = [
  { url: haenselUrl, play: "haensel" },
  { url: froschkoenigUrl, play: "froschkoenig" },
  { url: improUrl, play: "impro" },
];
/** The plays of the painted signs; every other play gets a sign of its own. */
export const PLAYS = FIXED.map((f) => f.play);
/** A play id: one of PLAYS or the file name of a play in assets/plays/. */
export type Play = string;

/** Signs per row (one row on screen at a time). */
const PER_ROW = 3;

/**
 * Hand-hung, not lined up: per place in the row an offset (x, y in sign
 * widths), a rest tilt (radians, ~3–5°) and a size factor. Fixed values, so
 * a row always looks the same.
 */
const MESS = [
  { x: 0.03, y: 0.06, tilt: 0.07, scale: 1.0 },
  { x: 0.0, y: -0.04, tilt: -0.035, scale: 1.05 },
  { x: -0.03, y: 0.09, tilt: 0.055, scale: 0.96 },
];

/** Just in front of the curtain (main-curtain.ts uses 0.05). */
const DISTANCE = 0.045;
/** The shadows lie between the curtain and the signs. */
const SHADOW_DISTANCE = 0.048;
/** Shadow offset (in sign widths) from a light above left; grows on hover as the sign comes forward. */
const SHADOW_OFFSET = new Vector2(0.035, -0.045);
const SHADOW_OPACITY = 0.45;
const SHADOW_BLUR = 0.012; // uv radius of the soft edge

const FIRST_DELAY = 2; // s after start
/** Delay before a row drops in after a return to the choice or a "mehr" click, s. */
const AGAIN_DELAY = 0.35;
const STAGGER = 0.25; // s between the signs
const DROP_SECONDS = 0.9;
/** A row making room for the next one goes up in this time, s. */
const LEAVE_SECONDS = 0.45;
const OVERSHOOT = 1.2; // easeOutBack strength; 1.70158 is the classic value
const HOVER_SCALE = 1.08;
/** Sign quad width: at most this share of the screen height … */
const MAX_WIDTH_OF_HEIGHT = 0.47;
/** … and small enough that the row keeps this margin to the screen edges (share of the width). */
const SIDE_MARGIN = 0.03;
/** Half the visible sign width in quad widths (transparent margins), with room for MESS and hover. */
const HALF_SIGN = 0.5;
/** Distance between sign centres, in sign widths. */
const STEP = 1.1;
const ROW_Y = 0.04; // centre of the row, in screen heights above the middle
/** A pointer that moved further than this between down and up was a drag (orbit), not a click. */
const CLICK_SLOP_PX = 6;

interface Sign {
  mesh: Mesh;
  shadow: Mesh;
  hover: number; // 0 … 1, smoothed
  play: Play;
  row: number;
  /** Place in its row, 0 … PER_ROW − 1 */
  slot: number;
  /** Painted at runtime: disposed when the list of plays is read again */
  painted: boolean;
}

const signs: Sign[] = [];
let clock = 0;
let hovered: Sign | null = null;
let chosen: Play | null = null;
const chooseListeners: ((play: Play) => void)[] = [];
/** The row on screen, and the clock time it starts to drop in */
let row = 0;
let rowStart = FIRST_DELAY;
/** The row going up to make room, and since when */
let leaving: { row: number; at: number } | null = null;
let world: World | null = null;
let arrows: { root: HTMLElement; back: HTMLButtonElement; more: HTMLButtonElement } | null = null;

const FACE_CAMERA = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI); // the quads face −z
const Z_AXIS = new Vector3(0, 0, 1);
const tmpPos = new Vector3();
const tmpQuat = new Quaternion();
const swing = new Quaternion();

export async function loadSigns(w: World) {
  world = w;
  const loader = new GLTFLoader();
  const meshes = new Map<string, { mesh: Mesh; shadow: MeshBasicMaterial }>();
  for (const { url } of FIXED) {
    const gltf = await loader.loadAsync(url);
    let mesh: Mesh | undefined;
    gltf.scene.traverse((o) => {
      if (o instanceof Mesh) mesh = o;
    });
    if (!mesh) throw new Error(`${url} has no mesh`);
    // Drawn over everything, after the curtain and the shadows. Transparent
    // (alpha test stays) only so it is sorted with the shadows: three.js
    // draws all opaque objects before all transparent ones, whatever the
    // renderOrder, which put the shadows on top of the signs.
    const material = mesh.material as Material & { map: Texture | null };
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    mesh.removeFromParent();
    meshes.set(url, { mesh, shadow: shadowMaterial(material.map) });
  }
  FIXED.forEach(({ url, play }, i) => {
    const source = meshes.get(url)!;
    addSign(source.mesh.clone(), source.shadow, play, i, false); // shares geometry and material
  });
  arrows = createArrows();
  void readPlays();

  const canvas = w.renderer.domElement;
  const ray = new Raycaster();
  const pick = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1),
      w.camera,
    );
    const hit = ray.intersectObjects(signs.filter((s) => s.row === row && s.mesh.visible).map((s) => s.mesh))[0];
    return hit ? signs.find((s) => s.mesh === hit.object)! : null;
  };

  canvas.addEventListener("pointermove", (e) => {
    hovered = isMainCurtainDown() ? pick(e) : null;
    canvas.style.cursor = hovered ? "pointer" : "";
  });
  const down = new Vector2();
  canvas.addEventListener("pointerdown", (e) => down.set(e.clientX, e.clientY));
  canvas.addEventListener("pointerup", (e) => {
    if (!isMainCurtainDown() || chosen || down.distanceTo(new Vector2(e.clientX, e.clientY)) > CLICK_SLOP_PX) return;
    const sign = pick(e);
    if (!sign) return;
    chosen = sign.play;
    hovered = null;
    canvas.style.cursor = "";
    raiseMainCurtain();
    for (const listener of chooseListeners) listener(sign.play);
  });
}

/** The clicked sign's play, or null before a choice. */
export function chosenPlay() {
  return chosen;
}

/** Called once a sign is clicked, as the curtain starts to go up. */
export function onPlayChosen(listener: (play: Play) => void) {
  chooseListeners.push(listener);
}

/**
 * Shows the choice again (the curtain is down again, play-menu.ts): the
 * first row drops in, with the plays read anew from assets/plays/.
 */
export function showSigns() {
  chosen = null;
  row = 0;
  leaving = null;
  rowStart = clock + AGAIN_DELAY;
  void readPlays();
}

function addSign(mesh: Mesh, shadowMat: MeshBasicMaterial, play: Play, index: number, painted: boolean) {
  const slot = index % PER_ROW;
  mesh.renderOrder = 1010 + slot;
  const shadow = new Mesh(mesh.geometry, shadowMat);
  shadow.renderOrder = 1001 + slot;
  for (const m of [mesh, shadow]) {
    m.frustumCulled = false;
    m.visible = false;
    world!.scene.add(m);
  }
  signs.push({ mesh, shadow, hover: 0, play, row: Math.floor(index / PER_ROW), slot, painted });
}

/** Paints a sign for every play beyond the three painted ones (again on each call). */
async function readPlays() {
  const ids = (await listPlays()).filter((id) => !PLAYS.includes(id));
  const plays = (await Promise.all(ids.map((id) => loadPlay(id).catch(() => null)))).filter((p): p is PlayFile => !!p);
  plays.sort((a, b) => a.name.localeCompare(b.name, "de"));
  await document.fonts.load(`${FONT_WEIGHT} 100px ${FONT}`).catch(() => {});

  for (const sign of signs.filter((s) => s.painted)) {
    sign.mesh.removeFromParent();
    sign.shadow.removeFromParent();
    const material = sign.mesh.material as MeshBasicMaterial;
    material.map?.dispose();
    material.dispose();
    (sign.shadow.material as Material).dispose();
    sign.mesh.geometry.dispose();
    signs.splice(signs.indexOf(sign), 1);
  }
  plays.forEach((play, i) => {
    const map = paintSign(play.name, play.scenes.length);
    const material = new MeshBasicMaterial({ map, transparent: true, alphaTest: 0.5, depthTest: false, depthWrite: false });
    // A plane faces +z; the painted signs (glTF quads) face −z, and place() turns them to the camera
    const mesh = new Mesh(new PlaneGeometry(1, 1).rotateY(Math.PI), material);
    addSign(mesh, shadowMaterial(map), play.id, FIXED.length + i, true);
  });
  if (row > lastRow()) row = 0;
}

const lastRow = () => Math.max(0, ...signs.map((s) => s.row));

// ---- Painted signs -----------------------------------------------------

const FONT = '"Geist", "Arial Narrow", sans-serif';
const FONT_WEIGHT = 800;
const TEXTURE = 512;

/**
 * A sign like the painted ones: a cardboard board with a wooden top lath,
 * hung on a string, the name in black capitals as if painted by hand, and
 * "in N Szenen" below (like "Froschkönig in 3 Akten").
 */
function paintSign(name: string, scenes: number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TEXTURE;
  const g = canvas.getContext("2d")!;
  // A fixed seed per name: the same play always looks the same
  let seed = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  const left = 34, right = TEXTURE - 34, top = 150, bottom = 440;

  // The string, from the lath's ends to a nail above
  g.strokeStyle = "#e7dccb";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(left + 120, top + 2);
  g.quadraticCurveTo(TEXTURE / 2 - 30, 58, TEXTURE / 2, 46);
  g.quadraticCurveTo(TEXTURE / 2 + 30, 58, right - 120, top + 2);
  g.stroke();

  // Cardboard: warm beige, slightly darker towards the edges, with fibres
  const board = g.createLinearGradient(0, top, 0, bottom);
  board.addColorStop(0, "#e2cfae");
  board.addColorStop(1, "#d6bf98");
  g.fillStyle = board;
  g.fillRect(left, top, right - left, bottom - top);
  const vignette = g.createRadialGradient(TEXTURE / 2, (top + bottom) / 2, 60, TEXTURE / 2, (top + bottom) / 2, 300);
  vignette.addColorStop(0, "#0000");
  vignette.addColorStop(1, "#5a3a1830");
  g.fillStyle = vignette;
  g.fillRect(left, top, right - left, bottom - top);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = random() < 0.5 ? "#ffffff14" : "#6b4a2414";
    g.fillRect(left + random() * (right - left), top + random() * (bottom - top), 1 + random() * 3, 1);
  }
  g.strokeStyle = "#a8875a";
  g.lineWidth = 2;
  g.strokeRect(left + 1, top + 1, right - left - 2, bottom - top - 2);
  // Nail holes along the bottom edge
  g.fillStyle = "#5a4630";
  for (let x = left + 22; x < right - 10; x += 48) {
    g.beginPath();
    g.arc(x, bottom - 9, 2.2, 0, Math.PI * 2);
    g.fill();
  }

  // The wooden lath on top
  const lath = g.createLinearGradient(0, top - 14, 0, top + 10);
  lath.addColorStop(0, "#e8c48a");
  lath.addColorStop(1, "#b98a4e");
  g.fillStyle = lath;
  g.fillRect(left - 6, top - 14, right - left + 12, 24);
  g.strokeStyle = "#8a6334";
  g.strokeRect(left - 6, top - 14, right - left + 12, 24);

  // The name: capitals, as large as fit in up to three lines
  const words = name.toUpperCase().split(/\s+/).filter(Boolean);
  const subtitle = scenes > 0 ? `in ${scenes} ${scenes === 1 ? "Szene" : "Szenen"}` : "";
  const width = right - left - 50;
  const textTop = top + 30;
  const textBottom = bottom - 28 - (subtitle ? 58 : 0);
  let size = 92;
  let lines: string[] = [];
  for (; size > 26; size -= 4) {
    g.font = `${FONT_WEIGHT} ${size}px ${FONT}`;
    lines = wrap(g, words, width, size * 0.12);
    if (lines.length * size * 1.08 <= textBottom - textTop && lines.every((l) => spaced(g, l, size * 0.12) <= width)) break;
  }
  g.fillStyle = "#26231f";
  g.textBaseline = "middle";
  const lineHeight = size * 1.08;
  const blockTop = (textTop + textBottom) / 2 - (lines.length * lineHeight) / 2;
  lines.forEach((line, i) => paintLine(g, line, TEXTURE / 2, blockTop + (i + 0.5) * lineHeight, size, random));
  if (subtitle) {
    g.font = `${FONT_WEIGHT} ${Math.min(52, size * 0.75)}px ${FONT}`;
    paintLine(g, subtitle, TEXTURE / 2, bottom - 58, Math.min(52, size * 0.75), random);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Width of a line with extra letter spacing. */
function spaced(g: CanvasRenderingContext2D, text: string, spacing: number) {
  return g.measureText(text).width + spacing * (text.length - 1);
}

/** Words into lines that fit `width`; a word too long for a line stays whole (the size loop shrinks it). */
function wrap(g: CanvasRenderingContext2D, words: string[], width: number, spacing: number) {
  const lines: string[] = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last && spaced(g, `${last} ${word}`, spacing) <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/** One line, centred, letter by letter with a little wobble in size, height and tilt: painted by hand. */
function paintLine(g: CanvasRenderingContext2D, text: string, cx: number, cy: number, size: number, random: () => number) {
  const spacing = size * 0.12;
  let x = cx - spaced(g, text, spacing) / 2;
  for (const letter of text) {
    const w = g.measureText(letter).width;
    g.save();
    g.translate(x + w / 2, cy + (random() - 0.5) * size * 0.08);
    g.rotate((random() - 0.5) * 0.09);
    g.scale(1 + (random() - 0.5) * 0.06, 1 + (random() - 0.5) * 0.08);
    g.fillText(letter, -w / 2, 0);
    g.restore();
    x += w + spacing;
  }
}

// ---- Arrows ------------------------------------------------------------

/** "zurück" and "mehr" under the row: golden arrows, shown when there is another row. */
function createArrows() {
  const root = document.createElement("nav");
  root.className = "sign-arrows";
  root.setAttribute("aria-label", "Weitere Stücke");
  const make = (text: string, className: string, label: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `sign-arrow ${className}`;
    button.setAttribute("aria-label", label);
    const arrow = document.createElement("span");
    arrow.className = "sign-arrow-head";
    arrow.setAttribute("aria-hidden", "true");
    const caption = document.createElement("span");
    caption.className = "sign-arrow-text";
    caption.textContent = text;
    button.append(arrow, caption);
    root.append(button);
    return button;
  };
  const back = make("zurück", "back", "Vorherige Stücke");
  const more = make("mehr", "more", "Weitere Stücke");
  back.addEventListener("click", () => turn(row - 1));
  more.addEventListener("click", () => turn(row + 1));
  document.body.append(root);
  return { root, back, more };
}

/** The current row goes up, the other one drops in. */
function turn(to: number) {
  if (chosen || to < 0 || to > lastRow() || to === row) return;
  leaving = { row, at: clock };
  row = to;
  rowStart = clock + AGAIN_DELAY;
  hovered = null;
}

function updateArrows() {
  if (!arrows) return;
  // Once the row has dropped in, and only while the curtain is down and nothing is chosen
  const settled = clock > rowStart + (PER_ROW - 1) * STAGGER + DROP_SECONDS * 0.6;
  const shown = settled && !chosen && curtainLift() <= 0;
  arrows.root.classList.toggle("shown", shown);
  arrows.back.hidden = row <= 0;
  arrows.more.hidden = row >= lastRow();
  arrows.root.inert = !shown;
}

// ---- Layout ------------------------------------------------------------

// Shadow of the sign: its silhouette (texture alpha, string included) in
// black with a soft edge: a small 9-tap blur of the alpha instead of the hard
// alpha mask.
function shadowMaterial(map: Texture | null) {
  const material = new MeshBasicMaterial({
    map,
    color: 0x000000,
    transparent: true,
    opacity: SHADOW_OPACITY,
    depthTest: false,
    depthWrite: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      /* glsl */ `
      float shadowAlpha = 0.0;
      for (int ix = -1; ix <= 1; ix++) {
        for (int iy = -1; iy <= 1; iy++) {
          shadowAlpha += texture2D(map, vMapUv + vec2(float(ix), float(iy)) * ${SHADOW_BLUR.toFixed(4)}).a;
        }
      }
      diffuseColor.a *= shadowAlpha / 9.0;
      `,
    );
  };
  return material;
}

// Overshoots past 1 and comes back: the sign drops a little below its
// place and bounces back up
function easeOutBack(t: number) {
  const c3 = OVERSHOOT + 1;
  return 1 + c3 * (t - 1) ** 3 + OVERSHOOT * (t - 1) ** 2;
}

/** Places a quad at (x, y) on a camera-facing plane `distance` in front of the camera. */
function put(mesh: Mesh, x: number, y: number, distance: number, angle: number, scale: number) {
  mesh.position.copy(new Vector3(x, y, -distance).applyQuaternion(tmpQuat).add(tmpPos));
  mesh.quaternion.copy(tmpQuat).multiply(FACE_CAMERA).multiply(swing.setFromAxisAngle(Z_AXIS, angle));
  mesh.scale.setScalar(scale);
}

function place(w: World, delta: number) {
  const camera = w.camera;
  // Layout in units of the sign plane; the shadow plane is scaled by `far`
  // so a shadow looks the same size as its sign
  const viewH = 2 * DISTANCE * Math.tan(MathUtils.degToRad(camera.fov) / 2);
  const viewW = viewH * camera.aspect;
  // Narrow screens (4:3, phone portrait): shrink so the row fits the width
  const rowHalf = ((PER_ROW - 1) / 2) * STEP + HALF_SIGN; // in sign widths
  const size = Math.min(viewH * MAX_WIDTH_OF_HEIGHT, (viewW * (0.5 - SIDE_MARGIN)) / rowHalf);
  const far = SHADOW_DISTANCE / DISTANCE;
  // Raised with the curtain, by the same share of the screen height
  const lift = curtainLift() * viewH;
  const startY = viewH / 2 + size; // fully above the screen

  camera.getWorldQuaternion(tmpQuat);
  camera.getWorldPosition(tmpPos);

  for (const sign of signs) {
    const i = sign.slot;
    const mess = MESS[i % MESS.length];
    const targetY = ROW_Y * viewH + mess.y * size;
    let age: number;
    let y: number;
    if (sign.row === row) {
      age = clock - rowStart - i * STAGGER;
      const t = Math.min(1, age / DROP_SECONDS);
      y = MathUtils.lerp(startY, targetY, easeOutBack(t));
    } else if (leaving && sign.row === leaving.row) {
      // Pulled up on its string, slowly at first
      const t = (clock - leaving.at - i * 0.06) / LEAVE_SECONDS;
      age = t >= 1 ? -1 : clock - leaving.at + 10; // the swing has died down
      y = MathUtils.lerp(targetY, startY, Math.max(0, t) ** 2);
    } else age = -1;

    // A chosen sign goes up with the curtain, but does not come down with it
    // on the way back to the choice (showSigns() drops the row in afresh)
    const visible = age >= 0 && curtainLift() < 1 && !(chosen && isMainCurtainDown());
    sign.mesh.visible = sign.shadow.visible = visible;
    if (!visible) continue;
    y! += lift;
    // A row that is not full hangs centred
    const inRow = signs.filter((o) => o.row === sign.row).length;
    const x = (i - (inRow - 1) / 2) * STEP * size + mess.x * size;

    sign.hover = MathUtils.damp(sign.hover, sign === hovered ? 1 : 0, 14, delta);
    const scale = size * mess.scale * MathUtils.lerp(1, HOVER_SCALE, sign.hover);

    // Hanging on its string: a small swing around the rest tilt that dies
    // down after the drop
    const angle = mess.tilt + 0.07 * Math.sin(age * 5.5 + i) * Math.exp(-age * 1.6);

    put(sign.mesh, x, y!, DISTANCE, angle, scale);
    const offset = 1 + 0.6 * sign.hover;
    put(
      sign.shadow,
      (x + SHADOW_OFFSET.x * size * offset) * far,
      (y! + SHADOW_OFFSET.y * size * offset) * far,
      SHADOW_DISTANCE,
      angle,
      scale * far,
    );
  }
}

export class SignSystem extends createSystem({}) {
  update(delta: number) {
    // Keep running until place() has hidden the signs after the curtain went up
    if (signs.length === 0 || (curtainLift() >= 1 && !signs.some((s) => s.mesh.visible))) {
      arrows?.root.classList.remove("shown");
      return;
    }
    clock += delta;
    place(this.world, delta);
    updateArrows();
  }
}
