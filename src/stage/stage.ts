import RAPIER from "@dimforge/rapier3d-compat";
import {
  Box3,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3,
  createSystem,
  type Object3D,
  type World,
} from "@iwsdk/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import stageUrl from "../../assets/stage_parts/Stage_Parent.glb?url";
import { GROUP, physics } from "../systems/rapier-system";
import { addGround } from "./ground";
import { addWall } from "./wall";

// The main stage from assets/stage_parts/Stage_Parent.glb (Unity export):
// Stage_Front (paper theatre front, cut-out PNG), Curtain (in front of it)
// and Ground_Box (the floor the puppet plays on). Loaded straight from
// assets/ until the converter exists.

/**
 * Width of the stage front in metres; the file is about 1 unit wide. Real
 * scale: sized to the 0.35 m marionette (export/marionette_rig.json).
 */
const STAGE_WIDTH = 1.4;
const CURTAIN_SPEED = 1.2; // open fraction per second

/** The stage floor in world space, set by loadStage: how far the puppet can be moved */
export const stageFloor = new Box3();

const curtain = {
  mesh: null as Object3D | null,
  top: 0, // y of the top edge, fixed while it rolls up
  height: 0,
  baseScaleY: 1,
  open: 1, // 0 closed … 1 rolled up
  target: 1,
};

/**
 * Where things stand on the stage, in world units; set by loadStage(). The
 * floor top is at y = 0, the camera looks from +z.
 */
export const stageBounds = {
  /** Scale from the Unity file units (stage front ≈ 1 wide) to metres. */
  scale: 1,
  /** z of the back edge of the floor. */
  backZ: 0,
  /** Width (x) of the floor, Ground_Box. */
  width: 0,
  centerX: 0,
};

/**
 * Unity exports the paper parts unlit (KHR_materials_unlit): they would
 * ignore the 3-point lighting and the spotlight. Swaps such a material for
 * a matte lit one with the same texture.
 */
export function makeLit(object: Object3D) {
  if (!(object instanceof Mesh) || !(object.material instanceof MeshBasicMaterial)) return;
  const unlit = object.material;
  object.material = new MeshStandardMaterial({
    map: unlit.map,
    color: unlit.color,
    alphaTest: unlit.alphaTest,
    transparent: unlit.transparent,
    side: unlit.side,
    roughness: 1,
    metalness: 0,
  });
  unlit.dispose();
}

export async function loadStage(world: World) {
  const gltf = await new GLTFLoader().loadAsync(stageUrl);
  const root = gltf.scene;

  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.receiveShadow = true;
    // Unity exported the paper parts unlit (KHR_materials_unlit): they would
    // ignore the 3-point lighting and the spotlight. Stage_Front stays unlit,
    // so the painted proscenium keeps its original colours.
    if (object.name !== "Stage_Front") makeLit(object);
  });

  // The front and the curtain face −z in the file: turn the stage to face
  // the camera (+z), which also puts the floor behind the front and the
  // curtain between them
  root.rotation.y = Math.PI;

  // Scale to STAGE_WIDTH, centre on x, floor top at y = 0, floor centred on z = 0
  const front = root.getObjectByName("Stage_Front")!;
  const ground = root.getObjectByName("Ground_Box")!;
  root.updateMatrixWorld(true);
  root.scale.setScalar(STAGE_WIDTH / new Box3().setFromObject(front).getSize(new Vector3()).x);
  root.updateMatrixWorld(true);
  const groundBox = new Box3().setFromObject(ground);
  const groundCenter = groundBox.getCenter(new Vector3());
  root.position.set(-groundCenter.x, -groundBox.max.y, -groundCenter.z);
  root.updateMatrixWorld(true);
  world.scene.add(root);
  // The asphalt around the theatre, at the bottom of the whole stage model
  addGround(world, new Box3().setFromObject(root).min.y);
  // The room wall behind the theatre
  await addWall(world, root);

  groundBox.setFromObject(ground);
  stageFloor.copy(groundBox);
  const size = groundBox.getSize(new Vector3());
  const center = groundBox.getCenter(new Vector3());
  stageBounds.scale = root.scale.x;
  stageBounds.backZ = groundBox.min.z;
  stageBounds.centerX = center.x;
  stageBounds.width = size.x;
  physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
      .setTranslation(center.x, center.y, center.z)
      .setCollisionGroups(GROUP.stage),
  );

  const curtainMesh = root.getObjectByName("Curtain");
  if (curtainMesh) {
    const box = new Box3().setFromObject(curtainMesh);
    curtain.mesh = curtainMesh;
    curtain.top = curtainMesh.position.y + (box.max.y - box.getCenter(new Vector3()).y) / root.scale.y;
    curtain.height = (box.max.y - box.min.y) / root.scale.y;
    curtain.baseScaleY = curtainMesh.scale.y;
    applyCurtain();
  }
}

/** Open (roll up) or close the curtain; animated by StageSystem. */
export function setCurtain(open: boolean) {
  curtain.target = open ? 1 : 0;
}

export function isCurtainOpen() {
  return curtain.target === 1;
}

// The curtain rolls up around its top edge (scale y towards 0) instead of
// sliding up, which would show it above the stage front
function applyCurtain() {
  const mesh = curtain.mesh;
  if (!mesh) return;
  const rest = Math.max(0.001, 1 - curtain.open);
  mesh.visible = curtain.open < 0.999;
  mesh.scale.y = curtain.baseScaleY * rest;
  mesh.position.y = curtain.top - (curtain.height * rest) / 2;
}

export class StageSystem extends createSystem({}) {
  update(delta: number) {
    if (curtain.open === curtain.target) return;
    const step = CURTAIN_SPEED * delta;
    curtain.open += Math.max(-step, Math.min(step, curtain.target - curtain.open));
    applyCurtain();
  }
}
