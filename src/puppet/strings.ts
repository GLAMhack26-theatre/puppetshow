import RAPIER from "@dimforge/rapier3d-compat";
import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Object3D,
  type World,
} from "@iwsdk/core";
import { DEFAULT_STRING_EXTRA, STRING_IDS, type ControlInput, type RockId, type StringId } from "../input/control-input";
import { STEP, addHook, addLinked, physics, renderPoint, setJointLimits, toQuat, toVec, worldPoint } from "../systems/rapier-system";
import type { Rig, RigController, RigPart, RigString } from "./rig";

// The control cross (Spielkreuz) and the strings, rebuilt from the real SKKG
// cross (export/marionette_rig.json, "controller"): the main bar carries the
// back, shoulder and head strings; the head bar, the leg bar and the hand bar
// rock about the main bar's long axis. Every bar is a kinematic body; each
// string is a rope joint (maximum distance, rest length from the rig) from the
// eye on its bar to the socket on the puppet. The puppeteer's moves come from
// ControlInput: the main bar's pose (tilting it bows or turns the puppet), the
// rocking angles, the hand bar taken off the cross and moved freely, a string
// caught by the other hand (hook), the head let forward (nod), and per-string
// pulls on top (plucking).
//
// Nothing here teleports. Every input is followed by a critically damped
// spring with a cap on speed and on acceleration (Follow): a tracker spike or a
// hand found again somewhere else used to become a sweep at full speed from
// one step to the next, which is what jerked the puppet about.
//
// A replicated puppet (simulated on another device, src/net/) has the same
// bars and drawn strings, but no rope joints and no input: its bars are set
// from the network like its other bodies. A caught string (hook) is drawn
// straight there, and the drawn sag assumes the usual string length unless
// the puppet is the local player's own.

/**
 * How a bar follows its input. omega (rad/s): the spring; it trails a steady
 * move by 2 / omega seconds. speed and accel: caps, in m and s for positions,
 * rad and s for angles. The acceleration cap only bites on input steps
 * (ordinary hand moves stay below it); braking may use BRAKE times as much, so
 * the bar never overshoots where it was sent.
 */
interface Follow {
  omega: number;
  speed: number;
  accel: number;
}
const BAR_MOVE: Follow = { omega: 24, speed: 1.5, accel: 12 }; // lag 0.08 s; a lively hand reaches about 10 m/s²
const BAR_TURN: Follow = { omega: 24, speed: 5, accel: 40 };
const ROCK: Follow = { omega: 24, speed: 6, accel: 60 }; // a full rock of the leg bar in 0.25 s: quick enough to walk
/**
 * The hand bar let go: it drifts back onto its seat instead of snapping there
 * (most of the way in 0.4 s, seated after about 0.8 s). The magnet is weak on
 * purpose: at 0.08 s the bar whipped the puppet's hands back.
 */
const RETURN: Follow = { omega: 9, speed: 1.5, accel: 12 };
const BRAKE = 3;
/** The returning hand bar sits again once it is this close to its seat and this slow against it (m, rad, m/s) */
const SEATED = { distance: 0.0005, angle: 0.01, speed: 0.005 };

const PULL_RANGE = 0.12; // m: a full pull shortens a string by this much (puppet: 0.35 m)
const MAX_PULL_SPEED = 1; // m/s: a string is drawn in, not teleported (a slider jump would otherwise leave it 12 cm too long for a step)
const MAX_LEASH = 0.3; // m: how far a detached bar may leave its seat (its strings are 0.48 m)
const MAX_EXTRA = 0.5; // m: ControlInput.stringExtra beyond this is ignored
const EXTRA_SPEED = 0.25; // m/s: the string length follows its setting (a slider), cross and strings together
const MAX_PUSH = 0.25; // m: how far a caught string can be pushed off its line (further, a tracker glitch would haul the puppet into the air)
const MIN_STRING = 0.05; // m: what is left of a string however far it is pulled, and below a hook
/**
 * ControlInput.nod: the head strings are let out, as tipping a real cross
 * forward slackens them, and the head, weighted at the front (marionette.ts),
 * drops forward until they hold it again. The length let out is what the
 * sockets need to turn about the head's joint by an angle between `rest` (nod
 * just above 0: about where the head hangs anyway) and `full` (nod = 1), rad;
 * the joint stops at 45°. Measured: head pitch 0.41 rad at nod 0.5, 0.71 at 1,
 * chest and pelvis within 0.02 rad of where they were.
 *
 * Tried and dropped: moving the head strings' eyes forward instead (5 cm gave
 * 0.36 rad and dragged chest and pelvis along by 0.07 to 0.09 rad).
 */
