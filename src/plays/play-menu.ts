import { curtainLift } from "../stage/main-curtain";
import "./play-menu.css";

// "Stücke": a round button at the bottom left, in the style of the sound
// button, that leads back to the play choice from any play (impro included).
// It shows while the main curtain is up; what going back means is up to
// main.ts (curtain down, the play's UI and set cleared, signs again).

const CURTAIN_ICON = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path class="rod" d="M3 4h18" />
  <path class="drape" d="M4 4c0 6 1 11 4 15M4 4v15h4M20 4c0 6-1 11-4 15M20 4v15h-4" />
  <path class="tie" d="M5.5 13.5l3 .5M18.5 13.5l-3 .5" />
</svg>`;

/** Adds the button; `goBack` runs on a click (the button waits for it). */
export function addPlayMenu(goBack: () => Promise<void>) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "play-menu";
  button.title = "Zurück zur Stückwahl";
  const icon = document.createElement("span");
  icon.className = "play-menu-icon";
  icon.innerHTML = CURTAIN_ICON;
  const label = document.createElement("span");
  label.className = "play-menu-label";
  label.textContent = "Stücke";
  button.append(icon, label);
  document.body.append(button);

  let busy = false;
  button.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    try {
      await goBack();
    } finally {
      busy = false;
    }
  });

  const update = () => {
    const shown = !busy && curtainLift() >= 1;
    button.classList.toggle("shown", shown);
    button.inert = !shown;
    requestAnimationFrame(update);
  };
  update();
}
