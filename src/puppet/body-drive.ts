import RAPIER from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3, type Object3D } from "@iwsdk/core";
import { controlInput } from "../input/control-input";
import { STEP, physics, renderPose, setJointFriction, setJointMotor, toQuat, toVec, worldPoint } from "../systems/rapier-system";
import { createWalk } from "./body-walk";
import type { Rig, RigPart } from "./rig";
import type { createStrings } from "./strings";

// The player's own body as the puppet's (WebXR, src/xr/): while
// ControlInput.body is active, the puppet's head is held on the head target,
// its hands are drawn to the hand targets, the body turns after the head,
// and the legs take steps when the head travels (body-walk.ts). Everything
// else stays a ragdoll and hangs from the head, as it does from the head
// strings otherwise. The cross only tags along above the head,
// with slack strings, so the player sees their own strings going up.
//
// The view never depends on these bodies: the camera stays on the tracked
// head (xr-embodiment.ts), and the puppet follows it with capped speeds.

/** The eyes in the head body's frame (origin: middle of the head, +z the face), m. */
const EYE = new Vector3(0, 0.005, 0.015);
/** Meshes the camera sits inside: hidden in first person. */
const FIRST_PERSON_HIDDEN = ["Head", "Hat", "HatRosette"];
/** Extra string length while the body drives, m: reaching out or bowing must not pull a string taut. */
const STRING_SLACK = 0.08;
const MAX_HEAD_SPEED = 1.5; // m/s: switching on or a tracking glitch must not whip the ragdoll
const MAX_HEAD_TURN = 8; // rad/s
const HAND_GAIN = 30; // 1/s: the hand closes half the gap to its target per step
const MAX_HAND_SPEED = 1.5; // m/s
const HAND_TURN_GAIN = 20; // 1/s
const MAX_HAND_TURN = 12; // rad/s
/** Share of the arm's length a hand target may be from the shoulder: an unreachable target would drag the torso. */
const REACH = 0.97;
/** The body turns after the head only once the head is turned this far from it, rad: a glance to the side leaves it alone. */
const BODY_FREE_TURN = 0.3;
/** Once it turns it goes all the way, until it is this close, rad: a quarter turn of the player is one of the puppet. */
const BODY_ALIGNED = 0.05;
const BODY_TURN_GAIN = 12; // 1/s
const MAX_BODY_TURN = 4; // rad/s
/**
 * Motor factor while a part turns (the joints' friction is 10). The feet
 * stand on the floor and hold the body back: measured after a quarter turn of
 * the head at a gain of 6, the chest stops 0.35 rad short of where it is sent
 * at 40, 0.1 at 400, 0.03 at 4000.
 */
const BODY_TURN_FORCE = 1000;

export interface BodyDrive {
  /** Height of the eyes above the puppet's feet at rest, m. */
  eyeHeight: number;
  /** Where the eyes are now (as rendered). */
  eye(out: Vector3): Vector3;
  /** Hides what the camera sits inside while the player looks out of the puppet's eyes. */
  setFirstPerson(on: boolean): void;
  /** Whether a player's body is driving the puppet right now. */
  driving(): boolean;
  /** How much the legs are stepping (body-walk.ts): 0 hanging … 1 full steps. */
  stepping(): number;
  /** Called when a player's body takes the puppet over. */
  onStart(listener: () => void): void;
}

/** Every puppet that can be driven by a body (the XR player takes the first). */
export const bodyDrives: BodyDrive[] = [];

interface Arm {
  side: "left" | "right";
  hand: RigPart;
  upper: RigPart;
  /** The shoulder joint in the upper arm's body frame */
  shoulder: RAPIER.Vector;
  /** Shoulder to the middle of the hand, arm stretched, m */
  length: number;
}

const UP = new Vector3(0, 1, 0);
/** An angle as the shortest way round, −π…π. */
const shortest = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const ANGULAR_AXES = [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ];
/**
 * Turn about the vertical axis, rad (0: facing +z). From the sideways axis,
 * not from where the face points: that has no direction when the head looks
 * straight up or down, and flips beyond.
 */
const yawOf = (q: Quaternion, sideways = new Vector3()) => {
  sideways.set(1, 0, 0).applyQuaternion(q);
  return Math.atan2(-sideways.z, sideways.x);
};

