// Connecting the hand to the puppet (camera control). While a hand is
// attached, the cross follows it. A hand hanging down in the low zone never
// connects; a hand that left the camera image is let go (the cross stays), so
// it, or the next player's, has to come back above the low zone.
//
// Letting go with a fist held for 3 s (and a countdown to take the hand away)
// was taken out again after the first play tests: a lowered hand now only
// lets the strings go slack (below the height at which the puppet stands,
// body-frame.ts), which is what lowering the hand does on a real cross, and
// the held fist got in the way of gripping.
//
// Pure logic on wall-clock time, fed once per frame (mediapipe.ts); no DOM
// and no MediaPipe in here.

/**
 * The low zone: a wrist below this height does not connect. Normalized image
 * height, 0 top … 1 bottom. The hand model sees no body, so "hand down at the
 * lower torso" is taken as the bottom of the camera image.
 */
export const LOW_ZONE = 0.75;
/** A waiting hand has to rise this far above the line: no flicker on the line itself */
const LOW_HYSTERESIS = 0.06;
/** Attached, but no hand seen for this long: it has left; short tracking losses keep the puppet */
const LOST_MS = 1000;

export interface HandSample {
  /** Wrist height in the camera image, 0 top … 1 bottom */
  wristY: number;
}

/**
 * - waiting: no hand connected; the cross stays where it is
 * - attached: the hand moves the cross
 */
export type HandPhase = "waiting" | "attached";

export interface HandReleaseState {
  phase: HandPhase;
}

export function createHandRelease() {
  const state: HandReleaseState = { phase: "waiting" };
  let low = false;
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
        if (now - lastSeenAt > LOST_MS) state.phase = "waiting";
      } else if (hand && !low) {
        state.phase = "attached";
      }
      return state;
    },
  };
}
