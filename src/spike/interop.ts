import RAPIER from "@dimforge/rapier3d-compat";
import {
  AudioListener,
  Bone,
  BoxGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  PositionalAudio,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Float32BufferAttribute,
  Vector3,
  type World,
} from "@iwsdk/core";
import { GROUP, addLinked, physics, puppetGroups, renderPose } from "../systems/rapier-system";
import { hudLines } from "./world";

// T4: plain three.js next to the ECS.
// - a SkinnedMesh whose bones follow a chain of Rapier bodies
// - two blocks hanging on rope joints (the title screen idea, letters there);
//   tap pushes the left one into the right one. Plain boxes since the spike
//   font (helvetiker) was dropped; TextGeometry itself was confirmed in T4
// - their collision plays a knock through PositionalAudio (audio unlocked by
//   the first tap; the knock is generated here, ZzFX comes in phase 4)

const SEGMENT = 0.2;

export async function setupInterop(world: World) {
  const listener = new AudioListener();
  world.camera.add(listener);
  addSkinnedChain(world);
  addLetters(world, listener);
}

function addSkinnedChain(world: World) {
  const pw = physics.world;
  const top = { x: -0.8, y: 2.2 };

  // Cylinder from y = 0 down to −3·SEGMENT, skinned to 3 bones by height
  const geometry = new CylinderGeometry(0.05, 0.05, SEGMENT * 3, 12, 24);
  geometry.translate(0, -SEGMENT * 1.5, 0);
  const position = geometry.getAttribute("position");
  const indices: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < position.count; i++) {
    const s = Math.min(2, Math.floor(-position.getY(i) / SEGMENT));
    indices.push(s, 0, 0, 0);
    weights.push(1, 0, 0, 0);
  }
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(indices, 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));

  const bones = [new Bone(), new Bone(), new Bone()];
  bones[1].position.y = -SEGMENT;
  bones[2].position.y = -SEGMENT;
  bones[0].add(bones[1]);
  bones[1].add(bones[2]);
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ color: 0x9c6b3f }));
  mesh.add(bones[0]);
  mesh.bind(new Skeleton(bones));
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  world.scene.add(mesh); // plain three.js, not an entity

  // One capsule body per bone, centred half a segment below it
  const anchor = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(top.x, top.y, 0));
  const bodies = bones.map((_, i) =>
    pw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(top.x, top.y - SEGMENT * (i + 0.5), 0)
        .setAngularDamping(1.5),
    ),
  );
  bodies.forEach((b) => pw.createCollider(RAPIER.ColliderDesc.capsule(SEGMENT / 2 - 0.05, 0.05).setCollisionGroups(puppetGroups(0, false).body), b));
  const half = SEGMENT / 2;
  pw.createImpulseJoint(RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: half, z: 0 }), anchor, bodies[0], true);
  for (let i = 1; i < bodies.length; i++) {
    pw.createImpulseJoint(RAPIER.JointData.spherical({ x: 0, y: -half, z: 0 }, { x: 0, y: half, z: 0 }), bodies[i - 1], bodies[i], true);
  }
  bodies[2].applyImpulse({ x: 0.08, y: 0, z: 0.03 }, true); // start a swing

  // Bones follow the bodies: root at the top of body 0, each bone the
  // rotation relative to its parent body
  const q = bodies.map(() => new Quaternion());
  const p = bodies.map(() => new Vector3());
  physics.afterSync.push(() => {
    bodies.forEach((b, i) => renderPose(b, p[i], q[i]));
    // The mesh sits at the origin unrotated, so bone-local equals world here
    bones[0].position.set(0, half, 0).applyQuaternion(q[0]).add(p[0]);
    bones[0].quaternion.copy(q[0]);
    bones[1].quaternion.copy(q[0]).invert().multiply(q[1]);
    bones[2].quaternion.copy(q[1]).invert().multiply(q[2]);
  });
}

function addLetters(world: World, listener: AudioListener) {
  const pw = physics.world;
  const material = new MeshStandardMaterial({ color: 0xe8c872, metalness: 0.2, roughness: 0.5 });

  const letter = (x: number) => {
    const size = new Vector3(0.2, 0.28, 0.06); // about the size of a title letter
    const geometry = new BoxGeometry(size.x, size.y, size.z);
    const mesh = new Mesh(geometry, material);
    const { body, collider } = addLinked(
      world,
      mesh,
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 1.6, 0.3).setAngularDamping(0.8),
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setCollisionGroups(GROUP.prop)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    );
    // Two strings from a fixed point above, to the letter's top corners
    const hook = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 2.3, 0.3));
    for (const side of [-1, 1]) {
      const corner = { x: (side * size.x) / 2, y: size.y / 2, z: 0 };
      pw.createImpulseJoint(RAPIER.JointData.rope(0.6, { x: (side * size.x) / 2, y: 0, z: 0 }, corner), hook, body, true);
    }
    return { mesh, body, collider: collider! };
  };

  const s = letter(0.25);
  const k = letter(0.5);

  const knock = new PositionalAudio(listener);
  knock.setBuffer(makeKnock(listener.context));
  knock.setRefDistance(1);
  k.mesh.add(knock);

  let lastKnock = 0;
  physics.onCollision.push((a, b, started) => {
    const letters = [s.collider.handle, k.collider.handle];
    if (!started || !letters.includes(a) || !letters.includes(b)) return;
    const now = performance.now();
    if (now - lastKnock < 80) return; // one knock per contact, not per solver bounce
    lastKnock = now;
    if (knock.isPlaying) knock.stop();
    knock.play();
    hudLines.audio = `knock (${listener.context.state})`;
  });

  world.renderer.domElement.addEventListener("pointerdown", () => {
    listener.context.resume(); // iOS: audio only starts after a user gesture
    s.body.applyImpulse({ x: 0.12, y: 0, z: 0 }, true);
  });
  hudLines.audio = listener.context.state;
}

/** A short wooden knock: a decaying noise burst over a low sine. */
function makeKnock(ctx: BaseAudioContext) {
  const length = Math.floor(ctx.sampleRate * 0.15);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / ctx.sampleRate;
    data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 60) * 0.5 + Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 25) * 0.6;
  }
  return buffer;
}
