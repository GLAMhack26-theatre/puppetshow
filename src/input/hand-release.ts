// Letting go of the puppet (camera control): while the hand is attached, the
// cross follows it, so lowering the hand would drag the puppet to the floor.
// A fist held for HOLD_SECONDS hangs the puppet up where it is. Then the
// player has GRACE_SECONDS to take the hand away (a countdown is shown);
// after that a hand connects again as soon as it is seen above the low zone.
// A hand hanging down in the low zone never connects. A hand that left the
// camera image is let go too (the cross stays), so it, or the next player's,
// has to come back above the low zone as well.
//
// Pure logic on wall-clock time, fed once per frame (mediapipe.ts); no DOM
// and no MediaPipe in here.

export const HOLD_SECONDS = 3;
export const GRACE_SECONDS = 5;
/**
 * The low zone: a wrist below this height does not connect. Normalized image
 * height, 0 top … 1 bottom. The hand model sees no body, so "hand down at the
 * lower torso" is taken as the bottom of the camera image.
 */
export const LOW_ZONE = 0.75;
/** A waiting hand has to rise this far above the line: no flicker on the line itself */
const LOW_HYSTERESIS = 0.06;
/** A fist lost for less than this (one bad frame, a short tracking dropout) still counts as held */
const DROPOUT_MS = 250;
/** Attached, but no hand seen for this long: it has left; short tracking losses keep the puppet */
const LOST_MS = 1000;

export interface HandSample {
  fist: boolean;
  /** Wrist height in the camera image, 0 top … 1 bottom */
  wristY: number;
}

/**
 * - waiting: no hand connected; the cross stays where it is
 * - attached: the hand moves the cross
 * - released: just let go; nothing connects until the countdown is over
 */
export type HandPhase = "waiting" | "attached" | "released";

export interface HandReleaseState {
  phase: HandPhase;
  /** attached: 0 … 1, how much of the fist hold is done (0: no fist) */
  hold: number;
  /** released: seconds left until a hand can connect again */
  countdown: number;
}

export function createHandRelease() {
  const state: HandReleaseState = { phase: "waiting", hold: 0, countdown: 0 };
  let low = false;
  // A new hold needs an open hand first: the fist that is still closed when
  // the hand connects again must not let go a second time
  let armed = false;
  let fistSince = -1;
  let lastFistAt = 0;
  let releasedAt = 0;
  let lastSeenAt = 0;

  return {
    state,
    /** @param hand the hand seen right now, null if none; @param now ms */
    update(hand: HandSample | null, now: number) {
      if (hand) {
        low = hand.wristY > (low ? LOW_ZONE - LOW_HYSTERESIS : LOW_ZONE);
        lastSeenAt = now;
      }

      if (state.phase === "attached") {
        if (hand && !hand.fist) armed = true;
        if (hand?.fist && armed) {
          if (fistSince < 0) fistSince = now;
          lastFistAt = now;
        } else if (fistSince >= 0 && now - lastFistAt > DROPOUT_MS) {
          fistSince = -1;
        }
        if (fistSince >= 0 && now - fistSince >= HOLD_SECONDS * 1000) {
          state.phase = "released";
          releasedAt = now;
          fistSince = -1;
        } else if (now - lastSeenAt > LOST_MS) {
          // No countdown: the hand is already away
          state.phase = "waiting";
          fistSince = -1;
        }
      } else if (state.phase === "released") {
        if (now - releasedAt >= GRACE_SECONDS * 1000) state.phase = "waiting";
      } else if (hand && !low) {
        state.phase = "attached";
        armed = !hand.fist;
        fistSince = -1;
      }

      state.hold = state.phase === "attached" && fistSince >= 0 ? Math.min(1, (now - fistSince) / (HOLD_SECONDS * 1000)) : 0;
      state.countdown = state.phase === "released" ? Math.max(0, GRACE_SECONDS - (now - releasedAt) / 1000) : 0;
      return state;
    },
  };
}