const NOD = { rest: 0.1, full: 0.7 };
const NOD_FOLLOW: Follow = { omega: 12, speed: 4, accel: 30 }; // 0…1: a nod takes about 0.4 s
/**
 * ControlInput.turn: the head turns about the vertical. On the real cross the
 * small head bar turns on its post and rubber strings take the head along. Here
 * the head bar turns by `angle` at turn = ±1 (rad; the head's joint stops at
 * 70°), so its eyes stay above the head's sockets, and a spring on the twist
 * of the head's joint stands in for the rubber strings (ω² and 2ζω of the
 * motion): two plain strings 25 cm long turn a head by a fraction of what
 * their bar turns, and the joint's friction eats the rest.
 */
const HEAD_TURN = { angle: Math.PI / 3, stiffness: 220, damping: 26 };
const TURN_FOLLOW: Follow = { omega: 12, speed: 4, accel: 30 }; // −1…1
/**
 * Take-up of the knee strings. They are the first to go slack when the cross
 * sinks (measured: 1.9 cm of slack at 1 cm, 4.4 cm at 3 cm, where a full rock
 * of the leg bar lifts no knee any more; the other strings stay taut, the body
 * hangs on them), and a hand cannot hold its height to that centimetre. So
 * while the leg bar is level, each knee string is drawn in until it is just
 * taut (`slack` is left, so it never lifts the knee by itself), and let out
 * again as the cross rises; while the bar rocks (its angle beyond `level`,
 * rad, fading between the two) the length is held, and the rock lifts the knee
 * by as much as the bar's end rises, at any height of the cross, also with the
 * puppet sitting. Not what a real string does: a puppeteer does it with the
 * wrist. max: the most that is drawn in, m; in / out: how fast, m/s (let out
 * faster than the cross can rise, or the knees would come up with it); calm:
 * s a string has to be slack before it is drawn in.
 */
const TAKE_UP = { slack: 0.002, max: 0.2, in: 0.5, out: 3, level: [0.05, 0.15] as [number, number], calm: 0.15 };
/** The extra lift of the whole cross (setLift): as fast as the cross itself moves, unless the caller says otherwise */
const LIFT: Follow = { omega: 24, speed: 1.5, accel: 12 };
const SEGMENTS = 12; // points per drawn string
const SAG = 0.5; // drawn sag per metre of slack

interface PuppetString {
  id: StringId;
  part: RigPart;
  bar: RAPIER.RigidBody;
  anchor: RAPIER.Vector; // on the puppet body
  /** The eye on the bar (bar-local) */
  eye: RAPIER.Vector;
  /** Where the rope joint holds on to the bar (bar-local): the eye, or the hook while the string is caught */
  barAnchor: RAPIER.Vector;
  /** Length in the rig, m */
  rest: number;
  /** The rope joint's limit right now: what is free between barAnchor and the socket */
  length: number;
  /** m drawn in by the take-up (TAKE_UP; knee strings only) */
  taken: number;
  /** None on a replicated puppet */
  joint?: RAPIER.ImpulseJoint;
  line: Line;
}

/** A bar's body and the pose it is sent to in this step (its strings' hooks are placed against it) */
interface BarPose {
  body: RAPIER.RigidBody;
  /** At rest, in the rig (world, without the lift) */
  pivot: Vector3;
  position: Vector3;
  rotation: Quaternion;
}

