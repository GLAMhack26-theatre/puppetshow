import { World } from "@iwsdk/core";
import { PhysicsLink } from "./components/physics-link";
import { addCameraButton, startHandTracking } from "./input/mediapipe";
import { addLighting } from "./stage/lighting";
import { MainCurtainSystem, loadMainCurtain, skipMainCurtain } from "./stage/main-curtain";
import { SignSystem, loadSigns, onPlayChosen } from "./stage/signs";
import { startImpro } from "./impro/impro";
import { startDirector } from "./plays/director";
import { startPlay } from "./plays/scene-buttons";
import { BackdropSystem } from "./stage/backdrops";
import { RequisitSystem } from "./props/requisits";
import { SpotlightSystem } from "./stage/spotlights";
import { StageSystem, isCurtainOpen, loadStage, setCurtain } from "./stage/stage";
import { RapierSystem, initPhysics } from "./systems/rapier-system";
import { FpsSystem } from "./spike/world";

// Without ?test: the play itself. Curtain and signs, then the marionette,
// led by the hand in front of the camera (the mouse until the camera runs).
// ?test=nocurtain is the same without the main curtain and the signs,
// straight into impro mode, for faster development (the "impro" debug button).
// &play=<id> with nocurtain starts that play's scenes (assets/plays/)
// instead of impro mode. In impro mode the director bar builds the scenes.
// Phase 0 spike tests (docs/spikes/iwsdk.md; src/spike/ is removed once the
// spike is done): ?test=world (orbit camera, no puppet), ?test=puppet (mouse
// only, no camera), ?test=interop.

const test = new URLSearchParams(location.search).get("test") ?? "play";
/** These tests have no camera control; everything else is the play */
const handControl = !["world", "puppet", "interop"].includes(test);

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
world.registerSystem(SpotlightSystem);

// Scene presets place props relative to the stage floor: they wait for it
let stageLoaded = () => {};
const stageReady = new Promise<void>((resolve) => (stageLoaded = resolve));
const chosenPlay = (play: string) => {
  if (play === "impro") {
    startImpro(world);
    startDirector(world);
  } else void startPlay(world, play, stageReady);
};

if (test === "nocurtain") {
  skipMainCurtain();
  chosenPlay(new URLSearchParams(location.search).get("play") ?? "impro");
} else {
  // First, so the curtain already covers the screen while the stage loads
  await loadMainCurtain(world);
  await loadSigns(world);
  onPlayChosen(chosenPlay);
  // The click on a sign also starts the camera: it is the user gesture
  // camera access needs. Registered here, before the stage and the puppet
  // load: the signs can be clicked long before those are ready.
  if (handControl) onPlayChosen(() => void startHandTracking());
}
await loadStage(world);
stageLoaded();
addLighting(world);
// Spike: V (Vorhang) toggles the curtain (later: closed on the title, opens on Play)
addEventListener("keydown", (e) => e.key === "v" && setCurtain(!isCurtainOpen()));

switch (test) {
  case "world":
    (await import("./spike/world")).setupOrbit(world);
    break;
  case "interop":
    (await import("./spike/interop")).setupInterop(world);
    break;
  default:
    await (await import("./spike/puppet")).setupPuppet(world);
    if (handControl) addCameraButton();
}
