import {
  LIGHT_PARAMS,
  type LightParamInfo,
  deleteLightScene,
  lightSceneSource,
  lightScenes,
  lighting,
  nextLightingScene,
  onLightingChange,
  saveLightScene,
  setLight,
  setLightingScene,
} from "../stage/lighting";
import "./light-desk.css";

// The light desk: one slider per parameter of the lighting rig
// (stage/lighting.ts), grouped by light, and the lighting scenes: choose one,
// save the desk's values as a scene (in this browser), delete a saved one,
// copy one as source for the built-in scenes. Plain debug styling, like the
// panel its buttons sit in.

const hex = (value: number) => `#${value.toString(16).padStart(6, "0")}`;

function shownValue({ kind, unit }: LightParamInfo, value: number) {
  return kind === "dimmer" ? `${Math.round(value * 100)} %` : `${value} ${unit}`;
}

export function addLightDesk() {
  const panel = document.getElementById("panel")!;
  // One button steps through the scenes (also L), one opens the desk
  const stepButton = element("button");
  const deskButton = element("button", "", "Lichtpult");
  panel.prepend(stepButton, deskButton);

  const desk = element("aside", "light-desk");
  desk.hidden = true;
  desk.setAttribute("aria-label", "Lichtpult");

  const sceneSelect = element("select");
  sceneSelect.setAttribute("aria-label", "Lichtszene");
  const close = element("button", "light-desk-close", "×");
  close.setAttribute("aria-label", "Schliessen");
  const header = element("header");
  header.append(sceneSelect, close);
  desk.append(header);

  // One fieldset per light, one row per parameter
  const inputs = new Map<LightParamInfo, { input: HTMLInputElement; output: HTMLOutputElement }>();
  let group: HTMLFieldSetElement | null = null;
  for (const param of LIGHT_PARAMS) {
    if (group?.dataset.group !== param.group) {
      group = element("fieldset");
      group.dataset.group = param.group;
      group.append(element("legend", "", param.group));
      desk.append(group);
    }
    const input = element("input");
    const output = element("output");
    if (param.kind === "color") {
      input.type = "color";
      input.addEventListener("input", () => setLight(param.key, parseInt(input.value.slice(1), 16)));
    } else {
      input.type = "range";
      input.min = String(param.min);
      input.max = String(param.max);
      input.step = String(param.step);
      input.addEventListener("input", () => setLight(param.key, Number(input.value)));
    }
    const row = element("label");
    row.append(element("span", "", param.label), input, output);
    group.append(row);
    inputs.set(param, { input, output });
  }

  const name = element("input");
  name.type = "text";
  name.placeholder = "Name der Szene";
  name.setAttribute("aria-label", "Name der Szene");
  // Typing a name must not reach the keys of the stage (L, C, V, the puppet's keys)
  name.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") save.click();
  });
  const save = element("button", "", "Speichern");
  const remove = element("button");
  const copy = element("button", "", "Als Code kopieren");
  copy.title = "Die Szene als Eintrag für PRESETS in src/stage/lighting.ts";
  const footer = element("footer");
  footer.append(name, save, remove, copy);
  desk.append(footer);
  document.body.append(desk);

  save.addEventListener("click", () => {
    saveLightScene(name.value);
    name.value = "";
  });
  remove.addEventListener("click", () => deleteLightScene(lighting.sceneId));
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(lightSceneSource());
    copy.textContent = "Kopiert";
    setTimeout(() => (copy.textContent = "Als Code kopieren"), 1500);
  });
  sceneSelect.addEventListener("change", () => setLightingScene(sceneSelect.value));
  stepButton.addEventListener("click", nextLightingScene);
  deskButton.addEventListener("click", () => (desk.hidden = !desk.hidden));
  close.addEventListener("click", () => (desk.hidden = true));
  addEventListener("keydown", (e) => e.key === "l" && !e.repeat && nextLightingScene());

  const refresh = () => {
    const scenes = lightScenes();
    const current = scenes.find((s) => s.id === lighting.sceneId);
    // "*": the desk no longer shows the scene as it is saved
    stepButton.textContent = `Licht: ${lighting.label}${lighting.modified ? " *" : ""} (L)`;
    sceneSelect.replaceChildren(
      ...scenes.map((s) => {
        const option = element("option", "", s.label + (s.id === lighting.sceneId && lighting.modified ? " *" : ""));
        option.value = s.id;
        return option;
      }),
    );
    sceneSelect.value = lighting.sceneId;
    for (const [param, { input, output }] of inputs) {
      const value = lighting.values[param.key];
      input.value = param.kind === "color" ? hex(value) : String(value);
      output.textContent = param.kind === "color" ? hex(value) : shownValue(param, value);
    }
    // Deleting a saved scene that replaced a built-in one brings that back
    remove.textContent = current?.builtIn ? "Zurücksetzen" : "Löschen";
    remove.disabled = !current?.saved;
  };
  onLightingChange(refresh);
  refresh();
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  if (el instanceof HTMLButtonElement) el.type = "button";
  return el;
}
