import {
  MathUtils,
  type Material,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
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
import { curtainLift, isMainCurtainDown, raiseMainCurtain } from "./main-curtain";

// Three hanging signs in front of the main curtain (the plays to choose
// from). Shortly after start they drop in one after another, overshoot a
// little and settle, swinging gently. Hover makes a sign slightly bigger; a
// click on one raises the curtain, and the signs go up with it.
//
// Like the curtain they live in camera space, so the row fits every aspect
// ratio (phone portrait included). Each sign casts a soft fake shadow on the
// curtain: the curtain is unlit and drawn over the scene, so real shadow
// maps would mean an extra light and shadow pass just for this.

/** One file per sign, left to right; chosenSign() is the index into this list. */
const SIGN_URLS = [haenselUrl, froschkoenigUrl, improUrl];
/** The play behind each sign, same order as SIGN_URLS. */
export const PLAYS = ["haensel", "froschkoenig", "impro"] as const;
export type Play = (typeof PLAYS)[number];

/**
 * Hand-hung, not lined up: per sign an offset (x, y in sign widths), a rest
 * tilt (radians, ~3–5°) and a size factor. Fixed values, so the row always
 * looks the same.
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
const STAGGER = 0.25; // s between the signs
const DROP_SECONDS = 0.9;
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
}

const signs: Sign[] = [];
let clock = 0;
let hovered: Sign | null = null;
let chosen = -1;
const chooseListeners: ((play: Play) => void)[] = [];

const FACE_CAMERA = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI); // the quads face −z
const Z_AXIS = new Vector3(0, 0, 1);
const tmpPos = new Vector3();
const tmpQuat = new Quaternion();
const swing = new Quaternion();

export async function loadSigns(world: World) {
  const loader = new GLTFLoader();
  const meshes = new Map<string, { mesh: Mesh; shadow: MeshBasicMaterial }>();
  for (const url of new Set(SIGN_URLS)) {
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

  SIGN_URLS.forEach((url, i) => {
    const source = meshes.get(url)!;
    const mesh = source.mesh.clone(); // shares geometry and material
    mesh.renderOrder = 1010 + i;
    const shadow = new Mesh(mesh.geometry, source.shadow);
    shadow.renderOrder = 1001 + i;
    for (const m of [mesh, shadow]) {
      m.frustumCulled = false;
      m.visible = false;
      world.scene.add(m);
    }
    signs.push({ mesh, shadow, hover: 0 });
  });

  const canvas = world.renderer.domElement;
  const ray = new Raycaster();
  const pick = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1),
      world.camera,
    );
    const hit = ray.intersectObjects(signs.filter((s) => s.mesh.visible).map((s) => s.mesh))[0];
    return hit ? signs.find((s) => s.mesh === hit.object)! : null;
  };

  canvas.addEventListener("pointermove", (e) => {
    hovered = isMainCurtainDown() ? pick(e) : null;
    canvas.style.cursor = hovered ? "pointer" : "";
  });
  const down = new Vector2();
  canvas.addEventListener("pointerdown", (e) => down.set(e.clientX, e.clientY));
  canvas.addEventListener("pointerup", (e) => {
    if (!isMainCurtainDown() || down.distanceTo(new Vector2(e.clientX, e.clientY)) > CLICK_SLOP_PX) return;
    const sign = pick(e);
    if (!sign) return;
    chosen = signs.indexOf(sign);
    hovered = null;
    canvas.style.cursor = "";
    raiseMainCurtain();
    for (const listener of chooseListeners) listener(PLAYS[chosen]);
  });
}

/** Index of the clicked sign, or −1 before a choice. */
export function chosenSign() {
  return chosen;
}

/** Called once a sign is clicked, as the curtain starts to go up. */
export function onPlayChosen(listener: (play: Play) => void) {
  chooseListeners.push(listener);
}

// The sign's silhouette (texture alpha, string included) in black with a
// soft edge: a small 9-tap blur of the alpha instead of the hard alpha mask.
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

function place(world: World, delta: number) {
  const camera = world.camera;
  // Layout in units of the sign plane; the shadow plane is scaled by `far`
  // so a shadow looks the same size as its sign
  const viewH = 2 * DISTANCE * Math.tan(MathUtils.degToRad(camera.fov) / 2);
  const viewW = viewH * camera.aspect;
  // Narrow screens (4:3, phone portrait): shrink so the row fits the width
  const rowHalf = ((signs.length - 1) / 2) * STEP + HALF_SIGN; // in sign widths
  const size = Math.min(viewH * MAX_WIDTH_OF_HEIGHT, (viewW * (0.5 - SIDE_MARGIN)) / rowHalf);
  const far = SHADOW_DISTANCE / DISTANCE;
  // Raised with the curtain, by the same share of the screen height
  const lift = curtainLift() * viewH;

  camera.getWorldQuaternion(tmpQuat);
  camera.getWorldPosition(tmpPos);

  signs.forEach((sign, i) => {
    const age = clock - FIRST_DELAY - i * STAGGER;
    const visible = age >= 0 && curtainLift() < 1;
    sign.mesh.visible = sign.shadow.visible = visible;
    if (!visible) return;

    const mess = MESS[i % MESS.length];
    const t = Math.min(1, age / DROP_SECONDS);
    const targetY = ROW_Y * viewH + mess.y * size;
    const startY = viewH / 2 + size; // fully above the screen
    const y = MathUtils.lerp(startY, targetY, easeOutBack(t)) + lift;
    const x = (i - (signs.length - 1) / 2) * STEP * size + mess.x * size;

    sign.hover = MathUtils.damp(sign.hover, sign === hovered ? 1 : 0, 14, delta);
    const scale = size * mess.scale * MathUtils.lerp(1, HOVER_SCALE, sign.hover);

    // Hanging on its string: a small swing around the rest tilt that dies
    // down after the drop
    const angle = mess.tilt + 0.07 * Math.sin(age * 5.5 + i) * Math.exp(-age * 1.6);

    put(sign.mesh, x, y, DISTANCE, angle, scale);
    const offset = 1 + 0.6 * sign.hover;
    put(
      sign.shadow,
      (x + SHADOW_OFFSET.x * size * offset) * far,
      (y + SHADOW_OFFSET.y * size * offset) * far,
      SHADOW_DISTANCE,
      angle,
      scale * far,
    );
  });
}

export class SignSystem extends createSystem({}) {
  update(delta: number) {
    // Keep running until place() has hidden the signs after the curtain went up
    if (signs.length === 0 || (curtainLift() >= 1 && !signs.some((s) => s.mesh.visible))) return;
    clock += delta;
    place(this.world, delta);
  }
}
