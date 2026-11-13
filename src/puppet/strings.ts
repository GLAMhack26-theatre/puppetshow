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
  Vector3,
  type Object3D,
  type World,
} from "@iwsdk/core";
import { STRING_IDS, controlInput, type StringId } from "../input/control-input";
import { STEP, addLinked, physics, renderPoint } from "../systems/rapier-system";
import type { Rig, RigPart, RigString } from "./rig";

// The control bar (Spielkreuz) and the strings: rope joints (maximum
// distance, rest lengths from the rig) from the bar to the string sockets.
// Pulling shortens a rope; the bar follows ControlInput with a capped speed.

const PULL_RANGE = 0.12; // m: a full pull shortens a string by this much (puppet: 0.35 m)
const MAX_BAR_SPEED = 1.5; // m/s: the bar follows the input without teleporting
const SEGMENTS = 12; // points per drawn string
const SAG = 0.5; // drawn sag per metre of slack

interface PuppetString {
  id: StringId;
  part: RigPart;
  anchor: RAPIER.Vector; // on the puppet body
  barAnchor: RAPIER.Vector; // on the bar
  rest: number;
  length: number;
  joint: RAPIER.ImpulseJoint;
  line: Line;
}

const vec = (v: Vector3): RAPIER.Vector => ({ x: v.x, y: v.y, z: v.z });

export function createStrings(world: World, root: Object3D, rig: Rig, description: RigString[]) {
  const pw = physics.world;
  root.updateMatrixWorld(true);
  const toWorld = (v: Vector3) => v.clone().applyMatrix4(root.matrixWorld);

  // One bar for all strings (the model's three controller bars merged): its
  // centre above the puppet at the mean height of the upper string ends
  const barPoints = description.map((s) => toWorld(s.barPoint));
  const rootPosition = root.getWorldPosition(new Vector3());
  const barCenter = new Vector3(rootPosition.x, barPoints.reduce((sum, p) => sum + p.y, 0) / barPoints.length, rootPosition.z);
  controlInput.bar.position.copy(barCenter);

  // Bar: a cross of two slats, kinematic
  const barMesh = new Group();
  const wood = new MeshStandardMaterial({ color: 0x4a2c17, roughness: 0.8 });
  barMesh.add(new Mesh(new BoxGeometry(0.32, 0.01, 0.014), wood), new Mesh(new BoxGeometry(0.014, 0.01, 0.1), wood));
  const { body: bar } = addLinked(world, barMesh, RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(barCenter.x, barCenter.y, barCenter.z));

  const strings: PuppetString[] = [];
  const material = new LineBasicMaterial({ color: 0xf3e9dc });
  description.forEach((s, i) => {
    const part = rig.byName.get(s.bone);
    if (!part || !STRING_IDS.includes(s.id)) return;
    const anchor = vec(toWorld(s.position).sub(new Vector3().copy(part.body.translation())));
    const barAnchor = vec(barPoints[i].clone().sub(barCenter));
    const rest = s.restLength;
    const joint = pw.createImpulseJoint(RAPIER.JointData.rope(rest, barAnchor, anchor), bar, part.body, true);

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3));
    const line = new Line(geometry, material);
    line.frustumCulled = false;
    world.scene.add(line);
    strings.push({ id: s.id, part, anchor, barAnchor, rest, length: rest, joint, line });
  });

  const barPosition = barCenter.clone();
  const barMove = new Vector3();
  physics.beforeStep.push(() => {
    barMove.subVectors(controlInput.bar.position, barPosition).clampLength(0, MAX_BAR_SPEED * STEP);
    barPosition.add(barMove);
    bar.setNextKinematicTranslation(barPosition);
    bar.setNextKinematicRotation(controlInput.bar.rotation);

    // Rapier's rope joint has no length setter in JS: recreate it when the
    // pull changed noticeably (a few joints per frame at most)
    for (const s of strings) {
      const length = Math.max(0.05, s.rest - PULL_RANGE * controlInput.pulls[s.id]);
      if (Math.abs(length - s.length) < 0.005) continue;
      pw.removeImpulseJoint(s.joint, true);
      s.joint = pw.createImpulseJoint(RAPIER.JointData.rope(length, s.barAnchor, s.anchor), bar, s.part.body, true);
      s.length = length;
    }
  });

  // Drawn with a parabolic sag that grows with the slack (rendering only)
  const a = new Vector3();
  const b = new Vector3();
  physics.afterSync.push(() => {
    for (const s of strings) {
      renderPoint(bar, s.barAnchor, a);
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

  return { bar, strings };
}
