import {
  Color,
  DirectionalLight,
  PMREMGenerator,
  RectAreaLight,
  SRGBColorSpace,
  createSystem,
  type World,
} from "@iwsdk/core";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { slug } from "../slug";
import { setBackdropTint } from "./backdrops";
import { setSpotLook } from "./spotlights";
import { stageBounds } from "./stage";

// The stage lighting, as a theatre lighting designer set it up for us. One
// fixed rig of five groups, each on a dimmer (0 … 100 %):
//
// - Front light: two white lights out front, 45° up and 45° to either side,
//   diffuse over the full stage width, 3000 … 5600 K.
// - Profile spot: the follow spots (spotlights.ts), one per puppet. Nearly
//   parallel, hard light with a soft rim; the only lights casting shadows.
// - Top light: an area light above the stage, any colour: the mood.
// - Side light: area lights in the wings on both sides, for plasticity.
// - Striplight: along the front edge of the floor, shining up at 45° into
//   the faces, any colour.
//
// The top, side and strip lights are area lights (RectAreaLight): soft, with
// no visible source (no "wall of light"), and they fall off with distance,
// so they light the stage and not the room. A lighting scene is a set of
// values for the parameters of this rig (LIGHT_PARAMS): the plain one below,
// and the library in assets/lights/, filled from the light desk
// (ui/light-desk.ts). A play's scene names the lighting scene it is lit with.
//
// Lights are never added or removed when switching: a changed light count
// recompiles every lit material (a visible hitch); a light that is not used
// stands at 0 %. Switching fades over FADE_SECONDS, like a cue on a desk.
//
// The renderer has no tone mapping (the unlit painted parts keep their
// colours), so light simply adds up to white: with everything at 100 % light
// clothes burn out.

// What 100 % on the dimmer is, per light
const FRONT_FULL = 2; // per light, directional
const SPOT_FULL = 30; // cd
const TOP_FULL = 3; // area lights: nits
const SIDE_FULL = 5;
const STRIP_FULL = 30; // a thin strip: little area, so a lot per area
const ROOM_FULL = 1; // scene.environmentIntensity
const BEAM_FULL = 0.4; // opacity of the drawn spot beam

/** Height of the top light above the floor: above the proscenium opening */
const TOP_HEIGHT = 0.8;
/** The side lights: height of the panel, and of its centre above the floor (about the puppet's chest) */
const SIDE_HEIGHT = 0.4;
const SIDE_Y = 0.35;
/** The striplight: height of the strip, and its tilt up from the horizontal, towards the back */
const STRIP_HEIGHT = 0.04;
const STRIP_TILT = Math.PI / 4;
const FADE_SECONDS = 1.5;

export type LightParam =
  | "front"
  | "frontKelvin"
  | "spot"
  | "spotKelvin"
  | "spotAngle"
  | "spotEdge"
  | "spotBeam"
  | "top"
  | "topColor"
  | "side"
  | "sideKelvin"
  | "strip"
  | "stripColor"
  | "room";
/** One lighting scene: dimmers 0 … 1, Kelvin, degrees, colours as hex numbers */
export type LightValues = Record<LightParam, number>;

export interface LightParamInfo {
  key: LightParam;
  /** The light group on the desk */
  group: string;
  label: string;
  /** dimmer: 0 … 1 shown as %; color: a hex colour; else a plain number with a unit */
  kind: "dimmer" | "color" | "number";
  min: number;
  max: number;
  step: number;
  unit: string;
}

const dimmer = (key: LightParam, group: string, label = "Helligkeit"): LightParamInfo => ({
  key,
  group,
  label,
  kind: "dimmer",
  min: 0,
  max: 1,
  step: 0.01,
  unit: "%",
});
const kelvin = (key: LightParam, group: string): LightParamInfo => ({
  key,
  group,
  label: "Farbtemperatur",
  kind: "number",
  min: 3000,
  max: 5600,
  step: 100,
  unit: "K",
});
const color = (key: LightParam, group: string): LightParamInfo => ({
  key,
  group,
  label: "Farbe",
  kind: "color",
  min: 0,
  max: 0xffffff,
  step: 1,
  unit: "",
});

