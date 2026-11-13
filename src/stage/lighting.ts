import { DirectionalLight, HemisphereLight, SpotLight, type World } from "@iwsdk/core";

// 3-point lighting (warm key, cool fill, back light for the silhouette)
// plus the controllable spotlight, the only light casting shadows (phones).

export function addLighting(world: World) {
  const key = new DirectionalLight(0xfff1dc, 1.6);
  key.position.set(2, 4, 4);
  const fill = new DirectionalLight(0xbcd4ff, 0.5);
  fill.position.set(-3, 2, 3);
  const back = new DirectionalLight(0xffffff, 1.0);
  back.position.set(0, 3, -3);
  const ambient = new HemisphereLight(0xffeedd, 0x201010, 0.25);

  const spot = new SpotLight(0xfff6e0, 40, 12, 0.35, 0.5, 1.5);
  spot.position.set(0, 4.5, 3);
  spot.target.position.set(0, 1, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);

  world.scene.add(key, fill, back, ambient, spot, spot.target);
  return { spot };
}
