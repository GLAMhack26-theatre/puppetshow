import { playSfx, playZzfx, type Zzfx } from "./sfx";

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

// The magnet in the puppet's hand (ZzFX: volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide, pitchJump, pitchJumpTime)
// A short click that jumps up as the hand takes hold, and one that falls as it lets go
const TAKE: Zzfx = [0.5, 0.03, 520, 0, 0.01, 0.05, 1, 1.5, 0, 0, 260, 0.02];
const LET_GO: Zzfx = [0.4, 0.03, 460, 0, 0.01, 0.07, 1, 1.5, -12];

/** A puppet's hand takes hold of a prop. */
export function cueGrab(x?: number) {
  playZzfx(TAKE, { volume: 0.5, pan: pan(x) });
}

/** A prop comes off the puppet's hand. */
export function cueLetGo(x?: number) {
  playZzfx(LET_GO, { volume: 0.4, pan: pan(x) });
}