const FRONT = "Vorderlicht (2 × 45°)";
const SPOT = "Profilscheinwerfer (Verfolger)";
const TOP = "Oberlicht";
const SIDE = "Seitenlicht (Gassen)";
const STRIP = "Rampe (Fussrampe)";
const ROOM = "Raum";

/** Every tunable value of the rig, in the order of the desk */
export const LIGHT_PARAMS: LightParamInfo[] = [
  dimmer("front", FRONT),
  kelvin("frontKelvin", FRONT),
  dimmer("spot", SPOT),
  kelvin("spotKelvin", SPOT),
  // The whole beam angle, as on a profile spot's data sheet
  { key: "spotAngle", group: SPOT, label: "Öffnung", kind: "number", min: 8, max: 45, step: 1, unit: "°" },
  // 0: a hard edge; the "diffuse rim" of a profile in a theatre is a little of this
  dimmer("spotEdge", SPOT, "Weicher Rand"),
  dimmer("spotBeam", SPOT, "Strahl im Dunst"),
  dimmer("top", TOP),
  color("topColor", TOP),
  dimmer("side", SIDE),
  kelvin("sideKelvin", SIDE),
  dimmer("strip", STRIP),
  color("stripColor", STRIP),
  // Reflections of the room on the glossy materials, and a little light from everywhere
  dimmer("room", ROOM, "Raumlicht"),
];

export interface LightScene {
  /** Shown on the button and the desk */
  label: string;
  values: LightValues;
}

/** The scene the stage starts in, and the one a play's scene without a light of its own gets */
const START = "neutral";
// Plain stage light: even from the front, the top light at 40 %. Built in,
// so there is light without the library, and a value for every parameter a
// file does not give.
const NEUTRAL: LightScene = {
  label: "Neutral",
  values: {
    front: 0.5,
    frontKelvin: 5600,
    spot: 0.27,
    spotKelvin: 5200,
    spotAngle: 17,
    spotEdge: 0.25,
    spotBeam: 0.25,
    top: 0.4,
    topColor: 0xfff2e0,
    side: 0.3,
    sideKelvin: 5000,
    strip: 0.1,
    stripColor: 0xffe6c4,
    room: 0.3,
  },
};

// The library of lighting scenes, shared by all plays: one JSON file per
// scene in assets/lights/<id>.json ({ "name", "values" }, colours as
// "#rrggbb"), served and written by the "lights" plugin in vite.config.ts.
// Fetched at runtime, not imported: saving from the desk would otherwise
// reload the page (and lose the director's unsaved play). Only the dev
// server can write; elsewhere (a build) a saved scene is kept in this
// browser (localStorage) and downloaded as a file, to be put there by hand.
// A scene in the browser stands in front of the file of the same id, a file
// "neutral" in front of the built-in plain scene.
const base = import.meta.env.BASE_URL;
const STORAGE_KEY = "puppetshow.lightScenes";
const files: Record<string, LightScene> = {};
const local = loadLocal();

const hex = (value: number) => `#${Math.round(value).toString(16).padStart(6, "0")}`;

/**
 * A scene's values from JSON. A missing or broken one is taken from the
 * plain scene (a NaN brightness would break the shaders); all are kept
 * within their range.
 */
export function lightValuesFromJson(json: unknown): LightValues {
  const given = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const values = { ...NEUTRAL.values };
  for (const { key, kind, min, max } of LIGHT_PARAMS) {
    const raw = given[key];
    const value = kind === "color" && typeof raw === "string" ? parseInt(raw.replace("#", ""), 16) : raw;
    if (typeof value === "number" && Number.isFinite(value)) values[key] = Math.min(max, Math.max(min, value));
  }
  return values;
}

/** The values as they stand in a file: colours as "#rrggbb", numbers rounded. */
export function lightValuesToJson(values: LightValues) {
  return Object.fromEntries(
    LIGHT_PARAMS.map(({ key, kind }) => [key, kind === "color" ? hex(values[key]) : +values[key].toFixed(3)]),
  ) as Record<LightParam, number | string>;
}

