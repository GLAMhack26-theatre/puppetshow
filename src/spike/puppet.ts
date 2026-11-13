import RAPIER from "@dimforge/rapier3d-compat";
import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  Plane,
  Quaternion,
  Raycaster,
  SphereGeometry,
  Vector2,
  Vector3,
  type World,
} from "@iwsdk/core";
import { controlInput, type StringId } from "../input/control-input";
import { GROUP, STEP, physics, renderPose } from "../systems/rapier-system";
import { addLinked, hudLines } from "./world";

// T2: kinematic control bar + simplified puppet (head, torso, two arms) on
// spherical joints, strings as rope joints, grab / throw a box with a hand
// sensor and a fixed joint.

const v = (x: number, y: number, z = 0) => ({ x, y, z });
const toVec = (p: RAPIER.Vector) => new Vector3(p.x, p.y, p.z);
const toQuat = (r: RAPIER.Rotation) => new Quaternion(r.x, r.y, r.z, r.w);

/** World position of a body-local point (physics pose). */
function worldPoint(body: RAPIER.RigidBody, local: RAPIER.Vector) {
  return new Vector3(local.x, local.y, local.z).applyQuaternion(toQuat(body.rotation())).add(toVec(body.translation()));
}

/** The same for rendering: interpolated pose, like the meshes. */
const renderP = new Vector3();
const renderQ = new Quaternion();
function renderPoint(body: RAPIER.RigidBody, local: RAPIER.Vector, out: Vector3) {
  renderPose(body, renderP, renderQ);
  return out.set(local.x, local.y, local.z).applyQuaternion(renderQ).add(renderP);
}

const MAX_PULL = 0.6; // a full pull shortens a string to 40% of its rest length
const MAX_BAR_SPEED = 4; // m/s: the bar follows the input without teleporting
const THROW_BOOST = 1.5; // release velocity = hand velocity × boost
// Wood-like densities (kg/m³): an arm ≈ 0.3 kg, the box ≈ 0.15 kg. With
// Rapier's default of 1 a limb weighed under a gram and a held box simply
// dragged it down.
const WOOD = 400;
const PROP = 150;

