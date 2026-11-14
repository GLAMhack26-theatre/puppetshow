import RAPIER from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3, createSystem, type Object3D, type World } from "@iwsdk/core";
import { PhysicsLink } from "../components/physics-link";

// Rapier as our own system: IWSDK's physics (Havok in a worker) has no
// joints, sensors or collision events, which the marionette needs.

export const STEP = 1 / 60;
const MAX_STEPS = 4; // after a stalled frame, drop time instead of catching up forever

/** Collision groups: membership in the high 16 bits, filter in the low 16. */
const group = (membership: number, filter: number) => (membership << 16) | filter;
const STAGE = 0x0002;
const PROP = 0x0004;
export const GROUP = {
  stage: group(STAGE, 0xffff),
  prop: group(PROP, 0xffff),
};

/** Puppets on the stage at once: each needs its own membership bit (see puppetGroups) */
export const MAX_PUPPETS = 6;
const PUPPET_BIT = 0x0010; // slot 0; the next slots take the bits above
const ALL_PUPPETS = ((1 << MAX_PUPPETS) - 1) * PUPPET_BIT;

/**
 * Collision groups of the puppet in `slot`. Its parts never collide with each
 * other (the joints hold them), only with the stage, props and, with
 * `contact`, the other puppets: that is why every puppet has its own bit.
 */
export function puppetGroups(slot: number, contact: boolean) {
  const self = PUPPET_BIT << slot;
  const others = contact ? ALL_PUPPETS & ~self : 0;
  return {
    body: group(self, STAGE | PROP | others),
    // Hands and arms skip props: they would push a prop away before the hand
    // sensor can grab it
    limb: group(self, STAGE | others),
    sensor: group(self, PROP), // hand sensors only see props
  };
}

export const physics = {
  world: null as unknown as RAPIER.World,
  events: null as unknown as RAPIER.EventQueue,
  /** Before every fixed step: kinematic targets, joint changes */
  beforeStep: [] as Array<() => void>,
  /** After every fixed step: measurements (debug) */
  afterStep: [] as Array<() => void>,
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

export const toVec = (p: RAPIER.Vector, out = new Vector3()) => out.set(p.x, p.y, p.z);
export const toQuat = (r: RAPIER.Rotation, out = new Quaternion()) => out.set(r.x, r.y, r.z, r.w);

/** World position of a body-local point (physics pose). */
export function worldPoint(body: RAPIER.RigidBody, local: RAPIER.Vector, out = new Vector3()) {
  return out.set(local.x, local.y, local.z).applyQuaternion(toQuat(body.rotation(), tmpQ)).add(toVec(body.translation()));
}

const renderP = new Vector3();
const renderQ = new Quaternion();
/** The same for rendering: the interpolated pose, like the meshes. */
export function renderPoint(body: RAPIER.RigidBody, local: RAPIER.Vector, out = new Vector3()) {
  renderPose(body, renderP, renderQ);
  return out.set(local.x, local.y, local.z).applyQuaternion(renderQ).add(renderP);
}

/**
 * Registers a hook (physics.beforeStep, afterStep, afterSync) and returns the
 * function that takes it out again: a puppet leaves with its player.
 */
export function addHook(list: Array<() => void>, fn: () => void) {
  list.push(fn);
  return () => {
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  };
}

/** Removes a body with its colliders and joints, and its remembered pose. */
export function removeBody(body: RAPIER.RigidBody) {
  previous.delete(body.handle);
  physics.world.removeRigidBody(body);
}

/** A mesh driven by a rigid body, through the ECS (PhysicsLink + RapierSystem). */
export function addLinked(
  world: World,
  object: Object3D,
  bodyDesc: RAPIER.RigidBodyDesc,
  colliderDesc?: RAPIER.ColliderDesc,
) {
  const body = physics.world.createRigidBody(bodyDesc);
  const collider = colliderDesc ? physics.world.createCollider(colliderDesc, body) : undefined;
  object.traverse((o) => (o.castShadow = true));
  const entity = world.createTransformEntity(object).addComponent(PhysicsLink, { body: body.handle });
  const remove = () => {
    entity.destroy();
    object.removeFromParent();
    removeBody(body);
  };
  return { body, collider, remove };
}

// Rapier's JS classes only offer limits and motors on one-axis joints, but
// its joint set takes them for any axis of any joint (UnitImpulseJoint.setLimits
// calls the same function). That gives what the high-level API lacks: limits
// on every rotation of a ball joint, and a rope whose length can change.
interface RawJointSet {
  jointSetLimits(handle: number, axis: RAPIER.JointAxis, min: number, max: number): void;
  jointConfigureMotorVelocity(handle: number, axis: RAPIER.JointAxis, targetVel: number, factor: number): void;
}
const rawJoints = (joint: RAPIER.ImpulseJoint) => (joint as unknown as { rawSet: RawJointSet }).rawSet;

/** Limit one axis of any joint (rad for angular axes, m for linear ones) */
export function setJointLimits(joint: RAPIER.ImpulseJoint, axis: RAPIER.JointAxis, min: number, max: number) {
  rawJoints(joint).jointSetLimits(joint.handle, axis, min, max);
}

/** Friction on one axis of any joint: a motor that pulls its speed towards 0 */
export function setJointFriction(joint: RAPIER.ImpulseJoint, axis: RAPIER.JointAxis, factor: number) {
  rawJoints(joint).jointConfigureMotorVelocity(joint.handle, axis, 0, factor);
}

// Solver effort. Rapier's default (4 × 1) leaves the puppet's joints soft: in
// lively play the strings stretched by 3 mm (25 mm when shaken) and hinges
// bent 25° off their axis, which reads as rubber strings. Each solver
// iteration is a substep, so more of them also catch a string that snaps taut
// earlier. Measured on the marionette (headless Chrome, desktop): 16 × 4
// keeps strings within 0.2 mm in play (3 mm when shaken) and hinges within
// 2°, for 0.2 ms per step instead of 0.05 ms.
const SOLVER_ITERATIONS = 16;
const PGS_ITERATIONS = 4;

/** Rapier's wasm must be ready before any body is created. */
export async function initPhysics() {
  await RAPIER.init();
  physics.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physics.world.timestep = STEP;
  physics.world.numSolverIterations = SOLVER_ITERATIONS;
  physics.world.numInternalPgsIterations = PGS_ITERATIONS;
  physics.events = new RAPIER.EventQueue(true);
}

/** One fixed step with its hooks; the render loop calls it, and so can a test (deterministic, faster than real time). */
export function stepPhysics() {
  rememberPoses();
  for (const fn of physics.beforeStep) fn();
  physics.world.step(physics.events);
  physics.events.drainCollisionEvents((a, b, started) => {
    for (const fn of physics.onCollision) fn(a, b, started);
  });
  for (const fn of physics.afterStep) fn();
}

export class RapierSystem extends createSystem({ links: { required: [PhysicsLink] } }) {
  private accumulator = 0;

  update(delta: number) {
    this.accumulator = Math.min(this.accumulator + delta, STEP * MAX_STEPS);
    const start = performance.now();
    let steps = 0;
    while (this.accumulator >= STEP) {
      stepPhysics();
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
