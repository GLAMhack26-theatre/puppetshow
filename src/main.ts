import { World } from "@iwsdk/core";
import { PhysicsLink } from "./components/physics-link";
import { addLighting } from "./stage/lighting";
import { MainCurtainSystem, loadMainCurtain, skipMainCurtain } from "./stage/main-curtain";
import { SignSystem, loadSigns, onPlayChosen } from "./stage/signs";
import { startImpro } from "./impro/impro";
import { BackdropSystem } from "./stage/backdrops";
import { RequisitSystem } from "./props/requisits";
import { StageSystem, isCurtainOpen, loadStage, setCurtain } from "./stage/stage";
import { RapierSystem, initPhysics } from "./systems/rapier-system";
import { FpsSystem } from "./spike/world";

// Phase 0 spike: one page, the test picked with ?test=world|puppet|mediapipe|interop
// (docs/spikes/iwsdk.md). src/spike/ is removed once the spike is done.
// ?test=nocurtain skips the main curtain and the signs and goes straight
// into impro mode, for faster development (the "impro" debug button).

const test = new URLSearchParams(location.search).get("test") ?? "world";

await initPhysics();

const world = await World.create(document.getElementById("app")!, {
  xr: false,
  features: { physics: false }, // Rapier instead, see systems/rapier-system.ts
  render: { fov: 45, near: 0.02, far: 50 },
});
world.renderer.shadowMap.enabled = true;
// Real scale: 1.4 m stage, 0.35 m puppet
world.camera.position.set(0, 0.5, 1.9);
world.camera.lookAt(0, 0.4, -0.1);

world.registerComponent(PhysicsLink);
world.registerSystem(RapierSystem);
world.registerSystem(StageSystem);
world.registerSystem(FpsSystem);
world.registerSystem(MainCurtainSystem);
world.registerSystem(SignSystem);
world.registerSystem(BackdropSystem);
world.registerSystem(RequisitSystem);

if (test === "nocurtain") {
  skipMainCurtain();
  startImpro(world);
} else {
  // First, so the curtain already covers the screen while the stage loads
  await loadMainCurtain(world);
  await loadSigns(world);
  onPlayChosen((play) => play === "impro" && startImpro(world));
}
await loadStage(world);
addLighting(world);
// Spike: V (Vorhang) toggles the curtain (later: closed on the title, opens on Play)
addEventListener("keydown", (e) => e.key === "v" && setCurtain(!isCurtainOpen()));

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
