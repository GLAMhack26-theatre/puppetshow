import { type Material, Mesh, Quaternion, Vector3, type Object3D, type World } from "@iwsdk/core";
import { addFollowSpot } from "../stage/spotlights";
import { renderPose } from "../systems/rapier-system";
import { createGrab, dropAllHeld, suspendGrab } from "./grab";
import { buildRig, type RigDescription } from "./rig";
import { createStrings } from "./strings";

/** Fade out / in of a puppet while a scene changes, s. */
const FADE_SECONDS = 0.35;
/**
 * While hidden the cross is pulled up this far (m), so the props of the next
 * scene come down onto a free stage: the 0.35 m puppet then hangs well above
 * the highest prop (0.5 m at most, lowered from 0.35 m).
 */
const HIDE_LIFT = 1.0;
/** After coming back down the puppet swings a moment before it fades in, s. */
const SETTLE_SECONDS = 0.3;
/**
 * Never wait longer than this for the cross to arrive, in frames (the input
 * may hold it far off); frames, not seconds, so a slow device still waits
 * for the physics, which runs per frame.
 */
const MAX_TRAVEL_FRAMES = 150;
/**
 * A new player's puppet (flyIn): the one on the stage is pulled up fast until
 * its feet are out of the picture, and let down slowly at the new hand. Paces
 * of the cross, m/s and m/s². Going up it brakes at three times its
 * acceleration (strings.ts), which has to stay below gravity: at 20 m/s² the
 * puppet flew on past the cross, tumbled, and came down lying across its
 * strings. margin: how far above the picture's top edge the
 * feet go, as a share of the picture's height; MAX: the most it is pulled up, m.
 */
const FLY = { up: { speed: 2.5, accel: 3 }, down: { speed: 0.3, accel: 1.5 }, margin: 0.06, max: 2.5 };
/** Never wait longer than this for the slow descent, in frames */
const MAX_DESCENT_FRAMES = 900;

interface Presence {
  /** 0 hidden … 1 shown */
  level: number;
  set(level: number): void;
  setLift(y: number, pace?: { speed: number; accel: number }): void;
  arrived(): boolean;
  /** How far the cross has to go up for the feet to leave the picture, m */
  exitLift(): number;
}

const puppets: Presence[] = [];
/** Each hide / show / fly-in call bumps this; an older call that is still running stops. */
let generation = 0;
/** Between hidePuppets() and the end of showPuppets(): the scene change has the puppets */
let sceneChanging = false;

/**
 * The marionette: a skinned model with its rig description (marionette.ts),
 * its ragdoll, the control cross with the strings, grabbing hands, and its
 * own follow spot on the lighting bar. Controlled through ControlInput.
 */
export function createPuppet(world: World, root: Object3D, description: RigDescription) {
  world.scene.add(root);
  const rig = buildRig(root, description);
  const strings = createStrings(world, root, rig, description.strings, description.controller);
  const grab = createGrab(world, rig, strings);
  // The spot follows the chest: the middle of the puppet, and calmer than the head
  const center = (rig.byName.get("chest") ?? rig.parts[0]).body;
  const rotation = new Quaternion();
  const spot = addFollowSpot(world, (out: Vector3) => renderPose(center, out, rotation));
  // The feet are the lowest part: where they are tells how far up "out of the picture" is
  const feet = ["foot.L", "foot.R"].flatMap((name) => rig.byName.get(name)?.body ?? []);
  const point = new Vector3();
  const exitLift = () => {
    const camera = world.camera;
    camera.updateMatrixWorld();
    let lowest = Infinity;
    let at = center.translation();
    for (const foot of feet) if (foot.translation().y < lowest) [lowest, at] = [foot.translation().y, foot.translation()];
    if (lowest === Infinity) lowest = at.y;
    // Raised step by step until the feet's place projects above the top edge (NDC y > 1)
    for (let lift = 0.2; lift < FLY.max; lift += 0.05) {
      if (point.set(at.x, lowest - 0.03 + lift, at.z).project(camera).y > 1 + 2 * FLY.margin) return lift;
    }
    return FLY.max;
  };
  puppets.push(createPresence(root, strings, spot, exitLift));
  return { root, rig, strings, grab, spot };
}

