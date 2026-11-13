import { World } from "@iwsdk/core";
import { PhysicsLink } from "./components/physics-link";
import { RapierSystem, initPhysics } from "./systems/rapier-system";
import { FpsSystem, buildStage } from "./spike/world";

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
world.camera.position.set(0, 1.35, 3.2);
world.camera.lookAt(0, 1.15, 0);

world.registerComponent(PhysicsLink);
world.registerSystem(RapierSystem);
world.registerSystem(FpsSystem);

buildStage(world);

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
