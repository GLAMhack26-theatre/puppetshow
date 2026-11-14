import data from "../../assets/sounds/archive.json";
import { audio, isSoundOn, onSoundChange } from "./audio";

// Background music streamed from archive.org (assets/sounds/archive.json,
// tracks filled in by scripts/index-archive.mjs). Nothing is downloaded into
// the repo: the netlabel licences (NC, ND) allow playing, not cutting.
// Each play has its playlist (archive.json "plays"); switching crossfades
// between two decks. The elements are routed through Web Audio (archive.org
// sends CORS headers), because iOS ignores HTMLMediaElement.volume.

export interface Track {
  item: string;
  file: string;
  title: string;
  creator: string;
  licence: string;
  url: string;
}
interface Playlist {
  label: string;
  shuffle: boolean;
  tracks: Track[];
}

const playlists = data.playlists as Record<string, Playlist>;
const plays = data.plays as Record<string, string>;
const DEFAULT = plays.default;
const CROSSFADE_S = 2;

interface Deck {
  element: HTMLAudioElement;
  gain: GainNode;
}
let decks: [Deck, Deck] | null = null;
/** Index into decks of the one playing */
let active = 0;
let playlist = DEFAULT;
let order: Track[] = [];
let position = 0;
let current: Track | null = null;
const listeners: ((track: Track | null) => void)[] = [];

export function streamUrl(item: string, file: string) {
  return `https://archive.org/download/${item}/${encodeURIComponent(file)}`;
}

/** The track playing (null while sound is off or nothing loaded). */
export function nowPlaying() {
  return isSoundOn() ? current : null;
}

export function onTrackChange(fn: (track: Track | null) => void) {
  listeners.push(fn);
}

function notify() {
  for (const fn of listeners) fn(nowPlaying());
}

/** An empty playlist (e.g. an item without a licence) falls back to the default. */
function resolve(name: string) {
  return playlists[name]?.tracks.length ? name : DEFAULT;
}

function shuffled(tracks: Track[], shuffle: boolean) {
  const list = [...tracks];
  if (shuffle) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  return list;
}

function createDecks(context: AudioContext, bus: GainNode): [Deck, Deck] {
  const deck = (): Deck => {
    const element = new Audio();
    element.crossOrigin = "anonymous";
    element.preload = "auto";
    const gain = new GainNode(context, { gain: 0 });
    context.createMediaElementSource(element).connect(gain).connect(bus);
    const created = { element, gain };
    // Next track on the same deck; a failed file is skipped the same way.
    // Only the active deck: the faded-out one is just paused.
    const advance = () => created === decks?.[active] && next();
    element.addEventListener("ended", advance);
    element.addEventListener("error", advance);
    return created;
  };
  return [deck(), deck()];
}

/** Starts the next track of the playlist on the active deck. */
function next() {
  if (!decks) return;
  if (position >= order.length) {
    order = shuffled(playlists[playlist].tracks, playlists[playlist].shuffle);
    position = 0;
  }
  current = order[position++];
  const { element } = decks[active];
  element.src = streamUrl(current.item, current.file);
  if (isSoundOn()) void element.play().catch(() => {});
  notify();
}

/** Fades the active deck out and starts `name` on the other one. */
function switchTo(name: string) {
  playlist = name;
  order = [];
  position = 0;
  if (!decks) return;
  const { context } = audio()!;
  const now = context.currentTime;
  const old = decks[active];
  old.gain.gain.cancelScheduledValues(now);
  old.gain.gain.setValueAtTime(old.gain.gain.value, now);
  old.gain.gain.linearRampToValueAtTime(0, now + CROSSFADE_S);
  // Unless a quick switch back made it the active deck again
  setTimeout(() => old !== decks?.[active] && old.element.pause(), CROSSFADE_S * 1000);
  active = 1 - active;
  const fresh = decks[active];
  fresh.gain.gain.cancelScheduledValues(now);
  fresh.gain.gain.setValueAtTime(0, now);
  fresh.gain.gain.linearRampToValueAtTime(1, now + CROSSFADE_S);
  next();
}

/** The playlist for a play ("haensel", "froschkoenig", "impro"; "default" for the curtain and the title). */
export function setAmbientPlay(play: string) {
  const name = resolve(plays[play] ?? DEFAULT);
  if (name !== playlist) switchTo(name);
}

export function setupAmbient() {
  playlist = resolve(DEFAULT);
  onSoundChange((on) => {
    const graph = audio()!;
    if (!decks) {
      // First turn-on, inside the click: elements must be started in the gesture
      decks = createDecks(graph.context, graph.ambientBus);
      decks[active].gain.gain.value = 1;
      next();
      return;
    }
    const { element } = decks[active];
    if (on) void element.play().catch(() => {});
    else element.pause();
    notify();
  });
}
