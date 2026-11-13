import RAPIER from "@dimforge/rapier3d-compat";
import {
  BoxGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SpotLight,
  createSystem,
  type Object3D,
  type World,
} from "@iwsdk/core";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PhysicsLink } from "../components/physics-link";
import { GROUP, physics } from "../systems/rapier-system";

// T1: the stage, 3-point lighting + spotlight, FPS overlay; orbit camera.
// Shared by the other tests.

const hud = document.getElementById("hud")!;
export const hudLines: Record<string, string> = {};

export class FpsSystem extends createSystem({}) {
  private frames = 0;
  private elapsed = 0;

  update(delta: number) {
    this.frames++;
    this.elapsed += delta;
    if (this.elapsed < 0.5) return;
    const fps = this.frames / this.elapsed;
    hud.textContent = [
      `fps     ${fps.toFixed(0)}`,
      `delta   ${(delta * 1000).toFixed(1)} ms`,
      `physics ${physics.stepMs.toFixed(2)} ms (${physics.steps} steps)`,
      ...Object.entries(hudLines).map(([k, v]) => `${k.padEnd(7)} ${v}`),
    ].join("\n");
    this.frames = 0;
    this.elapsed = 0;
  }
}

export function buildStage(world: World) {
  const wood = new MeshStandardMaterial({ color: 0x6b4426, roughness: 0.8 });
  const velvet = new MeshStandardMaterial({ color: 0x7a1020, roughness: 0.9 });
  const paper = new MeshStandardMaterial({ color: 0xe8dcc4, roughness: 1 });

  const floor = new Mesh(new BoxGeometry(4, 0.1, 2.4), wood);
  floor.position.set(0, -0.05, 0);
  floor.receiveShadow = true;
  const backdrop = new Mesh(new PlaneGeometry(3.6, 2.6), paper);
  backdrop.position.set(0, 1.3, -1.1);
  backdrop.receiveShadow = true;
  const left = new Mesh(new BoxGeometry(0.3, 2.8, 0.2), velvet);
  left.position.set(-1.85, 1.4, -0.9);
  const right = left.clone();
  right.position.x = 1.85;
  const top = new Mesh(new BoxGeometry(4, 0.4, 0.2), velvet);
  top.position.set(0, 2.8, -0.9);
  for (const mesh of [floor, backdrop, left, right, top]) world.scene.add(mesh);

  physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(2, 0.05, 1.2).setTranslation(0, -0.05, 0).setCollisionGroups(GROUP.stage),
  );

  // 3-point lighting: warm key, cool fill, back light for the silhouette
  const key = new DirectionalLight(0xfff1dc, 1.6);
  key.position.set(2, 4, 3);
  const fill = new DirectionalLight(0xbcd4ff, 0.5);
  fill.position.set(-3, 2, 2);
  const back = new DirectionalLight(0xffffff, 1.0);
  back.position.set(0, 3, -3);
  const ambient = new HemisphereLight(0xffeedd, 0x201010, 0.25);

  // The controllable spotlight: the only light casting shadows (phones)
  const spot = new SpotLight(0xfff6e0, 40, 10, 0.35, 0.5, 1.5);
  spot.position.set(0, 4.5, 2.2);
  spot.target.position.set(0, 1, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  world.scene.add(key, fill, back, ambient, spot, spot.target);
  return { spot };
}

/** A mesh driven by a rigid body, through the ECS (PhysicsLink + RapierSystem). */
export function addLinked(
  world: World,
  object: Object3D,
  bodyDesc: RAPIER.RigidBodyDesc,
  colliderDesc?: RAPIER.ColliderDesc,
) {
  const body = physics.world.createRigidBody(bodyDesc);
  const collider = colliderDesc ? physics.world.createCollider(colliderDesc, body) : undefined;
  object.traverse((o) => (o.castShadow = true));
  world.createTransformEntity(object).addComponent(PhysicsLink, { body: body.handle });
  return { body, collider };
}

export function setupOrbit(world: World) {
  const controls = new OrbitControls(world.camera, world.renderer.domElement);
  controls.target.set(0, 1.15, 0);
  controls.update();
}
