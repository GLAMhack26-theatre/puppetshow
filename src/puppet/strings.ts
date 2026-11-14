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
import { STEP, addLinked, physics, renderPoint, setJointLimits } from "../systems/rapier-system";
import type { Rig, RigController, RigPart, RigString } from "./rig";

// The control cross (Spielkreuz) and the strings, rebuilt from the real SKKG
// cross (export/marionette_rig.json, "controller"): the main bar carries the
// back, shoulder and head strings; the leg bar and the hand bar rock about the
// main bar's long axis. Every bar is a kinematic body; each string is a rope
// joint (maximum distance, rest length from the rig) from the eye on its bar
// to the socket on the puppet. The puppeteer's moves come from ControlInput:
// the main bar's pose (tilting it bows or turns the puppet), the rocking
// angles, the hand bar taken off the cross and moved freely, and per-string
// pulls on top (plucking a single string).

const PULL_RANGE = 0.12; // m: a full pull shortens a string by this much (puppet: 0.35 m)
const MAX_PULL_SPEED = 1; // m/s: a string is drawn in, not teleported (a slider jump would otherwise leave it 12 cm too long for a step)
const MAX_BAR_SPEED = 1.5; // m/s: the bar follows the input without teleporting
const MAX_BAR_TURN = 5; // rad/s: the same for its rotation (a noisy source would otherwise whip the strings)
const REATTACH = 0.08; // s: time constant of a bar that was let go easing back onto its seat (the magnet pulls it in)
const MAX_LEASH = 0.3; // m: how far a detached bar may leave its seat (its strings are 0.48 m)
const MAX_ROCK_SPEED = 6; // rad/s: rocking follows the input smoothly
const SEGMENTS = 12; // points per drawn string
const SAG = 0.5; // drawn sag per metre of slack

interface PuppetString {
  id: StringId;
  part: RigPart;
  bar: RAPIER.RigidBody;
  anchor: RAPIER.Vector; // on the puppet body
  barAnchor: RAPIER.Vector; // on the bar
  rest: number;
  length: number;
  joint: RAPIER.ImpulseJoint;
  line: Line;
}

interface RockingBar {
  body: RAPIER.RigidBody;
  input: RockId;
  axis: Vector3;
  /** Pivot relative to the main bar's pivot, in the main bar's frame */
  offset: Vector3;
  limit: number;
  angle: number;
  /** Can be taken off the cross; while it is not seated it has its own pose (world) */
  detachable: boolean;
  seated: boolean;
  freePosition: Vector3;
  freeRotation: Quaternion;
}

const vec = (v: Vector3): RAPIER.Vector => ({ x: v.x, y: v.y, z: v.z });
const UP = new Vector3(0, 0, 1);

