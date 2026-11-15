import RAPIER from "@dimforge/rapier3d-compat";
import { Matrix4, PropertyBinding, Quaternion, Vector3, type Object3D } from "@iwsdk/core";
import type { RockId, StringId } from "../input/control-input";
import { GROUP, physics, renderPose, setJointFriction, setJointLimits, setJointSpring } from "../systems/rapier-system";

// Ragdoll from a rig description (marionette.ts): one capsule body per bone,
// joints at the child bone heads, and every frame the skeleton's bones
// follow the (interpolated) bodies.
//
// All bodies start unrotated; each capsule is turned by its collider
// instead. Then every joint frame is aligned at rest, and Rapier's revolute
// joint (one axis for both bodies) works for any bone orientation.
//
// Joints keep the limits from the rig: a wooden marionette cannot fold its
// body, spin its head or bend a knee backwards, and without limits the
// ragdoll does all of that as soon as the cross is shaken.

// Air drag only: the joints have their own limits and friction. A part may ask for more (RigBone.linearDamping, angularDamping)
const LINEAR_DAMPING = 0.5;
const ANGULAR_DAMPING = 1;
/**
 * Resistance of the joints themselves (wood on wire loops): a motor on every
 * free rotation that pulls its speed towards 0. Limbs still dangle and swing,
 * but come to rest after a few beats. Measured after letting a rocker go: an
 * arm swings for 1.7 s instead of 2.6 s, the head wobbles for 1.9 s instead
 * of 4.7 s; at 40 arms and legs stop within a second. The default; a part may
 * have its own (RigBone.friction).
 */
const JOINT_FRICTION = 10;

export type RigJoint =
  // Swing: how far the bone may lean off its rest direction; twist: turning about its own axis. Rad, ± from the rest pose
  | { type: "cone"; swing: number; twist: number }
  // Axis in bone-local space; limits in rad, right-hand rule, from the rest pose
  | { type: "revolute"; axis: Vector3; limits: [number, number] }
  // Rigid on its parent (the feet): no body of its own, its collider joins the parent's body
  | { type: "fixed" };

const ANGULAR_AXES = [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ];

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
  /**
   * The centre of mass lies this far off the capsule's middle (root-local, m):
   * a part weighted on one side, like a head with lead in its face
   */
  massOffset?: Vector3;
  joint?: RigJoint;
  /** Friction of this part's joint (1/s: how fast its turning dies down); the default if left out */
  friction?: number;
  /** Air drag on this part's turning and on its moving (1/s); the defaults if left out */
  angularDamping?: number;
  linearDamping?: number;
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
  /** Rocking range, rad (± about the axis) */
  limit: number;
  /** Can be taken off the cross and moved freely (ControlInput.handBar) */
  detachable: boolean;
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
  name: string;
  bone: Object3D;
  /** A part that is fixed on its parent shares the parent's body */
  body: RAPIER.RigidBody;
  joint?: RAPIER.ImpulseJoint;
  /**
   * A cone joint's twist: turns the part about its own long axis against its
   * parent by `angle` rad (+ = about the puppet's up axis, right-hand rule: to
   * its left), held there by a spring (ω² and 2ζω, see setJointSpring).
   */
  twistTo?: (angle: number, stiffness: number, damping: number) => void;
  /** Body-local end of the capsule (hand tips: where they hold props, grab.ts) */
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
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Principal inertia of a solid capsule along y (a cylinder and two half balls), as Rapier computes it for setMass */
function capsuleInertia(mass: number, halfHeight: number, radius: number) {
  const [r2, cylinder, ball] = [radius * radius, 2 * halfHeight * radius * radius, (4 / 3) * radius ** 3];
  const [mc, mb] = [(mass * cylinder) / (cylinder + ball), (mass * ball) / (cylinder + ball)];
  const along = (mc * r2) / 2 + (2 * mb * r2) / 5;
  const across = mc * (r2 / 4 + (halfHeight * halfHeight) / 3) + mb * ((83 / 320) * r2 + (halfHeight + (3 * radius) / 8) ** 2);
  return { x: across, y: along, z: across };
}