function loadLocal(): Record<string, LightScene> {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, Partial<LightScene>>;
    return Object.fromEntries(
      Object.entries(stored).map(([id, s]) => [id, { label: s.label ?? id, values: lightValuesFromJson(s.values) }]),
    );
  } catch {
    return {}; // no storage (private mode) or broken data: the library only
  }
}

function storeLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
  } catch (e) {
    console.warn("Lighting scenes could not be stored", e);
  }
}

let loading: Promise<void> | null = null;

/** Resolves once the library is read (or could not be: then there is only the plain scene). */
export function lightScenesLoaded() {
  loading ??= (async () => {
    try {
      const response = await fetch(`${base}lights/index.json`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const all = (await response.json()) as Record<string, { name?: string; values?: unknown } | null>;
      for (const [id, json] of Object.entries(all))
        files[id] = { label: json?.name || id, values: lightValuesFromJson(json?.values) };
    } catch (e) {
      console.warn("Lighting scenes could not be loaded: the plain scene only", e);
    }
    changed();
  })();
  return loading;
}

const scene = (id: string): LightScene | undefined => local[id] ?? files[id] ?? (id === START ? NEUTRAL : undefined);

/** All scenes: the plain one first, then by name. */
export function lightScenes() {
  const ids = [...new Set([START, ...Object.keys(files), ...Object.keys(local)])];
  return ids
    .map((id) => ({
      id,
      label: scene(id)!.label,
      /** Kept in this browser only, not (or not in this form) in assets/lights/ */
      local: id in local,
      /** Can be deleted here: the browser's own scenes anywhere, files only through the dev server */
      removable: id in local || (id in files && import.meta.env.DEV),
      /** Deleting it brings back the scene it stands in front of */
      resets: id === START || (id in local && id in files),
    }))
    .sort((a, b) => Number(b.id === START) - Number(a.id === START) || a.label.localeCompare(b.label, "de"));
}

interface Rig {
  world: World;
  front: DirectionalLight[];
  top: RectAreaLight;
  sides: RectAreaLight[];
  strip: RectAreaLight;
}

let rig: Rig | null = null;
let sceneId = START;
/** The desk's values differ from the scene they came from */
let modified = false;
/** What is shown right now, the fade's two ends, and how far it is (1: done) */
let shown = { ...NEUTRAL.values };
let from = shown;
let to = shown;
let fade = 1;
/** Something chose the light already, before the library arrived */
let touched = false;
const listeners: (() => void)[] = [];

/** The state of the desk: the scene and the values it is set to (the end of a running fade). */
export const lighting = {
  get sceneId() {
    return sceneId;
  },
  get label() {
    return scene(sceneId)?.label ?? sceneId;
  },
  get modified() {
    return modified;
  },
  get values(): Readonly<LightValues> {
    return to;
  },
};

/** Called whenever the scene, its values or the list of scenes changed. */
export function onLightingChange(listener: () => void) {
  listeners.push(listener);
}

const changed = () => listeners.forEach((listener) => listener());

export function addLighting(world: World) {
  // A neutral room as environment: the marionette's clearcoat, sheen and
  // specular materials (made in Blender with an HDRI) look dull and too
  // dark with direct lights alone
  const pmrem = new PMREMGenerator(world.renderer);
  world.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  // The lookup textures area lights need; without them they stay dark
  RectAreaLightUniformsLib.init();

  // The floor is centred on z = 0; its front edge is as far out as its back edge
  const width = stageBounds.width;
  const frontZ = Math.abs(stageBounds.backZ);
  const x = stageBounds.centerX;

  // 45° up and 45° to the side: directional lights shine from their position
  // towards the origin, evenly over the whole stage
  const front = [-1, 1].map((side) => {
    const light = new DirectionalLight();
    light.position.set(side, Math.SQRT2, 1);
    return light;
  });

  // Area lights shine from one face only, along their −z; lookAt() turns that face to the point
  const top = new RectAreaLight(0xffffff, 0, width, frontZ * 2);
  top.position.set(x, TOP_HEIGHT, 0);
  top.rotation.x = -Math.PI / 2; // straight down

  const sides = [-1, 1].map((side) => {
    const light = new RectAreaLight(0xffffff, 0, frontZ * 2, SIDE_HEIGHT);
    light.position.set(x + side * (width / 2 + 0.05), SIDE_Y, 0);
    light.lookAt(x, SIDE_Y, 0);
    return light;
  });

  const strip = new RectAreaLight(0xffffff, 0, width, STRIP_HEIGHT);
  strip.position.set(x, STRIP_HEIGHT / 2, frontZ);
  strip.lookAt(x, strip.position.y + Math.sin(STRIP_TILT), frontZ - Math.cos(STRIP_TILT));

  world.scene.add(...front, top, ...sides, strip);
  rig = { world, front, top, sides, strip };

  apply(shown);
  // The library arrives a moment later: until then the plain scene. ?light=
  // chooses the scene to start in, unless a play's scene was faster.
  const chosen = new URLSearchParams(location.search).get("light");
  void lightScenesLoaded().then(() => {
    if (touched) return;
    if (chosen && scene(chosen)) sceneId = chosen;
    shown = from = to = { ...scene(sceneId)!.values };
    apply(shown);
    changed();
  });
}

/** Fades to another lighting scene. */
export function setLightingScene(id: string) {
  const next = scene(id);
  if (next) fadeTo(id, next.values, false);
}

function fadeTo(id: string, values: LightValues, changedValues: boolean) {
  sceneId = id;
  modified = changedValues;
  touched = true;
  // From what is shown now, not from the last scene: no jump when switching during a fade
  from = shown;
  to = { ...values };
  fade = 0;
  changed();
}

/**
 * The light of a play's scene (plays/plays.ts): a scene of the library, by
 * its id, and the desk's values if they were changed without being saved as
 * a lighting scene, so the scene looks as it was set up either way.
 */
export interface SceneLight {
  scene: string;
  values?: Record<string, number | string>;
}

/** The light as it stands now, for a play's scene. */
export function stageLight(): SceneLight {
  return { scene: sceneId, ...(modified && { values: lightValuesToJson(to) }) };
}

/**
 * Fades to the light of a play's scene. A scene without one is lit plainly,
 * so its light does not depend on the scene shown before. Needs the library
 * (lightScenesLoaded).
 */
export function setStageLight(light: SceneLight | undefined) {
  const known = !!light && typeof light.scene === "string" && !!scene(light.scene);
  if (light && !known) console.warn(`Scene preset: unknown lighting scene ${String(light.scene)}`);
  const id = known ? light!.scene : START;
  if (light?.values) fadeTo(id, lightValuesFromJson(light.values), true);
  else fadeTo(id, scene(id)!.values, false);
}

/** The next scene in the list (the L key). */
export function nextLightingScene() {
  const ids = lightScenes().map((s) => s.id);
  setLightingScene(ids[(ids.indexOf(sceneId) + 1) % ids.length]);
}

/** One value from the desk: at once, without a fade. */
export function setLight(key: LightParam, value: number) {
  // Also at both ends of a running fade, or the fade would bring the old value back
  from = { ...from, [key]: value };
  to = { ...to, [key]: value };
  shown = { ...shown, [key]: value };
  modified = true;
  touched = true;
  apply(shown);
  changed();
}

/**
 * Saves the desk's values as a lighting scene of the library and makes it
 * the current one. A name that is already there replaces that scene, in
 * every play's scene that uses it; without a name the current one is saved.
 * Returns how: written to assets/lights/ (dev server), or kept in this
 * browser and downloaded as a file to put there (a build).
 */
export async function saveLightScene(name: string): Promise<{ id: string; how: "saved" | "downloaded" }> {
  const label = name.trim() || lighting.label;
  const existing = lightScenes().find((s) => s.label.toLowerCase() === label.toLowerCase());
  const id = existing?.id ?? slug(label, "licht");
  const saved: LightScene = { label: existing?.label ?? label, values: { ...to } };
  const file = `${JSON.stringify({ name: saved.label, values: lightValuesToJson(saved.values) }, null, 2)}\n`;
  if (import.meta.env.DEV) {
    const response = await fetch(`${base}lights/${id}.json`, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error(`Speichern fehlgeschlagen (${response.status})`);
    files[id] = saved;
    delete local[id]; // the file is what counts now
  } else {
    local[id] = saved;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([file], { type: "application/json" }));
    link.download = `${id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  storeLocal();
  sceneId = id;
  modified = false;
  touched = true;
  changed();
  return { id, how: import.meta.env.DEV ? "saved" : "downloaded" };
}

/**
 * Deletes a lighting scene: the browser's own, or (dev server) its file. The
 * scene it stood in front of comes back; a play's scene that used it is lit
 * plainly from then on.
 */
export async function deleteLightScene(id: string) {
  if (id in local) {
    delete local[id];
    storeLocal();
  } else if (id in files && import.meta.env.DEV) {
    const response = await fetch(`${base}lights/${id}.json`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Löschen fehlgeschlagen (${response.status})`);
    delete files[id];
  } else return;
  if (id === sceneId) setLightingScene(scene(id) ? id : START);
  else changed();
}

