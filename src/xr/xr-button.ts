import type { World } from "@iwsdk/core";
import { onXrSession } from "./xr-embodiment";
import "./xr-button.css";

// The WebXR button, top right: enters the stage as the marionette
// (xr-embodiment.ts). Only there where a headset can start an immersive
// session (Quest browser; on a desktop with ?emu, emulator.ts).
//
// A click while the stage is changing (`busy`) waits for the change to
// finish and then enters. A session needs a user gesture, and the browser
// only counts a click as one for a few seconds: if the change took longer,
// the button asks for a second tap instead of failing silently.

/** Wait at most this long for the stage, ms: a change that never ends must not hold the button for good. */
const MAX_WAIT_MS = 20_000;

const GOGGLES =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8.5h18v8h-5.2l-2-2.6h-3.6l-2 2.6H3z"/><circle cx="8" cy="12.3" r="1.6"/><circle cx="16" cy="12.3" r="1.6"/></svg>';

type State = "idle" | "waiting" | "again" | "session";
const LABELS: Record<State, string> = {
  idle: "WebXR",
  waiting: "WebXR – nach dem Szenenwechsel",
  again: "WebXR – nochmals tippen",
  session: "WebXR beenden",
};

/** @param busy whether the stage is changing right now (a scene change, the curtain on its way) */
export async function addXrButton(world: World, busy: () => boolean = () => false) {
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

  let state: State = "idle";
  const show = (next: State) => {
    state = next;
    label.textContent = LABELS[next];
    button.dataset.state = next;
  };
  show("idle");
  // The label follows the session itself: launchXR only logs when it cannot start one
  onXrSession((active) => show(active ? "session" : "idle"));

  button.addEventListener("click", () => {
    if (world.renderer.xr.isPresenting) return world.exitXR();
    if (state === "waiting") return; // already waiting; the click still renews the gesture
    if (!busy()) return world.launchXR();

    show("waiting");
    const since = performance.now();
    const timer = setInterval(() => {
      if (busy() && performance.now() - since < MAX_WAIT_MS) return;
      clearInterval(timer);
      if (state !== "waiting") return; // a session started some other way
      // Without userActivation (older browsers) just try: the session then starts or does not
      if (navigator.userActivation?.isActive ?? true) {
        show("idle");
        world.launchXR();
      } else {
        show("again");
      }
    }, 100);
  });
  document.body.append(button);
}