interface StringState {
  string: PuppetString;
  bar: BarPose;
  /** Eye and socket at rest, world: how much longer the string gets per metre the cross is raised */
  eyeAtRest: Vector3;
  socketAtRest: Vector3;
  /** m drawn in by ControlInput.pulls */
  pulled: number;
  /** A head string: its socket seen from the head's joint at rest (world), for ControlInput.nod */
  fromJoint?: Vector3;
  /** A knee string: the leg bar, whose angle says whether the take-up may adapt (TAKE_UP) */
  legBar?: RockingBar;
  /** … how fast it is being let out while it stays taut, m/s, and for how long it has been slack since, s */
  falling: number;
  calm: number;
  /** Caught by the other hand: where on the string (0 eye … 1 socket), and how far it is pushed off the straight line (world, m) */
  hooked: boolean;
  along: number;
  push: Vector3;
  pushSpeed: Vector3;
}

interface RockingBar {
  pose: BarPose;
  input: RockId;
  axis: Vector3;
  /** Pivot relative to the main bar's pivot, in the main bar's frame */
  offset: Vector3;
  limit: number;
  angle: number;
  angleSpeed: number;
  /** Can be taken off the cross; while it is not seated it has its own pose (world) */
  detachable: boolean;
  seated: boolean;
  /** Let go and on its way back: how far it still is from its seat, and how fast it closes in (world axes) */
  returning: boolean;
  away: Vector3;
  awaySpeed: Vector3;
  freePosition: Vector3;
  freeVelocity: Vector3;
  freeRotation: Quaternion;
  freeSpin: Vector3;
  /** The seat in the step before: its speed carries the bar along while it sits or comes back */
  lastSeat: Vector3;
}

const vec = (v: Vector3): RAPIER.Vector => ({ x: v.x, y: v.y, z: v.z });
const UP = new Vector3(0, 0, 1);
const ZERO = new Vector3();
const IDENTITY = new Quaternion();
const UPRIGHT = new Vector3(0, 1, 0);
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Scratch for the followers
const fe = new Vector3();
const fdv = new Vector3();
const fq = new Quaternion();

/** One step of the spring on a vector: x and v are changed in place. Exact for a target that holds still, so stable at any omega */
function followVector(x: Vector3, v: Vector3, target: Vector3, f: Follow) {
  fe.subVectors(x, target);
  springStep(fe, v, f);
  x.addScaledVector(v, STEP);
}

/** The same for a rotation: spin is the angular velocity, world axes */
function followRotation(q: Quaternion, spin: Vector3, target: Quaternion, f: Follow) {
  // The error as a rotation vector, the short way round: q = exp(error) · target
  fq.copy(target).invert().premultiply(q);
  if (fq.w < 0) fq.set(-fq.x, -fq.y, -fq.z, -fq.w);
  const sin = Math.hypot(fq.x, fq.y, fq.z);
  fe.set(fq.x, fq.y, fq.z).multiplyScalar(sin < 1e-9 ? 2 : (2 * Math.atan2(sin, fq.w)) / sin);
  springStep(fe, spin, f);
  const angle = spin.length() * STEP;
  if (angle > 1e-12) q.premultiply(fq.setFromAxisAngle(fe.copy(spin).normalize(), angle)).normalize();
}

/** New velocity of the critically damped spring for the error e (x − target), within the caps */
function springStep(e: Vector3, v: Vector3, f: Follow) {
  // v' = (v − ω (v + ω e) dt) · exp(−ω dt)
  fdv.copy(e).multiplyScalar(f.omega).add(v).multiplyScalar(-f.omega * STEP).add(v).multiplyScalar(Math.exp(-f.omega * STEP)).sub(v);
  const speedingUp = fdv.lengthSq() + 2 * fdv.dot(v) > 0;
  fdv.clampLength(0, (speedingUp ? 1 : BRAKE) * f.accel * STEP);
  v.add(fdv).clampLength(0, f.speed);
}

/** And for a single number; returns the new [x, v] */
function followNumber(x: number, v: number, target: number, f: Follow): [number, number] {
  let dv = (v - f.omega * (v + f.omega * (x - target)) * STEP) * Math.exp(-f.omega * STEP) - v;
  const most = (Math.abs(v + dv) > Math.abs(v) ? 1 : BRAKE) * f.accel * STEP;
  dv = clamp(dv, -most, most);
  v = clamp(v + dv, -f.speed, f.speed);
  return [x + v * STEP, v];
}

