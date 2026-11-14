import {
  CanvasTexture,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  type World,
} from "@iwsdk/core";
import asphaltUrl from "../../assets/textures/clean_asphalt_diff_1k.jpg?url";

// The ground around the theatre: a large plane with a tiled asphalt texture,
// fading out towards its edge so there is no visible horizon line.

/** Side length of the ground plane in metres (inside the camera's far plane). */
const SIZE = 20;
/** Metres covered by one repeat of the texture. */
const TILE = 1.5;

/** Adds the ground with its top at height y (the bottom of the theatre). */
export function addGround(world: World, y: number) {
  const map = new TextureLoader().load(asphaltUrl);
  map.colorSpace = SRGBColorSpace;
  map.wrapS = map.wrapT = RepeatWrapping;
  map.repeat.set(SIZE / TILE, SIZE / TILE);
  // Seen at a grazing angle: without anisotropy the tiles blur into mush
  map.anisotropy = world.renderer.capabilities.getMaxAnisotropy();

  const ground = new Mesh(
    new PlaneGeometry(SIZE, SIZE),
    new MeshStandardMaterial({
      map,
      // Separate texture transform (no repeat): fades the whole plane at its rim
      alphaMap: radialFade(),
      transparent: true,
      roughness: 0.95,
      metalness: 0,
    }),
  );
  ground.name = "Ground";
  ground.rotation.x = -Math.PI / 2;
  // A hair below, so it never z-fights with the theatre's own base
  ground.position.y = y - 0.001;
  ground.receiveShadow = true;
  ground.renderOrder = -1; // under everything, drawn before the other transparent parts
  world.scene.add(ground);
  return ground;
}

/** White in the middle, black at the rim: alpha for the fade-out. */
function radialFade() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, "#fff");
  gradient.addColorStop(0.35, "#fff");
  gradient.addColorStop(1, "#000");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  return new CanvasTexture(canvas);
}
