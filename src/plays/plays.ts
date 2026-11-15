import type { World } from "@iwsdk/core";
import { hidePuppets, showPuppets } from "../puppet/puppet";
import { arrangeRequisits, type FloorSpot, placedRequisits, requisitsSettled } from "../props/requisits";
import { slug } from "../slug";
import { currentBackdrop, loadBackdrops, setBackdrop } from "../stage/backdrops";
import { lightScenesLoaded, type SceneLight, setStageLight, stageLight } from "../stage/lighting";

// Plays ("Stücke") and their scenes: stage presets built in impro mode
// (director.ts) and switched with the golden buttons while a play runs
// (scene-buttons.ts). One JSON file per play in assets/plays/<id>.json,
// served and written by the "plays" plugin in vite.config.ts. The id is the
// file name; the signs' plays (signs.ts PLAYS, e.g. "froschkoenig") pick up
// the file of the same name.
//
// A scene holds the backdrop, the props with their spots and its light: the
// id of a lighting scene from the library all plays share (assets/lights/,
// stage/lighting.ts), chosen on the Licht page. "sound" is reserved for the
// Sound page: kept as it is when a scene is saved again, not applied yet.

export interface Scene {
  name: string;
  /** Backdrop id (file name without "Background_"), null for none. */
  backdrop: string | null;
  props: FloorSpot[];
  /** The lighting scene; without one the scene is lit plainly. */
  light?: SceneLight;
  sound?: unknown;
}

export interface Play {
  id: string;
  name: string;
  scenes: Scene[];
}

const base = import.meta.env.BASE_URL;

/** Ids of all plays (file names in assets/plays/). */
export async function listPlays(): Promise<string[]> {
  try {
    const response = await fetch(`${base}plays/index.json`, { cache: "no-store" });
    return response.ok ? ((await response.json()) as string[]) : [];
  } catch {
    return [];
  }
}

/** The play, or null if there is no file for it. */
export async function loadPlay(id: string): Promise<Play | null> {
  const response = await fetch(`${base}plays/${id}.json`, { cache: "no-store" });
  if (!response.ok) return null;
  return parsePlay(id, await response.json());
}

/** A play from its JSON (a file from assets/plays/, or one dropped into the director bar). */
export function parsePlay(id: string, json: unknown): Play {
  const play = json as Partial<Play> | null;
  if (!play || typeof play !== "object" || !Array.isArray(play.scenes)) throw new Error("Keine Stück-Datei (scenes fehlt)");
  return {
    id,
    name: play.name ?? id,
    scenes: play.scenes.map((s) => ({ ...s, name: s.name ?? "", backdrop: s.backdrop ?? null, props: s.props ?? [] })),
  };
}

/** The play as a file, as it would be stored in assets/plays/. */
function playJson({ id: _, ...rest }: Play) {
  return JSON.stringify(rest, null, 2) + "\n";
}

/** Downloads the play as <id>.json, to keep it or put it into assets/plays/ by hand. */
export function downloadPlay(play: Play) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([playJson(play)], { type: "application/json" }));
  link.download = `${play.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/**
 * Writes the play back to assets/plays/ (dev server only). Without the dev
 * server (a build) the file is downloaded instead, to be put there by hand.
 * Returns how it was saved.
 */
export async function savePlay(play: Play): Promise<"saved" | "downloaded"> {
  if (import.meta.env.DEV) {
    const response = await fetch(`${base}plays/${play.id}.json`, {
      method: "PUT",
      body: playJson(play),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error(`Speichern fehlgeschlagen (${response.status})`);
    return "saved";
  }
  downloadPlay(play);
  return "downloaded";
}

/** "Der Froschkönig" → "der-froschkoenig" (file name of a new play). */
export const playId = (name: string) => slug(name, "stueck");

/** The stage as it stands now, as a scene (sound taken over from `previous`). */
export function captureScene(name: string, previous?: Scene): Scene {
  return {
    name,
    backdrop: currentBackdrop()?.id ?? null,
    props: placedRequisits(),
    light: stageLight(),
    ...(previous?.sound !== undefined && { sound: previous.sound }),
  };
}

const listeners: (() => void)[] = [];

/** Called after a scene was put on the stage (impro marks the chosen cards again). */
export function onSceneApplied(listener: () => void) {
  listeners.push(listener);
}

/**
 * Puts the scene on the stage: backdrop, light (faded) and props, each with
 * its usual animation. The puppet steps aside meanwhile (faded out and pulled up), so
 * the props come down onto a free stage, and comes back once all have landed.
 */
export async function applyScene(world: World, scene: Scene) {
  const run = ++applying;
  const hidden = hidePuppets();
  const [backdrops] = await Promise.all([loadBackdrops(), lightScenesLoaded()]);
  const backdrop = scene.backdrop ? backdrops.find((b) => b.id === scene.backdrop) : null;
  if (scene.backdrop && !backdrop) console.warn(`Scene preset: unknown backdrop ${scene.backdrop}`);
  setBackdrop(world, backdrop ?? null);
  setStageLight(scene.light);
  // The props only start down once the puppet is out of their way
  await hidden;
  if (run !== applying) return; // another scene was clicked meanwhile
  const arranging = arrangeRequisits(world, scene.props);
  for (const listener of listeners) listener();
  await arranging;
  for (const listener of listeners) listener(); // props that had to load first
  await until(requisitsSettled);
  // A scene clicked meanwhile brings the puppet back itself
  if (run === applying) await showPuppets();
}

let applying = 0;

function until(done: () => boolean) {
  return new Promise<void>((resolve) => {
    const check = () => (done() ? resolve() : requestAnimationFrame(check));
    check();
  });
}