export function buildRig(root: Object3D, description: RigDescription): Rig {
  const pw = physics.world;
  root.updateMatrixWorld(true);
  const toWorld = (v: Vector3) => v.clone().applyMatrix4(root.matrixWorld);
  const sideways = new Vector3(1, 0, 0).transformDirection(root.matrixWorld);
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

    const halfHeight = Math.max(0.0005, axis.length() / 2);
    const turned = new Quaternion().setFromUnitVectors(Y, axis.clone().normalize());
    const capsule = RAPIER.ColliderDesc.capsule(halfHeight, spec.radius)
      .setRotation(turned)
      .setMass(spec.mass)
      .setCollisionGroups(spec.group === "limb" ? GROUP.limb : GROUP.puppet)
      // Contact starts drive the wooden clatter (audio/impacts.ts)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    if (spec.massOffset) {
      // Same mass and the capsule's own inertia, only the centre moves (in the collider's frame, whose y is the capsule's axis)
      const offset = spec.massOffset.clone().transformDirection(root.matrixWorld).multiplyScalar(spec.massOffset.length()).applyQuaternion(turned.clone().invert());
      capsule.setMassProperties(spec.mass, offset, capsuleInertia(spec.mass, halfHeight, spec.radius), { x: 0, y: 0, z: 0, w: 1 });
    }

    // The nearest ancestor that has a body
    let parentName = spec.parent;
    while (parentName && !byName.has(parentName)) parentName = known.get(parentName)?.parent;
    const parent = parentName ? byName.get(parentName) : undefined;

    let body: RAPIER.RigidBody;
    let joint: RAPIER.ImpulseJoint | undefined;
    let twistTo: RigPart["twistTo"];
    const friction = spec.friction ?? JOINT_FRICTION;
    if (parent && spec.joint?.type === "fixed") {
      // Rigid on its parent: one body with two capsules. Nothing for the solver
      // to hold together, which a fixed joint between two light bodies would be
      body = parent.body;
      const origin = body.translation();
      pw.createCollider(capsule.setTranslation(center.x - origin.x, center.y - origin.y, center.z - origin.z), body);
    } else {
      body = pw.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(center.x, center.y, center.z)
          .setLinearDamping(spec.linearDamping ?? LINEAR_DAMPING)
          .setAngularDamping(spec.angularDamping ?? ANGULAR_DAMPING),
      );
      pw.createCollider(capsule, body);
    }

    if (parent && spec.joint && spec.joint.type !== "fixed") {
      const p = parent.body.translation();
      const anchor1 = { x: head.x - p.x, y: head.y - p.y, z: head.z - p.z };
      const anchor2 = { x: head.x - center.x, y: head.y - center.y, z: head.z - center.z };
      if (spec.joint.type === "revolute") {
        // Bone-local axis → world at rest = the same in both (unrotated) bodies
        const worldAxis = spec.joint.axis.clone().applyQuaternion(bone.getWorldQuaternion(new Quaternion())).normalize();
        joint = pw.createImpulseJoint(
          RAPIER.JointData.revolute(anchor1, anchor2, { x: worldAxis.x, y: worldAxis.y, z: worldAxis.z }),
          parent.body,
          body,
          true,
        );
        (joint as RAPIER.RevoluteImpulseJoint).setLimits(...spec.joint.limits);
        if (friction > 0) (joint as RAPIER.RevoluteImpulseJoint).configureMotorVelocity(0, friction);
      } else {
        // Cone: a ball joint (a generic joint with only the position locked)
        // with a limit on each rotation. The joint's x axis is the bone's rest
        // direction (twist); y is the puppet's left–right axis and z what is
        // left, so the swing limit holds for leaning forwards / backwards and
        // sideways (the corners between the two reach √2 times as far).
        const along = axis.clone().normalize();
        const z = new Vector3().crossVectors(along, sideways);
        if (z.lengthSq() < 1e-6) z.crossVectors(along, Y);
        z.normalize();
        const frame = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(along, new Vector3().crossVectors(z, along), z));
        const { LinX, LinY, LinZ } = RAPIER.JointAxesMask;
        joint = pw.createImpulseJoint(
          RAPIER.JointData.generic(anchor1, anchor2, { x: along.x, y: along.y, z: along.z }, LinX | LinY | LinZ),
          parent.body,
          body,
          true,
        );
        joint.setLocalFrame1(anchor1, frame);
        joint.setLocalFrame2(anchor2, frame);
        const { swing, twist } = spec.joint;
        ANGULAR_AXES.forEach((angular, i) => {
          setJointLimits(joint!, angular, i === 0 ? -twist : -swing, i === 0 ? twist : swing);
          if (friction > 0) setJointFriction(joint!, angular, friction);
        });
        // The joint's x axis is the bone's direction, which points up or down the puppet
        const up = Math.sign(along.y) || 1;
        const cone = joint;
        twistTo = (angle, stiffness, damping) => setJointSpring(cone, RAPIER.JointAxis.AngX, clamp(up * angle, -twist, twist), stiffness, damping);
      }
    }

    const origin = body.translation();
    const part: RigPart = {
      name: spec.name,
      bone,
      body,
      joint,
      twistTo,
      tail: b.clone().sub(origin),
      restQuaternion: bone.getWorldQuaternion(new Quaternion()),
      restOffset: bone.getWorldPosition(new Vector3()).sub(origin),
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
