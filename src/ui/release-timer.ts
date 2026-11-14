import { GRACE_SECONDS, type HandReleaseState } from "../input/hand-release";
import "./release-timer.css";

// The little timer for letting go of the puppet (input/hand-release.ts): a
// ring that fills while the fist is held, then counts down the seconds the
// player has to take the hand away, then asks for the hand again.

/** The hold ring appears only after this share of the hold: a short fist shows nothing */
const HOLD_SHOWN = 0.12;
const RADIUS = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

type Mode = "hidden" | "hold" | "released" | "waiting";
const CAPTIONS: Record<Mode, string> = {
  hidden: "",
  hold: "Faust halten: Puppe loslassen",
  released: "Puppe hängt – Hand wegnehmen",
  waiting: "Hand heben, um die Puppe zu führen",
};

export function createReleaseTimer() {
  const root = Object.assign(document.createElement("div"), { className: "release-timer" });
  root.setAttribute("role", "status");
  const dial = Object.assign(document.createElement("div"), { className: "release-timer-dial" });
  dial.innerHTML = `<svg viewBox="0 0 44 44" aria-hidden="true">
    <circle class="release-timer-track" cx="22" cy="22" r="${RADIUS}" />
    <circle class="release-timer-ring" cx="22" cy="22" r="${RADIUS}" stroke-dasharray="${CIRCUMFERENCE}" />
  </svg>`;
  const ring = dial.querySelector<SVGCircleElement>(".release-timer-ring")!;
  const value = Object.assign(document.createElement("span"), { className: "release-timer-value" });
  dial.append(value);
  const caption = document.createElement("span");
  root.append(dial, caption);
  document.body.append(root);

  let mode: Mode = "hidden";
  let shown = "";
  return {
    /** Once per frame. */
    show(state: HandReleaseState) {
      const next: Mode =
        state.phase === "released" ? "released" : state.phase === "waiting" ? "waiting" : state.hold > HOLD_SHOWN ? "hold" : "hidden";
      if (next !== mode) {
        mode = next;
        root.classList.toggle("visible", mode !== "hidden");
        // Hidden: keep the last text while it fades out
        if (mode !== "hidden") caption.textContent = CAPTIONS[mode];
      }
      if (mode === "hidden") return;
      // Full ring = fist held long enough / all the seconds left
      const fill = mode === "hold" ? state.hold : mode === "released" ? state.countdown / GRACE_SECONDS : 0;
      ring.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - fill));
      const text = mode === "hold" ? "✊" : mode === "released" ? String(Math.ceil(state.countdown)) : "✋";
      if (text !== shown) value.textContent = shown = text;
    },
  };
}
