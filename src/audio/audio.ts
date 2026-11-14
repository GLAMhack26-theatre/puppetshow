// The audio graph and the on/off state of its two channels: "music" (the
// archive.org background playlists, ambient.ts) and "effects" (excerpts,
// cues, physics sounds). Both are off at every page load (never
// remembered): nothing plays until a button or a sign is clicked. The first
// turn-on creates and resumes the AudioContext, the user gesture iOS needs.
// music bus and effects bus → master → destination.

export type Channel = "music" | "effects";

let context: AudioContext | null = null;
let musicBus: GainNode;
let effectsBus: GainNode;
const state: Record<Channel, boolean> = { music: false, effects: false };
const listeners: ((channel: Channel, on: boolean) => void)[] = [];

/** Below the effects: background music must not cover the play */
const MUSIC_LEVEL = 0.5;
/** While an excerpt plays, the background music steps back */
const DUCKED = 0.3;
const FADE_S = 0.3;
let ducking = 0;

/** Created on the first turn-on; null before. */
export function audio() {
  return context && { context, musicBus, effectsBus };
}

export function isOn(channel: Channel) {
  return state[channel];
}

function musicLevel() {
  if (!state.music) return 0;
  return ducking ? MUSIC_LEVEL * DUCKED : MUSIC_LEVEL;
}

/** Must run inside a user gesture the first time (click, key). */
export function setOn(channel: Channel, on: boolean) {
  if (!context) {
    context = new AudioContext();
    musicBus = new GainNode(context, { gain: 0 });
    effectsBus = new GainNode(context, { gain: 0 });
    const master = new GainNode(context, { gain: 1 });
    musicBus.connect(master);
    effectsBus.connect(master);
    master.connect(context.destination);
  }
  state[channel] = on;
  if (on) void context.resume();
  // A short fade instead of a click
  const bus = channel === "music" ? musicBus : effectsBus;
  bus.gain.setTargetAtTime(channel === "music" ? musicLevel() : on ? 1 : 0, context.currentTime, FADE_S / 3);
  for (const fn of listeners) fn(channel, on);
}

export function onChannelChange(fn: (channel: Channel, on: boolean) => void) {
  listeners.push(fn);
}

/** Counted: duck(true) and duck(false) come in pairs, one per playing excerpt. */
export function duck(down: boolean) {
  ducking = Math.max(0, ducking + (down ? 1 : -1));
  if (context) musicBus.gain.setTargetAtTime(musicLevel(), context.currentTime, 0.25);
}
