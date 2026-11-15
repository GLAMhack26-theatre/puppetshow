import { World } from "@iwsdk/core";
import { PhysicsLink } from "./components/physics-link";
import { setupHandTracking, startHandTracking } from "./input/mediapipe";
import { flyIn } from "./puppet/puppet";
import { LightingSystem, addLighting } from "./stage/lighting";
import { MainCurtainSystem, isMainCurtainLoaded, loadMainCurtain, lowerMainCurtain, skipMainCurtain } from "./stage/main-curtain";
import { SignSystem, loadSigns, onPlayChosen, showSigns } from "./stage/signs";
import { startImpro } from "./impro/impro";
import { startDirector } from "./plays/director";
import { addPlayMenu } from "./plays/play-menu";
import { startPlay } from "./plays/scene-buttons";
import { setupPresentation } from "./presentation/presentation";
import { BackdropSystem, setBackdrop } from "./stage/backdrops";
import { RequisitSystem, arrangeRequisits } from "./props/requisits";
import { SpotlightSystem } from "./stage/spotlights";
import { StageSystem, isCurtainOpen, loadStage, setCurtain, stageFloor } from "./stage/stage";
import { RapierSystem, initPhysics } from "./systems/rapier-system";
import { FpsSystem, hudLines } from "./spike/world";
import { addLightDesk } from "./ui/light-desk";
import { setupDebugMode } from "./ui/debug-mode";
import { setAmbientPlay, setupAmbient } from "./audio/ambient";
import { playCue, setupExcerpts } from "./audio/excerpts";
import { isOn, setOn } from "./audio/audio";
import { setupImpacts } from "./audio/impacts";
import { setupSfx } from "./audio/sfx";
import { setupSoundToggle } from "./ui/sound-toggle";

// Without ?test: the play itself. Curtain and signs, then the marionette,
// led by the hand in front of the camera (the mouse until the camera runs).
// ?test=nocurtain is the same without the main curtain and the signs,
// straight into impro mode, for faster development (the "impro" debug button).
// &play=<id> with nocurtain starts that play's scenes (assets/plays/)
// instead of impro mode. In impro mode the director bar builds the scenes.
// The "Stücke" button (bottom left) leads back to the play choice from any
// play: the main curtain comes down and the signs drop in again.
// Phase 0 spike tests (docs/spikes/iwsdk.md; src/spike/ is removed once the
// spike is done): ?test=world (orbit camera, no puppet), ?test=puppet (mouse
// only, no camera), ?test=interop.

const test = new URLSearchParams(location.search).get("test") ?? "play";
/** These tests have no camera control; everything else is the play */
const handControl = !["world", "puppet", "interop"].includes(test);
/** Hand control keeps the puppet's body and skirt on the floor, m from its front and back edge */
const FLOOR_MARGIN = 0.1;

// Independent of the test: Shift+D shows the debug UI, Shift+P / the
// "presentation" button opens the presentation
setupDebugMode();
setupPresentation();
// Sound: music and effects off until their buttons (bottom right) or a sign are clicked
setupAmbient();
setupExcerpts();
setupSfx();
setupImpacts();
setupSoundToggle();

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
world.registerSystem(LightingSystem);

// Scene presets place props relative to the stage floor: they wait for it
let stageLoaded = () => {};
const stageReady = new Promise<void>((resolve) => (stageLoaded = resolve));
/** What the running play has put up (its UI), taken down on the way back to the choice */
let running: { stop(): void; canLeave?(): boolean }[] = [];
const chosenPlay = (play: string) => {
  // Each play has its own music (assets/sounds/archive.json), crossfaded while the curtain rises
  setAmbientPlay(play);
  if (play === "impro") running = [{ stop: startImpro(world) }, startDirector(world)];
  else running = [{ stop: startPlay(world, play, stageReady) }];
};

/** Main curtain and signs, with the choice wired up. */
const loadChoice = async () => {
  await loadMainCurtain(world);
  await loadSigns(world);
  // chosenPlay also switches the music to the play's playlist
  onPlayChosen(chosenPlay);
  // The first sign click turns music and effects on (a user gesture, as their
  // buttons); later choices (after the "Stücke" button) keep what the visitor
  // set meanwhile. Every choice plays the drum roll and announcement while the
  // curtain rises. After chosenPlay, so the music starts with the play's playlist.
  let soundTurnedOn = false;
  onPlayChosen(() => {
    if (!soundTurnedOn) for (const channel of ["music", "effects"] as const) if (!isOn(channel)) setOn(channel, true);
    soundTurnedOn = true;
    playCue("curtain");
  });
  // The click on a sign also starts the camera: it is the user gesture
  // camera access needs. Registered here, before the stage and the puppet
  // load: the signs can be clicked long before those are ready.
  if (handControl) onPlayChosen(() => void startHandTracking());
};

if (test === "nocurtain") {
  skipMainCurtain();
  chosenPlay(new URLSearchParams(location.search).get("play") ?? "impro");
} else {
  // First, so the curtain already covers the screen while the stage loads
  await loadChoice();
}

await loadStage(world);
stageLoaded();

// Back to the choice: the curtain comes down, behind it the play's UI goes and
// the stage is cleared, then the signs drop in again
addPlayMenu(async () => {
  if (!running.every((r) => r.canLeave?.() ?? true)) return;
  if (!isMainCurtainLoaded()) await loadChoice(); // ?test=nocurtain: loaded only now, still raised
  for (const r of running) r.stop();
  running = [];
  setAmbientPlay("default");
  await lowerMainCurtain();
  setBackdrop(world, null);
  void arrangeRequisits(world, []);
  setCurtain(true);
  showSigns();
});
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
    const { controller } = await (await import("./spike/puppet")).setupPuppet(world);
    if (handControl)
      setupHandTracking({
        controller,
        depthRange: stageFloor.isEmpty() ? undefined : [stageFloor.min.z + FLOOR_MARGIN, stageFloor.max.z - FLOOR_MARGIN],
        hud: hudLines,
        panel: document.getElementById("panel")!,
        // A new player's puppet is pulled up out of the picture and let down at their hand
        // (the promise: the height at which it stands is taken only once it has landed)
        onNewPlayer: () => flyIn(),
      });
  }
}
