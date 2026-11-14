import type { World } from "@iwsdk/core";
import { onXrSession } from "./xr-embodiment";
import "./xr-button.css";

// The WebXR button, top right: enters the stage as the marionette
// (xr-embodiment.ts). Only there where a headset can start an immersive
// session (Quest browser; on a desktop with ?emu, emulator.ts).

const GOGGLES =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8.5h18v8h-5.2l-2-2.6h-3.6l-2 2.6H3z"/><circle cx="8" cy="12.3" r="1.6"/><circle cx="16" cy="12.3" r="1.6"/></svg>';

export async function addXrButton(world: World) {
  const supported = await navigator.xr?.isSessionSupported("immersive-vr").catch(() => false);
  if (!supported) return;

  const button = document.createElement("button");
  button.id = "xr-button";
  button.type = "button";
  button.title = "Als Marionette auf die Bühne (VR-Brille)";
  const label = document.createElement("span");
  const icon = document.createElement("span");
  icon.className = "xr-button-icon";
  icon.innerHTML = GOGGLES;
  button.append(label, icon);
  const show = (active: boolean) => (label.textContent = active ? "WebXR beenden" : "WebXR");
  show(false);
  onXrSession(show);

  // launchXR inside the click: a session needs the user gesture. It only
  // logs when the session cannot start, and the label follows the session.
  button.addEventListener("click", () => (world.renderer.xr.isPresenting ? world.exitXR() : world.launchXR()));
  document.body.append(button);
}