export function createBodyDrive(root: Object3D, rig: Rig, strings: ReturnType<typeof createStrings>): BodyDrive | undefined {
  const head = rig.byName.get("head");
  if (!head) return undefined; // a rig without a head has no eyes to look out of
  const chest = rig.byName.get("chest");
  const pelvis = rig.byName.get("pelvis");
  // Head to chest (the neck bone is fixed on the chest), and chest to pelvis
  const neck = head.joint;
  const waist = chest?.joint;

  // At rest (bodies unrotated): bone origins are body origin + restOffset
  const boneOrigin = (part: RigPart) => toVec(part.body.translation()).add(part.restOffset);
  const arms: Arm[] = (["left", "right"] as const).flatMap((side) => {
    const suffix = side === "left" ? "L" : "R";
    const hand = rig.byName.get(`hand.${suffix}`);
    const upper = rig.byName.get(`upper_arm.${suffix}`);
    const forearm = rig.byName.get(`forearm.${suffix}`);
    if (!hand || !upper || !forearm) return [];
    const [shoulder, elbow, wrist] = [boneOrigin(upper), boneOrigin(forearm), boneOrigin(hand)];
    const length = shoulder.distanceTo(elbow) + elbow.distanceTo(wrist) + wrist.distanceTo(toVec(hand.body.translation()));
    const { x, y, z } = upper.restOffset;
    return [{ side, hand, upper, shoulder: { x, y, z }, length }];
  });

  const restEye = toVec(head.body.translation()).add(EYE);
  // Steps when the player walks (their legs are not tracked)
  const walk = createWalk(rig, head.body.translation().y - root.getWorldPosition(new Vector3()).y);
  // Where the cross rests: its place above the eyes is kept while the body drives
  const barRest = controlInput.bar.position.clone();
  const crossOffset = barRest.clone().sub(restEye);

  let driving = false;
  // Where the chest is held, and whether it is on its way to the head's turn
  // (it goes all the way once it starts)
  let bodyYaw = 0;
  let turning = false;
  // The head body's turn at the last step, for its turning rate
  let headBodyYawBefore = 0;
  const headP = new Vector3();
  const headQ = new Quaternion();
  const yawQ = new Quaternion();
  const a = new Vector3();
  const b = new Vector3();
  const q = new Quaternion();
  const sideways = new Vector3();

  // The wrists' own friction holds a hand against the turn it is given: off while the hands are driven
  function wristFriction(factor?: number) {
    for (const arm of arms) if (arm.hand.joint) for (const axis of ANGULAR_AXES) setJointFriction(arm.hand.joint, axis, factor ?? arm.hand.friction);
  }

  /**
   * Turns the joint's parent body by `turn` rad, whatever its child does
   * (`childRate`: the child's own turning, rad/s).
   */
  function follow(joint: RAPIER.ImpulseJoint, turn: number, childRate: number) {
    const rate = Math.max(-MAX_BODY_TURN, Math.min(MAX_BODY_TURN, turn * BODY_TURN_GAIN));
    // The motor sets the child's turn relative to the parent. Without the
    // child's own rate in it, a parent that should stay put would be dragged
    // along: a glance of the head would swing the chest out and back.
    setJointMotor(joint, RAPIER.JointAxis.AngX, childRate - rate, BODY_TURN_FORCE);
  }

  const starting: Array<() => void> = [];

  function start() {
    for (const listener of starting) listener();
    // Kinematic: the head is exactly where the player's head is, whatever hangs on it
    head!.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    toVec(head!.body.translation(), headP);
    toQuat(head!.body.rotation(), headQ);
    bodyYaw = chest ? yawOf(toQuat(chest.body.rotation(), q), sideways) : 0;
    turning = false;
    headBodyYawBefore = yawOf(headQ, sideways);
    strings.setSlack(STRING_SLACK);
    wristFriction(0);
  }

  function stop() {
    head!.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    // The joints' own friction again (each part has its own, rig.ts). The neck's twist is the head-turn spring's from the next step on (strings.ts)
    for (const part of [head!, chest]) if (part?.joint) setJointMotor(part.joint, RAPIER.JointAxis.AngX, 0, part.friction);
    walk?.stop();
    wristFriction();
    strings.setSlack(0);
    // Back on the strings alone: the cross returns to where it rests
    controlInput.bar.position.copy(barRest);
    controlInput.bar.rotation.identity();
  }

  physics.beforeStep.push(() => {
    const input = controlInput.body;
    if (input.active !== driving) {
      driving = input.active;
      if (driving) start();
      else stop();
    }
    if (!driving) return;

    // Head: towards the target with capped speeds; the eyes land on the target
    headQ.rotateTowards(input.head.rotation, MAX_HEAD_TURN * STEP);
    a.copy(EYE).applyQuaternion(headQ).negate().add(input.head.position);
    headP.add(a.sub(headP).clampLength(0, MAX_HEAD_SPEED * STEP));
    head.body.setNextKinematicTranslation(headP);
    head.body.setNextKinematicRotation(headQ);

    // Cross: above the eyes as at rest, turned with the head but kept level
    const headYaw = yawOf(input.head.rotation, sideways);
    yawQ.setFromAxisAngle(UP, headYaw);
    controlInput.bar.position.copy(crossOffset).applyQuaternion(yawQ).add(input.head.position);
    controlInput.bar.rotation.copy(yawQ);

    // Body: only the head is tracked, so the chest turns after it once the
    // head is turned further than a glance, and then all the way: the player
    // turning to walk across the stage turns the puppet. In between the chest
    // is held where it arrived (the feet dragging on the floor pull it back).
    // The pelvis, and the legs on it, follows the chest. Both through the motor
    // of the joint above them (its x axis is the bone's own axis), which
    // otherwise is the joint's friction.
    if (chest && neck) {
      const chestYaw = yawOf(toQuat(chest.body.rotation(), q), sideways);
      if (Math.abs(shortest(headYaw - bodyYaw)) > BODY_FREE_TURN) turning = true;
      if (turning) {
        bodyYaw = headYaw;
        turning = Math.abs(shortest(headYaw - chestYaw)) > BODY_ALIGNED;
      }
      const headBodyYaw = yawOf(headQ, sideways);
      follow(neck, shortest(bodyYaw - chestYaw), shortest(headBodyYaw - headBodyYawBefore) / STEP);
      headBodyYawBefore = headBodyYaw;
      if (pelvis && waist) follow(waist, shortest(chestYaw - yawOf(toQuat(pelvis.body.rotation(), q), sideways)), chest.body.angvel().y);
    }

    // Legs: steps while the head travels, facing the way the pelvis does
    walk?.step(headP, pelvis ? yawOf(toQuat(pelvis.body.rotation(), q), sideways) : headYaw);

    // Hands: velocities towards the targets; the arm's joints do the rest
    for (const arm of arms) {
      const target = input.hands[arm.side];
      if (!target.tracked) continue;
      const body = arm.hand.body;
      worldPoint(arm.upper.body, arm.shoulder, a);
      b.copy(target.position).sub(a).clampLength(0, arm.length * REACH).add(a);
      b.sub(toVec(body.translation(), a)).multiplyScalar(HAND_GAIN).clampLength(0, MAX_HAND_SPEED);
      // Plus what gravity takes away during the step, or the hand hangs below its target
      b.y -= physics.world.gravity.y * STEP;
      body.setLinvel(b, true);

      // The turn that is still missing, as a rotation vector. Weak so far:
      // measured, the hand stays 30–75° off a target turned up to 40° from
      // rest, also with the wrist's limits lifted. The hand's middle is held
      // on its target and its wrist end by the arm, which leaves it little
      // freedom to turn; it needs the arm posed for the rotation (docs/xr.md).
      q.copy(toQuat(body.rotation(), q).invert()).premultiply(target.rotation);
      if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      const sin = Math.hypot(q.x, q.y, q.z);
      const angle = 2 * Math.atan2(sin, q.w);
      a.set(q.x, q.y, q.z).multiplyScalar(sin > 1e-6 ? (angle * HAND_TURN_GAIN) / sin : 0).clampLength(0, MAX_HAND_TURN);
      body.setAngvel(a, true);
    }
  });

  const drive: BodyDrive = {
    eyeHeight: restEye.y - root.getWorldPosition(new Vector3()).y,
    eye(out) {
      renderPose(head.body, out, q);
      return out.add(a.copy(EYE).applyQuaternion(q));
    },
    driving: () => driving,
    stepping: () => walk?.level() ?? 0,
    onStart: (listener) => void starting.push(listener),
    setFirstPerson(on) {
      for (const name of FIRST_PERSON_HIDDEN) {
        const mesh = root.getObjectByName(name);
        if (mesh) mesh.visible = !on;
      }
    },
  };
  bodyDrives.push(drive);
  return drive;
}
