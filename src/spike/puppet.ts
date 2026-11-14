import { Euler, Plane, Raycaster, Vector2, Vector3, type World } from "@iwsdk/core";
import { MAX_ROCK, STRING_IDS, controlInput } from "../input/control-input";
import { loadMarionette } from "../puppet/marionette";
import { createPuppet } from "../puppet/puppet";
import { physics } from "../systems/rapier-system";
import { hudLines } from "./world";

// The SKKG marionette (src/puppet/) on its control cross with 9 strings
// (props come from the impro panel and scene presets). Pointer moves the cross, wheel rolls it, Shift+wheel
// pitches it (bow); Q / E rock the leg bar (walk), A / D rock the hand bar
// (or the rocker sliders); string sliders pluck single strings; F / G (or the
// buttons) grip left / right.

/** Where the pointer can move the bar (real scale: puppet 0.35 m) */
const BAR_X = 0.55;
const BAR_Y: [number, number] = [0.35, 1.0];

export async function setupPuppet(world: World) {
  const { root, description } = await loadMarionette();
  const puppet = createPuppet(world, root, description);

  physics.afterSync.push(() => {
    for (const hand of puppet.grab.status()) hudLines[hand.side] = `${hand.touching} / ${hand.holding}`;
    hudLines.input = controlInput.source;
  });
  setupPointerAndPanel(world);
}

function setupPointerAndPanel(world: World) {
  const canvas = world.renderer.domElement;
  const raycaster = new Raycaster();
  const plane = new Plane(new Vector3(0, 0, 1), 0);
  const ndc = new Vector2();
  const hit = new Vector3();
  canvas.addEventListener("pointermove", (e) => {
    if (controlInput.source !== "mouse") return;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, world.camera);
    if (raycaster.ray.intersectPlane(plane, hit)) {
      controlInput.bar.position.set(Math.max(-BAR_X, Math.min(BAR_X, hit.x)), Math.max(BAR_Y[0], Math.min(BAR_Y[1], hit.y)), 0);
    }
  });

  const tilt = new Euler();
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = Math.sign(e.deltaY) * 0.05;
      if (e.shiftKey) tilt.x = Math.max(-0.8, Math.min(0.8, tilt.x + delta));
      else tilt.z = Math.max(-0.8, Math.min(0.8, tilt.z + delta));
      controlInput.bar.rotation.setFromEuler(tilt);
    },
    { passive: false },
  );

  const panel = document.getElementById("panel")!;
  // Rocking bars: slider, or hold a key (released: back to level)
  for (const [rock, text, plus, minus] of [["legs", "Beine (Q/E)", "q", "e"], ["hands", "Hände (A/D)", "a", "d"]] as const) {
    const label = document.createElement("label");
    const slider = Object.assign(document.createElement("input"), {
      type: "range", min: String(-MAX_ROCK), max: String(MAX_ROCK), step: "0.01", value: "0",
    });
    const set = (angle: number) => {
      controlInput.rock[rock] = angle;
      slider.value = String(angle);
    };
    slider.addEventListener("input", () => set(Number(slider.value)));
    addEventListener("keydown", (e) => (e.key === plus ? set(MAX_ROCK) : e.key === minus ? set(-MAX_ROCK) : undefined));
    addEventListener("keyup", (e) => (e.key === plus || e.key === minus) && set(0));
    label.append(text, slider);
    panel.append(label);
  }
  for (const id of STRING_IDS) {
    const label = document.createElement("label");
    const slider = Object.assign(document.createElement("input"), { type: "range", min: "0", max: "1", step: "0.01", value: "0" });
    slider.addEventListener("input", () => (controlInput.pulls[id] = Number(slider.value)));
    label.append(id, slider);
    panel.append(label);
  }
  for (const [side, key, text] of [["left", "f", "Links greifen (F)"], ["right", "g", "Rechts greifen (G)"]] as const) {
    const button = Object.assign(document.createElement("button"), { textContent: text });
    const set = (on: boolean) => () => (controlInput.grip[side] = on);
    button.addEventListener("pointerdown", set(true));
    button.addEventListener("pointerup", set(false));
    button.addEventListener("pointerleave", set(false));
    panel.append(button);
    addEventListener("keydown", (e) => e.key === key && set(true)());
    addEventListener("keyup", (e) => e.key === key && set(false)());
  }
}
