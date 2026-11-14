import RAPIER from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3, type Object3D } from "@iwsdk/core";
import { controlInput } from "../input/control-input";
import { STEP, physics, renderPose, setJointFriction, setJointMotor, toQuat, toVec, worldPoint } from "../systems/rapier-system";
import { JOINT_FRICTION, type Rig, type RigPart } from "./rig";
import type { createStrings } from "./strings";

// The player's own body as the puppet's (WebXR, src/xr/): while
// ControlInput.body is active, the puppet's head is held on the head target,
// its hands are drawn to the hand targets, and the chest turns after the
// head. Everything else stays a ragdoll and hangs from the head, as it does
// from the head strings otherwise. The cross only tags along above the head,
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
/** The chest turns after the head only beyond this angle, rad: a glance to the side leaves the body alone. */
const CHEST_FREE_TURN = 0.3;
const CHEST_TURN_GAIN = 6; // 1/s
const MAX_CHEST_TURN = 4; // rad/s
/**
 * Motor factor while the chest turns (the joint's friction is 10). The feet
 * stand on the floor and hold the body back: measured after a quarter turn of
 * the head (0.4 rad of free turn), the chest stops 0.75 rad short at 40,
 * 0.5 at 400, 0.43 at 4000.
 */
const CHEST_TURN_FORCE = 400;

export interface BodyDrive {
  /** Height of the eyes above the puppet's feet at rest, m. */
  eyeHeight: number;
  /** Where the eyes are now (as rendered). */
  eye(out: Vector3): Vector3;
  /** Hides what the camera sits inside while the player looks out of the puppet's eyes. */
  setFirstPerson(on: boolean): void;
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
  // Head to chest (the neck bone is fixed on the chest)
  const neck = head.joint;

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
  // Where the cross rests: its place above the eyes is kept while the body drives
  const barRest = controlInput.bar.position.clone();
  const crossOffset = barRest.clone().sub(restEye);

  let driving = false;
  const headP = new Vector3();
  const headQ = new Quaternion();
  const yawQ = new Quaternion();
  const a = new Vector3();
  const b = new Vector3();
  const q = new Quaternion();
  const sideways = new Vector3();

  // The wrists' own friction holds a hand against the turn it is given: off while the hands are driven
  function wristFriction(factor: number) {
    for (const arm of arms) if (arm.hand.joint) for (const axis of ANGULAR_AXES) setJointFriction(arm.hand.joint, axis, factor);
  }

  function start() {
    // Kinematic: the head is exactly where the player's head is, whatever hangs on it
    head!.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    toVec(head!.body.translation(), headP);
    toQuat(head!.body.rotation(), headQ);
    strings.setSlack(STRING_SLACK);
    wristFriction(0);
  }

  function stop() {
    head!.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    if (neck) setJointMotor(neck, RAPIER.JointAxis.AngX, 0, JOINT_FRICTION);
    wristFriction(JOINT_FRICTION);
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

    // Chest: only the head is tracked, so the body turns after it once the
    // head is turned further than a glance. Driven by the motor of the neck
    // joint (its x axis is the head's own axis), which otherwise is the
    // joint's friction. It has to be strong: the feet stand on the floor and
    // hold the body back (CHEST_TURN_FORCE).
    if (chest && neck) {
      let turn = headYaw - yawOf(toQuat(chest.body.rotation(), q), sideways);
      turn = Math.atan2(Math.sin(turn), Math.cos(turn)); // shortest way round
      turn = Math.sign(turn) * Math.max(0, Math.abs(turn) - CHEST_FREE_TURN);
      const rate = Math.max(-MAX_CHEST_TURN, Math.min(MAX_CHEST_TURN, turn * CHEST_TURN_GAIN));
      // The motor sets the head's turn relative to the chest: the opposite way
      setJointMotor(neck, RAPIER.JointAxis.AngX, -rate, rate === 0 ? JOINT_FRICTION : CHEST_TURN_FORCE);
    }

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

      // The turn that is still missing, as a rotation vector. The hand gets
      // only as far as the wrist allows (60° of swing, 30° of twist; the
      // elbow is a hinge): measured, it follows a 40° bend to within 10°,
      // and a 40° turn about the arm's axis hardly at all.
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
