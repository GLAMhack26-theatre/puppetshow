import { DirectionalLight, HemisphereLight, PMREMGenerator, SpotLight, type World } from "@iwsdk/core";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// 3-point lighting (warm key, cool fill, back light for the silhouette)
// plus the controllable spotlight, the only light casting shadows (phones).
// Positions for the real-scale stage (1.4 m wide, puppet 0.35 m).

/** Strength of the environment reflections; the lights stay the main source */
const ENVIRONMENT_INTENSITY = 0.4;

export function addLighting(world: World) {
  // A neutral room as environment: the marionette's clearcoat, sheen and
  // specular materials (made in Blender with an HDRI) look dull and too
  // dark with direct lights alone
  const pmrem = new PMREMGenerator(world.renderer);
  world.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  world.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
  pmrem.dispose();

  const key = new DirectionalLight(0xfff1dc, 1.6);
  key.position.set(0.8, 1.6, 1.6);
  const fill = new DirectionalLight(0xbcd4ff, 0.5);
  fill.position.set(-1.2, 0.8, 1.2);
  const back = new DirectionalLight(0xffffff, 1.0);
  back.position.set(0, 1.2, -1.2);
  const ambient = new HemisphereLight(0xffeedd, 0x201010, 0.25);

  const spot = new SpotLight(0xfff6e0, 10, 5, 0.35, 0.5, 1.5);
  spot.position.set(0, 1.8, 1.2);
  spot.target.position.set(0, 0.3, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0005; // small scene: avoid shadow acne on the puppet
  world.scene.add(key, fill, back, ambient, spot, spot.target);
  return { spot };
}
