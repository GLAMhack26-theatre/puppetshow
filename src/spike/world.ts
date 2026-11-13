import { createSystem, type World } from "@iwsdk/core";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { physics } from "../systems/rapier-system";

// T1: FPS overlay and orbit camera around the stage (src/stage/).
// The HUD is shared by the other tests.

const hud = document.getElementById("hud")!;
export const hudLines: Record<string, string> = {};

export class FpsSystem extends createSystem({}) {
  private frames = 0;
  private elapsed = 0;

  update(delta: number) {
    this.frames++;
    this.elapsed += delta;
    if (this.elapsed < 0.5) return;
    const fps = this.frames / this.elapsed;
    hud.textContent = [
      `fps     ${fps.toFixed(0)}`,
      `delta   ${(delta * 1000).toFixed(1)} ms`,
      `physics ${physics.stepMs.toFixed(2)} ms (${physics.steps} steps)`,
      ...Object.entries(hudLines).map(([k, v]) => `${k.padEnd(7)} ${v}`),
    ].join("\n");
    this.frames = 0;
    this.elapsed = 0;
  }
}

export function setupOrbit(world: World) {
  const controls = new OrbitControls(world.camera, world.renderer.domElement);
  controls.target.set(0, 0.4, -0.1);
  controls.update();
}
