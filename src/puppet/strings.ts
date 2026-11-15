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
import { STRING_IDS, controlInput, type RockId, type StringId } from "../input/control-input";
import { STEP, addLinked, physics, renderPoint, setJointLimits, worldPoint } from "../systems/rapier-system";
import type { Rig, RigController, RigPart, RigString } from "./rig";

// The control cross (Spielkreuz) and the strings, rebuilt from the real SKKG
// cross (export/marionette_rig.json, "controller"): the main bar carries the
// back, shoulder and head strings; the head bar, the leg bar and the hand bar
// rock about the main bar's long axis. Every bar is a kinematic body; each
// string is a rope joint (maximum distance, rest length from the rig) from the
// eye on its bar to the socket on the puppet. The puppeteer's moves come from
// ControlInput: the main bar's pose (tilting it bows or turns the puppet), the
// rocking angles, the hand bar taken off the cross and moved freely, a string
// caught by the other hand (hook), and per-string pulls on top (plucking).
//
// Nothing here teleports. Every input is followed by a critically damped
// spring with a cap on speed and on acceleration (Follow): a tracker spike or a
// hand found again somewhere else used to become a sweep at full speed from
// one step to the next, which is what jerked the puppet about.

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
  joint: RAPIER.ImpulseJoint;
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
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

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

export function createStrings(world: World, root: Object3D, rig: Rig, description: RigString[], controller: RigController) {
  const pw = physics.world;
  root.updateMatrixWorld(true);
  const toWorld = (v: Vector3) => v.clone().applyMatrix4(root.matrixWorld);
  const dirToWorld = (v: Vector3) => v.clone().transformDirection(root.matrixWorld);

  // ControlInput.stringExtra: the whole cross hangs this much higher than in
  // the rig and every string is as much longer as it takes to reach it, so the
  // puppet stands the same. It starts at the setting and follows it later.
  let extra = clamp(controlInput.stringExtra, 0, MAX_EXTRA);
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
    const { body } = addLinked(world, group, RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(position.x, position.y, position.z));
    bodies.set(bar.name, { body, pivot, position, rotation: new Quaternion() });
  }
  const mainBar = controller.bars.find((b) => !b.parent)!;
  const main = bodies.get(mainBar.name)!;
  controlInput.bar.position.copy(main.pivot); // rig coordinates: without the lift
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
    const string = { id: s.id, part, bar: bar.body, anchor, eye, barAnchor: { ...eye }, rest: s.restLength, length: s.restLength, joint: null as unknown as RAPIER.ImpulseJoint, line };
    const state: StringState = { string, bar, eyeAtRest, socketAtRest, pulled: 0, hooked: false, along: 0.5, push: new Vector3(), pushSpeed: new Vector3() };
    string.length = lengthAt(state, extra);
    string.joint = pw.createImpulseJoint(RAPIER.JointData.rope(string.length, eye, anchor), bar.body, part.body, true);
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
  // out of the way while a scene changes (puppet.ts). Separate from `lift`,
  // which raises the cross with the string length.
  let sceneLift = 0;
  // Extra length on every string while the cross stays where it is: the puppet
  // moves freely under it while the player's body drives it (body-drive.ts).
  // Eased like a pull, so taking it away does not yank the puppet.
  let slack = 0;
  let slackWanted = 0;
  const rockQ = new Quaternion();
  const p = new Vector3();
  const q = new Quaternion();
  const target = new Vector3();
  const inverse = new Quaternion();
  const seatVelocity = new Vector3();
  const eyeNow = new Vector3();
  const socketNow = new Vector3();
  const hookNow = new Vector3();
  const handBar = controlInput.handBar;
  handBar.detached = false;
  handBar.position.copy(rocking.find((r) => r.detachable)?.pose.position ?? main.position);
  handBar.rotation.identity();
  physics.beforeStep.push(() => {
    const wanted = clamp(controlInput.stringExtra, 0, MAX_EXTRA);
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

    barTarget.copy(controlInput.bar.position).setY(controlInput.bar.position.y + sceneLift);
    followVector(barPosition, barVelocity, barTarget, BAR_MOVE);
    followRotation(barRotation, barSpin, controlInput.bar.rotation, BAR_TURN);
    main.position.copy(barPosition).add(lift);
    main.rotation.copy(barRotation);
    main.body.setNextKinematicTranslation(main.position);
    main.body.setNextKinematicRotation(main.rotation);

    // Rocking bars ride on the main bar: pivot follows its pose, and they turn
    // about their axis (in the main bar's frame) on top of its rotation
    for (const r of rocking) {
      // ?? 0: a rig may name a rocker this build has no input for yet
      [r.angle, r.angleSpeed] = followNumber(r.angle, r.angleSpeed, clamp(controlInput.rock[r.input] ?? 0, -r.limit, r.limit), ROCK);
      p.copy(r.offset).applyQuaternion(barRotation).add(main.position);
      q.copy(barRotation).multiply(rockQ.setFromAxisAngle(r.axis, r.angle));
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
    slack += clamp(slackWanted - slack, -MAX_PULL_SPEED * STEP, MAX_PULL_SPEED * STEP);
    const hook = controlInput.hook;
    for (const state of states) {
      const s = state.string;
      const pull = PULL_RANGE * controlInput.pulls[s.id];
      state.pulled += clamp(pull - state.pulled, -MAX_PULL_SPEED * STEP, MAX_PULL_SPEED * STEP);
      let length = Math.max(MIN_STRING, lengthAt(state, extra) - state.pulled + slack);

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
        s.joint.setAnchor1(s.barAnchor);
        s.part.body.wakeUp();
      } else if (state.hooked) {
        state.push.set(0, 0, 0);
        state.pushSpeed.set(0, 0, 0);
        Object.assign(s.barAnchor, s.eye);
        s.joint.setAnchor1(s.barAnchor);
      }
      state.hooked = hooked;
      if (length === s.length) continue;
      setJointLimits(s.joint, RAPIER.JointAxis.LinX, 0, length);
      s.part.body.wakeUp(); // a resting puppet sleeps, and a limit alone does not wake it
      s.length = length;
    }
  });

  // Drawn eye → (hook →) socket, with a parabolic sag below the hook that grows
  // with the slack (rendering only)
  const a = new Vector3();
  const h = new Vector3();
  const b = new Vector3();
  physics.afterSync.push(() => {
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
  });

  return {
    bar: main.body,
    strings,
    /** The cross and the strings, for fading them with the puppet. */
    objects,
    materials: [wood, material],
    /** Raises the cross by `y` metres above where the input holds it (0: back down). */
    setLift(y: number) {
      sceneLift = y;
    },
    /** Lengthens every string by `length` metres (0: back to the rig's lengths). */
    setSlack(length: number) {
      slackWanted = length;
    },
    /** Whether the cross has arrived where input and lift want it. */
    arrived: () => barPosition.distanceTo(barTarget) < 0.005,
  };
}
