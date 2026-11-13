import type { World } from "@iwsdk/core";
import { type Backdrop, currentBackdrop, loadBackdrops, setBackdrop } from "../stage/backdrops";
import { curtainLift } from "../stage/main-curtain";
import "./impro.css";

// Impro mode (the "Impro" sign): the visitor first builds their own stage
// set. A menu offers "Bühnenbild"; it slides in a panel from the right
// (at most a quarter of the screen width) listing the painted backdrops.
// A click puts that backdrop at the back of the stage. Props come later.
// Plain DOM over the canvas for now; the theatre styling comes later.

export function startImpro(world: World) {
  const backdrops = loadBackdrops(); // starts loading while the curtain goes up

  const menu = element("nav", "impro-menu");
  const setButton = element("button", "impro-menu-item", "Bühnenbild");
  setButton.type = "button";
  menu.append(setButton);

  const panel = element("aside", "impro-panel");
  panel.setAttribute("aria-label", "Bühnenbild");
  panel.inert = true;
  const header = element("header", "impro-panel-header");
  const close = element("button", "impro-panel-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Schliessen");
  header.append(element("h2", "", "Hintergrund"), close);
  const list = element("ul", "impro-backdrops");
  list.append(element("li", "impro-loading", "Lädt …"));
  panel.append(header, list);
  document.body.append(menu, panel);

  const setOpen = (open: boolean) => {
    panel.classList.toggle("open", open);
    panel.inert = !open;
    setButton.setAttribute("aria-expanded", String(open));
  };
  setButton.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  close.addEventListener("click", () => setOpen(false));

  backdrops.then((all) => fillList(world, list, all));

  // The menu appears once the main curtain is out of view
  const waitForCurtain = () => {
    if (curtainLift() >= 1) menu.classList.add("visible");
    else requestAnimationFrame(waitForCurtain);
  };
  waitForCurtain();
}

function fillList(world: World, list: HTMLElement, backdrops: Backdrop[]) {
  list.replaceChildren();
  const buttons = new Map<Backdrop, HTMLButtonElement>();
  const markSelected = () => {
    for (const [backdrop, button] of buttons) {
      button.setAttribute("aria-pressed", String(backdrop === currentBackdrop()));
    }
  };
  for (const backdrop of backdrops) {
    const button = element("button", "impro-backdrop");
    button.type = "button";
    const image = element("img");
    image.src = backdrop.thumbnail;
    image.alt = "";
    image.draggable = false;
    button.append(image, element("span", "", backdrop.label));
    // A second click on the chosen one takes it off the stage again
    button.addEventListener("click", () => {
      setBackdrop(world, currentBackdrop() === backdrop ? null : backdrop);
      markSelected();
    });
    buttons.set(backdrop, button);
    const item = element("li");
    item.append(button);
    list.append(item);
  }
  markSelected();
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}