/**
 * Fades the puppets out and pulls them up out of the way, e.g. before the
 * props of a new scene come down. Resolves once they are up.
 */
export async function hidePuppets() {
  const run = ++generation;
  sceneChanging = true;
  // What the puppet holds stays on the stage (the scene change sorts the props),
  // and nothing is taken while the puppet hangs above it
  suspendGrab(true);
  dropAllHeld();
  await fade(0, run);
  if (run !== generation) return;
  for (const p of puppets) p.setLift(HIDE_LIFT);
  await travel(run);
}

/** Lets the puppets down again and fades them in, once the stage is set. */
export async function showPuppets() {
  const run = ++generation;
  for (const p of puppets) p.setLift(0);
  await travel(run);
  await wait(SETTLE_SECONDS);
  if (run !== generation) return;
  await fade(1, run);
  if (run === generation) {
    sceneChanging = false;
    suspendGrab(false);
  }
}

/**
 * A new player's hand has taken the cross: the puppet on the stage is pulled
 * up out of the picture, fast, and a "new" one is let down slowly from above
 * to where the hand holds the cross (the cross follows the hand sideways and
 * in depth all the while, so it comes down at the hand's place and height).
 * It used to be dragged across the stage to the new hand and dropped there.
 * Not during a scene change: that one lets the puppet down itself.
 */
export async function flyIn() {
  if (sceneChanging) return;
  const run = ++generation;
  // The puppet that leaves takes nothing with it: its props stay for the next player
  dropAllHeld();
  for (const p of puppets) p.setLift(p.exitLift(), FLY.up);
  await travel(run);
  if (run !== generation) return;
  for (const p of puppets) p.setLift(0, FLY.down);
  await travel(run, MAX_DESCENT_FRAMES);
}

function createPresence(
  root: Object3D,
  strings: ReturnType<typeof createStrings>,
  spot: ReturnType<typeof addFollowSpot>,
  exitLift: () => number,
): Presence {
  const meshes: Mesh[] = [];
  root.traverse((o) => o instanceof Mesh && meshes.push(o));
  const materials = new Set<Material>(strings.materials);
  for (const mesh of meshes) for (const m of [mesh.material].flat()) materials.add(m);
  // As they come from the file; a fade changes them only while it runs
  const original = new Map([...materials].map((m) => [m, { transparent: m.transparent, opacity: m.opacity }]));
  const shadows = new Map(meshes.map((m) => [m, m.castShadow]));
  const objects = [root, ...strings.objects];

  return {
    level: 1,
    set(level) {
      this.level = level;
      const full = level >= 1;
      for (const [m, o] of original) {
        // Transparent only while fading: the shown puppet sorts as before
        if (m.transparent !== (full ? o.transparent : true)) {
          m.transparent = full ? o.transparent : true;
          m.needsUpdate = true;
        }
        m.opacity = o.opacity * level;
      }
      // A half-faded puppet would still throw a full shadow
      for (const [mesh, cast] of shadows) mesh.castShadow = full && cast;
      for (const o of objects) o.visible = level > 0;
      spot.dim(level);
    },
    setLift: strings.setLift,
    arrived: strings.arrived,
    exitLift,
  };
}

/** Animates every puppet's level towards `to`. */
function fade(to: number, run: number) {
  return new Promise<void>((resolve) => {
    let last = performance.now();
    const step = (now: number) => {
      if (run !== generation) return resolve();
      const delta = (now - last) / 1000 / FADE_SECONDS;
      last = now;
      let done = true;
      for (const p of puppets) {
        const level = to > p.level ? Math.min(to, p.level + delta) : Math.max(to, p.level - delta);
        if (level !== p.level) p.set(level);
        done &&= level === to;
      }
      if (done) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Waits until every cross is where its lift wants it (or a while has passed). */
function travel(run: number, most = MAX_TRAVEL_FRAMES) {
  let frames = 0;
  return new Promise<void>((resolve) => {
    const check = () => {
      if (run !== generation || puppets.every((p) => p.arrived()) || ++frames > most) resolve();
      else requestAnimationFrame(check);
    };
    // One frame first: the physics step has to pick up the new lift
    requestAnimationFrame(check);
  });
}

const wait = (s: number) => new Promise((resolve) => setTimeout(resolve, s * 1000));
