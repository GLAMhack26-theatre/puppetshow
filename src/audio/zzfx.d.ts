// ZzFX (MIT, github.com/KilledByAPixel/ZzFX) ships no types; only what sfx.ts uses.
declare module "zzfx" {
  export const ZZFX: {
    sampleRate: number;
    /** volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, … */
    buildSamples(...parameters: number[]): number[];
  };
}