export function setupPuppet(world: World) {
  const pw = physics.world;
  const limb = new MeshStandardMaterial({ color: 0xd9b48f, roughness: 0.7 });
  const cloth = new MeshStandardMaterial({ color: 0x2f5d8a, roughness: 0.9 });
  const dynamic = (x: number, y: number) =>
    RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, 0).setLinearDamping(0.6).setAngularDamping(2.5);

  // Control bar (Spielkreuz): kinematic, follows ControlInput.bar
  const barMesh = new Mesh(new BoxGeometry(0.5, 0.03, 0.06), new MeshStandardMaterial({ color: 0x4a2c17 }));
  const p0 = controlInput.bar.position;
  const { body: bar } = addLinked(world, barMesh, RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p0.x, p0.y, p0.z));

  const { body: torso } = addLinked(
    world,
    new Mesh(new CapsuleGeometry(0.07, 0.2), cloth),
    dynamic(0, 1.35),
    RAPIER.ColliderDesc.capsule(0.1, 0.07).setDensity(WOOD).setCollisionGroups(GROUP.puppet),
  );
  const { body: head } = addLinked(
    world,
    new Mesh(new SphereGeometry(0.08, 24, 16), limb),
    dynamic(0, 1.6),
    RAPIER.ColliderDesc.ball(0.08).setDensity(WOOD).setCollisionGroups(GROUP.puppet),
  );
  const arm = (side: -1 | 1) =>
    addLinked(
      world,
      new Mesh(new CapsuleGeometry(0.035, 0.16), limb),
      dynamic(side * 0.09, 1.355),
      RAPIER.ColliderDesc.capsule(0.08, 0.035).setDensity(WOOD).setCollisionGroups(GROUP.limb),
    ).body;
  const armL = arm(-1);
  const armR = arm(1);

  // Spherical joints; Rapier's JS API has no cone limits for them, so
  // angular damping keeps the limbs calm (finding for docs/spikes/iwsdk.md)
  pw.createImpulseJoint(RAPIER.JointData.spherical(v(0, 0.17), v(0, -0.08)), torso, head, true);
  pw.createImpulseJoint(RAPIER.JointData.spherical(v(-0.09, 0.12), v(0, 0.115)), torso, armL, true);
  pw.createImpulseJoint(RAPIER.JointData.spherical(v(0.09, 0.12), v(0, 0.115)), torso, armR, true);

  // Strings: rope joints (max distance) from the bar to the attachment points
  const hand = v(0, -0.115);
  const strings: Record<StringId, { body: RAPIER.RigidBody; barAnchor: RAPIER.Vector; anchor: RAPIER.Vector; rest: number; length: number; joint: RAPIER.ImpulseJoint; line: Line }> = {} as never;
  const lineMaterial = new LineBasicMaterial({ color: 0xf3e9dc });
  const addString = (id: StringId, body: RAPIER.RigidBody, barAnchor: RAPIER.Vector, anchor: RAPIER.Vector) => {
    const rest = worldPoint(bar, barAnchor).distanceTo(worldPoint(body, anchor)) * 1.02;
    const joint = pw.createImpulseJoint(RAPIER.JointData.rope(rest, barAnchor, anchor), bar, body, true);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
    const line = new Line(geometry, lineMaterial);
    line.frustumCulled = false;
    world.scene.add(line);
    strings[id] = { body, barAnchor, anchor, rest, length: rest, joint, line };
  };
  addString("head", head, v(0, 0), v(0, 0.08));
  addString("handL", armL, v(-0.22, 0), hand);
  addString("handR", armR, v(0.22, 0), hand);

  // A table with a box to grab
  const table = new Mesh(new BoxGeometry(0.5, 1, 0.4), new MeshStandardMaterial({ color: 0x5a3a22 }));
  table.position.set(0.55, 0.5, 0);
  table.receiveShadow = true;
  world.scene.add(table);
  pw.createCollider(RAPIER.ColliderDesc.cuboid(0.25, 0.5, 0.2).setTranslation(0.55, 0.5, 0).setCollisionGroups(GROUP.stage));
  const { body: prop, collider: propCollider } = addLinked(
    world,
    new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color: 0xc89b3c })),
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0.5, 1.06, 0).setCcdEnabled(true),
    RAPIER.ColliderDesc.cuboid(0.05, 0.05, 0.05).setDensity(PROP).setCollisionGroups(GROUP.prop),
  );
  const sensor = pw.createCollider(
    RAPIER.ColliderDesc.ball(0.06).setTranslation(hand.x, hand.y, hand.z).setSensor(true).setCollisionGroups(GROUP.sensor),
    armR,
  );

  let grabJoint: RAPIER.ImpulseJoint | null = null;
  let wasGripping = false;
  const barPosition = controlInput.bar.position.clone();
  const barMove = new Vector3();

  physics.beforeStep.push(() => {
    barMove.subVectors(controlInput.bar.position, barPosition).clampLength(0, MAX_BAR_SPEED * STEP);
    barPosition.add(barMove);
    bar.setNextKinematicTranslation(barPosition);
    bar.setNextKinematicRotation(controlInput.bar.rotation);

    // Rapier's rope joint has no length setter in JS: recreate it when the
    // pull changed noticeably (cheap, a few joints per frame at most)
    for (const id of Object.keys(strings) as StringId[]) {
      const s = strings[id];
      const length = s.rest * (1 - MAX_PULL * controlInput.pulls[id]);
      if (Math.abs(length - s.length) < 0.005) continue;
      pw.removeImpulseJoint(s.joint, true);
      s.joint = pw.createImpulseJoint(RAPIER.JointData.rope(length, s.barAnchor, s.anchor), bar, s.body, true);
      s.length = length;
    }

    const gripping = controlInput.grip.right;
    if (gripping && !wasGripping && !grabJoint && propCollider && pw.intersectionPair(sensor, propCollider)) {
      // Keep the current relative pose: frame1 = armRot⁻¹ · propRot
      const handWorld = worldPoint(armR, hand);
      const propRot = toQuat(prop.rotation());
      const local = handWorld.sub(toVec(prop.translation())).applyQuaternion(propRot.clone().invert());
      const frame = toQuat(armR.rotation()).invert().multiply(propRot);
      grabJoint = pw.createImpulseJoint(
        RAPIER.JointData.fixed(hand, frame, local, { x: 0, y: 0, z: 0, w: 1 }),
        armR,
        prop,
        true,
      );
    } else if (!gripping && grabJoint) {
      pw.removeImpulseJoint(grabJoint, true);
      grabJoint = null;
      // Throw: the box leaves with the hand's velocity (v + ω × r), boosted
      // because the damped puppet moves slower than a real flick
      const r = worldPoint(armR, hand).sub(toVec(armR.translation()));
      const velocity = toVec(armR.angvel()).cross(r).add(toVec(armR.linvel())).multiplyScalar(THROW_BOOST);
      prop.setLinvel(velocity, true);
    }
    wasGripping = gripping;
  });

  const a = new Vector3();
  const b = new Vector3();
  physics.afterSync.push(() => {
    for (const s of Object.values(strings)) {
      renderPoint(bar, s.barAnchor, a);
      renderPoint(s.body, s.anchor, b);
      const position = s.line.geometry.getAttribute("position");
      position.setXYZ(0, a.x, a.y, a.z);
      position.setXYZ(1, b.x, b.y, b.z);
      position.needsUpdate = true;
    }
    hudLines.sensor = propCollider && pw.intersectionPair(sensor, propCollider) ? "touching" : "-";
    hudLines.grab = grabJoint ? "holding" : "-";
    hudLines.input = controlInput.source;
  });

  setupPointerAndPanel(world);
}

/** Pointer moves the bar on the z = 0 plane; sliders pull strings; G or the button grips. */
function setupPointerAndPanel(world: World) {
  const canvas = world.renderer.domElement;
  const raycaster = new Raycaster();
  const plane = new Plane(new Vector3(0, 0, 1), 0);
  const ndc = new Vector2();
  const hit = new Vector3();
  canvas.addEventListener("pointermove", (e) => {
    if (controlInput.source !== "mouse") return;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, world.camera);
    if (raycaster.ray.intersectPlane(plane, hit)) {
      controlInput.bar.position.set(Math.max(-1.4, Math.min(1.4, hit.x)), Math.max(1.0, Math.min(2.6, hit.y)), 0);
    }
  });

  const panel = document.getElementById("panel")!;
  for (const id of ["head", "handL", "handR"] as StringId[]) {
    const label = document.createElement("label");
    const slider = Object.assign(document.createElement("input"), { type: "range", min: "0", max: "1", step: "0.01", value: "0" });
    slider.addEventListener("input", () => (controlInput.pulls[id] = Number(slider.value)));
    label.append(id, slider);
    panel.append(label);
  }
  const grab = Object.assign(document.createElement("button"), { textContent: "Greifen (G)" });
  grab.addEventListener("pointerdown", () => (controlInput.grip.right = true));
  grab.addEventListener("pointerup", () => (controlInput.grip.right = false));
  grab.addEventListener("pointerleave", () => (controlInput.grip.right = false));
  panel.append(grab);
  addEventListener("keydown", (e) => e.key === "g" && (controlInput.grip.right = true));
  addEventListener("keyup", (e) => e.key === "g" && (controlInput.grip.right = false));
}