// The colour of a white light of a colour temperature (Tanner Helland's fit
// to the black-body curve, for up to 6600 K; white is 6600 K, so 5600 K is
// still slightly warm and 3000 K a clear orange)
function white(kelvins: number, out: Color) {
  const t = kelvins / 100;
  const green = 99.4708025861 * Math.log(t) - 161.1195681661;
  const blue = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const unit = (value: number) => Math.min(1, Math.max(0, value / 255));
  return out.setRGB(1, unit(green), unit(blue), SRGBColorSpace);
}

const frontColor = new Color();
const sideColor = new Color();
const spotColor = new Color();
const tint = new Color();
const part = new Color();

function apply(v: LightValues) {
  if (!rig) return;
  white(v.frontKelvin, frontColor);
  for (const light of rig.front) {
    light.color.copy(frontColor);
    light.intensity = v.front * FRONT_FULL;
  }
  rig.top.color.setHex(v.topColor);
  rig.top.intensity = v.top * TOP_FULL;
  white(v.sideKelvin, sideColor);
  for (const light of rig.sides) {
    light.color.copy(sideColor);
    light.intensity = v.side * SIDE_FULL;
  }
  rig.strip.color.setHex(v.stripColor);
  rig.strip.intensity = v.strip * STRIP_FULL;
  rig.world.scene.environmentIntensity = v.room * ROOM_FULL;
  setSpotLook(
    white(v.spotKelvin, spotColor),
    v.spot * SPOT_FULL,
    // Half the beam angle, rad
    (v.spotAngle * Math.PI) / 360,
    v.spotEdge,
    v.spotBeam * BEAM_FULL,
  );

  // The painted backdrops are unlit, so the stage lights do not reach them:
  // they are tinted with the light that would fall on a sheet at the back of
  // the stage. Mostly the front light, which meets it at 45°; the strip
  // shines up at it; top and side light only graze it. Everything at 0 %
  // is black, the plain scene leaves the paint as it is (clamped to white).
  tint.setRGB(0, 0, 0);
  tint.add(part.copy(frontColor).multiplyScalar(v.front * 2.4));
  tint.add(part.copy(rig.strip.color).multiplyScalar(v.strip * 0.8));
  tint.add(part.copy(rig.top.color).multiplyScalar(v.top * 0.3));
  tint.add(part.copy(sideColor).multiplyScalar(v.side * 0.1));
  setBackdropTint(tint.setRGB(Math.min(1, tint.r), Math.min(1, tint.g), Math.min(1, tint.b)));
}

const fromColor = new Color();
const toColor = new Color();

export class LightingSystem extends createSystem({}) {
  update(delta: number) {
    if (fade >= 1) return;
    fade = Math.min(1, fade + delta / FADE_SECONDS);
    const k = fade * fade * (3 - 2 * fade); // eased: no hard start or stop
    const next = { ...to };
    for (const { key, kind } of LIGHT_PARAMS) {
      // Colours blend as light (linear), not as hex numbers
      if (kind === "color") next[key] = fromColor.setHex(from[key]).lerp(toColor.setHex(to[key]), k).getHex();
      else next[key] = from[key] + (to[key] - from[key]) * k;
    }
    shown = next;
    apply(shown);
  }
}
