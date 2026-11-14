import "./presentation.css";
import { buildSlides, load3D } from "./slides";
import { restartPralines } from "./pralines";
import { playSlideMusic, stopSlideMusic } from "./slide-music";
import { type Channel, isOn, setOn } from "../audio/audio";
import { initViews, startViews, stopViews } from "./views";

// Presentation mode for the pitch: Shift+P or the "presentation" button
// opens 4 fullscreen slides over the running app; ESC (or Shift+P) closes
// them. Built lazily on the first open; the models load once.

let overlay: HTMLElement | null = null;
let slides: HTMLElement[] = [];
let dots: HTMLButtonElement[] = [];
let current = 0;

const isOpen = () => !!overlay && !overlay.hidden;

export function setupPresentation() {
  document.getElementById("presentation-button")?.addEventListener("click", toggle);
  // Capture phase: while open, the slides own the keyboard (the app's keys
  // like C, F, G or Q must not act behind them)
  addEventListener("keydown", onKey, { capture: true });
  document.addEventListener("fullscreenchange", () => {
    // ESC in fullscreen is taken by the browser: leaving fullscreen closes the mode
    if (!document.fullscreenElement && isOpen()) close();
  });
}

function onKey(e: KeyboardEvent) {
  const shiftP = e.shiftKey && e.code === "KeyP";
  if (!isOpen()) {
    if (shiftP) {
      e.preventDefault();
      open();
    }
    return;
  }
  e.stopPropagation();
  if (shiftP || e.key === "Escape") close();
  else if (["ArrowRight", "PageDown", " "].includes(e.key)) show(current + 1);
  else if (["ArrowLeft", "PageUp"].includes(e.key)) show(current - 1);
  else if (/^[1-9]$/.test(e.key)) show(Number(e.key) - 1);
  else return;
  e.preventDefault();
}

function toggle() {
  if (isOpen()) close();
  else open();
}

/** The app's sound channels that were on when the presentation opened; turned on again when it closes */
let silenced: Channel[] = [];

function open() {
  if (!overlay) build();
  // The app keeps running underneath: its music and effects must not play over the slides
  silenced = (["music", "effects"] as const).filter(isOn);
  for (const channel of silenced) setOn(channel, false);
  overlay!.hidden = false;
  show(current);
  if (current === PRALINES) restartPralines(); // reopened on the box slide
  startViews();
  // A user gesture (key or click), as fullscreen requires; where it isn't
  // available (iPhone Safari) the overlay still covers the window
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function close() {
  overlay!.hidden = true;
  stopViews();
  stopSlideMusic();
  for (const channel of silenced) setOn(channel, true);
  silenced = [];
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

/** Index of the chocolate box slide: its camera flight starts again on every visit */
const PRALINES = 3;

function show(index: number) {
  const previous = current;
  current = Math.max(0, Math.min(slides.length - 1, index));
  if (current === PRALINES && previous !== PRALINES) restartPralines();
  // The carousel music belongs to slide 4 only
  if (current === PRALINES && !overlay!.hidden) playSlideMusic();
  else stopSlideMusic();
  slides.forEach((slide, i) => (slide.hidden = i !== current));
  dots.forEach((dot, i) => dot.setAttribute("aria-current", String(i === current)));
}

function build() {
  overlay = document.createElement("div");
  overlay.className = "presentation";
  overlay.hidden = true;
  const built = buildSlides();
  slides = built.slides;
  const nav = document.createElement("nav");
  nav.className = "presentation-dots";
  dots = slides.map((_, i) => {
    const dot = Object.assign(document.createElement("button"), { type: "button", title: `Slide ${i + 1}` });
    dot.addEventListener("click", () => show(i));
    return dot;
  });
  nav.append(...dots);
  overlay.append(...slides, nav);
  document.body.append(overlay);
  initViews(overlay);
  load3D(built.objectViews, built.marionetteView, built.handCanvas, built.pralinesView).catch((e) => console.warn("Presentation: loading failed", e));
}
