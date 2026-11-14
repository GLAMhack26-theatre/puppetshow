import type { Object3D, World } from "@iwsdk/core";
import { createGrab } from "./grab";
import { buildRig, type RigDescription } from "./rig";
import { createStrings } from "./strings";

/**
 * The marionette: a skinned model with its rig description (marionette.ts),
 * its ragdoll, the control cross with the strings, and grabbing hands.
 * Controlled through ControlInput.
 */
export function createPuppet(world: World, root: Object3D, description: RigDescription) {
  world.scene.add(root);
  const rig = buildRig(root, description);
  const strings = createStrings(world, root, rig, description.strings, description.controller);
  const grab = createGrab(rig);
  return { root, rig, strings, grab };
}
