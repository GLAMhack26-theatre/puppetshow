import { Box3, type Material, MathUtils, Mesh, type Object3D, Vector3, createSystem, type World } from "@iwsdk/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { catalogueEntry } from "../catalogue";
import { stageBounds } from "./stage";
import { cueBackdrop } from "../audio/cues";

// Painted backdrops ("Hintergrund"-Aufsteller) for the impro mode: every
// assets/stage_parts/Background_*.glb (Unity export: one 1×1 alpha quad)
// is offered. The chosen one stands still at the back edge of the stage
// floor, scaled to the floor's width; there is only ever one. Backdrops stay
// unlit (as exported), so the painted colours are not changed by the lights.
// A new file in that folder shows up in the list without code changes.
//
// Reveal: like a backdrop let down from the fly loft, the sheet sinks into
// place while it is uncovered from the top down behind a ragged, torn-paper
// edge with a warm rim. Hiding runs it backwards (rolled up and out).
// Switching crossfades: the old one goes up while the new one comes down.

const FILES = import.meta.glob("../../assets/stage_parts/Background_*.glb", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Display names and SKKG sources: assets/catalogue.json ("backdrops");
// files not listed there show their file name.

/** Just in front of the back edge, so the floor does not cut the bottom of the quad. */
const BACK_INSET = 0.005;
/** The outgoing backdrop moves this far back, so the two never z-fight while crossfading. */
const OUTGOING_STEP = 0.004;
const REVEAL_SECONDS = 1.1;
const HIDE_SECONDS = 0.8;
/** How far the sheet sinks while it is revealed, in metres. */
const DROP = 0.06;
/** Height of the ragged band, in uv (share of the sheet height). */
const EDGE = 0.12;

export interface Backdrop {
  id: string;
  label: string;
  /** Link to the SKKG collection, "ai" for an invented one (assets/catalogue.json). */
  source: string;
  /** Object URL of the painted sheet (the texture inside the .glb), for the picker. */
  thumbnail: string;
  object: Object3D;
  /** 0 hidden … 1 fully shown, animated by BackdropSystem towards `target`. */
  reveal: { value: number };
  target: number;
  /** Rest position on the stage (set by setBackdrop). */
  rest: Vector3;
}

let catalogue: Promise<Backdrop[]> | null = null;
let current: Backdrop | null = null;

/** Loads all backdrops once (on first use, not at app start). */
export function loadBackdrops(): Promise<Backdrop[]> {
  catalogue ??= Promise.all(
    Object.entries(FILES)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, url]) => loadBackdrop(path, url)),
  );
  return catalogue;
}

async function loadBackdrop(path: string, url: string): Promise<Backdrop> {
  const id = path.match(/Background_(.+)\.glb$/)![1];
  // One download for both: the picker image is cut out of the .glb's
  // binary chunk, the mesh is parsed from the same buffer
  const buffer = await (await fetch(url)).arrayBuffer();
  const gltf = await new GLTFLoader().parseAsync(buffer, "");
  const object = gltf.scene;
  const reveal = { value: 0 };
  object.traverse((o) => {
    if (o instanceof Mesh) addReveal(o.material as Material, reveal);
  });
  return {
    id,
    label: catalogueEntry("backdrops", id).label ?? id.replaceAll("_", " "),
    source: catalogueEntry("backdrops", id).source ?? "",
    thumbnail: embeddedImage(buffer),
    object,
    reveal,
    target: 0,
    rest: new Vector3(),
  };
}

// Cuts the sheet off below a ragged line that runs from the top (reveal 0)
// past the bottom (reveal 1). Two octaves of value noise along x make the
// torn edge; just above the cut the paper gets a warm, slightly bright rim.
function addReveal(material: Material, reveal: { value: number }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uReveal = reveal;
    shader.fragmentShader = `uniform float uReveal;
float revealHash(float n) { return fract(sin(n) * 43758.5453); }
float revealNoise(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(revealHash(i), revealHash(i + 1.0), f * f * (3.0 - 2.0 * f));
}
${shader.fragmentShader}`.replace(
      "#include <map_fragment>",
      /* glsl */ `
      #include <map_fragment>
      // glTF uv: v = 0 is the top of the sheet
      float ragged = 0.65 * revealNoise(vMapUv.x * 9.0) + 0.35 * revealNoise(vMapUv.x * 31.0 + 7.0);
      float line = uReveal * (1.0 + ${EDGE.toFixed(3)}) - ragged * ${EDGE.toFixed(3)};
      float below = vMapUv.y - line; // > 0: still hidden
      if (below > 0.0) discard;
      float rim = smoothstep(-0.025, 0.0, below);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.25, 1.1, 0.85) + vec3(0.06, 0.04, 0.0), rim);
      `,
    );
  };
  material.needsUpdate = true;
}

/** The first image of a .glb as an object URL. */
function embeddedImage(glb: ArrayBuffer) {
  const view = new DataView(glb);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
  const binStart = 20 + jsonLength + 8; // skip the BIN chunk header
  const image = json.images[0];
  const bufferView = json.bufferViews[image.bufferView];
  const bytes = new Uint8Array(glb, binStart + (bufferView.byteOffset ?? 0), bufferView.byteLength);
  return URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
}

const shown = new Set<Backdrop>();

/**
 * Reveals the backdrop at the back of the stage; the previous one is hidden
 * at the same time. null hides the current one.
 */
export function setBackdrop(world: World, backdrop: Backdrop | null) {
  if (current === backdrop) return;
  cueBackdrop(); // one rustle for the sheet coming down or going up
  if (current) {
    current.target = 0;
    current.rest.z -= OUTGOING_STEP;
  }
  current = backdrop;
  if (!backdrop) return;

  const object = backdrop.object;
  // The quads face −z in the file (like Stage_Front): turn to the camera.
  // Then scale it uniformly to the width of the floor (Ground_Box).
  object.rotation.set(0, Math.PI, 0);
  object.scale.setScalar(1);
  object.position.set(0, 0, 0);
  object.updateMatrixWorld(true);
  const box = new Box3().setFromObject(object);
  object.scale.setScalar(stageBounds.width / box.getSize(new Vector3()).x);
  object.updateMatrixWorld(true);
  box.setFromObject(object);
  const center = box.getCenter(new Vector3());
  // Bottom edge on the floor (y = 0), centred, at the back edge
  backdrop.rest.set(stageBounds.centerX - center.x, -box.min.y, stageBounds.backZ + BACK_INSET - center.z);
  backdrop.target = 1;
  if (!object.parent) world.scene.add(object);
  shown.add(backdrop);
  place(backdrop);
}

function place(backdrop: Backdrop) {
  const t = backdrop.reveal.value;
  // Sinks in with a soft landing; goes up again on the way out
  const eased = 1 - (1 - t) ** 3;
  backdrop.object.position.copy(backdrop.rest).setY(backdrop.rest.y + DROP * (1 - eased));
}

export class BackdropSystem extends createSystem({}) {
  update(delta: number) {
    for (const backdrop of shown) {
      const reveal = backdrop.reveal;
      const speed = backdrop.target > reveal.value ? 1 / REVEAL_SECONDS : 1 / HIDE_SECONDS;
      reveal.value = MathUtils.clamp(
        reveal.value + Math.sign(backdrop.target - reveal.value) * speed * delta,
        Math.min(reveal.value, backdrop.target),
        Math.max(reveal.value, backdrop.target),
      );
      place(backdrop);
      if (reveal.value === 0 && backdrop.target === 0) {
        backdrop.object.removeFromParent();
        shown.delete(backdrop);
      }
    }
  }
}

export function currentBackdrop() {
  return current;
}
