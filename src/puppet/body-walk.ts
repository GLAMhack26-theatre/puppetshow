import type RAPIER from "@dimforge/rapier3d-compat";
import { Vector3 } from "@iwsdk/core";
import { STEP } from "../systems/rapier-system";
import type { Rig } from "./rig";

// Walking while a player's body drives the puppet (body-drive.ts): the
// player's legs are not tracked, so when the head travels across the floor
// the puppet takes steps of its own. The hips and knees (hinges) get
// position motors on a gait that advances with the distance covered: one
// leg swings forward with the knee bent while the other stays back, then
// they change. Standing still, the legs hang on the joints' friction as
// always.
//
// The legs only swing fore and aft (the hips are hinges), so going backwards
// runs the same gait in reverse, and going sideways steps on the spot.

/** Distance for one full cycle (a step with each leg), m: about the puppet's own stride (legs of 0.16 m). */
const STRIDE = 0.24;
/** Hip swing fore and aft, rad: with the stride above, the standing foot stays where it is on the floor. */
const SWING = 0.4;
/** The swinging leg's hip lifts this much more, rad, and its knee bends by KNEE, so the foot clears the floor. */
const LIFT = 0.25;
const KNEE = 0.9;
/** Walking starts above this speed of the head, m/s (0.3 m/s in the room), and ends below STOP_SPEED. */
const START_SPEED = 0.06;
const STOP_SPEED = 0.03;
/**
 * … and only once the head is this far from where the puppet stood, m:
 * leaning and looking around are not steps. Measured with a head that turns
 * about the neck: at 0.025 a lean of 15 cm in the room already stepped; at
 * 0.045 a lean of 20 cm does not, one of 30 cm does.
 */
const START_DISTANCE = 0.045;
/** Smoothing of the head's velocity, s. */
const SMOOTH = 0.15;
/** The place where the puppet stands follows a slow sway of the head, s. */
const SETTLE = 1;
/** Below this share of the standing height the legs are folded on the floor: no steps. */
const CROUCH = 0.8;
/** Steps fade in and out over this time, s. */
const EASE = 0.25;
/**
 * Motor stiffness and damping (critically damped). Far above what the light
 * thigh alone would need: the motor only knows the two bodies it joins, and
 * the shin with its lead-weighted foot hangs on them. Measured after 1 s: a
 * knee sent to 0.9 rad gets to 0.43 at 1 600, 0.68 at 10 000 and 0.84 at
 * 50 000; a single hip sent 0.6 rad forward to 0.03, 0.16 and 0.2 (the
 * pelvis gives way the other side; with both legs stepping it swings ±0.4).
 */
const STIFFNESS = 50_000;
const DAMPING = 450;

export interface Walk {
  /** Every physics step: where the head is now, and which way the body faces (rad, 0: +z). */
  step(head: Vector3, bodyYaw: number): void;
  /** Back to hanging legs (the body is no longer driven). */
  stop(): void;
  /** How much the legs are stepping right now: 0 hanging … 1 full steps. */
  level(): number;
}

export function createWalk(rig: Rig, standingHeight: number): Walk | undefined {
  const legs = ["L", "R"].flatMap((side, i) => {
    const thigh = rig.byName.get(`thigh.${side}`);
    const shin = rig.byName.get(`shin.${side}`);
    if (!thigh?.joint || !shin?.joint) return [];
    return [
      {
        hip: thigh.joint as RAPIER.RevoluteImpulseJoint,
        knee: shin.joint as RAPIER.RevoluteImpulseJoint,
        bodies: [thigh.body, shin.body],
        // The joints' own friction, for when the legs hang again (each part has its own, rig.ts)
        friction: { hip: thigh.friction, knee: shin.friction },
        // The legs are half a cycle apart
        offset: i * Math.PI,
      },
    ];
  });
  if (legs.length < 2) return undefined; // a rig without two hinged legs does not walk

  const last = new Vector3();
  const stood = new Vector3();
  const velocity = new Vector3();
  const move = new Vector3();
  let started = false;
  let walking = false;
  /** 0 hanging … 1 full steps */
  let level = 0;
  let phase = 0;
  let motors = false;

  // The joints' own friction again; a body at rest sleeps and would not notice
  function hang() {
    if (!motors) return;
    motors = false;
    for (const leg of legs) {
      leg.hip.configureMotorVelocity(0, leg.friction.hip);
      leg.knee.configureMotorVelocity(0, leg.friction.knee);
      for (const body of leg.bodies) body.wakeUp();
    }
  }

  return {
    step(head, bodyYaw) {
      if (!started) {
        started = true;
        last.copy(head);
        stood.copy(head);
      }
      // Along the floor only: nodding, crouching and jumping are not steps
      move.subVectors(head, last).setY(0).divideScalar(STEP);
      last.copy(head);
      velocity.lerp(move, STEP / SMOOTH);
      const speed = velocity.length();
      const upright = head.y > standingHeight * CROUCH;

      if (!walking) {
        const away = Math.hypot(head.x - stood.x, head.z - stood.z);
        if (upright && speed > START_SPEED && away > START_DISTANCE) walking = true;
        else stood.lerp(head, STEP / SETTLE);
      } else if (!upright || speed < STOP_SPEED) {
        walking = false;
        stood.copy(head);
      }
      level += Math.max(-STEP / EASE, Math.min(STEP / EASE, (walking ? 1 : 0) - level));
      if (level <= 0) return hang();

      // The gait advances with the distance covered; while the steps fade out it stays where it is
      if (walking) phase += (2 * Math.PI * speed * STEP) / STRIDE;
      // Fore (1) or aft (−1) of the way the body faces; sideways (0) steps on the spot
      const forward = speed > 1e-6 ? (velocity.x * Math.sin(bodyYaw) + velocity.z * Math.cos(bodyYaw)) / speed : 0;
      for (const leg of legs) {
        const angle = phase + leg.offset;
        // The leg is in the air while it swings the way the puppet goes
        const air = Math.max(0, Math.cos(angle));
        // Hip: negative lifts the knee forwards (rig convention); knee: positive bends
        leg.hip.configureMotorPosition(-level * (SWING * forward * Math.sin(angle) + LIFT * air), STIFFNESS, DAMPING);
        leg.knee.configureMotorPosition(level * KNEE * air, STIFFNESS, DAMPING);
        if (!motors) for (const body of leg.bodies) body.wakeUp();
      }
      motors = true;
    },
    level: () => level,
    stop() {
      hang();
      started = walking = false;
      level = 0;
      velocity.set(0, 0, 0);
    },
  };
}
