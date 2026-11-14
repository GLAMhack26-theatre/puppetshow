import RAPIER from "@dimforge/rapier3d-compat";
import { Quaternion } from "@iwsdk/core";
import { controlInput } from "../input/control-input";
import { GROUP, physics, toQuat, toVec, worldPoint } from "../systems/rapier-system";
import type { Rig } from "./rig";

// Both hands grab: a sensor at each hand's tip; grip while it touches a
// grabbable prop creates a fixed joint, release removes it and throws the
// prop with the hand's velocity.

const SENSOR_RADIUS = 0.02; // m, around the fingertips of the 0.35 m puppet
const THROW_BOOST = 1.5; // the damped puppet moves slower than a real flick

export interface Grabbable {
  name: string;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

/** Small props register here when they stand on the stage (props/requisits.ts). */
export const grabbables: Grabbable[] = [];

export function createGrab(rig: Rig) {
  const pw = physics.world;
  const hands = (["left", "right"] as const).flatMap((side) => {
    const part = rig.byName.get(side === "left" ? "hand.L" : "hand.R");
    if (!part) return [];
    const tip = { x: part.tail.x, y: part.tail.y, z: part.tail.z };
    const sensor = pw.createCollider(
      RAPIER.ColliderDesc.ball(SENSOR_RADIUS).setTranslation(tip.x, tip.y, tip.z).setSensor(true).setCollisionGroups(GROUP.sensor),
      part.body,
    );
    return [{ side, body: part.body, tip, sensor, held: null as { joint: RAPIER.ImpulseJoint; item: Grabbable } | null, wasGripping: false }];
  });

  physics.beforeStep.push(() => {
    for (const hand of hands) {
      const gripping = controlInput.grip[hand.side];
      if (gripping && !hand.wasGripping && !hand.held) {
        const item = grabbables.find((g) => pw.intersectionPair(hand.sensor, g.collider));
        if (item) {
          // Keep the current relative pose: frame1 = handRot⁻¹ · propRot
          const propRot = toQuat(item.body.rotation());
          const local = worldPoint(hand.body, hand.tip).sub(toVec(item.body.translation())).applyQuaternion(propRot.clone().invert());
          const frame = toQuat(hand.body.rotation()).invert().multiply(propRot);
          const joint = pw.createImpulseJoint(
            RAPIER.JointData.fixed(hand.tip, frame, local, new Quaternion()),
            hand.body,
            item.body,
            true,
          );
          hand.held = { joint, item };
        }
      } else if (!gripping && hand.held) {
        pw.removeImpulseJoint(hand.held.joint, true);
        // Throw: the prop leaves with the hand tip's velocity (v + ω × r)
        const r = worldPoint(hand.body, hand.tip).sub(toVec(hand.body.translation()));
        const velocity = toVec(hand.body.angvel()).cross(r).add(toVec(hand.body.linvel())).multiplyScalar(THROW_BOOST);
        hand.held.item.body.setLinvel(velocity, true);
        hand.held = null;
      }
      hand.wasGripping = gripping;
    }
  });

  return {
    /** Per hand: the touched prop's name ("-" if none) and whether it is held */
    status: () =>
      hands.map((h) => ({
        side: h.side,
        touching: grabbables.find((g) => pw.intersectionPair(h.sensor, g.collider))?.name ?? "-",
        holding: h.held?.item.name ?? "-",
      })),
  };
}
