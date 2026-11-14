import { World } from "@iwsdk/core";
import { PhysicsLink } from "./components/physics-link";
import { setupHandTracking, startHandTracking } from "./input/mediapipe";
import { LightingSystem, addLighting } from "./stage/lighting";
import { MainCurtainSystem, loadMainCurtain, skipMainCurtain } from "./stage/main-curtain";
import { SignSystem, loadSigns, onPlayChosen } from "./stage/signs";
import { startImpro } from "./impro/impro";
import { BackdropSystem } from "./stage/backdrops";
import { SpotlightSystem } from "./stage/spotlights";
import { StageSystem, isCurtainOpen, loadStage, setCurtain, stageFloor } from "./stage/stage";
import { RapierSystem, initPhysics } from "./systems/rapier-system";
import { FpsSystem, hudLines } from "./spike/world";
import { addLightDesk } from "./ui/light-desk";

// Without ?test: the play itself. Curtain and signs, then the marionette,
// led by the hand in front of the camera (the mouse until the camera runs).
// ?test=nocurtain is the same without the main curtain and the signs,
// straight into impro mode, for faster development (the "impro" debug button).
// Phase 0 spike tests (docs/spikes/iwsdk.md; src/spike/ is removed once the
// spike is done): ?test=world (orbit camera, no puppet), ?test=puppet (mouse
// only, no camera), ?test=interop.

const params = new URLSearchParams(location.search);
const test = params.get("test") ?? "play";
/** These tests have no camera control; everything else is the play */
const handControl = !["world", "puppet", "interop"].includes(test);
/** Hand control keeps the puppet's body and skirt on the floor, m from its front and back edge */
const FLOOR_MARGIN = 0.1;

// Several players on one stage (src/net/, docs/architecture.md §3.3): every
// device opens the same ?room=<secret>; the one that simulates the stage adds
// &host (and gets a new room if none is given). &contact=0: puppets pass
// through each other; &lossy=0: no lossy channel for the poses.
const isHost = params.has("host");
if (isHost && !params.get("room")) {
  params.set("room", crypto.randomUUID().slice(0, 8));
  history.replaceState(null, "", `?${params}`);
}
const roomId = params.get("room");
const room = roomId
  ? { room: roomId, host: isHost, contact: params.get("contact") !== "0", lossy: params.get("lossy") !== "0" }
  : undefined;
// The test links keep the room: a link without it would leave the others behind
if (roomId) {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("#tests a")) {
    const target = new URLSearchParams(link.search);
    target.set("room", roomId);
    if (isHost) target.set("host", "");
    link.search = target.toString();
  }
}

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
world.registerSystem(SpotlightSystem);
world.registerSystem(LightingSystem);

if (test === "nocurtain") {
  skipMainCurtain();
  startImpro(world);
} else {
  // First, so the curtain already covers the screen while the stage loads
  await loadMainCurtain(world);
  await loadSigns(world);
  onPlayChosen((play) => play === "impro" && startImpro(world));
  // The click on a sign also starts the camera: it is the user gesture
  // camera access needs. Registered here, before the stage and the puppet
  // load: the signs can be clicked long before those are ready.
  if (handControl) onPlayChosen(() => void startHandTracking());
}
await loadStage(world);
addLighting(world);
addLightDesk();
// Spike: V (Vorhang) toggles the curtain (later: closed on the title, opens on Play)
addEventListener("keydown", (e) => e.key === "v" && setCurtain(!isCurtainOpen()));

switch (test) {
  case "world":
    (await import("./spike/world")).setupOrbit(world);
    break;
  case "interop":
    (await import("./spike/interop")).setupInterop(world);
    break;
  default: {
    const { controller } = await (await import("./spike/puppet")).setupPuppet(world, room);
    if (handControl)
      setupHandTracking({
        controller,
        depthRange: stageFloor.isEmpty() ? undefined : [stageFloor.min.z + FLOOR_MARGIN, stageFloor.max.z - FLOOR_MARGIN],
        hud: hudLines,
        panel: document.getElementById("panel")!,
      });
  }
}
