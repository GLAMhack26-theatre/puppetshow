import { DirectionalLight, HemisphereLight, PMREMGenerator, type World } from "@iwsdk/core";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// 3-point lighting (warm key, cool fill, back light for the silhouette): the
// general light on the stage, kept low enough that a follow spot still stands
// out and white props do not burn out under it. The focus comes from the
// follow spots, one per puppet (spotlights.ts), which are also the only
// lights casting shadows.
// Positions for the real-scale stage (1.4 m wide, puppet 0.35 m).

/** Strength of the environment reflections; the lights stay the main source */
const ENVIRONMENT_INTENSITY = 0.3;

export function addLighting(world: World) {
  // A neutral room as environment: the marionette's clearcoat, sheen and
  // specular materials (made in Blender with an HDRI) look dull and too
  // dark with direct lights alone
  const pmrem = new PMREMGenerator(world.renderer);
  world.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  world.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
  pmrem.dispose();

  const key = new DirectionalLight(0xfff1dc, 0.8);
  key.position.set(0.8, 1.6, 1.6);
  const fill = new DirectionalLight(0xbcd4ff, 0.25);
  fill.position.set(-1.2, 0.8, 1.2);
  const back = new DirectionalLight(0xffffff, 0.6);
  back.position.set(0, 1.2, -1.2);
  const ambient = new HemisphereLight(0xffeedd, 0x201010, 0.15);

  world.scene.add(key, fill, back, ambient);
}
