import type { World } from "@iwsdk/core";
import { setupHandTracking } from "../input/mediapipe";
import { stageFloor } from "../stage/stage";
import { setupPuppet } from "./puppet";
import { hudLines } from "./world";

// T3: MediaPipe hands on the camera play the T2 puppet (src/input/mediapipe.ts:
// the cross hand holds the cross, a second hand can take the hand bar).
// ?replay=synthetic plays a scripted session without a camera.

/** Keeps the puppet's body and skirt on the floor, m from its front and back edge */
const FLOOR_MARGIN = 0.1;

export async function setupMediaPipe(world: World) {
  const { controller } = await setupPuppet(world);
  setupHandTracking({
    controller,
    depthRange: stageFloor.isEmpty() ? undefined : [stageFloor.min.z + FLOOR_MARGIN, stageFloor.max.z - FLOOR_MARGIN],
    hud: hudLines,
    panel: document.getElementById("panel")!,
  });
}
