import type { World } from "@iwsdk/core";
import { curtainLift } from "../stage/main-curtain";
import { curtainOpenness, setCurtain } from "../stage/stage";
import { applyScene, loadPlay, type Play } from "./plays";
import "./plays.css";

// A play with scene presets (plays.ts), e.g. the Froschkönig sign: once the
// main curtain is up, the first scene stands on the stage and a column of
// golden buttons on the left switches between the scenes. A switch is a
// real scene change: the stage curtain comes down, the set changes behind
// it (backdrop, props), and the curtain goes up again.

/** How long the closed curtain stays down while the set changes, s. */
const CHANGE_PAUSE = 0.6;

/**
 * Starts the play `id` if assets/plays/<id>.json has scenes; plays without
 * a file run as before (no buttons). `stageReady` resolves once the stage is
 * loaded (props are placed relative to its floor). Returns the function that
 * ends it (back to the play choice): the buttons go, the set stays to be
 * cleared by the caller.
 */
export function startPlay(world: World, id: string, stageReady: Promise<unknown>) {
  let stopped = false;
  let nav: HTMLElement | null = null;
  void (async () => {
    const play = await loadPlay(id).catch(() => null);
    if (!play?.scenes.length) return;
    await stageReady;
    await until(() => stopped || curtainLift() >= 1);
    if (stopped) return;
    await applyScene(world, play.scenes[0]);
    if (!stopped) nav = showSceneButtons(world, play);
  })();
  return () => {
    stopped = true;
    nav?.remove();
  };
}

function showSceneButtons(world: World, play: Play) {
  const nav = document.createElement("nav");
  nav.className = "scene-buttons";
  nav.setAttribute("aria-label", `Szenen: ${play.name}`);
  const title = document.createElement("p");
  title.className = "scene-buttons-title";
  title.textContent = play.name;
  nav.append(title);

  let current = 0;
  let changing = false;
  const buttons = play.scenes.map((scene, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scene-button";
    button.title = scene.name;
    const number = document.createElement("span");
    number.className = "scene-button-number";
    number.textContent = String(i + 1);
    const label = document.createElement("span");
    label.className = "scene-button-label";
    label.textContent = scene.name;
    button.append(number, label);
    button.addEventListener("click", () => void change(i));
    nav.append(button);
    return button;
  });
  const mark = () => buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === current)));

  const change = async (index: number) => {
    if (changing || index === current) return;
    changing = true;
    current = index;
    mark();
    nav.classList.add("changing");
    setCurtain(false);
    await until(() => curtainOpenness() <= 0);
    await applyScene(world, play.scenes[index]);
    await seconds(CHANGE_PAUSE);
    setCurtain(true);
    nav.classList.remove("changing");
    changing = false;
  };

  mark();
  document.body.append(nav);
  requestAnimationFrame(() => nav.classList.add("ready"));
  return nav;
}

function until(done: () => boolean) {
  return new Promise<void>((resolve) => {
    const check = () => (done() ? resolve() : requestAnimationFrame(check));
    check();
  });
}

const seconds = (s: number) => new Promise((resolve) => setTimeout(resolve, s * 1000));
