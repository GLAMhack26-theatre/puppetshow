import type { World } from "@iwsdk/core";
import { applyScene, captureScene, downloadPlay, listPlays, loadPlay, parsePlay, type Play, playId, savePlay } from "./plays";
import "./plays.css";

// Director bar ("Regie") in impro mode: build the scenes of a play.
//   1. pick a play or create one ("+ Neues Stück", asks for its name),
//   2. "+ Szene" asks for the scene's name and starts from the stage as it
//      stands,
//   3. set the stage with the impro panels (backdrop, props and where they
//      stand; light and sound once those pages exist),
//   4. "Speichern" stores the stage in the chosen scene and writes the play
//      to assets/plays/<id>.json (dev server; a build downloads the file).
// A click on a scene puts it on the stage, to look at or change it; a
// double click renames it. "Download" keeps a copy of the play as a file;
// "Laden" (or dropping a .json onto the bar) brings such a file back in,
// replacing the play of the same id until it is saved.

let director: ReturnType<typeof buildDirector> | null = null;

/**
 * Shows the director bar (built on the first call, shown again after a
 * return to the play choice, with the list of plays read anew). Returns
 * `stop` to hide it, and `canLeave`, which asks before unsaved changes are
 * left behind.
 */
export function startDirector(world: World) {
  if (!director) director = buildDirector(world);
  const shown = director;
  shown.bar.hidden = false;
  void shown.reload();
  return {
    stop: () => (shown.bar.hidden = true),
    canLeave: () => !shown.isDirty() || confirm("Das Stück hat ungespeicherte Änderungen. Trotzdem zur Stückwahl?"),
  };
}

