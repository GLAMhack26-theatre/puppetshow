import type { HandReleaseState } from "../input/hand-release";
import "./release-timer.css";

// The little sign that asks for the hand while none is connected to the
// puppet (input/hand-release.ts). It used to be a timer as well, for letting
// go with a held fist; that gesture is gone, the name and the dial stayed.

const CAPTION = "Hand heben, um die Puppe zu führen";

export function createReleaseTimer() {
  const root = Object.assign(document.createElement("div"), { className: "release-timer" });
  root.setAttribute("role", "status");
  const dial = Object.assign(document.createElement("div"), { className: "release-timer-dial" });
  dial.append(Object.assign(document.createElement("span"), { className: "release-timer-value", textContent: "✋" }));
  root.append(dial, Object.assign(document.createElement("span"), { textContent: CAPTION }));
  document.body.append(root);

  let shown = false;
  return {
    /** Once per frame. */
    show(state: HandReleaseState) {
      const waiting = state.phase === "waiting";
      if (waiting !== shown) root.classList.toggle("visible", (shown = waiting));
    },
  };
}
