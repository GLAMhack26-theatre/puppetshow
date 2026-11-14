// The audio graph and the global on/off state. Sound is off at every page
// load (never remembered): nothing plays until the speaker button is clicked.
// That click creates and resumes the AudioContext, the user gesture iOS
// needs. master → destination; ambient and effects buses → master.

let context: AudioContext | null = null;
let master: GainNode;
let ambientBus: GainNode;
let effectsBus: GainNode;
let on = false;
const listeners: ((on: boolean) => void)[] = [];

/** Below the effects: background music must not cover the play */
const AMBIENT_LEVEL = 0.5;
const FADE_S = 0.3;

/** Created on the first turn-on; null before. */
export function audio() {
  return context && { context, ambientBus, effectsBus };
}

export function isSoundOn() {
  return on;
}

/** Must run inside a user gesture the first time (click, key). */
export function setSoundOn(value: boolean) {
  if (!context) {
    context = new AudioContext();
    master = new GainNode(context, { gain: 0 });
    ambientBus = new GainNode(context, { gain: AMBIENT_LEVEL });
    effectsBus = new GainNode(context, { gain: 1 });
    ambientBus.connect(master);
    effectsBus.connect(master);
    master.connect(context.destination);
  }
  on = value;
  if (on) void context.resume();
  // A short fade instead of a click
  master.gain.setTargetAtTime(on ? 1 : 0, context.currentTime, FADE_S / 3);
  for (const fn of listeners) fn(on);
}

export function onSoundChange(fn: (on: boolean) => void) {
  listeners.push(fn);
}

/** While an excerpt plays, the background music steps back */
const DUCKED = 0.3;
let ducking = 0;

/** Counted: duck(true) and duck(false) come in pairs, one per playing excerpt. */
export function duck(down: boolean) {
  ducking = Math.max(0, ducking + (down ? 1 : -1));
  if (!context) return;
  const level = ducking ? AMBIENT_LEVEL * DUCKED : AMBIENT_LEVEL;
  ambientBus.gain.setTargetAtTime(level, context.currentTime, 0.25);
}
