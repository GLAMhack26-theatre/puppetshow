import { physics } from "../systems/rapier-system";
import { colliderSounds } from "./materials";

// How fast a prop met something. Rapier reports a contact after its step has
// resolved it, so the velocity read then is what is left after the impact: a
// prop without bounce that hit the floor at 1.5 m/s read 0.02 m/s (measured in
// the page). So each prop's velocity is kept from before every step, and the
// impact is measured with that. Used for the impact sounds and the squash.

type Vec = { x: number; y: number; z: number };

const before = new Map<number, Vec>();
const ZERO: Vec = { x: 0, y: 0, z: 0 };

physics.beforeStep.push(() => {
  before.clear();
  for (const handle of colliderSounds.keys()) {
    const body = physics.world.getCollider(handle)?.parent();
    if (body?.isDynamic()) before.set(handle, body.linvel());
  }
});

/**
 * The velocity a collider came into this step with: a prop's from before the
 * step, anything else's as it is now; a collider without a body (the stage
 * floor) stands still.
 */
export function approachVelocity(handle: number): Vec {
  return before.get(handle) ?? physics.world.getCollider(handle)?.parent()?.linvel() ?? ZERO;
}

/** The two colliders' velocity against each other as they met. */
export function impactVelocity(a: number, b: number): Vec {
  const va = approachVelocity(a);
  const vb = approachVelocity(b);
  return { x: va.x - vb.x, y: va.y - vb.y, z: va.z - vb.z };
}
