import type { World } from "@iwsdk/core";
import { enableRequisitDrag, isPlaced, loadRequisits, type Requisit, toggleRequisit } from "../props/requisits";
import { type Backdrop, currentBackdrop, loadBackdrops, setBackdrop } from "../stage/backdrops";
import { scaleCaption } from "../catalogue";
import { curtainLift } from "../stage/main-curtain";
import { createSlider, type Slider } from "./backdrop-slider";
import { infoHandler } from "./source-info";
import "./impro.css";

// Impro mode (the "Impro" sign): the visitor builds their own stage set.
// The menu offers "Bühnenbild", a panel from the right listing the painted
// backdrops as paper cards on a night sky (backdrop-slider.ts), and
// "Requisiten", the same slider mirrored on the left listing the props
// (props/requisits.ts). A click puts the backdrop at the back of the stage
// or lowers the prop onto it; placed props are dragged around on the floor.

export function startImpro(world: World) {
  const backdrops = loadBackdrops(); // starts loading while the curtain goes up
  const requisits = loadRequisits();
  enableRequisitDrag(world);

  const menu = element("nav", "impro-menu");
  const set = createPanel(menu, "Bühnenbild", "Hintergrund", "right");
  const props = createPanel(menu, "Requisiten", "Requisiten", "left");
  document.body.append(menu);

  backdrops.then((all) => {
    set.loaded();
    fillBackdrops(world, set.slider, all);
  });
  if (requisits.length) {
    props.loaded();
    fillRequisits(world, props.slider, requisits);
  } else props.loaded("Noch keine Requisiten");

  // The menu appears once the main curtain is out of view
  const waitForCurtain = () => {
    if (curtainLift() >= 1) menu.classList.add("visible");
    else requestAnimationFrame(waitForCurtain);
  };
  waitForCurtain();
}

/** A menu button and the slider panel it opens on one side of the screen. */
function createPanel(menu: HTMLElement, buttonText: string, title: string, side: "left" | "right") {
  const button = element("button", "impro-menu-item", buttonText);
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  menu.append(button);

  const panel = element("aside", `impro-panel ${side}`);
  panel.setAttribute("aria-label", title);
  panel.inert = true;
  const slider = createSlider({ mirror: side === "left" });
  const header = element("header", "impro-panel-header");
  const close = element("button", "impro-panel-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Schliessen");
  header.append(element("h2", "", title), close);
  const loading = element("p", "impro-loading", "Lädt …");
  panel.append(slider.root, header, loading);
  document.body.append(panel);

  const setOpen = (open: boolean) => {
    panel.classList.toggle("open", open);
    panel.inert = !open;
    if (open) slider.layout();
    button.setAttribute("aria-expanded", String(open));
  };
  button.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  close.addEventListener("click", () => setOpen(false));

  return {
    slider,
    /** Removes the loading note, or replaces it with a message. */
    loaded(message?: string) {
      if (message) loading.textContent = message;
      else loading.remove();
    },
  };
}

function fillBackdrops(world: World, slider: Slider, backdrops: Backdrop[]) {
  const markSelected = () => slider.setSelected((i) => backdrops[i] === currentBackdrop());
  const items = backdrops.map((b) => ({ ...b, onInfo: infoHandler(b.source) }));
  slider.setItems(items, (index) => {
    // A second click on the chosen one takes it off the stage again
    const backdrop = backdrops[index];
    setBackdrop(world, currentBackdrop() === backdrop ? null : backdrop);
    markSelected();
  });
  markSelected();
}

function fillRequisits(world: World, slider: Slider, requisits: Requisit[]) {
  const markSelected = () => slider.setSelected((i) => isPlaced(requisits[i]));
  const items = requisits.map((r) => ({
    label: r.label,
    thumbnail: r.thumbnail,
    caption: scaleCaption(r.scale),
    onInfo: infoHandler(r.source),
  }));
  slider.setItems(items, async (index) => {
    // A second click lifts it off the stage again
    const placing = toggleRequisit(world, requisits[index]);
    markSelected(); // at once when lifting off
    await placing;
    markSelected(); // after loading when placing
  });
  // Thumbnails without a picture of their own are rendered one after another
  requisits.forEach((requisit, i) => {
    requisit.onThumbnail = (url) => slider.setThumbnail(i, url);
    // Models larger than the stage allows are scaled down once loaded
    requisit.onScale = (scale) => slider.setCaption(i, scaleCaption(scale));
  });
  markSelected();
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}