function buildDirector(world: World) {
  const bar = element("section", "director");
  bar.setAttribute("aria-label", "Regie");
  const playSelect = element("select", "director-play");
  playSelect.title = "Stück";
  const scenes = element("div", "director-scenes");
  const addScene = button("+ Szene", "director-add", "Neue Szene aus der Bühne, wie sie gerade steht");
  const save = button("Speichern", "director-save", "Bühne in dieser Szene speichern");
  const remove = button("×", "director-remove", "Szene löschen");
  const download = button("Download", "director-file", "Stück als JSON-Datei herunterladen");
  const upload = button("Laden", "director-file", "Stück-JSON laden (oder auf die Leiste ziehen)");
  const picker = element("input");
  picker.type = "file";
  picker.accept = ".json,application/json";
  picker.hidden = true;
  const status = element("span", "director-status");
  const label = element("span", "director-label", "Regie");
  bar.append(label, playSelect, scenes, addScene, save, remove, download, upload, picker, status);
  document.body.append(bar);

  const NEW = "__new__";
  let plays: Play[] = [];
  let play: Play | null = null;
  let scene = -1;
  let dirty = false;

  const setStatus = (text: string, kind: "" | "ok" | "warn" = "") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const markDirty = () => {
    dirty = true;
    setStatus("nicht gespeichert", "warn");
  };

  const render = () => {
    playSelect.replaceChildren(
      ...(play ? [] : [option("", "Stück wählen …")]),
      ...plays.map((p) => option(p.id, p.name)),
      option(NEW, "+ Neues Stück …"),
    );
    playSelect.value = play?.id ?? "";
    scenes.replaceChildren(
      ...(play?.scenes ?? []).map((s, i) => {
        const chip = button(s.name || `Szene ${i + 1}`, "director-scene", "Klick: auf die Bühne · Doppelklick: umbenennen");
        chip.setAttribute("aria-pressed", String(i === scene));
        chip.addEventListener("click", () => {
          scene = i;
          render();
          void applyScene(world, s);
        });
        chip.addEventListener("dblclick", async () => {
          const name = await askName("Szene umbenennen", s.name);
          if (!name) return;
          s.name = name;
          markDirty();
          render();
        });
        return chip;
      }),
    );
    addScene.disabled = !play;
    save.disabled = !play;
    remove.disabled = !play || scene < 0;
    download.disabled = !play;
  };

  playSelect.addEventListener("change", async () => {
    if (playSelect.value === NEW) {
      render(); // back to the current play until a name is given
      const name = await askName("Neues Stück", "", "z.B. Der Froschkönig");
      if (!name) return;
      const id = playId(name);
      const known = plays.find((p) => p.id === id);
      if (known) {
        setStatus(`„${known.name}“ gibt es schon`, "warn");
        return choose(known);
      }
      const created: Play = { id, name, scenes: [] };
      plays.push(created);
      choose(created);
      markDirty();
      return;
    }
    const chosen = plays.find((p) => p.id === playSelect.value);
    if (chosen) choose(chosen);
  });

  const choose = (chosen: Play) => {
    play = chosen;
    scene = chosen.scenes.length ? 0 : -1;
    dirty = false;
    setStatus("");
    render();
    if (scene >= 0) void applyScene(world, chosen.scenes[0]);
  };

  addScene.addEventListener("click", async () => {
    if (!play) return;
    const name = await askName("Neue Szene", "", `Szene ${play.scenes.length + 1}`);
    if (!name) return;
    play.scenes.push(captureScene(name));
    scene = play.scenes.length - 1;
    markDirty();
    render();
  });

  save.addEventListener("click", async () => {
    if (!play) return;
    if (scene < 0) {
      // No scene yet: the first one is made from the stage now
      const name = await askName("Name der Szene", "", "Szene 1");
      if (!name) return;
      play.scenes.push(captureScene(name));
      scene = play.scenes.length - 1;
    } else {
      play.scenes[scene] = captureScene(play.scenes[scene].name, play.scenes[scene]);
    }
    render();
    await write();
  });

  remove.addEventListener("click", async () => {
    if (!play || scene < 0) return;
    if (!confirm(`Szene „${play.scenes[scene].name}“ löschen?`)) return;
    play.scenes.splice(scene, 1);
    scene = Math.min(scene, play.scenes.length - 1);
    render();
    await write();
  });

  const write = async () => {
    if (!play) return;
    setStatus("speichert …");
    try {
      const how = await savePlay(play);
      dirty = false;
      setStatus(how === "saved" ? `gespeichert: assets/plays/${play.id}.json` : `heruntergeladen: ${play.id}.json → assets/plays/`, "ok");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Fehler beim Speichern", "warn");
    }
  };

  download.addEventListener("click", () => play && downloadPlay(play));

  // A downloaded play comes back in: as a play of its own, or in place of
  // the one with the same id ("froschkoenig (1).json" counts as froschkoenig)
  const importFile = async (file: File) => {
    try {
      const id = playId(file.name.replace(/\.json$/i, "").replace(/\s*\(\d+\)$/, ""));
      const loaded = parsePlay(id, JSON.parse(await file.text()));
      const index = plays.findIndex((p) => p.id === id);
      if (index >= 0) plays[index] = loaded;
      else plays.push(loaded);
      choose(loaded);
      markDirty();
      setStatus(`${file.name} geladen – Speichern schreibt assets/plays/${id}.json`, "warn");
    } catch (error) {
      setStatus(`${file.name}: ${error instanceof Error ? error.message : "nicht lesbar"}`, "warn");
    }
  };
  upload.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    if (file) void importFile(file);
    picker.value = "";
  });
  bar.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    bar.classList.add("dragover");
  });
  bar.addEventListener("dragleave", () => bar.classList.remove("dragover"));
  bar.addEventListener("drop", (e) => {
    e.preventDefault();
    bar.classList.remove("dragover");
    const file = e.dataTransfer?.files[0];
    if (file) void importFile(file);
  });

  addEventListener("beforeunload", (e) => {
    if (dirty) e.preventDefault();
  });

  render();
  // Plays read from the files; the chosen one stays as it is (it may hold unsaved changes)
  const reload = async () => {
    const ids = await listPlays();
    const loaded = (await Promise.all(ids.map((id) => loadPlay(id).catch(() => null)))).filter((p): p is Play => !!p);
    plays = loaded.map((p) => (p.id === play?.id ? play : p));
    if (play && !plays.includes(play)) plays.push(play);
    render();
  };
  return { bar, reload, isDirty: () => dirty };
}

/** A small paper dialog asking for a name; null if cancelled. */
function askName(title: string, value: string, placeholder = ""): Promise<string | null> {
  const dialog = element("dialog", "director-ask");
  const form = element("form");
  const heading = element("h2", "", title);
  const input = element("input");
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  input.required = true;
  input.maxLength = 80;
  const actions = element("div", "director-ask-actions");
  const cancel = button("Abbrechen", "director-ask-cancel");
  const ok = button("OK", "director-ask-ok");
  ok.type = "submit";
  actions.append(cancel, ok);
  form.append(heading, input, actions);
  dialog.append(form);
  document.body.append(dialog);
  // Typing a name must not reach the app's key shortcuts (V = stage curtain)
  dialog.addEventListener("keydown", (e) => e.stopPropagation());
  dialog.showModal();
  input.select();
  // Answered from the form's own events, not the dialog's "close": that one
  // did not always arrive (seen with Enter in Chrome)
  return new Promise((resolve) => {
    let done = false;
    const finish = (name: string | null) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(name);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      finish(input.value.trim() || null);
    });
    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", () => finish(null)); // Esc
    dialog.addEventListener("close", () => finish(null));
  });
}

function option(value: string, text: string) {
  const o = element("option", "", text);
  o.value = value;
  return o;
}

function button(text: string, className: string, title = "") {
  const b = element("button", className, text);
  b.type = "button";
  if (title) b.title = title;
  return b;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}
