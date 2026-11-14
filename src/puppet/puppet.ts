import { type Material, Mesh, Quaternion, type Object3D, type Vector3, type World } from "@iwsdk/core";
import { addFollowSpot } from "../stage/spotlights";
import { renderPose } from "../systems/rapier-system";
import { createBodyDrive } from "./body-drive";
import { createGrab } from "./grab";
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

interface Presence {
  /** 0 hidden … 1 shown */
  level: number;
  set(level: number): void;
  setLift(y: number): void;
  arrived(): boolean;
}

const puppets: Presence[] = [];
/** Each hide/show call bumps this; an older call that is still running stops. */
let generation = 0;

/**
 * The marionette: a skinned model with its rig description (marionette.ts),
 * its ragdoll, the control cross with the strings, grabbing hands, the drive
 * for a player's own body (WebXR), and its own follow spot on the lighting
 * bar. Controlled through ControlInput.
 */
export function createPuppet(world: World, root: Object3D, description: RigDescription) {
  world.scene.add(root);
  const rig = buildRig(root, description);
  const strings = createStrings(world, root, rig, description.strings, description.controller);
  const grab = createGrab(rig);
  const body = createBodyDrive(root, rig, strings);
  // The spot follows the chest: the middle of the puppet, and calmer than the head
  const center = (rig.byName.get("chest") ?? rig.parts[0]).body;
  const rotation = new Quaternion();
  const spot = addFollowSpot(world, (out: Vector3) => renderPose(center, out, rotation));
  puppets.push(createPresence(root, strings, spot));
  return { root, rig, strings, grab, body, spot };
}

/**
 * Fades the puppets out and pulls them up out of the way, e.g. before the
 * props of a new scene come down. Resolves once they are up.
 */
export async function hidePuppets() {
  const run = ++generation;
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
}

function createPresence(
  root: Object3D,
  strings: ReturnType<typeof createStrings>,
  spot: ReturnType<typeof addFollowSpot>,
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
function travel(run: number) {
  let frames = 0;
  return new Promise<void>((resolve) => {
    const check = () => {
      if (run !== generation || puppets.every((p) => p.arrived()) || ++frames > MAX_TRAVEL_FRAMES) resolve();
      else requestAnimationFrame(check);
    };
    // One frame first: the physics step has to pick up the new lift
    requestAnimationFrame(check);
  });
}

const wait = (s: number) => new Promise((resolve) => setTimeout(resolve, s * 1000));