export function createStrings(world: World, root: Object3D, rig: Rig, description: RigString[], controller: RigController) {
  const pw = physics.world;
  root.updateMatrixWorld(true);
  const toWorld = (v: Vector3) => v.clone().applyMatrix4(root.matrixWorld);
  const dirToWorld = (v: Vector3) => v.clone().transformDirection(root.matrixWorld);

  // One kinematic body per bar, at its pivot; all start unrotated, so a point's
  // body-local anchor at rest is simply (point − pivot) in world space
  const wood = new MeshStandardMaterial({ color: 0xc8a171, roughness: 0.8 });
  const size = controller.stickSize;
  const bodies = new Map<string, { body: RAPIER.RigidBody; pivot: Vector3 }>();
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
    const { body } = addLinked(world, group, RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pivot.x, pivot.y, pivot.z));
    bodies.set(bar.name, { body, pivot });
  }
  const mainBar = controller.bars.find((b) => !b.parent)!;
  const main = bodies.get(mainBar.name)!;
  controlInput.bar.position.copy(main.pivot);
  const rocking: RockingBar[] = controller.bars
    .filter((b) => b.parent && b.axis && b.input)
    .map((b) => {
      const { body, pivot } = bodies.get(b.name)!;
      return { body, input: b.input!, axis: dirToWorld(b.axis!), offset: pivot.clone().sub(main.pivot), limit: b.limit, angle: 0, detachable: b.detachable, seated: true, freePosition: pivot.clone(), freeRotation: new Quaternion() };
    });

  const strings: PuppetString[] = [];
  const material = new LineBasicMaterial({ color: 0xf3e9dc });
  for (const s of description) {
    const part = rig.byName.get(s.bone);
    const bar = bodies.get(s.bar) ?? main;
    if (!part || !STRING_IDS.includes(s.id)) continue;
    const anchor = vec(toWorld(s.position).sub(new Vector3().copy(part.body.translation())));
    const barAnchor = vec(toWorld(s.barPoint).sub(bar.pivot));
    const rest = s.restLength;
    const joint = pw.createImpulseJoint(RAPIER.JointData.rope(rest, barAnchor, anchor), bar.body, part.body, true);

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3));
    const line = new Line(geometry, material);
    line.frustumCulled = false;
    world.scene.add(line);
    objects.push(line);
    strings.push({ id: s.id, part, bar: bar.body, anchor, barAnchor, rest, length: rest, joint, line });
  }

  const barPosition = main.pivot.clone();
  const barRotation = new Quaternion();
  const barTarget = new Vector3();
  const barMove = new Vector3();
  // Extra height of the cross on top of the input: pulls the whole puppet up
  // out of the way while a scene changes (puppet.ts)
  let lift = 0;
  const rockQ = new Quaternion();
  const p = new Vector3();
  const q = new Quaternion();
  const handBar = controlInput.handBar;
  handBar.detached = false;
  physics.beforeStep.push(() => {
    barTarget.copy(controlInput.bar.position).setY(controlInput.bar.position.y + lift);
    barMove.subVectors(barTarget, barPosition).clampLength(0, MAX_BAR_SPEED * STEP);
    barPosition.add(barMove);
    barRotation.rotateTowards(controlInput.bar.rotation, MAX_BAR_TURN * STEP);
    main.body.setNextKinematicTranslation(barPosition);
    main.body.setNextKinematicRotation(barRotation);

    // Rocking bars ride on the main bar: pivot follows its pose, and they turn
    // about their axis (in the main bar's frame) on top of its rotation
    for (const r of rocking) {
      // ?? 0: a rig may name a rocker this build has no input for yet
      const target = Math.max(-r.limit, Math.min(r.limit, controlInput.rock[r.input] ?? 0));
      r.angle += Math.max(-MAX_ROCK_SPEED * STEP, Math.min(MAX_ROCK_SPEED * STEP, target - r.angle));
      p.copy(r.offset).applyQuaternion(barRotation).add(barPosition);
      q.copy(barRotation).multiply(rockQ.setFromAxisAngle(r.axis, r.angle));
      if (r.detachable) {
        // p, q: its seat on the cross. Taken off, it follows ControlInput.handBar
        // instead (speed-capped like the main bar, and on a leash so the strings
        // stay sane); let go, it is pulled back until it sits again.
        if (handBar.detached) {
          r.seated = false;
          barMove.subVectors(handBar.position, r.freePosition).clampLength(0, MAX_BAR_SPEED * STEP);
          r.freePosition.add(barMove).sub(p).clampLength(0, MAX_LEASH).add(p);
          r.freeRotation.rotateTowards(handBar.rotation, MAX_BAR_TURN * STEP);
        } else if (!r.seated) {
          const pull = 1 - Math.exp(-STEP / REATTACH);
          r.freePosition.lerp(p, pull);
          r.freeRotation.slerp(q, pull);
          r.seated = r.freePosition.distanceTo(p) < 0.002 && r.freeRotation.angleTo(q) < 0.03;
        }
        if (r.seated) {
          r.freePosition.copy(p);
          r.freeRotation.copy(q);
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
      r.body.setNextKinematicTranslation(p);
      r.body.setNextKinematicRotation(q);
    }

    // A pull shortens the rope. A rope joint is a distance limit on the joint's
    // first axis, so its length is that limit: set it instead of recreating
    // the joint (which pulled in 5 mm steps and threw the solver's state away)
    for (const s of strings) {
      const target = Math.max(0.05, s.rest - PULL_RANGE * controlInput.pulls[s.id]);
      if (target === s.length) continue;
      const length = s.length + Math.max(-MAX_PULL_SPEED * STEP, Math.min(MAX_PULL_SPEED * STEP, target - s.length));
      setJointLimits(s.joint, RAPIER.JointAxis.LinX, 0, length);
      s.part.body.wakeUp(); // a resting puppet sleeps, and a limit alone does not wake it
      s.length = length;
    }
  });

  // Drawn with a parabolic sag that grows with the slack (rendering only)
  const a = new Vector3();
  const b = new Vector3();
  physics.afterSync.push(() => {
    for (const s of strings) {
      renderPoint(s.bar, s.barAnchor, a);
      renderPoint(s.part.body, s.anchor, b);
      const distance = a.distanceTo(b);
      const sag = Math.sqrt(Math.max(0, s.length * s.length - distance * distance)) * SAG;
      const position = s.line.geometry.getAttribute("position");
      for (let i = 0; i <= SEGMENTS; i++) {
        const t = i / SEGMENTS;
        position.setXYZ(i, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t - 4 * sag * t * (1 - t), a.z + (b.z - a.z) * t);
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
      lift = y;
    },
    /** Whether the cross has arrived where input and lift want it. */
    arrived: () => barPosition.distanceTo(barTarget) < 0.005,
  };
}
