import { AnimationMixer, Box3, CatmullRomCurve3, MathUtils, type Object3D, type PerspectiveCamera, Sphere, Vector3 } from "@iwsdk/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import boxUrl from "../../assets/digital.skkg.ch/Pralinen_Schachtel_v2.glb?url";
import { addView } from "./views";

// Slide 4, "Your Selection of Pralines": the chocolate box with the 12
// collection objects as miniatures in its compartments, and a camera
// flight through it. Each loop: the whole box from a distance, down into it
// to one object, up again and across to a second one, and back out; the
// next loop takes the next pair. The model's own "Drehteller" animation
// turns every object, so a close-up shows it from all sides.
// Object positions are read from the model's nodes (named after the
// objects), not hard-coded.

/** Pairs shown one loop each, in this order (node names in the .glb) */
const PAIRS: [string, string][] = [
  ["Marionette", "Frosch"],
  ["Mikroskop", "Truhe"],
  ["Laterne", "Katze"],
  ["Becher", "Nadelbaum"],
  ["Hund", "Stuhl"],
  ["Kugel", "Bett"],
];

// One loop, s. `stop`: the camera comes to rest there (eased), otherwise it flies through
const KEYS: { at: number; stop: boolean }[] = [
  { at: 0, stop: true }, // wide, the whole box
  { at: 3, stop: false }, // approaching
  { at: 5, stop: false }, // above the first object
  { at: 6.5, stop: true }, // close-up
  { at: 9.5, stop: true }, // still close, drifting a little (the turntable does the rest)
  { at: 12, stop: false }, // up over the compartments
  { at: 14.5, stop: true }, // close-up of the second object
  { at: 17.5, stop: true },
  { at: 21.5, stop: true }, // back to the wide shot
];
/** Rest on the wide shot before the next pair */
const WIDE_HOLD = 1.5;
const LOOP = KEYS[KEYS.length - 1].at + WIDE_HOLD;

let reset = () => {};

/** Starts the flight again from the wide shot (on entering the slide). */
export function restartPralines() {
  reset();
}

export async function loadPralines(view: HTMLElement) {
  const gltf = await new GLTFLoader().loadAsync(boxUrl);
  const box = gltf.scene;
  // In the model the insert's top, the cups' bottoms and the objects' bases
  // all lie at y = 0.004 m: three coplanar surfaces flicker (z-fighting) as
  // the camera moves. Lift the cups 0.25 mm and the objects 0.5 mm; too
  // little to see at 3 cm. (Better fixed in the .blend one day.)
  const objects = new Set(PAIRS.flat());
  box.traverse((node) => {
    if (node.name.startsWith("Kapsel_")) node.position.y += 0.00025;
    else if (objects.has(node.name)) node.position.y += 0.0005;
  });
  addView(view, box, { spin: 0, angle: 0, update });
  const mixer = new AnimationMixer(box);
  for (const clip of gltf.animations) mixer.clipAction(clip).play();

  // Everything in world space of the view's scene: addView scales the box to
  // a unit box, so the matrices are updated from the scene root down
  let root: Object3D = box;
  while (root.parent) root = root.parent;
  root.updateMatrixWorld(true);
  const floor = box.getObjectByName("Boden") ?? box;
  const bounds = new Box3().setFromObject(floor);
  const centre = bounds.getCenter(new Vector3());
  const width = bounds.getSize(new Vector3()).x;
  // The whole model (open lid and tissue paper included), for the wide shot
  const whole = new Box3().setFromObject(box).getBoundingSphere(new Sphere());

  /** Where to look at an object: about half its height above its base */
  const focus = (name: string) => {
    const node = box.getObjectByName(name);
    if (!node) return centre.clone();
    const size = new Box3().setFromObject(node).getSize(new Vector3());
    return node.getWorldPosition(new Vector3()).add(new Vector3(0, size.y * 0.45, 0));
  };

  // Camera positions and look targets of one loop, for objects a and b.
  // The lid stands open at the back (−z), so the camera stays in front (+z).
  // Close-ups look down at about 55°, so neither the box walls nor the row
  // in front hide the object; the whole object stays in view with its compartment.
  // The wide shot is fitted to the screen: the camera backs off along a fixed
  // direction until the whole model's bounding sphere fits the narrower of
  // the two fields of view, with a margin
  const WIDE_DIRECTION = new Vector3(0.15, 1.15, 1.6).normalize();
  const WIDE_MARGIN = 1.08;
  const wideShot = (camera: PerspectiveCamera) => {
    const vertical = MathUtils.degToRad(camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
    const distance = (whole.radius / Math.sin(Math.min(vertical, horizontal) / 2)) * WIDE_MARGIN;
    return whole.center.clone().addScaledVector(WIDE_DIRECTION, distance);
  };

  const loop = ([nameA, nameB]: [string, string], camera: PerspectiveCamera) => {
    const a = focus(nameA);
    const b = focus(nameB);
    const at = (base: Vector3, x: number, y: number, z: number) => base.clone().add(new Vector3(x, y, z).multiplyScalar(width));
    const middle = a.clone().lerp(b, 0.5);
    const wide = wideShot(camera);
    return {
      positions: new CatmullRomCurve3([
        wide,
        wide.clone().lerp(at(centre, 0.1, 0.95, 1.1), 0.6), // approaching
        at(a, 0, 0.8, 0.5),
        at(a, 0.07, 0.48, 0.3),
        at(a, -0.05, 0.5, 0.27),
        at(middle, 0, 0.75, 0.45),
        at(b, -0.07, 0.48, 0.3),
        at(b, 0.05, 0.5, 0.27),
        wide,
      ]),
      targets: new CatmullRomCurve3([whole.center, centre, a, a, a, middle, b, b, whole.center]),
    };
  };

  let time = 0;
  let pair = 0;
  // Built in update(), where the view's camera (and its aspect) is known
  let path: ReturnType<typeof loop> | null = null;
  reset = () => {
    time = 0;
    pair = 0;
    path = null;
  };

  function update(dt: number, camera: PerspectiveCamera) {
    mixer.update(dt);
    time += dt;
    if (time >= LOOP) {
      time -= LOOP;
      pair = (pair + 1) % PAIRS.length;
      path = null;
    }
    path ??= loop(PAIRS[pair], camera);
    const u = progress(time);
    camera.position.copy(path.positions.getPoint(u));
    camera.lookAt(path.targets.getPoint(u));
  }
}

/** Curve parameter 0…1 at loop time t: key i sits at i / (keys − 1), eased where the camera stops. */
function progress(t: number) {
  const i = KEYS.findIndex((k, n) => n < KEYS.length - 1 && t >= k.at && t < KEYS[n + 1].at);
  if (i < 0) return 1; // past the last key: holding the wide shot
  const [from, to] = [KEYS[i], KEYS[i + 1]];
  const f = (t - from.at) / (to.at - from.at);
  const eased =
    from.stop && to.stop ? f * f * (3 - 2 * f) : from.stop ? f * f : to.stop ? 1 - (1 - f) * (1 - f) : f;
  return (i + eased) / (KEYS.length - 1);
}