export interface StringOptions {
  /**
   * Who leads the cross. Without it the puppet is replicated and led by
   * nobody here; a replicated puppet with an input is the local player's own
   * (the input is kept in step with the cross, see below).
   */
  input?: ControlInput;
  mode?: "simulated" | "replicated";
}

export function createStrings(world: World, root: Object3D, rig: Rig, description: RigString[], controller: RigController, options: StringOptions = {}) {
  const pw = physics.world;
  const simulated = options.mode !== "replicated";
  const input = options.input;
  const removers: Array<() => void> = [];
  root.updateMatrixWorld(true);
  const toWorld = (v: Vector3) => v.clone().applyMatrix4(root.matrixWorld);
  const dirToWorld = (v: Vector3) => v.clone().transformDirection(root.matrixWorld);

  // ControlInput.stringExtra: the whole cross hangs this much higher than in
  // the rig and every string is as much longer as it takes to reach it, so the
  // puppet stands the same. It starts at the setting and follows it later.
  let extra = clamp(input?.stringExtra ?? DEFAULT_STRING_EXTRA, 0, MAX_EXTRA);
  const lift = new Vector3(0, extra, 0);

  // One kinematic body per bar, at its pivot; all start unrotated, so a point's
  // body-local anchor at rest is simply (point − pivot) in world space
  const wood = new MeshStandardMaterial({ color: 0xc8a171, roughness: 0.8 });
  const size = controller.stickSize;
  const bodies = new Map<string, BarPose>();
  const objects: Object3D[] = [];
  for (const bar of controller.bars) {
    const pivot = toWorld(bar.pivot);
    const group = new Group();
    for (const stick of bar.sticks) {
      const a = toWorld(stick.a).sub(pivot);
      const b = toWorld(stick.b).sub(pivot);
      const mesh = new Mesh(new BoxGeometry(size, size, a.distanceTo(b) + size), wood);
      mesh.position.addVectors(a, b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
      group.add(mesh);
    }
    objects.push(group);
    const position = pivot.clone().add(lift);
    const { body, remove } = addLinked(world, group, RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(position.x, position.y, position.z));
    bodies.set(bar.name, { body, pivot, position, rotation: new Quaternion() });
    removers.push(remove);
  }
  const mainBar = controller.bars.find((b) => !b.parent)!;
  const main = bodies.get(mainBar.name)!;
  // The input starts where the cross hangs, so the puppet does not jump to a
  // default place. Rig coordinates: without the lift
  input?.bar.position.copy(main.pivot);
  const rocking: RockingBar[] = controller.bars
    .filter((b) => b.parent && b.axis && b.input)
    .map((b) => {
      const pose = bodies.get(b.name)!;
      return {
        pose, input: b.input!, axis: dirToWorld(b.axis!), offset: pose.pivot.clone().sub(main.pivot), limit: b.limit, angle: 0, angleSpeed: 0,
        detachable: b.detachable, seated: true, returning: false, away: new Vector3(), awaySpeed: new Vector3(), freePosition: pose.position.clone(), freeVelocity: new Vector3(), freeRotation: new Quaternion(), freeSpin: new Vector3(), lastSeat: pose.position.clone(),
      };
    });

  /** A string's length with the cross raised by `raised`: the rig's length, stretched as the way from eye to socket is */
  const lengthAt = (state: StringState, raised: number) => {
    const eye = state.eyeAtRest;
    const socket = state.socketAtRest;
    const atRest = eye.distanceTo(socket);
    const now = Math.hypot(eye.x - socket.x, eye.y + raised - socket.y, eye.z - socket.z);
    return state.string.rest * (atRest > 1e-6 ? now / atRest : 1);
  };

  const strings: PuppetString[] = [];
  const states: StringState[] = [];
  const material = new LineBasicMaterial({ color: 0xf3e9dc });
  for (const s of description) {
    const part = rig.byName.get(s.bone);
    const bar = bodies.get(s.bar) ?? main;
    if (!part || !STRING_IDS.includes(s.id)) continue;
    const socketAtRest = toWorld(s.position);
    const eyeAtRest = toWorld(s.barPoint);
    const anchor = vec(socketAtRest.clone().sub(new Vector3().copy(part.body.translation())));
    const eye = vec(eyeAtRest.clone().sub(bar.pivot));

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3));
    const line = new Line(geometry, material);
    line.frustumCulled = false;
    world.scene.add(line);
    objects.push(line);
    removers.push(() => {
      line.removeFromParent();
      geometry.dispose();
    });
    const string: PuppetString = { id: s.id, part, bar: bar.body, anchor, eye, barAnchor: { ...eye }, rest: s.restLength, length: s.restLength, taken: 0, line };
    const state: StringState = { string, bar, eyeAtRest, socketAtRest, pulled: 0, falling: 0, calm: 0, hooked: false, along: 0.5, push: new Vector3(), pushSpeed: new Vector3() };
    state.legBar = rocking.find((r) => r.pose === bar && r.input === "legs");
    // The bone's origin is its joint (rig.ts: restOffset is the bone seen from its body)
    if (s.bone === "head" && part.joint) state.fromJoint = socketAtRest.clone().sub(part.restOffset).sub(new Vector3().copy(part.body.translation()));
    string.length = lengthAt(state, extra);
    if (simulated) string.joint = pw.createImpulseJoint(RAPIER.JointData.rope(string.length, eye, anchor), bar.body, part.body, true);
    strings.push(string);
    states.push(state);
  }

  // The main bar as it follows ControlInput.bar, in rig coordinates (the lift comes on top)
  const barPosition = main.pivot.clone();
  const barVelocity = new Vector3();
  const barRotation = new Quaternion();
  const barSpin = new Vector3();
  const barTarget = new Vector3();
  // Extra height of the cross on top of the input: pulls the whole puppet up
  // out of the way while a scene changes, or out of view before a new player's
  // puppet is let down (puppet.ts). Separate from `lift`, which raises the
  // cross with the string length, and with its own pace: up fast, down slowly.
  let liftTarget = 0;
  let liftNow = 0;
  let liftSpeed = 0;
  let liftFollow = LIFT;
  const rockQ = new Quaternion();
  const turnQ = new Quaternion();
  let turn = 0;
  let turnSpeed = 0;
  const head = rig.byName.get("head");
  const p = new Vector3();
  const q = new Quaternion();
  const target = new Vector3();
  const inverse = new Quaternion();
  const seatVelocity = new Vector3();
  const eyeNow = new Vector3();
  const socketNow = new Vector3();
  const hookNow = new Vector3();
  let nod = 0;
  let nodSpeed = 0;
  /**
   * How much longer a head string has to be for the head to tip forward by
   * `angle`: its socket turns about the head's joint, forwards and down
   */
  const nodSlack = (state: StringState, angle: number) => {
    const r = state.fromJoint!;
    const [c, sn] = [Math.cos(angle), Math.sin(angle)];
    // The socket's way: about the puppet's left–right axis (x), up towards the front (+z)
    const dy = r.y * c - r.z * sn - r.y;
    const dz = r.y * sn + r.z * c - r.z;
    const eye = state.eyeAtRest;
    const socket = state.socketAtRest;
    const tipped = Math.hypot(eye.x - socket.x, eye.y + extra - socket.y - dy, eye.z - socket.z - dz);
    return tipped - Math.hypot(eye.x - socket.x, eye.y + extra - socket.y, eye.z - socket.z);
  };
  const detachable = rocking.find((r) => r.detachable);
  if (input) {
    input.handBar.detached = false;
    input.handBar.position.copy(detachable?.pose.position ?? main.position);
    input.handBar.rotation.identity();
  }
  if (simulated && input) removers.push(addHook(physics.beforeStep, () => {
    const handBar = input.handBar;
    const wanted = clamp(input.stringExtra, 0, MAX_EXTRA);
    if (wanted !== extra) {
      // Cross and strings change together, at an even pace. The bars are set to
      // their new height at once rather than moved there during the step: a
      // string's length holds for the whole step, so with the bar still on its
      // way the strings were too short (or too long) for most of it, and the
      // puppet rode up 3 cm while a slider was dragged.
      const change = clamp(wanted - extra, -EXTRA_SPEED * STEP, EXTRA_SPEED * STEP);
      extra += change;
      lift.set(0, extra, 0);
      for (const bar of bodies.values()) {
        const at = bar.body.translation();
        bar.body.setTranslation({ x: at.x, y: at.y + change, z: at.z }, true);
      }
      for (const r of rocking) {
        r.freePosition.y += change;
        r.lastSeat.y += change;
      }
    }

    barTarget.copy(input.bar.position);
    followVector(barPosition, barVelocity, barTarget, BAR_MOVE);
    followRotation(barRotation, barSpin, input.bar.rotation, BAR_TURN);
    [liftNow, liftSpeed] = followNumber(liftNow, liftSpeed, liftTarget, liftFollow);
    main.position.copy(barPosition).add(lift);
    main.position.y += liftNow;
    main.rotation.copy(barRotation);
    main.body.setNextKinematicTranslation(main.position);
    main.body.setNextKinematicRotation(main.rotation);

    // The head turns: its bar about the cross's upright, its joint by the same angle
    // ?? 0: a source that does not know the turn
    [turn, turnSpeed] = followNumber(turn, turnSpeed, clamp(input.turn ?? 0, -1, 1), TURN_FOLLOW);
    if (Math.abs(turn) < 1e-5 && Math.abs(turnSpeed) < 1e-4) turn = turnSpeed = 0;
    head?.twistTo?.(turn * HEAD_TURN.angle, HEAD_TURN.stiffness, HEAD_TURN.damping);

    // Rocking bars ride on the main bar: pivot follows its pose, and they turn
    // about their axis (in the main bar's frame) on top of its rotation
    for (const r of rocking) {
      // ?? 0: a rig may name a rocker this build has no input for yet
      [r.angle, r.angleSpeed] = followNumber(r.angle, r.angleSpeed, clamp(input.rock[r.input] ?? 0, -r.limit, r.limit), ROCK);
      p.copy(r.offset).applyQuaternion(barRotation).add(main.position);
      q.copy(barRotation);
      if (r.input === "head") q.multiply(turnQ.setFromAxisAngle(UPRIGHT, turn * HEAD_TURN.angle));
      q.multiply(rockQ.setFromAxisAngle(r.axis, r.angle));
      if (r.detachable) {
        // p, q: its seat on the cross. Taken off, it follows ControlInput.handBar
        // instead (like the main bar, and on a leash so the strings stay sane);
        // let go, it drifts back until it sits again.
        seatVelocity.subVectors(p, r.lastSeat).divideScalar(STEP);
        r.lastSeat.copy(p);
        if (handBar.detached) {
          r.seated = r.returning = false;
          target.subVectors(handBar.position, p).clampLength(0, MAX_LEASH).add(p);
          followVector(r.freePosition, r.freeVelocity, target, BAR_MOVE);
          followRotation(r.freeRotation, r.freeSpin, handBar.rotation, BAR_TURN);
        } else if (!r.seated) {
          // Measured against the seat, which moves with the cross: the bar comes home
          // however the cross is being moved meanwhile (chasing the seat in world
          // space, it trailed behind a moving cross and never sat)
          if (!r.returning) {
            r.returning = true;
            r.away.subVectors(r.freePosition, p);
            r.awaySpeed.subVectors(r.freeVelocity, seatVelocity);
          }
          followVector(r.away, r.awaySpeed, ZERO, RETURN);
          followRotation(r.freeRotation, r.freeSpin, q, RETURN);
          r.freePosition.addVectors(p, r.away);
          r.freeVelocity.addVectors(seatVelocity, r.awaySpeed); // taken again on its way, it goes on from this
          r.seated = r.away.length() < SEATED.distance && r.awaySpeed.length() < SEATED.speed && r.freeRotation.angleTo(q) < SEATED.angle;
          r.returning = !r.seated;
        }
        if (r.seated) {
          // Carried by the cross: taken off, it leaves with the speed it has
          r.freePosition.copy(p);
          r.freeVelocity.copy(seatVelocity);
          r.freeRotation.copy(q);
          r.freeSpin.set(0, 0, 0);
        } else {
          p.copy(r.freePosition);
          q.copy(r.freeRotation);
        }
        // Where the bar is now: a source that takes it off starts from here
        if (!handBar.detached) {
          handBar.position.copy(p);
          handBar.rotation.copy(q);
        }
      }
      r.pose.position.copy(p);
      r.pose.rotation.copy(q);
      r.pose.body.setNextKinematicTranslation(p);
      r.pose.body.setNextKinematicRotation(q);
    }

    // A rope joint is a distance limit on the joint's first axis, so its length
    // is that limit: set it instead of recreating the joint (which pulled in
    // 5 mm steps and threw the solver's state away)
    const hook = input.hook;
    // ?? 0: a source that does not know the nod
    [nod, nodSpeed] = followNumber(nod, nodSpeed, clamp(input.nod ?? 0, 0, 1), NOD_FOLLOW);
    if (nod < 1e-5 && Math.abs(nodSpeed) < 1e-4) nod = nodSpeed = 0; // exactly the rig's strings again
    for (const state of states) {
      const s = state.string;
      const pull = PULL_RANGE * input.pulls[s.id];
      state.pulled += clamp(pull - state.pulled, -MAX_PULL_SPEED * STEP, MAX_PULL_SPEED * STEP);
      let length = Math.max(MIN_STRING, lengthAt(state, extra) - state.pulled);
      // A nod: the head strings are let out
      if (state.fromJoint && nod > 0) length += Math.max(0, nodSlack(state, NOD.rest + nod * (NOD.full - NOD.rest)));
      // Take-up (TAKE_UP): against the length it has without it, so a string
      // that is plucked taut is not drawn in further
      if (state.legBar) {
        // Eye and socket as they are now, both before this step: measured
        // against where the bar is sent in this step, a cross on its way down
        // looked 5 mm nearer in every step, and the knees were reeled up
        // until the puppet hung across its knee strings
        worldPoint(s.bar, s.eye, eyeNow);
        worldPoint(s.part.body, s.anchor, socketNow);
        const level = 1 - smoothstep(TAKE_UP.level[0], TAKE_UP.level[1], Math.abs(state.legBar.angle));
        const wanted = clamp(length - eyeNow.distanceTo(socketNow) - TAKE_UP.slack, 0, TAKE_UP.max);
        if (wanted < s.taken) {
          // Taut: the string carries the knee (drawn in while the leg swung
          // up, or the cross has risen). Let out to slack and a bit more with
          // every step, as much as a falling knee needs: let out only to
          // "just slack", the string caught the knee again in every other
          // step, and a leg that had swung up came down at 10 cm/s
          state.calm = 0;
          state.falling = Math.min(TAKE_UP.out, state.falling + 9.81 * STEP);
          s.taken = Math.max(0, s.taken - Math.min(TAKE_UP.out * STEP, s.taken - wanted + state.falling * STEP) * level);
        } else if ((state.calm += STEP) > TAKE_UP.calm) {
          // Slack and at rest for a moment: drawn in. Not sooner: a knee on its way down must not be caught
          state.falling = 0;
          s.taken += Math.min(wanted - s.taken, TAKE_UP.in * STEP * level);
        }
        length = Math.max(MIN_STRING, length - s.taken);
      }

      // Caught by the other hand: the string runs eye → hook → socket. The rope
      // joint then holds on to the bar at the hook (the bar is kinematic, so a
      // point that moves in its frame is as good as a body of its own) and only
      // what is left below the hook is free. The push is followed like a bar
      // and eases out again when the string is let go.
      const caught = hook.id === s.id;
      if (caught && !state.hooked) state.along = clamp(hook.along, 0.05, 0.95); // fresh catch: the push is still zero, so nothing jumps
      else if (caught) state.along += clamp(clamp(hook.along, 0.05, 0.95) - state.along, -STEP, STEP);
      followVector(state.push, state.pushSpeed, caught ? target.copy(hook.offset).clampLength(0, MAX_PUSH) : ZERO, BAR_MOVE);
      const hooked = caught || state.push.lengthSq() > 1e-8 || state.pushSpeed.lengthSq() > 1e-6;
      if (hooked) {
        const bar = state.bar;
        eyeNow.set(s.eye.x, s.eye.y, s.eye.z).applyQuaternion(bar.rotation).add(bar.position);
        worldPoint(s.part.body, s.anchor, socketNow);
        hookNow.lerpVectors(eyeNow, socketNow, state.along).add(state.push).sub(eyeNow);
        // Never more string above the hook than leaves a short end below it
        hookNow.clampLength(0, length - MIN_STRING);
        length -= hookNow.length();
        hookNow.applyQuaternion(inverse.copy(bar.rotation).invert());
        s.barAnchor.x = s.eye.x + hookNow.x;
        s.barAnchor.y = s.eye.y + hookNow.y;
        s.barAnchor.z = s.eye.z + hookNow.z;
        s.joint?.setAnchor1(s.barAnchor);
        s.part.body.wakeUp();
      } else if (state.hooked) {
        state.push.set(0, 0, 0);
        state.pushSpeed.set(0, 0, 0);
        Object.assign(s.barAnchor, s.eye);
        s.joint?.setAnchor1(s.barAnchor);
      }
      state.hooked = hooked;
      if (length === s.length || !s.joint) continue;
      setJointLimits(s.joint, RAPIER.JointAxis.LinX, 0, length);
      s.part.body.wakeUp(); // a resting puppet sleeps, and a limit alone does not wake it
      s.length = length;
    }
  }));

  // The local player's own puppet, simulated elsewhere: the engine there keeps
  // handBar at the bar's place while it is not taken off. Do the same here from
  // the replicated bar, so that taking it off starts from where it is. The
  // string length is the player's own setting, so the drawn sag can follow it.
  if (!simulated && input) removers.push(addHook(physics.beforeStep, () => {
    for (const state of states) state.string.length = lengthAt(state, clamp(input.stringExtra, 0, MAX_EXTRA));
    if (!detachable || input.handBar.detached) return;
    toVec(detachable.pose.body.translation(), input.handBar.position);
    toQuat(detachable.pose.body.rotation(), input.handBar.rotation);
  }));

  // Drawn eye → (hook →) socket, with a parabolic sag below the hook that grows
  // with the slack (rendering only)
  const a = new Vector3();
  const h = new Vector3();
  const b = new Vector3();
  removers.push(addHook(physics.afterSync, () => {
    for (const s of strings) {
      renderPoint(s.bar, s.eye, a);
      renderPoint(s.bar, s.barAnchor, h); // the eye itself unless the string is caught
      renderPoint(s.part.body, s.anchor, b);
      const distance = h.distanceTo(b);
      const sag = Math.sqrt(Math.max(0, s.length * s.length - distance * distance)) * SAG;
      const position = s.line.geometry.getAttribute("position");
      position.setXYZ(0, a.x, a.y, a.z);
      for (let i = 1; i <= SEGMENTS; i++) {
        const t = (i - 1) / (SEGMENTS - 1);
        position.setXYZ(i, h.x + (b.x - h.x) * t, h.y + (b.y - h.y) * t - 4 * sag * t * (1 - t), h.z + (b.z - h.z) * t);
      }
      position.needsUpdate = true;
    }
  }));

  return {
    bar: main.body,
    /** The bars' bodies in the rig's order: the same list on every device (src/net/) */
    bars: controller.bars.map((b) => bodies.get(b.name)!.body),
    strings,
    /** The cross and the strings, for fading them with the puppet. */
    objects,
    materials: [wood, material],
    /**
     * Raises the cross by `y` metres above where the input holds it (0: back
     * down). pace: how fast it goes there (speed m/s, accel m/s²).
     */
    setLift(y: number, pace?: { speed: number; accel: number }) {
      liftTarget = y;
      // omega: a lag of 2 / omega s behind an even climb; slow paces get a soft landing
      liftFollow = pace ? { omega: Math.min(24, 20 * pace.speed + 4), ...pace } : LIFT;
    },
    /** Whether the cross has arrived where input and lift want it (a replicated cross is not moved from here). */
    arrived: () => !(simulated && input) || (barPosition.distanceTo(barTarget) < 0.005 && Math.abs(liftNow - liftTarget) < 0.005),
    /** Whether a bar that was let go is on its way back to its seat: it moves fast then, and nobody is throwing (grab.ts) */
    returning: () => rocking.some((r) => r.returning),
    dispose() {
      for (const remove of removers) remove();
      wood.dispose();
      material.dispose();
    },
  };
}
