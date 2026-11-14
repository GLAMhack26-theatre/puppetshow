import RAPIER from "@dimforge/rapier3d-compat";
import { Matrix4, PropertyBinding, Quaternion, Vector3, type Object3D } from "@iwsdk/core";
import type { RockId, StringId } from "../input/control-input";
import { GROUP, physics, renderPose } from "../systems/rapier-system";

// Ragdoll from a rig description (marionette.ts): one capsule body per bone,
// joints at the child bone heads, and every frame the skeleton's bones
// follow the (interpolated) bodies.
//
// All bodies start unrotated; each capsule is turned by its collider
// instead. Then every joint frame is aligned at rest, and Rapier's revolute
// joint (one axis for both bodies) works for any bone orientation.

const LINEAR_DAMPING = 0.5;
const ANGULAR_DAMPING = 3; // calms the spherical joints, which have no cone limits in Rapier's JS API

export type RigJoint =
  | { type: "spherical" }
  // Axis in bone-local space; limits in rad, right-hand rule, from the rest pose
  | { type: "revolute"; axis: Vector3; limits: [number, number] };

/** Points are in the puppet root's local space. */
export interface RigBone {
  name: string;
  parent?: string;
  head: Vector3;
  /** Capsule segment and radius */
  a: Vector3;
  b: Vector3;
  radius: number;
  mass: number;
  joint?: RigJoint;
  /** "limb" parts don't collide with props, so a hand can reach into them to grab */
  group: "body" | "limb";
}

export interface RigString {
  id: StringId;
  /** Bone whose body carries the string */
  bone: string;
  position: Vector3;
  /** Bar of the control cross that carries the upper end */
  bar: string;
  /** Upper end (the eye on the bar), at rest */
  barPoint: Vector3;
  restLength: number;
}

/** One bar of the control cross (Spielkreuz). Points are in the puppet root's local space, at rest. */
export interface RigBar {
  name: string;
  /** Rocking bars hang on the main bar (no parent) */
  parent?: string;
  /** Origin of the bar: the grip for the main bar, the pin for a rocking bar */
  pivot: Vector3;
  /** Rocking axis (unit); + lifts the puppet's left end */
  axis?: Vector3;
  input?: RockId;
  /** For drawing: square sticks from a to b */
  sticks: { a: Vector3; b: Vector3 }[];
}

export interface RigController {
  stickSize: number;
  bars: RigBar[];
}

export interface RigDescription {
  bones: RigBone[];
  strings: RigString[];
  controller: RigController;
}

export interface RigPart {
  bone: Object3D;
  body: RAPIER.RigidBody;
  /** Body-local end of the capsule (hand tips: grab sensors) */
  tail: Vector3;
  // Bone pose relative to its body (the body is unrotated at rest)
  restQuaternion: Quaternion;
  restOffset: Vector3;
  restScale: Vector3;
  world: Matrix4;
}

export interface Rig {
  parts: RigPart[];
  byName: Map<string, RigPart>;
}

const Y = new Vector3(0, 1, 0);

export function buildRig(root: Object3D, description: RigDescription): Rig {
  const pw = physics.world;
  root.updateMatrixWorld(true);
  const toWorld = (v: Vector3) => v.clone().applyMatrix4(root.matrixWorld);
  const known = new Map(description.bones.map((b) => [b.name, b]));
  const parts: RigPart[] = [];
  const byName = new Map<string, RigPart>();
  const byBone = new Map<Object3D, RigPart>();

  for (const spec of description.bones) {
    // GLTFLoader strips "." from node names (hand.L → handL)
    const bone = root.getObjectByName(PropertyBinding.sanitizeNodeName(spec.name));
    if (!bone) continue;
    const a = toWorld(spec.a);
    const b = toWorld(spec.b);
    const head = toWorld(spec.head);
    const center = a.clone().add(b).multiplyScalar(0.5);
    const axis = b.clone().sub(a);

    const body = pw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(center.x, center.y, center.z)
        .setLinearDamping(LINEAR_DAMPING)
        .setAngularDamping(ANGULAR_DAMPING),
    );
    pw.createCollider(
      RAPIER.ColliderDesc.capsule(Math.max(0.0005, axis.length() / 2), spec.radius)
        .setRotation(new Quaternion().setFromUnitVectors(Y, axis.clone().normalize()))
        .setMass(spec.mass)
        .setCollisionGroups(spec.group === "limb" ? GROUP.limb : GROUP.puppet)
        // Contact starts drive the wooden clatter (audio/impacts.ts)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );

    // Joint to the nearest ancestor that has a body
    let parentName = spec.parent;
    while (parentName && !byName.has(parentName)) parentName = known.get(parentName)?.parent;
    const parent = parentName ? byName.get(parentName) : undefined;
    if (parent && spec.joint) {
      const p = parent.body.translation();
      const anchor1 = { x: head.x - p.x, y: head.y - p.y, z: head.z - p.z };
      const anchor2 = { x: head.x - center.x, y: head.y - center.y, z: head.z - center.z };
      if (spec.joint.type === "revolute") {
        // Bone-local axis → world at rest = the same in both (unrotated) bodies
        const worldAxis = spec.joint.axis.clone().applyQuaternion(bone.getWorldQuaternion(new Quaternion())).normalize();
        const joint = pw.createImpulseJoint(
          RAPIER.JointData.revolute(anchor1, anchor2, { x: worldAxis.x, y: worldAxis.y, z: worldAxis.z }),
          parent.body,
          body,
          true,
        );
        (joint as RAPIER.RevoluteImpulseJoint).setLimits(...spec.joint.limits);
      } else {
        pw.createImpulseJoint(RAPIER.JointData.spherical(anchor1, anchor2), parent.body, body, true);
      }
    }

    const part: RigPart = {
      bone,
      body,
      tail: b.clone().sub(center),
      restQuaternion: bone.getWorldQuaternion(new Quaternion()),
      restOffset: bone.getWorldPosition(new Vector3()).sub(center),
      restScale: bone.getWorldScale(new Vector3()),
      world: new Matrix4(),
    };
    parts.push(part);
    byName.set(spec.name, part);
    byBone.set(bone, part);
  }

  // Bones follow the bodies, parents first (description order): world pose
  // from the body, local pose relative to the parent's new world pose
  const p = new Vector3();
  const q = new Quaternion();
  const offset = new Vector3();
  const boneQ = new Quaternion();
  const parentInverse = new Matrix4();
  const local = new Matrix4();
  physics.afterSync.push(() => {
    for (const part of parts) {
      renderPose(part.body, p, q);
      p.add(offset.copy(part.restOffset).applyQuaternion(q));
      boneQ.copy(q).multiply(part.restQuaternion);
      part.world.compose(p, boneQ, part.restScale);
      const parent = part.bone.parent!;
      parentInverse.copy(byBone.get(parent)?.world ?? parent.matrixWorld).invert();
      local.multiplyMatrices(parentInverse, part.world);
      local.decompose(part.bone.position, part.bone.quaternion, part.bone.scale);
    }
  });

  return { parts, byName };
}
