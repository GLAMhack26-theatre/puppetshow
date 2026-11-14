import { audio, isOn, onChannelChange } from "./audio";

// Short sound effects: CC0 samples unpacked by scripts/unpack-sounds.sh into
// assets/sounds/sfx/ (git-ignored; without them only ZzFX plays), grouped by
// the name before the number (wood-1.ogg, wood-2.ogg → "wood"). A random
// variant per play, with a little pitch spread, so repeats differ. Small
// synthetic sounds come from ZzFX, rendered into our own graph. ZzFX creates
// an AudioContext of its own when its module loads, which we never use, so
// the module is only imported on first use, after effects were turned on.

const files = import.meta.glob("../../assets/sounds/sfx/*.ogg", { query: "?url", import: "default", eager: true }) as Record<
  string,
  string
>;

const groups = new Map<string, string[]>();
for (const [path, url] of Object.entries(files)) {
  const name = path.split("/").pop()!.replace(/-\d+\.ogg$/, "");
  groups.set(name, [...(groups.get(name) ?? []), url]);
}

const buffers = new Map<string, AudioBuffer[]>();
let loading: Promise<void> | null = null;

/** Decodes all samples once effects are on. A file the browser cannot decode (Ogg Vorbis on older Safari) is left out. */
function load() {
  const graph = audio();
  if (loading || !graph) return;
  loading = Promise.all(
    [...groups].map(async ([name, urls]) => {
      const decoded = await Promise.all(
        urls.map((url) =>
          fetch(url)
            .then((r) => r.arrayBuffer())
            .then((data) => graph.context.decodeAudioData(data))
            .catch(() => null),
        ),
      );
      buffers.set(name, decoded.filter((b): b is AudioBuffer => !!b));
    }),
  ).then(() => {});
}

export interface SfxOptions {
  /** 0…1 */
  volume?: number;
  /** Playback rate; 1 = original pitch. A random ±spread is added. */
  rate?: number;
  spread?: number;
  /** −1 left … 1 right */
  pan?: number;
}

/** Plays a random variant of a sample group; `fallback` (ZzFX) if the group has no decoded samples. */
export function playSfx(group: string, options: SfxOptions = {}, fallback?: Zzfx) {
  const graph = audio();
  if (!graph || !isOn("effects")) return;
  const variants = buffers.get(group);
  if (!variants?.length) {
    if (fallback) playZzfx(fallback, options);
    return;
  }
  const buffer = variants[Math.floor(Math.random() * variants.length)];
  const { rate = 1, spread = 0.08 } = options;
  start(buffer, options, rate * (1 + (Math.random() * 2 - 1) * spread));
}

function start(buffer: AudioBuffer, { volume = 1, pan = 0 }: SfxOptions, rate: number) {
  const { context, effectsBus } = audio()!;
  const source = new AudioBufferSourceNode(context, { buffer, playbackRate: rate });
  const gain = new GainNode(context, { gain: volume });
  const panner = new StereoPannerNode(context, { pan: Math.max(-1, Math.min(1, pan)) });
  source.connect(gain).connect(panner).connect(effectsBus);
  source.start();
}

/** ZzFX parameters (volume, randomness, frequency, attack, sustain, release, shape, …), see zzfx.ts. */
export type Zzfx = number[];

let zzfxModule: Promise<typeof import("zzfx")> | null = null;
const zzfxCache = new Map<Zzfx, AudioBuffer>();

/** Renders a ZzFX sound into a buffer once and plays it through the effects bus. */
export function playZzfx(params: Zzfx, options: SfxOptions = {}) {
  const graph = audio();
  if (!graph || !isOn("effects")) return;
  const cached = zzfxCache.get(params);
  if (cached) return start(cached, options, options.rate ?? 1);
  zzfxModule ??= import("zzfx");
  void zzfxModule.then(({ ZZFX }) => {
    const samples = ZZFX.buildSamples(...params);
    const buffer = graph.context.createBuffer(1, samples.length, ZZFX.sampleRate);
    buffer.getChannelData(0).set(samples);
    zzfxCache.set(params, buffer);
    start(buffer, options, options.rate ?? 1);
  });
}

export function setupSfx() {
  onChannelChange((channel, on) => channel === "effects" && on && load());
}
