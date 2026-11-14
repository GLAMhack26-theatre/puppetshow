import {
  Box3,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  Vector3,
  type Object3D,
  type World,
} from "@iwsdk/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import wallUrl from "../../assets/stage_parts/wall.glb?url";

// The curved room wall behind the paper theatre, from
// assets/stage_parts/wall.glb (Blender export): Wall (a velvet cylinder
// section, already upright) and Borduere (a gold band near its foot). The
// file's y = 0 is the floor. In the file the arc bulges towards +z.

/** Width of the wall (chord of the arc) in metres, much wider than the 1.4 m stage. */
const WALL_WIDTH = 8;
/** Gap between the back of the stage model and the wall, in metres. */
const WALL_GAP = 2.8;
/** Size of one velvet tile on the wall, in metres. */
const VELVET_TILE = 0.5;
/**
 * Colour of the velvet. The texture in the file is grey on purpose: it only
 * gives the grain and folds, this colour is multiplied into it (sRGB hex).
 */
const VELVET_COLOR = 0x2c5a56;
/** Velvet is matte: overrides the file's 0.5, which gave the wall a sheen. */
const VELVET_ROUGHNESS = 0.85;

/**
 * Stands the wall up behind the theatre.
 * @param theatre the loaded stage model (already scaled and placed)
 */
export async function addWall(world: World, theatre: Object3D) {
  const gltf = await new GLTFLoader().loadAsync(wallUrl);
  const wall = gltf.scene;
  // Not "Wall": that is the mesh node looked up below
  wall.name = "RoomWall";

  // Turned like the stage, so the hollow side faces the camera (+z) and the
  // wall wraps around the back of the theatre
  wall.rotation.y = Math.PI;
  wall.traverse((object) => {
    if (object instanceof Mesh) object.receiveShadow = true;
  });

  const mesh = wall.getObjectByName("Wall")!;
  wall.updateMatrixWorld(true);
  wall.scale.setScalar(WALL_WIDTH / new Box3().setFromObject(mesh).getSize(new Vector3()).x);
  wall.updateMatrixWorld(true);
  tileVelvet(mesh as Mesh, world);

  // The file's floor (y = 0) on the ground the theatre stands on (the wall
  // reaches a little below it), centred on the stage, the deepest point of
  // the arc a gap behind the stage's back
  const stageBox = new Box3().setFromObject(theatre);
  const wallBox = new Box3().setFromObject(mesh);
  const stageCenter = stageBox.getCenter(new Vector3());
  wall.position.set(
    stageCenter.x - wallBox.getCenter(new Vector3()).x,
    stageBox.min.y,
    stageBox.min.z - WALL_GAP - wallBox.min.z,
  );
  world.scene.add(wall);
  return wall;
}

/**
 * Tiles the velvet: Blender's cylinder unwrap stretches
 * the one texture over the whole wall, so it repeats it instead, one tile per
 * VELVET_TILE metres. The UVs are proportional to the surface (arc length
 * along u, height along v), so the metres per UV unit are measured from the
 * mesh once.
 */
function tileVelvet(mesh: Mesh, world: World) {
  const material = mesh.material as MeshStandardMaterial;
  // three.js multiplies the material colour with the texture
  material.color.setHex(VELVET_COLOR);
  material.roughness = VELVET_ROUGHNESS;
  const map = material.map;
  if (!map) return;
  const position = mesh.geometry.getAttribute("position");
  const uv = mesh.geometry.getAttribute("uv");

  // Vertices in world space with their UVs
  const points = Array.from({ length: position.count }, (_, i) => ({
    p: new Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld),
    u: uv.getX(i),
    v: uv.getY(i),
  }));
  // Along u: walk the bottom row of vertices around the arc
  const vMax = Math.max(...points.map((q) => q.v));
  const row = points.filter((q) => Math.abs(q.v - vMax) < 1e-4).sort((a, b) => a.u - b.u);
  let arc = 0;
  for (let i = 1; i < row.length; i++) arc += row[i].p.distanceTo(row[i - 1].p);
  const metresPerU = arc / (row[row.length - 1].u - row[0].u);
  // Along v: the wall's height
  const vMin = Math.min(...points.map((q) => q.v));
  const ys = points.map((q) => q.p.y);
  const metresPerV = (Math.max(...ys) - Math.min(...ys)) / (vMax - vMin);

  map.wrapS = map.wrapT = RepeatWrapping;
  map.repeat.set(metresPerU / VELVET_TILE, metresPerV / VELVET_TILE);
  // Seen at a grazing angle at the ends of the arc
  map.anisotropy = world.renderer.capabilities.getMaxAnisotropy();
  map.needsUpdate = true;
}
