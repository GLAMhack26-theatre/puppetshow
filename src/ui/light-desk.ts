import {
  LIGHT_PARAMS,
  type LightParamInfo,
  deleteLightScene,
  lightScenes,
  lighting,
  nextLightingScene,
  onLightingChange,
  saveLightScene,
  setLight,
  setLightingScene,
} from "../stage/lighting";
import "./light-desk.css";

// The light desk: the lighting scenes of the library (stage/lighting.ts) to
// choose from, one slider per parameter of the rig, grouped by light, and
// saving the desk's values as a lighting scene under a name: a new one for
// every play to use, or an existing one, changed wherever it is used.
//
// Built once per place it is shown in: the Licht page of the scene editor
// (impro/impro.ts) and the debug panel (addLightDesk, for the pages without
// the editor). All of them show the same state.

const hex = (value: number) => `#${value.toString(16).padStart(6, "0")}`;

function shownValue({ kind, unit }: LightParamInfo, value: number) {
  return kind === "dimmer" ? `${Math.round(value * 100)} %` : `${value} ${unit}`;
}

/** The desk's controls, to be placed in a panel that gives them their colours (light-desk.css). */
export function createLightDesk() {
  const desk = element("div", "light-desk");

  // The scenes as buttons: one click lights the stage with it
  const sceneList = element("div", "light-desk-scenes");
  sceneList.setAttribute("role", "group");
  sceneList.setAttribute("aria-label", "Lichtszene");
  desk.append(sceneList);
  let chips = new Map<string, HTMLButtonElement>();
  let chipsFor = "";

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
    row.append(element("span", "", param.label), output, input);
    group.append(row);
    inputs.set(param, { input, output });
  }

  const name = element("input");
  name.type = "text";
  name.maxLength = 60;
  name.setAttribute("aria-label", "Name der Lichtszene");
  // Typing a name must not reach the keys of the stage (L, V, the puppet's keys, the scene numbers)
  name.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") save.click();
  });
  const save = element("button", "light-desk-save", "Lichtszene speichern");
  save.title = "Mit Namen: als neue Lichtszene für alle Stücke. Ohne: die gewählte überschreiben.";
  const remove = element("button");
  const status = element("p", "light-desk-status");
  status.setAttribute("role", "status");
  const footer = element("footer");
  footer.append(name, save, remove, status);
  desk.append(footer);

  const setStatus = (text: string, kind: "" | "ok" | "warn" = "") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const failed = (error: unknown) => setStatus(error instanceof Error ? error.message : "Fehler", "warn");

  save.addEventListener("click", async () => {
    try {
      const { id, how } = await saveLightScene(name.value);
      name.value = "";
      setStatus(how === "saved" ? `gespeichert: assets/lights/${id}.json` : `heruntergeladen: ${id}.json → assets/lights/`, "ok");
    } catch (error) {
      failed(error);
    }
  });
  remove.addEventListener("click", async () => {
    const current = lightScenes().find((s) => s.id === lighting.sceneId);
    if (!current?.removable) return;
    const question = current.resets
      ? `Lichtszene „${current.label}“ auf ihren ursprünglichen Stand zurücksetzen?`
      : `Lichtszene „${current.label}“ löschen? Szenen, die sie verwenden, werden danach neutral beleuchtet.`;
    if (!confirm(question)) return;
    try {
      await deleteLightScene(current.id);
      setStatus(current.resets ? "zurückgesetzt" : "gelöscht", "ok");
    } catch (error) {
      failed(error);
    }
  });

  const refresh = () => {
    const scenes = lightScenes();
    const current = scenes.find((s) => s.id === lighting.sceneId);
    // The buttons are only built anew when the list changed: they keep the focus while a slider moves
    const list = scenes.map((s) => `${s.id}\n${s.label}`).join("\n");
    if (list !== chipsFor) {
      chipsFor = list;
      chips = new Map(
        scenes.map((s) => {
          const chip = element("button", "light-desk-scene");
          chip.addEventListener("click", () => setLightingScene(s.id));
          return [s.id, chip];
        }),
      );
      sceneList.replaceChildren(...chips.values());
    }
    for (const s of scenes) {
      const chip = chips.get(s.id)!;
      const chosen = s.id === lighting.sceneId;
      // "*": the desk no longer shows the scene as it is saved
      chip.textContent = s.label + (chosen && lighting.modified ? " *" : "");
      chip.setAttribute("aria-pressed", String(chosen));
      chip.title = s.local ? "Nur in diesem Browser gespeichert" : "";
    }
    for (const [param, { input, output }] of inputs) {
      const value = lighting.values[param.key];
      input.value = param.kind === "color" ? hex(value) : String(value);
      output.textContent = param.kind === "color" ? hex(value) : shownValue(param, value);
    }
    name.placeholder = `Name (leer: „${lighting.label}“)`;
    // Deleting a scene that stands in front of another one brings that back
    remove.textContent = current?.resets ? "Zurücksetzen" : "Löschen";
    remove.disabled = !current?.removable;
  };
  onLightingChange(refresh);
  refresh();
  return desk;
}

/**
 * The desk for the debug panel: a button that steps through the scenes
 * (also the L key, on every page) and one that opens the desk as a panel on
 * the left.
 */
export function addLightDesk() {
  const panel = document.getElementById("panel")!;
  const stepButton = element("button");
  const deskButton = element("button", "", "Lichtpult");
  panel.prepend(stepButton, deskButton);

  const float = element("aside", "light-desk-float");
  float.hidden = true;
  float.setAttribute("aria-label", "Lichtpult");
  const close = element("button", "light-desk-close", "×");
  close.setAttribute("aria-label", "Schliessen");
  const header = element("header");
  header.append(element("strong", "", "Lichtpult"), close);
  float.append(header, createLightDesk());
  document.body.append(float);

  stepButton.addEventListener("click", nextLightingScene);
  deskButton.addEventListener("click", () => (float.hidden = !float.hidden));
  close.addEventListener("click", () => (float.hidden = true));
  addEventListener("keydown", (e) => {
    if (e.key !== "l" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    // Not while typing a name somewhere (the director's dialog); a slider may keep the focus
    if ((e.target as HTMLElement | null)?.closest?.("input:not([type=range], [type=color]), textarea, select, [contenteditable]")) return;
    nextLightingScene();
  });

  const refresh = () => (stepButton.textContent = `Licht: ${lighting.label}${lighting.modified ? " *" : ""} (L)`);
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
