import "./presentation.css";
import { buildSlides, load3D } from "./slides";
import { initViews, startViews, stopViews } from "./views";

// Presentation mode for the pitch: Shift+P or the "presentation" button
// opens 3 fullscreen slides over the running app; ESC (or Shift+P) closes
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

function open() {
  if (!overlay) build();
  overlay!.hidden = false;
  show(current);
  startViews();
  // A user gesture (key or click), as fullscreen requires; where it isn't
  // available (iPhone Safari) the overlay still covers the window
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function close() {
  overlay!.hidden = true;
  stopViews();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function show(index: number) {
  current = Math.max(0, Math.min(slides.length - 1, index));
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
  load3D(built.objectViews, built.marionetteView, built.handCanvas).catch((e) => console.warn("Presentation: loading failed", e));
}
