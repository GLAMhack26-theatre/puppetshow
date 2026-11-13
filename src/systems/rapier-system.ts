import RAPIER from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3, createSystem } from "@iwsdk/core";
import { PhysicsLink } from "../components/physics-link";

// Rapier as our own system: IWSDK's physics (Havok in a worker) has no
// joints, sensors or collision events, which the marionette needs.

export const STEP = 1 / 60;
const MAX_STEPS = 4; // after a stalled frame, drop time instead of catching up forever

/** Collision groups: membership in the high 16 bits, filter in the low 16. */
const group = (membership: number, filter: number) => (membership << 16) | filter;
export const GROUP = {
  // Puppet parts never collide with each other (the joints hold them), only
  // with the stage and props
  puppet: group(0x0001, 0x0006),
  // Hands and arms skip props: they would push a prop away before the hand
  // sensor can grab it
  limb: group(0x0001, 0x0002),
  stage: group(0x0002, 0xffff),
  prop: group(0x0004, 0xffff),
  sensor: group(0x0001, 0x0004), // hand sensors only see props
};

export const physics = {
  world: null as unknown as RAPIER.World,
  events: null as unknown as RAPIER.EventQueue,
  /** Before every fixed step: kinematic targets, joint changes */
  beforeStep: [] as Array<() => void>,
  /** Once per frame after the poses were synced: string lines, bones */
  afterSync: [] as Array<() => void>,
  onCollision: [] as Array<(a: number, b: number, started: boolean) => void>,
  /** How far the render frame is between the last two steps (0…1) */
  alpha: 1,
  stepMs: 0,
  steps: 0,
};

// Pose of every moving body before the last step. Rendering blends between
// it and the current pose (alpha), so the 60 Hz physics looks smooth on
// displays with other refresh rates (120 Hz: 0 or 2 steps per frame).
const previous = new Map<number, { p: Vector3; q: Quaternion }>();
const tmpQ = new Quaternion();

function rememberPoses() {
  physics.world.forEachRigidBody((body) => {
    if (body.isFixed()) return;
    let pose = previous.get(body.handle);
    if (!pose) previous.set(body.handle, (pose = { p: new Vector3(), q: new Quaternion() }));
    const t = body.translation();
    const r = body.rotation();
    pose.p.set(t.x, t.y, t.z);
    pose.q.set(r.x, r.y, r.z, r.w);
  });
}

/** The body's pose for rendering: interpolated between the last two steps. */
export function renderPose(body: RAPIER.RigidBody, p: Vector3, q: Quaternion) {
  const t = body.translation();
  const r = body.rotation();
  p.set(t.x, t.y, t.z);
  q.set(r.x, r.y, r.z, r.w);
  const before = previous.get(body.handle);
  if (!before) return;
  p.lerpVectors(before.p, p, physics.alpha);
  tmpQ.copy(q);
  q.copy(before.q).slerp(tmpQ, physics.alpha);
}

/** Rapier's wasm must be ready before any body is created. */
export async function initPhysics() {
  await RAPIER.init();
  physics.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physics.world.timestep = STEP;
  physics.events = new RAPIER.EventQueue(true);
}

export class RapierSystem extends createSystem({ links: { required: [PhysicsLink] } }) {
  private accumulator = 0;

  update(delta: number) {
    this.accumulator = Math.min(this.accumulator + delta, STEP * MAX_STEPS);
    const start = performance.now();
    let steps = 0;
    while (this.accumulator >= STEP) {
      rememberPoses();
      for (const fn of physics.beforeStep) fn();
      physics.world.step(physics.events);
      physics.events.drainCollisionEvents((a, b, started) => {
        for (const fn of physics.onCollision) fn(a, b, started);
      });
      this.accumulator -= STEP;
      steps++;
    }
    physics.alpha = this.accumulator / STEP;
    physics.stepMs = performance.now() - start;
    physics.steps = steps;

    for (const entity of this.queries.links.entities) {
      const body = physics.world.getRigidBody(entity.getValue(PhysicsLink, "body") as number);
      const object = entity.object3D;
      if (body && object) renderPose(body, object.position, object.quaternion);
    }
    for (const fn of physics.afterSync) fn();
  }
}
