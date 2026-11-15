import { Euler, Plane, Quaternion, Raycaster, Vector2, Vector3, type World } from "@iwsdk/core";
import { STRING_IDS, controlInput } from "../input/control-input";
import { loadMarionette } from "../puppet/marionette";
import { createPuppet } from "../puppet/puppet";
import type { RigController } from "../puppet/rig";
import { physics, stepPhysics } from "../systems/rapier-system";
import { hudLines } from "./world";

// The SKKG marionette (src/puppet/) on its control cross with 9 strings
// (props come from the impro panel and scene presets). Pointer moves the
// cross, wheel rolls it, Shift+wheel pitches it (bow); Q / E rock the leg bar
// (walk), A / D the hand bar, Y / X the head bar (or the rocker sliders); H
// takes the hand bar off the cross: pointer and wheel then move and turn it
// instead, H again lets it snap back; B (held) pushes against the back string,
// as the other hand or arm would; string sliders pluck single strings; F / G
// (or the buttons) grip left / right; "Fadenlänge" sets how much longer than
// the rig's the strings are.

/** Where the pointer can move the bar (real scale: puppet 0.35 m) */
const BAR_X = 0.55;
const BAR_Y: [number, number] = [0.35, 1.0];

/** B: how far the back string is pushed, m, and where on it (0 eye … 1 socket) */
const HOOK_PUSH = 0.1;
const HOOK_ALONG = 0.5;
/** Range of the string length slider, m on top of the rig's strings */
const MAX_STRING_EXTRA = 0.4;
const STRING_KEY = "string-extra";

/** Returns the puppet's cross (for input sources that need its geometry) */
export async function setupPuppet(world: World) {
  const { root, description } = await loadMarionette();
  const puppet = createPuppet(world, root, description);

  physics.afterSync.push(() => {
    for (const hand of puppet.grab.status()) hudLines[hand.side] = `${hand.touching} / ${hand.holding}`;
    hudLines.input = controlInput.source;
  });
  // ?debug: handles for headless tests (scripted shakes, string stretch, joint angles)
  if (new URLSearchParams(location.search).has("debug")) Object.assign(globalThis, { world, controlInput, puppet, description, physics, stepPhysics });
  setupPointerAndPanel(world, description.controller);
  return { controller: description.controller };
}

function setupPointerAndPanel(world: World, controller: RigController) {
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
    if (!raycaster.ray.intersectPlane(plane, hit)) return;
    const handBar = controlInput.handBar;
    if (handBar.detached) {
      // The hand bar is off the cross: the pointer carries it, from where it was taken
      handBar.position.copy(grab.bar).add(hit).sub(grab.pointer);
    } else {
      controlInput.bar.position.set(Math.max(-BAR_X, Math.min(BAR_X, hit.x)), Math.max(BAR_Y[0], Math.min(BAR_Y[1], hit.y)), 0);
    }
    pointer.copy(hit);
  });

  const tilt = new Euler();
  const freeTilt = new Euler();
  const turn = new Quaternion();
  const pointer = new Vector3();
  const grab = { bar: new Vector3(), pointer: new Vector3(), rotation: new Quaternion() };
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = Math.sign(e.deltaY) * 0.05;
      const target = controlInput.handBar.detached ? freeTilt : tilt;
      if (e.shiftKey) target.x = Math.max(-0.8, Math.min(0.8, target.x + delta));
      else target.z = Math.max(-0.8, Math.min(0.8, target.z + delta));
      if (controlInput.handBar.detached) controlInput.handBar.rotation.copy(grab.rotation).premultiply(turn.setFromEuler(freeTilt));
      else controlInput.bar.rotation.setFromEuler(tilt);
    },
    { passive: false },
  );
  // H: take the hand bar off the cross / let it snap back (ControlInput.handBar)
  addEventListener("keydown", (e) => {
    if (e.key !== "h" || e.repeat || controlInput.source !== "mouse") return;
    const handBar = controlInput.handBar;
    if (!handBar.detached) {
      // The engine keeps handBar at the bar's seat while it is on the cross: start from there
      grab.bar.copy(handBar.position);
      grab.rotation.copy(handBar.rotation);
      grab.pointer.copy(pointer);
      freeTilt.set(0, 0, 0);
    }
    handBar.detached = !handBar.detached;
    hudLines.handbar = handBar.detached ? "frei (H)" : "am Kreuz (H)";
  });

  // B: the other hand pushes against the back string (ControlInput.hook), which lifts the puppet's seat
  const pushBack = (on: boolean) => (e: KeyboardEvent) => {
    if (e.key !== "b" || e.repeat || controlInput.source !== "mouse") return;
    controlInput.hook.id = on ? "back" : null;
    controlInput.hook.along = HOOK_ALONG;
    // Drawn back (upstage) and only a little sideways, as the MediaPipe source does: straight sideways the puppet swings round and rolls
    controlInput.hook.offset.set(0.3 * HOOK_PUSH, 0, -HOOK_PUSH);
  };
  addEventListener("keydown", pushBack(true));
  addEventListener("keyup", pushBack(false));

  const panel = document.getElementById("panel")!;
  {
    // How long the strings are: the cross hangs that much higher, the puppet stands the same
    const label = document.createElement("label");
    // Remembered: a matter of taste and of the stage picture
    try {
      const stored = localStorage.getItem(STRING_KEY);
      if (stored !== null && Number.isFinite(Number(stored))) controlInput.stringExtra = Math.max(0, Math.min(MAX_STRING_EXTRA, Number(stored)));
    } catch {
      // No storage (private mode): the default length
    }
    const slider = Object.assign(document.createElement("input"), {
      type: "range", min: "0", max: String(MAX_STRING_EXTRA), step: "0.01", value: String(controlInput.stringExtra),
    });
    const value = document.createElement("span");
    const show = () => (value.textContent = `+${Math.round(controlInput.stringExtra * 100)} cm`);
    show();
    slider.addEventListener("input", () => {
      controlInput.stringExtra = Number(slider.value);
      show();
      try {
        localStorage.setItem(STRING_KEY, slider.value);
      } catch {
        // Not remembered then
      }
    });
    label.append("Fadenlänge", slider, value);
    panel.append(label);
  }
  // Rocking bars: slider, or hold a key (released: back to level). Y and Z: the same key on QWERTZ and QWERTY keyboards
  const rockers = [["legs", "Beine (Q/E)", ["q"], "e"], ["hands", "Hände (A/D)", ["a"], "d"], ["head", "Kopf (Y/X)", ["y", "z"], "x"]] as const;
  for (const [rock, text, plusKeys, minus] of rockers) {
    const limit = controller.bars.find((b) => b.input === rock)?.limit;
    if (limit === undefined) continue; // this rig has no such bar
    const label = document.createElement("label");
    const slider = Object.assign(document.createElement("input"), {
      type: "range", min: String(-limit), max: String(limit), step: "0.01", value: "0",
    });
    const set = (angle: number) => {
      controlInput.rock[rock] = angle;
      slider.value = String(angle);
    };
    slider.addEventListener("input", () => set(Number(slider.value)));
    const isPlus = (key: string) => (plusKeys as readonly string[]).includes(key);
    addEventListener("keydown", (e) => (isPlus(e.key) ? set(limit) : e.key === minus ? set(-limit) : undefined));
    addEventListener("keyup", (e) => (isPlus(e.key) || e.key === minus) && set(0));
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
