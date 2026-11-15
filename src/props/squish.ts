import RAPIER from "@dimforge/rapier3d-compat";
import { Group, Matrix4, Quaternion, Vector3 } from "@iwsdk/core";
import { physics } from "../systems/rapier-system";
import { impactVelocity } from "./contacts";

// Soft props, as a visual effect only: on an impact the model squashes along
// the direction it was hit from, about the face that took the hit, and
// wobbles back (a damped oscillation, volume kept). The collider stays rigid:
// Rapier has no soft bodies, and one built from bodies on springs would be
// unstable at a few grams and costly. The bounce itself is the collider's
// restitution (materials.ts).

export const SQUISH = {
  /** Below this relative speed (m/s) an impact does not squash (settling, sliding) */
  minSpeed: 0.12,
  /** Relative speed at which the squash is full */
  fullSpeed: 1.2,
  /** Squash at squish 1 and full speed: the model is this much shorter along the hit */
  maxSquash: 0.4,
  /** Hz of the wobble and its decay time (s); it stops after `duration` s */
  frequency: 7,
  decay: 0.1,
  duration: 0.5,
};

interface Soft {
  /** Sits between the prop's holder (moved by the physics) and its model */
  group: Group;
  body: RAPIER.RigidBody;
  /** Half the model's bounding box, in the group's space */
  half: Vector3;
  squish: number;
  /** Seconds since the impact; ≥ SQUISH.duration when at rest */
  t: number;
  amplitude: number;
  /** Direction towards the face that was hit, in the group's space */
  normal: Vector3;
}

const softs = new Map<number, Soft>();
let listening = false;

/** Squashes `group` when the collider is hit; `half` is half the model's size. */
export function addSquish(collider: RAPIER.Collider, group: Group, half: Vector3, squish: number) {
  if (squish <= 0) return;
  if (!listening) {
    listening = true;
    physics.onCollision.push(onContact);
  }
  group.matrixAutoUpdate = false;
  softs.set(collider.handle, {
    group,
    body: collider.parent()!,
    half: half.clone(),
    squish: Math.min(1, squish),
    t: SQUISH.duration,
    amplitude: 0,
    normal: new Vector3(0, -1, 0),
  });
}

export function removeSquish(collider: RAPIER.Collider) {
  const soft = softs.get(collider.handle);
  if (!soft) return;
  soft.group.matrix.identity();
  soft.group.matrixWorldNeedsUpdate = true;
  softs.delete(collider.handle);
}

const relative = new Vector3();
const inverse = new Quaternion();

function onContact(a: number, b: number, started: boolean) {
  if (!started) return;
  for (const [self, other] of [
    [a, b],
    [b, a],
  ]) {
    const soft = softs.get(self);
    if (!soft) continue;
    // The prop's motion against what it meets, as they met, points at the face that is hit
    const v = impactVelocity(self, other);
    relative.set(v.x, v.y, v.z);
    const speed = relative.length();
    if (speed < SQUISH.minSpeed) continue;
    const strength = Math.min(1, (speed - SQUISH.minSpeed) / (SQUISH.fullSpeed - SQUISH.minSpeed));
    const amplitude = soft.squish * strength * SQUISH.maxSquash;
    // A smaller hit does not cut a bigger wobble short
    if (soft.t < SQUISH.duration && amplitude < currentSquash(soft)) continue;
    const r = soft.body.rotation();
    inverse.set(r.x, r.y, r.z, r.w).invert();
    soft.normal.copy(relative).normalize().applyQuaternion(inverse);
    soft.amplitude = amplitude;
    soft.t = 0;
  }
}

function currentSquash(soft: Soft) {
  return Math.abs(soft.amplitude * Math.exp(-soft.t / SQUISH.decay));
}

const scale = new Matrix4();
const pivot = new Vector3();
const moved = new Vector3();

/** Per frame (RequisitSystem). */
export function updateSquish(delta: number) {
  for (const soft of softs.values()) {
    if (soft.t >= SQUISH.duration) continue;
    soft.t += delta;
    const { group, normal: n, half } = soft;
    if (soft.t >= SQUISH.duration) {
      group.matrix.identity();
      group.matrixWorldNeedsUpdate = true;
      continue;
    }
    // Squashed (> 0) and stretched back (< 0), dying down
    const s = soft.amplitude * Math.exp(-soft.t / SQUISH.decay) * Math.cos(2 * Math.PI * SQUISH.frequency * soft.t);
    const along = 1 - Math.min(0.8, s);
    const across = 1 / Math.sqrt(along); // keeps the volume
    // S = across·I + (along − across)·n nᵀ
    const k = along - across;
    scale.set(
      across + k * n.x * n.x, k * n.x * n.y, k * n.x * n.z, 0,
      k * n.y * n.x, across + k * n.y * n.y, k * n.y * n.z, 0,
      k * n.z * n.x, k * n.z * n.y, across + k * n.z * n.z, 0,
      0, 0, 0, 1,
    );
    // About the face that took the hit, so a prop landing on the floor stays on it
    pivot.copy(n).multiplyScalar(Math.abs(n.x) * half.x + Math.abs(n.y) * half.y + Math.abs(n.z) * half.z);
    moved.copy(pivot).applyMatrix4(scale);
    scale.setPosition(pivot.x - moved.x, pivot.y - moved.y, pivot.z - moved.z);
    group.matrix.copy(scale);
    group.matrixWorldNeedsUpdate = true;
  }
}
