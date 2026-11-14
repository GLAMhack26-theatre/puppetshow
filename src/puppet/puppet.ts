import { Quaternion, type Object3D, type Vector3, type World } from "@iwsdk/core";
import { addFollowSpot } from "../stage/spotlights";
import { renderPose } from "../systems/rapier-system";
import { createGrab } from "./grab";
import { buildRig, type RigDescription } from "./rig";
import { createStrings } from "./strings";

/**
 * The marionette: a skinned model with its rig description (marionette.ts),
 * its ragdoll, the control cross with the strings, grabbing hands, and its
 * own follow spot on the lighting bar. Controlled through ControlInput.
 */
export function createPuppet(world: World, root: Object3D, description: RigDescription) {
  world.scene.add(root);
  const rig = buildRig(root, description);
  const strings = createStrings(world, root, rig, description.strings, description.controller);
  const grab = createGrab(rig);
  // The spot follows the chest: the middle of the puppet, and calmer than the head
  const center = (rig.byName.get("chest") ?? rig.parts[0]).body;
  const rotation = new Quaternion();
  const spot = addFollowSpot(world, (out: Vector3) => renderPose(center, out, rotation));
  return { root, rig, strings, grab, spot };
}
