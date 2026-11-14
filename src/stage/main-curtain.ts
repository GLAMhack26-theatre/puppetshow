import {
  MathUtils,
  type Material,
  Mesh,
  Quaternion,
  Vector3,
  createSystem,
  type World,
} from "@iwsdk/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import curtainUrl from "../../assets/stage_parts/Main_Curtain.glb?url";

// The main curtain from assets/stage_parts/Main_Curtain.glb: a 1×1 quad
// with a painted curtain. At start it hangs right in front of the camera
// and covers the whole screen; a click on one of the signs in front of it
// (signs.ts) raises it out of view.
//
// It follows the camera every frame (instead of being placed in the stage),
// so it covers the screen at every aspect ratio, also on phones in portrait
// and while the orbit camera moves.

/** Distance in front of the camera (near plane is 0.02). */
const DISTANCE = 0.05;
/**
 * The cloth band of the 1024×1024 texture, as fractions of the height from
 * the top: above it is transparent, below CLOTH_BOTTOM the wavy hem starts.
 * Only this band is used to cover the screen.
 */
const CLOTH_TOP = 376 / 1024;
const CLOTH_BOTTOM = 985 / 1024;
/** A bit larger than the screen, so no edge shows through rounding. */
const OVERSCAN = 1.03;
const RAISE_SECONDS = 1.6;

const curtain = {
  mesh: null as Mesh | null,
  raise: 0, // 0 down … 1 out of view
  raising: false,
  lift: 0, // see curtainLift()
};

const FACE_CAMERA = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI); // the quad faces −z
const tmpPos = new Vector3();
const tmpQuat = new Quaternion();

export async function loadMainCurtain(world: World) {
  const gltf = await new GLTFLoader().loadAsync(curtainUrl);
  let mesh: Mesh | undefined;
  gltf.scene.traverse((o) => {
    if (o instanceof Mesh) mesh = o;
  });
  if (!mesh) throw new Error("Main_Curtain.glb has no mesh");

  // Detached from the file's node (and its scale): placed in camera space
  // by MainCurtainSystem. Drawn last and over everything, so the stage
  // never pokes through it; kept unlit, like a painted backdrop.
  mesh.removeFromParent();
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
  const material = mesh.material as Material;
  // three.js draws all opaque objects before all transparent ones, whatever
  // the renderOrder: as an opaque mesh the curtain would be covered by any
  // transparent part of the scene (the fading ground, backdrops). In the
  // transparent pass its renderOrder puts it last.
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  addWobble(material);
  world.scene.add(mesh);
  curtain.mesh = mesh;
  place(world);
}

const wobbleTime = { value: 0 };

// Gentle cloth movement. The quad has only 4 vertices, so instead of
// displacing geometry the texture lookup sways sideways: not at all at the
// top (where the cloth hangs), more towards the hem. A faint light ripple
// across the folds sells it as moving fabric. The sway stays well inside the
// OVERSCAN margin, so no edge shows.
function addWobble(material: Material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wobbleTime;
    shader.fragmentShader = `uniform float uTime;\n${shader.fragmentShader}`.replace(
      "#include <map_fragment>",
      /* glsl */ `
      // glTF uv: v = 0 is the top of the image
      float hang = smoothstep(${CLOTH_TOP.toFixed(4)}, 1.0, vMapUv.y);
      float sway = 0.6 * sin(uTime * 1.1 + vMapUv.y * 5.0)
                 + 0.4 * sin(uTime * 1.9 + vMapUv.x * 8.0 + vMapUv.y * 3.0);
      vec2 wobbleUv = vMapUv + vec2(sway * 0.006 * hang, 0.0);
      diffuseColor *= texture2D(map, wobbleUv);
      diffuseColor.rgb *= 1.0 + 0.05 * hang * sin(uTime * 1.5 + vMapUv.x * 22.0 - vMapUv.y * 4.0);
      `,
    );
  };
}

export function raiseMainCurtain() {
  curtain.raising = true;
}

export function isMainCurtainDown() {
  return !curtain.raising;
}

/**
 * How far the curtain has moved up, in screen heights (0 down); 1 once it
 * is out of view. Things in front of it (signs.ts) rise with it.
 */
export function curtainLift() {
  return curtain.raise >= 1 ? 1 : curtain.lift;
}

// Size and position in camera space: the cloth band covers the view
// ("cover", cropping the sides on narrow screens); raising moves it up
// until its hem is above the top edge of the screen.
function place(world: World) {
  const mesh = curtain.mesh;
  if (!mesh) return;
  const camera = world.camera;
  const viewH = 2 * DISTANCE * Math.tan(MathUtils.degToRad(camera.fov) / 2);
  const viewW = viewH * camera.aspect;
  const size = OVERSCAN * Math.max(viewW, viewH / (CLOTH_BOTTOM - CLOTH_TOP));

  // Quad centre so that the middle of the cloth band sits on the screen centre
  const downY = -(0.5 - (CLOTH_TOP + CLOTH_BOTTOM) / 2) * size;
  const upY = viewH / 2 + size / 2; // quad bottom at the top of the screen
  const t = curtain.raise;
  const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; // ease in-out cubic
  const y = MathUtils.lerp(downY, upY, eased);
  curtain.lift = (y - downY) / viewH;

  camera.getWorldQuaternion(tmpQuat);
  camera.getWorldPosition(tmpPos);
  mesh.position.copy(new Vector3(0, y, -DISTANCE).applyQuaternion(tmpQuat).add(tmpPos));
  mesh.quaternion.copy(tmpQuat).multiply(FACE_CAMERA);
  mesh.scale.setScalar(size);
  mesh.visible = t < 1;
}

export class MainCurtainSystem extends createSystem({}) {
  update(delta: number) {
    if (!curtain.mesh || curtain.raise >= 1) return;
    wobbleTime.value += delta;
    if (curtain.raising) curtain.raise = Math.min(1, curtain.raise + delta / RAISE_SECONDS);
    place(this.world);
  }
}
