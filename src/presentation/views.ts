import {
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Object3D,
  type Texture,
} from "@iwsdk/core";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// 3D views on the slides: one shared renderer on its own transparent canvas
// over the slides (three.js "multiple elements" pattern). Every view is a
// DOM placeholder plus a scene; each frame the visible views are drawn into
// their placeholder's rectangle with viewport + scissor: one WebGL context
// for all models instead of one per view.

interface View {
  element: HTMLElement;
  scene: Scene;
  camera: PerspectiveCamera;
  pivot: Group;
  spin: number; // rad/s
  /** Per frame while the view is visible (e.g. a demo animation, or a camera flight that moves `camera`) */
  update?: (dt: number, camera: PerspectiveCamera) => void;
}

const views: View[] = [];
let renderer: WebGLRenderer | null = null;
let environment: Texture | null = null;
let last = 0;

export function initViews(parent: HTMLElement) {
  const canvas = document.createElement("canvas");
  canvas.className = "presentation-canvas";
  parent.append(canvas);
  renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const pmrem = new PMREMGenerator(renderer);
  environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}

/**
 * Shows `object` in `element`, centred, scaled to fit and turning around
 * its vertical axis. `overlay` objects (e.g. a SkeletonHelper, which
 * positions itself from the bones) go into the scene unscaled and unturned.
 */
export function addView(
  element: HTMLElement,
  object: Object3D,
  options: {
    spin?: number;
    angle?: number;
    /** Camera distance: 2.4 shows the unit box with a margin; smaller zooms in */
    distance?: number;
    overlay?: Object3D[];
    update?: (dt: number, camera: PerspectiveCamera) => void;
  } = {},
) {
  const scene = new Scene();
  scene.environment = environment;
  scene.environmentIntensity = 0.5;
  const key = new DirectionalLight(0xfff1dc, 1.8);
  key.position.set(1, 2, 2);
  scene.add(new HemisphereLight(0xffeedd, 0x302018, 0.6), key);

  // Fit into a unit box around the origin
  object.updateMatrixWorld(true);
  const box = new Box3().setFromObject(object);
  const size = box.getSize(new Vector3());
  const scale = 1 / Math.max(size.x, size.y, size.z, 1e-6);
  const fitted = new Group();
  fitted.scale.setScalar(scale);
  fitted.position.copy(box.getCenter(new Vector3()).multiplyScalar(-scale));
  fitted.add(object);
  const pivot = new Group();
  pivot.rotation.y = options.angle ?? 0;
  pivot.add(fitted);
  scene.add(pivot);
  for (const extra of options.overlay ?? []) scene.add(extra);

  const camera = new PerspectiveCamera(30, 1, 0.01, 20);
  const distance = options.distance ?? 2.4;
  camera.position.set(0, 0.25 * (distance / 2.4), distance);
  camera.lookAt(0, 0, 0);
  views.push({ element, scene, camera, pivot, spin: options.spin ?? 0.3, update: options.update });
  element.classList.add("loaded");
}

export function startViews() {
  last = performance.now();
  renderer?.setAnimationLoop(frame);
}

/** The render loop runs only while the presentation is open. */
export function stopViews() {
  renderer?.setAnimationLoop(null);
}

function frame(now: number) {
  if (!renderer) return;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const canvas = renderer.domElement;
  if (canvas.width !== Math.floor(canvas.clientWidth * renderer.getPixelRatio()) ||
      canvas.height !== Math.floor(canvas.clientHeight * renderer.getPixelRatio())) {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  }
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.setScissorTest(true);

  for (const view of views) {
    const rect = view.element.getBoundingClientRect();
    // Views on hidden slides have no size; skip those off screen too
    if (rect.width === 0 || rect.bottom < 0 || rect.top > canvas.clientHeight) continue;
    view.pivot.rotation.y += view.spin * dt;
    view.update?.(dt, view.camera);
    const bottom = canvas.clientHeight - rect.bottom;
    renderer.setViewport(rect.left, bottom, rect.width, rect.height);
    renderer.setScissor(rect.left, bottom, rect.width, rect.height);
    view.camera.aspect = rect.width / rect.height;
    view.camera.updateProjectionMatrix();
    renderer.render(view.scene, view.camera);
  }
}
