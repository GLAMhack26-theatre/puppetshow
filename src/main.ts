import { World } from "@iwsdk/core";
import { PhysicsLink } from "./components/physics-link";
import { addLighting } from "./stage/lighting";
import { StageSystem, isCurtainOpen, loadStage, setCurtain } from "./stage/stage";
import { RapierSystem, initPhysics } from "./systems/rapier-system";
import { FpsSystem } from "./spike/world";

// Phase 0 spike: one page, the test picked with ?test=world|puppet|mediapipe|interop
// (docs/spikes/iwsdk.md). src/spike/ is removed once the spike is done.

const test = new URLSearchParams(location.search).get("test") ?? "world";

await initPhysics();

const world = await World.create(document.getElementById("app")!, {
  xr: false,
  features: { physics: false }, // Rapier instead, see systems/rapier-system.ts
  render: { fov: 45 },
});
world.renderer.shadowMap.enabled = true;
world.camera.position.set(0, 1.5, 4.6);
world.camera.lookAt(0, 1.3, -0.4);

world.registerComponent(PhysicsLink);
world.registerSystem(RapierSystem);
world.registerSystem(StageSystem);
world.registerSystem(FpsSystem);

await loadStage(world);
addLighting(world);
// Spike: C toggles the curtain (later: closed on the title, opens on Play)
addEventListener("keydown", (e) => e.key === "c" && setCurtain(!isCurtainOpen()));

switch (test) {
  case "puppet":
    (await import("./spike/puppet")).setupPuppet(world);
    break;
  case "mediapipe":
    (await import("./spike/mediapipe")).setupMediaPipe(world);
    break;
  case "interop":
    (await import("./spike/interop")).setupInterop(world);
    break;
  default:
    (await import("./spike/world")).setupOrbit(world);
}
