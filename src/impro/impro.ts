import type { World } from "@iwsdk/core";
import { type Backdrop, currentBackdrop, loadBackdrops, onBackdropChange, setBackdrop } from "../stage/backdrops";
import { curtainLift } from "../stage/main-curtain";
import { createSlider, type Slider } from "./backdrop-slider";
import "./impro.css";

// Impro mode (the "Impro" sign): the visitor first builds their own stage
// set. A menu offers "Bühnenbild"; it slides in a panel from the right
// listing the painted backdrops as paper cards on a night sky
// (backdrop-slider.ts). A click puts that backdrop at the back of the stage.
// Props come later.

export function startImpro(world: World) {
  const backdrops = loadBackdrops(); // starts loading while the curtain goes up

  const menu = element("nav", "impro-menu");
  const setButton = element("button", "impro-menu-item", "Bühnenbild");
  setButton.type = "button";
  menu.append(setButton);

  const panel = element("aside", "impro-panel");
  panel.setAttribute("aria-label", "Bühnenbild");
  panel.inert = true;
  const slider = createSlider();
  const header = element("header", "impro-panel-header");
  const close = element("button", "impro-panel-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Schliessen");
  header.append(element("h2", "", "Hintergrund"), close);
  const loading = element("p", "impro-loading", "Lädt …");
  panel.append(slider.root, header, loading);
  document.body.append(menu, panel);

  const setOpen = (open: boolean) => {
    panel.classList.toggle("open", open);
    panel.inert = !open;
    if (open) slider.layout();
    setButton.setAttribute("aria-expanded", String(open));
  };
  setButton.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  close.addEventListener("click", () => setOpen(false));

  backdrops.then((all) => {
    loading.remove();
    fillSlider(world, slider, all);
  });

  // The menu appears once the main curtain is out of view
  const waitForCurtain = () => {
    if (curtainLift() >= 1) menu.classList.add("visible");
    else requestAnimationFrame(waitForCurtain);
  };
  waitForCurtain();
}

function fillSlider(world: World, slider: Slider, backdrops: Backdrop[]) {
  const markSelected = () => {
    const current = currentBackdrop();
    slider.setSelected(current ? backdrops.indexOf(current) : null);
  };
  slider.setItems(backdrops, (index) => {
    // A second click on the chosen one takes it off the stage again
    const backdrop = backdrops[index];
    setBackdrop(world, currentBackdrop() === backdrop ? null : backdrop);
  });
  // Also when another player chose it (src/net/)
  onBackdropChange(markSelected);
  markSelected();
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}
