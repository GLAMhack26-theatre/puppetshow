import { Quaternion, type Object3D, type Vector3, type World } from "@iwsdk/core";
import { controlInput, type ControlInput } from "../input/control-input";
import { addFollowSpot } from "../stage/spotlights";
import { MAX_PUPPETS, puppetGroups, renderPose } from "../systems/rapier-system";
import { createGrab } from "./grab";
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
  const rig = buildRig(root, description, { mode, groups });
  const strings = createStrings(world, root, rig, description.strings, description.controller, { mode, input });
  const grab = simulated && input ? createGrab(rig, input, groups) : undefined;
  // The spot follows the chest: the middle of the puppet, and calmer than the head
  const center = (rig.byName.get("chest") ?? rig.parts[0]).body;
  const rotation = new Quaternion();
  const spot = addFollowSpot(world, (out: Vector3) => renderPose(center, out, rotation));

  return {
    root,
    rig,
    strings,
    grab,
    spot,
    /** Bars, then bones: the bodies whose poses travel over the network, in the same order on every device */
    bodies: [...strings.bars, ...rig.bodies],
    dispose() {
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
