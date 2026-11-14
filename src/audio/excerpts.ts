import data from "../../assets/sounds/archive.json";
import { streamUrl } from "./ambient";
import { audio, duck, isSoundOn, onSoundChange } from "./audio";

// Passages of a longer archive.org recording (Oda Klonk, "Ein Haus das
// klingt"), played straight from the stream: the element seeks to `start`
// and fades out at `end`. Nothing is cut into files, because the licence
// (ND) does not allow derivatives. archive.org serves range requests, so
// seeking does not load the whole 30 MB file. The first play waits for the
// network: excerpts are for the Sound page and the curtain, not for exact timing.

export interface Excerpt {
  id: string;
  label: string;
  icon: string;
  item: string;
  file: string;
  start: number;
  end: number;
  title: string;
  creator: string;
  licence: string;
  url: string;
}

export const EXCERPTS = data.excerpts as Excerpt[];
const cues = data.cues as Record<string, string>;

const FADE_S = 0.3;

interface Player {
  element: HTMLAudioElement;
  gain: GainNode;
  playing: boolean;
  /** Ends the fade-out timer of a stop in progress */
  timer?: ReturnType<typeof setTimeout>;
}
const players = new Map<string, Player>();
const listeners: (() => void)[] = [];

export function onExcerptChange(fn: () => void) {
  listeners.push(fn);
}

export function isExcerptPlaying(id: string) {
  return !!players.get(id)?.playing;
}

/** The excerpt playing last, for the credit line; null if none. */
export function playingExcerpt() {
  return [...EXCERPTS].reverse().find((e) => isExcerptPlaying(e.id)) ?? null;
}

function notify() {
  for (const fn of listeners) fn();
}

function player(excerpt: Excerpt) {
  let p = players.get(excerpt.id);
  if (p) return p;
  const { context, effectsBus } = audio()!;
  const element = new Audio();
  element.crossOrigin = "anonymous";
  element.preload = "auto";
  element.src = streamUrl(excerpt.item, excerpt.file);
  const gain = new GainNode(context, { gain: 0 });
  context.createMediaElementSource(element).connect(gain).connect(effectsBus);
  const created: Player = { element, gain, playing: false };
  // timeupdate comes about four times a second: the fade starts just before the end
  element.addEventListener("timeupdate", () => {
    if (created.playing && element.currentTime >= excerpt.end - FADE_S) stopExcerpt(excerpt.id);
  });
  element.addEventListener("error", () => created.playing && stopExcerpt(excerpt.id));
  players.set(excerpt.id, created);
  return created;
}

/** Plays an excerpt from its start; sound must be on (the caller decides whether to turn it on). */
export function playExcerpt(id: string) {
  const excerpt = EXCERPTS.find((e) => e.id === id);
  if (!excerpt || !audio() || !isSoundOn()) return;
  const p = player(excerpt);
  clearTimeout(p.timer);
  const { context } = audio()!;
  if (!p.playing) duck(true);
  p.playing = true;
  // Seeking before the metadata is there is not reliable in every browser (Safari)
  if (p.element.readyState >= 1) p.element.currentTime = excerpt.start;
  else p.element.addEventListener("loadedmetadata", () => (p.element.currentTime = excerpt.start), { once: true });
  p.gain.gain.cancelScheduledValues(context.currentTime);
  p.gain.gain.setTargetAtTime(1, context.currentTime, 0.02);
  void p.element.play().catch(() => stopExcerpt(id));
  notify();
}

export function stopExcerpt(id: string) {
  const p = players.get(id);
  if (!p?.playing) return;
  const { context } = audio()!;
  p.playing = false;
  duck(false);
  p.gain.gain.setTargetAtTime(0, context.currentTime, FADE_S / 3);
  p.timer = setTimeout(() => p.element.pause(), FADE_S * 1000);
  notify();
}

export function toggleExcerpt(id: string) {
  if (isExcerptPlaying(id)) stopExcerpt(id);
  else playExcerpt(id);
}

/** An event cue (archive.json "cues"); silent while sound is off. */
export function playCue(name: string) {
  if (cues[name]) playExcerpt(cues[name]);
}

/** Loads the start of every excerpt in advance, once sound is on (the Sound page calls this when it opens). */
export function preloadExcerpts() {
  if (!audio()) return;
  for (const excerpt of EXCERPTS) {
    const p = player(excerpt);
    if (!p.playing && p.element.readyState >= 1) p.element.currentTime = excerpt.start;
    else if (!p.playing) p.element.addEventListener("loadedmetadata", () => (p.element.currentTime = excerpt.start), { once: true });
  }
}

export function setupExcerpts() {
  // Turning sound off silences the excerpts too (and releases their ducking)
  onSoundChange((on) => {
    if (!on) for (const excerpt of EXCERPTS) stopExcerpt(excerpt.id);
  });
}
