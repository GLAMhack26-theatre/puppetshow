import type { World } from "@iwsdk/core";
import { manifestFromDrop, manifestFromFile, parseManifest } from "../props/iiif";
import {
  addIiifRequisit,
  enableRequisitDrag,
  isPlaced,
  loadRequisits,
  type Requisit,
  toggleRequisit,
} from "../props/requisits";
import { type Backdrop, currentBackdrop, loadBackdrops, setBackdrop } from "../stage/backdrops";
import { scaleCaption } from "../catalogue";
import { curtainLift } from "../stage/main-curtain";
import { createSlider, type Slider } from "./backdrop-slider";
import { infoHandler } from "./source-info";
import iconBackground from "../../assets/ui/icon-background.png";
import iconLight from "../../assets/ui/icon-light.png";
import iconRequisites from "../../assets/ui/icon-requisites.png";
import iconSound from "../../assets/ui/icon-sound.png";
import "./impro.css";

// Impro mode (the "Impro" sign): the visitor builds their own stage set.
// Each side of the screen has a night-sky panel (backdrop-slider.ts) with
// two pages, picked by round icon buttons that ride along at the panel's
// scalloped edge: on the right "Hintergrund" (the painted backdrops as paper
// cards) and "Licht", on the left "Requisiten" (the props, the slider
// mirrored, props/requisits.ts) and "Sound". Light and sound are empty skies
// for now. A golden X under the buttons closes the panel. A click puts the backdrop at the back of the stage
// or lowers the prop onto it; placed props are dragged around on the floor.
// The last props card is a drop field for IIIF 3D manifests (props/iiif.ts):
// the object becomes a new card and lands on the stage at once.

export function startImpro(world: World) {
  const backdrops = loadBackdrops(); // starts loading while the curtain goes up
  const requisits = loadRequisits();
  enableRequisitDrag(world);

  const left = createSide("left", [
    { title: "Requisiten", icon: iconRequisites },
    { title: "Sound", icon: iconSound },
  ]);
  const right = createSide("right", [
    { title: "Hintergrund", icon: iconBackground },
    { title: "Licht", icon: iconLight },
  ]);
  // Only one side is open at a time, so the stage stays visible in the middle
  left.onOpen = right.close;
  right.onOpen = left.close;
  const [props] = left.pages;
  const [set] = right.pages;

  backdrops.then((all) => {
    set.loaded();
    fillBackdrops(world, set.slider, all);
  });
  props.loaded();
  fillRequisits(world, props.slider, requisits);

  // The buttons appear once the main curtain is out of view
  const waitForCurtain = () => {
    if (curtainLift() >= 1) for (const side of [left, right]) side.panel.classList.add("ready");
    else requestAnimationFrame(waitForCurtain);
  };
  waitForCurtain();
}

/** Room between the round buttons and the sky's scalloped edge, px. */
const DOCK_GAP = 30;

/**
 * One side of the screen: a sky panel with one slider per page, and the dock
 * (a round button per page, the X below) that is part of the panel, so it
 * slides with it. Closed, the panel moves out just far enough that the dock
 * stays at the screen edge (impro.css, --dock-x).
 */
function createSide(side: "left" | "right", pageSpecs: { title: string; icon: string }[]) {
  const panel = element("aside", `impro-panel ${side}`);
  const header = element("header", "impro-panel-header");
  const heading = element("h2");
  header.append(heading);
  const dock = element("nav", "impro-dock");
  const close = element("button", "impro-dock-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Schliessen");

  const pages = pageSpecs.map((spec) => {
    const slider = createSlider({ mirror: side === "left" });
    const page = element("section", "impro-page");
    page.hidden = true;
    const loading = element("p", "impro-loading", "Lädt …");
    page.append(slider.root, loading);
    const button = element("button", "impro-dock-button");
    button.type = "button";
    button.title = spec.title;
    button.setAttribute("aria-label", spec.title);
    button.setAttribute("aria-pressed", "false");
    const icon = element("img");
    icon.src = spec.icon;
    icon.alt = "";
    icon.draggable = false;
    button.append(icon);
    dock.append(button);
    return {
      ...spec,
      slider,
      page,
      button,
      /** Removes the loading note, or replaces it with a message. */
      loaded(message?: string) {
        if (message) loading.textContent = message;
        else loading.remove();
      },
    };
  });
  dock.append(close);
  panel.append(...pages.map((p) => p.page), header, dock);
  document.body.append(panel);
  // The second pages (light, sound) have no content yet: the bare sky
  for (const p of pages.slice(1)) {
    p.slider.setItems([], () => {});
    p.loaded();
  }

  let current: (typeof pages)[number] | null = null;
  const open = (page: (typeof pages)[number] | null) => {
    current = page;
    panel.classList.toggle("open", !!page);
    for (const p of pages) {
      p.page.hidden = p !== (page ?? pages[0]);
      p.button.setAttribute("aria-pressed", String(p === page));
    }
    // The sky's edge comes in as far on every page (same panel width); the
    // dock sits just in front of it
    const shown = page ?? pages[0];
    shown.slider.layout();
    const edge = shown.slider.innerEdge();
    if (edge) panel.style.setProperty("--dock-x", `${edge - DOCK_GAP}px`);
    heading.textContent = page?.title ?? "";
    for (const p of pages) p.page.inert = !page;
  };
  const handle = {
    panel,
    pages,
    /** Called when this side opens (startImpro closes the other side then). */
    onOpen: () => {},
    close: () => current && open(null),
  };
  for (const p of pages)
    p.button.addEventListener("click", () => {
      if (current === p) return open(null);
      handle.onOpen();
      open(p);
    });
  close.addEventListener("click", () => open(null));
  addEventListener("resize", () => open(current));
  open(null);

  return handle;
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
  const markSelected = () => slider.setSelected((i) => i < requisits.length && isPlaced(requisits[i]));
  const place = async (requisit: Requisit) => {
    // A second click lifts it off the stage again
    const placing = toggleRequisit(world, requisit);
    markSelected(); // at once when lifting off
    await placing;
    markSelected(); // after loading when placing
  };
  const dropIndex = requisits.length;
  const hint = "Manifest hierher ziehen oder klicken";

  // The IIIF drop field: a manifest turns into a new card before it, and its object lands on the stage
  const addManifest = async (read: Promise<{ json: unknown; base: string }>) => {
    slider.setCaption(dropIndex, "Lädt …");
    try {
      const { json, base } = await read;
      const requisit = addIiifRequisit(parseManifest(json, base));
      fillRequisits(world, slider, requisits); // requisits now holds the new one
      if (!isPlaced(requisit)) await place(requisit);
    } catch (error) {
      console.warn("IIIF manifest", error);
      slider.setCaption(dropIndex, error instanceof Error ? error.message : "Fehler beim Laden");
    }
  };
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".json,application/json,application/ld+json";
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    if (file) void addManifest(manifestFromFile(file));
    picker.value = "";
  });

  const items = [
    ...requisits.map((r) => ({
      label: r.label,
      thumbnail: r.thumbnail,
      caption: scaleCaption(r.scale),
      onInfo: infoHandler(r.source),
    })),
    { label: "IIIF-Objekt", thumbnail: "", caption: hint, drop: (data: DataTransfer) => void addManifest(manifestFromDrop(data)) },
  ];
  slider.setItems(items, (index) => {
    if (index === dropIndex) picker.click();
    else void place(requisits[index]);
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
