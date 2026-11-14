import karussellUrl from "../../assets/presentation/karussell.m4a?url";

// The carousel music of slide 4 (taken from Karussell.mp4, 10 s), looped
// while that slide is shown and faded out when it is left or the
// presentation closes. Independent of the app's music and effects buttons:
// the presentation is a pitch, its sound belongs to it. Slides are changed
// by key or click, so the AudioContext may start (a user gesture).
// Played as a looping buffer, not an <audio loop>, which leaves a gap.

/** The recording is quiet (peak −15.6 dB) */
const LEVEL = 1.8;
const FADE_IN_S = 0.6;
const FADE_OUT_S = 0.5;

let context: AudioContext | null = null;
let gain: GainNode;
let buffer: Promise<AudioBuffer | null> | null = null;
let source: AudioBufferSourceNode | null = null;
let wanted = false;

function graph() {
  if (!context) {
    context = new AudioContext();
    gain = new GainNode(context, { gain: 0 });
    gain.connect(context.destination);
    buffer = fetch(karussellUrl)
      .then((r) => r.arrayBuffer())
      .then((data) => context!.decodeAudioData(data))
      .catch((e) => {
        console.warn("Presentation: carousel music failed to load", e);
        return null;
      });
  }
  return context;
}

/** Starts the loop (once it is decoded, if the slide is still shown then). */
export function playSlideMusic() {
  wanted = true;
  const ctx = graph();
  void ctx.resume();
  void buffer!.then((decoded) => {
    if (!decoded || !wanted || source) return;
    source = new AudioBufferSourceNode(ctx, { buffer: decoded, loop: true });
    source.connect(gain);
    source.start();
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(LEVEL, ctx.currentTime + FADE_IN_S);
  });
}

export function stopSlideMusic() {
  wanted = false;
  if (!context || !source) return;
  const playing = source;
  source = null;
  const now = context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(0, now + FADE_OUT_S);
  playing.stop(now + FADE_OUT_S);
}
