import { playSfx } from "./sfx";

// Event cues: short samples for things the stage does on its own (the
// physics impacts are in impacts.ts). Silent while sound is off. `x` is the
// position across the stage in metres, for the stereo pan.

const PAN_WIDTH = 0.7;
const pan = (x = 0) => x / PAN_WIDTH;

/** A sign reaches its place in front of the curtain (before it overshoots and swings). */
export function cueSignLanded(index: number) {
  playSfx("knock", { volume: 0.35, rate: 1.2 + 0.1 * index, pan: (index - 1) * 0.4 });
}

/** A prop starts down on its string from the fly loft, or is lifted off: the rope creaks. */
export function cueRope(x?: number) {
  playSfx("creak", { volume: 0.35, pan: pan(x) });
}

/** A lowered prop touches the floor. */
export function cuePropLanded(x?: number) {
  playSfx("place", { volume: 0.5, pan: pan(x) });
}

/** A backdrop sheet is let down or drawn up. */
export function cueBackdrop() {
  playSfx("paper", { volume: 0.6, spread: 0.04 });
}
