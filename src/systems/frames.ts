import { createSystem } from "@iwsdk/core";

// The world's own loop as the clock for everything that waits on the stage:
// a scene change (the puppet fading, the cross travelling, props settling),
// the curtain coming down. The page's requestAnimationFrame stops while a
// WebXR session runs on a headset, and its timers may be throttled like a
// background tab's; the world's loop is the session's loop then. A wait on
// this clock goes on in a session, one on the page's would hang until the
// session ends.

const waiting: Array<(now: number) => void> = [];

/** Like requestAnimationFrame (`now` in ms), on the world's loop. */
export function nextFrame(callback: (now: number) => void) {
  waiting.push(callback);
}

/** Resolves once `done()` holds; checked at once and then every frame. */
export function until(done: () => boolean) {
  return new Promise<void>((resolve) => {
    const check = () => (done() ? resolve() : nextFrame(check));
    check();
  });
}

/** Resolves after `s` seconds, counted on the world's loop. */
export function seconds(s: number) {
  const end = performance.now() + s * 1000;
  return until(() => performance.now() >= end);
}

export class FrameSystem extends createSystem({}) {
  update() {
    if (waiting.length === 0) return;
    const now = performance.now();
    // What a callback asks for now runs next frame
    for (const callback of waiting.splice(0)) callback(now);
  }
}
