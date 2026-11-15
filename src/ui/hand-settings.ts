import "./hand-settings.css";

// The player's own settings for the hand control, bottom centre: a button that
// sets the cross right ("Kreuz zurücksetzen") and one that opens the sliders
// (how high the hand is held, the tilt of the cross, the length of the
// strings). Always visible, unlike the debug panel: a player needs them
// whenever the camera, the place they stand at or their hand is different.
// Each value is remembered in this browser; a double click on a row puts it
// back to its default.

export interface HandSlider {
  label: string;
  /** What the slider is for, as a tooltip */
  title: string;
  /** localStorage key */
  key: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  format(value: number): string;
  apply(value: number): void;
}

// Line icons in the style of the sound buttons: cream drawing, gold accent
const ICONS = {
  // The control cross with an arrow going round it
  reset: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <path class="body" d="M16 10 V23 M11 13.5 H21 M12.5 19.5 H19.5"/>
    <path class="accent" d="M25.5 12 A10.5 10.5 0 1 0 26.5 17 M25.8 6.5 V12 H20.3"/>
  </svg>`,
  // Three sliders
  sliders: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <path class="body" d="M6 9 H26 M6 16 H26 M6 23 H26"/>
    <circle class="accent knob" cx="12" cy="9" r="2.6"/><circle class="accent knob" cx="21" cy="16" r="2.6"/><circle class="accent knob" cx="10" cy="23" r="2.6"/>
  </svg>`,
};

function stored(slider: HandSlider) {
  try {
    const value = localStorage.getItem(slider.key);
    if (value !== null && Number.isFinite(Number(value))) return Math.max(slider.min, Math.min(slider.max, Number(value)));
  } catch {
    // No storage (private mode): starts at its default
  }
  return slider.initial;
}

export function addHandSettings(options: { reset(): void; sliders: HandSlider[] }) {
  const root = Object.assign(document.createElement("div"), { id: "hand-settings" });

  const reset = Object.assign(document.createElement("button"), { type: "button", className: "hand-settings-reset" });
  reset.innerHTML = `<span class="hand-settings-icon">${ICONS.reset}</span><span>Kreuz zurücksetzen</span>`;
  reset.title = "Die Hand, wie sie jetzt gehalten wird, ist das waagrechte Kreuz in der Bühnenmitte (N)";
  reset.addEventListener("click", () => {
    options.reset();
    reset.blur(); // keys go to the stage again (Space would press the button once more)
  });

  const panel = Object.assign(document.createElement("div"), { className: "hand-settings-panel", hidden: true });
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "Einstellungen der Handsteuerung");
  const toggle = Object.assign(document.createElement("button"), { type: "button", className: "hand-settings-toggle hand-settings-icon", innerHTML: ICONS.sliders });
  toggle.title = toggle.ariaLabel = "Einstellungen der Handsteuerung";
  toggle.setAttribute("aria-expanded", "false");
  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });

  for (const slider of options.sliders) {
    const row = document.createElement("label");
    row.title = `${slider.title} (Doppelklick: Standard)`;
    const input = Object.assign(document.createElement("input"), {
      type: "range", min: String(slider.min), max: String(slider.max), step: String(slider.step), value: String(stored(slider)),
    });
    const shown = document.createElement("output");
    const set = (value: number) => {
      slider.apply(value);
      shown.textContent = slider.format(value);
    };
    set(Number(input.value));
    input.addEventListener("input", () => {
      set(Number(input.value));
      try {
        localStorage.setItem(slider.key, input.value);
      } catch {
        // Not remembered then
      }
    });
    row.addEventListener("dblclick", () => {
      input.value = String(slider.initial);
      input.dispatchEvent(new Event("input"));
    });
    row.append(slider.label, input, shown);
    panel.append(row);
  }

  root.append(panel, reset, toggle);
  document.body.append(root);
}
