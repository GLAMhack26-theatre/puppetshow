import { type Material, Mesh, Quaternion, Vector3, type Object3D, type World } from "@iwsdk/core";
import { controlInput, puppetState, type ControlInput } from "../input/control-input";
import { addFollowSpot } from "../stage/spotlights";
import { MAX_PUPPETS, puppetGroups, renderPose } from "../systems/rapier-system";
import { createGrab, suspendGrab } from "./grab";
import { loadMarionette } from "./marionette";
import { buildRig, type RigDescription } from "./rig";
import { createStrings } from "./strings";

export interface PuppetOptions {
  /**
   * "simulated": this device runs the puppet's physics, led by `input`.
   * "replicated": another device does (src/net/); here its bodies are only
   * set from the network. `input` is then given for the local player's own
   * puppet only.
   */
  mode?: "simulated" | "replicated";
  input?: ControlInput;
  /** Its place among the puppets on the stage (0 … MAX_PUPPETS − 1): collision group */
  slot?: number;
  /** Puppets bump into each other instead of passing through */
  contact?: boolean;
}

export type Puppet = ReturnType<typeof createPuppet>;

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
  /** Led by the player at this device */
  local: boolean;
  /** Its hands let go of what they hold, without a throw */
  drop(): void;
}

/** The puppets on the stage now: they come and go with their players (src/net/) */
const puppets: Presence[] = [];
/**
 * How a material came from the file. Kept across puppets: they share the
 * model's materials (marionette.ts), so one that joins while the others are
 * faded would otherwise take the faded values for the original ones.
 */
const originals = new WeakMap<Material, { transparent: boolean; opacity: number }>();
/** Each hide / show / fly-in call bumps this; an older call that is still running stops. */
let generation = 0;
/** Between hidePuppets() and the end of showPuppets(): the scene change has the puppets */
let sceneChanging = false;

/**
 * The marionette: a skinned model with its rig description (marionette.ts),
 * its ragdoll, the control cross with the strings, grabbing hands, and its
 * own follow spot on the lighting bar. Controlled through a ControlInput; it
 * stands where `root` is.
 */
export function createPuppet(world: World, root: Object3D, description: RigDescription, options: PuppetOptions = {}) {
  const mode = options.mode ?? "simulated";
  const simulated = mode === "simulated";
  // A simulated puppet always has a leader: the local player unless told otherwise
  const input = options.input ?? (simulated ? controlInput : undefined);
  const groups = puppetGroups(options.slot ?? 0, options.contact ?? false);

  world.scene.add(root);
  // The puppet the player at this device leads (on another device's stage it is replicated here, and its hands are there)
  const local = input === controlInput;
  const rig = buildRig(root, description, { mode, groups });
  const strings = createStrings(world, root, rig, description.strings, description.controller, { mode, input });
  // The local player's hands report to the sources and the UI (puppetState), any other puppet's to an object of its own
  const grab = simulated && input ? createGrab(world, rig, strings, input, local ? puppetState : undefined) : undefined;
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
  const presence = createPresence(root, strings, spot, exitLift, local, () => grab?.drop());
  puppets.push(presence);

  return {
    root,
    rig,
    strings,
    grab,
    spot,
    /** Bars, then bones: the bodies whose poses travel over the network, in the same order on every device */
    bodies: [...strings.bars, ...rig.bodies],
    dispose() {
      // Out of the list first: a scene change must not wait for a cross that no longer moves
      puppets.splice(puppets.indexOf(presence), 1);
      spot.remove();
      grab?.dispose();
      strings.dispose();
      rig.dispose();
    },
  };
}

/** Where the puppets stand at first, by slot: x and z on the stage floor, m (the stage is 1.4 m wide) */
const PLACES: [number, number][] = [[0, 0], [-0.3, 0], [0.3, 0], [-0.55, 0], [0.55, 0], [0, -0.2]];

/** Loads a marionette and puts it on the stage at its slot's place. */
export async function spawnPuppet(world: World, options: PuppetOptions = {}) {
  const { root, description } = await loadMarionette();
  const [x, z] = PLACES[(options.slot ?? 0) % Math.min(PLACES.length, MAX_PUPPETS)];
  root.position.set(x, 0, z);
  return createPuppet(world, root, description, options);
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
  for (const p of puppets) p.drop();
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
 *
 * Only the puppet this device's player leads, and only where it is simulated:
 * the other players' puppets stay on the stage, and on a device that only
 * shows the puppets (a client in a room, src/net/) nothing happens.
 */
export async function flyIn() {
  if (sceneChanging) return;
  const run = ++generation;
  const own = puppets.filter((p) => p.local);
  // The puppet that leaves takes nothing with it: its props stay for the next player
  for (const p of own) p.drop();
  for (const p of own) p.setLift(p.exitLift(), FLY.up);
  await travel(run, MAX_TRAVEL_FRAMES, own);
  if (run !== generation) return;
  for (const p of own) p.setLift(0, FLY.down);
  await travel(run, MAX_DESCENT_FRAMES, own);
}

function createPresence(
  root: Object3D,
  strings: ReturnType<typeof createStrings>,
  spot: ReturnType<typeof addFollowSpot>,
  exitLift: () => number,
  local: boolean,
  drop: () => void,
): Presence {
  const meshes: Mesh[] = [];
  root.traverse((o) => o instanceof Mesh && meshes.push(o));
  const materials = new Set<Material>(strings.materials);
  for (const mesh of meshes) for (const m of [mesh.material].flat()) materials.add(m);
  // As they come from the file; a fade changes them only while it runs
  for (const m of materials) if (!originals.has(m)) originals.set(m, { transparent: m.transparent, opacity: m.opacity });
  const original = new Map([...materials].map((m) => [m, originals.get(m)!]));
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
    local,
    drop,
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

/** Waits until every cross (of `who`) is where its lift wants it (or a while has passed). */
function travel(run: number, most = MAX_TRAVEL_FRAMES, who = puppets) {
  let frames = 0;
  return new Promise<void>((resolve) => {
    const check = () => {
      if (run !== generation || who.every((p) => p.arrived()) || ++frames > most) resolve();
      else requestAnimationFrame(check);
    };
    // One frame first: the physics step has to pick up the new lift
    requestAnimationFrame(check);
  });
}

const wait = (s: number) => new Promise((resolve) => setTimeout(resolve, s * 1000));
