import { Euler, Matrix4, Quaternion, Vector3 } from "@iwsdk/core";

// IIIF 3D manifests as props: the last card of the props slider takes a
// manifest (a dropped .json file, a dropped link, or a file picked by click)
// and the object lands on the stage like any other prop.
//
// Only what a prop needs is read: the label, the thumbnail, the homepage
// (the "i" on the card) and the first painted Model in the first Scene, with
// the transforms of its annotation body. Cameras and lights of the scene are
// ignored: the stage has its own. Works with Presentation 4 (3D) and with
// the 3.0 shapes it shares (language maps, `items`, `homepage`).

export interface IiifObject {
  /** The manifest's id, so the same object is not added twice. */
  id: string;
  label: string;
  thumbnail: string;
  /** Homepage of the object (catalogue record), for the card's "i". */
  homepage: string;
  /** URL of the .glb / .gltf. */
  model: string;
  /** Rotate/scale transforms of the painting annotation (translation is dropped: props are centred). */
  transform: Matrix4;
}

/** Reads a manifest from a drop: a .json file, or a link to one. */
export async function manifestFromDrop(data: DataTransfer): Promise<{ json: unknown; base: string }> {
  const file = [...data.files].find((f) => f.name.endsWith(".json") || f.type.includes("json")) ?? data.files[0];
  if (file) return { json: JSON.parse(await file.text()), base: location.href };
  const text = (data.getData("text/uri-list") || data.getData("text/plain")).split(/\s+/).find((t) => /^https?:/.test(t));
  if (!text) throw new Error("Kein IIIF-Manifest");
  return manifestFromUrl(text);
}

export async function manifestFromFile(file: File) {
  return { json: JSON.parse(await file.text()) as unknown, base: location.href };
}

/**
 * Fetches a manifest. IIIF drag-and-drop links usually point to a viewer
 * with the manifest in a `manifest` (or `iiif-content`) parameter.
 */
export async function manifestFromUrl(url: string) {
  const link = new URL(url);
  const target = link.searchParams.get("manifest") ?? link.searchParams.get("iiif-content") ?? url;
  const response = await fetch(target);
  if (!response.ok) throw new Error(`Manifest nicht erreichbar (${response.status})`);
  return { json: (await response.json()) as unknown, base: target };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function parseManifest(json: unknown, base: string): IiifObject {
  const manifest = json as Json;
  const type = manifest?.type ?? manifest?.["@type"];
  if (type !== "Manifest" && type !== "sc:Manifest") throw new Error("Kein IIIF-Manifest");
  const painting = findModel(manifest);
  if (!painting) throw new Error("Kein 3D-Modell im Manifest");
  const resolve = (url: string) => new URL(url, base).href;
  const thumbnail: string | undefined = first(manifest.thumbnail)?.id;
  return {
    id: String(manifest.id ?? manifest["@id"] ?? painting.model),
    // "Microscope, E. Leitz GmbH, 1908 (ETHZ GEOB 0055)" → "Microscope": the card has room for a word or two
    label: text(manifest.label).replace(/\s*\(.*\)\s*$/, "").split(",")[0].trim() || "IIIF-Objekt",
    thumbnail: thumbnail ? resolve(thumbnail) : "",
    homepage: first(manifest.homepage)?.id ?? "",
    model: resolve(painting.model),
    transform: painting.transform,
  };
}

/** The first annotation in any Scene (or Canvas) that paints a Model. */
function findModel(manifest: Json): { model: string; transform: Matrix4 } | null {
  for (const container of list(manifest.items)) {
    for (const page of list(container.items)) {
      for (const annotation of list(page.items)) {
        const body = first(annotation.body);
        if (!body) continue;
        const resource = body.type === "SpecificResource" ? first(body.source) : body;
        const isModel =
          resource?.type === "Model" || /gltf|glb/i.test(resource?.format ?? "") || /\.(glb|gltf)(\?|$)/i.test(resource?.id ?? "");
        if (resource?.id && isModel) return { model: resource.id, transform: transforms(list(body.transform)) };
      }
    }
  }
  return null;
}

/** Composes the transforms in their listed order (each applies after the ones before). */
function transforms(steps: Json[]) {
  const matrix = new Matrix4();
  const step = new Matrix4();
  const deg = Math.PI / 180;
  for (const t of steps) {
    const x = Number(t.x ?? 0);
    const y = Number(t.y ?? 0);
    const z = Number(t.z ?? 0);
    if (t.type === "RotateTransform") {
      step.makeRotationFromQuaternion(new Quaternion().setFromEuler(new Euler(x * deg, y * deg, z * deg, "XYZ")));
    } else if (t.type === "ScaleTransform") {
      step.makeScale(Number(t.x ?? 1), Number(t.y ?? 1), Number(t.z ?? 1));
    } else if (t.type === "TranslateTransform") {
      step.makeTranslation(new Vector3(x, y, z));
    } else continue;
    matrix.premultiply(step);
  }
  return matrix;
}

const list = (value: unknown): Json[] => (Array.isArray(value) ? value : value ? [value as Json] : []);
const first = (value: unknown): Json | undefined => list(value)[0];

/** A language map as one string: German first (the play is in German), then English, then anything. */
function text(map: unknown): string {
  if (typeof map === "string") return map;
  if (!map || typeof map !== "object") return "";
  const m = map as Record<string, string[]>;
  const values = m.de ?? m.en ?? m.none ?? Object.values(m)[0];
  return Array.isArray(values) ? values.join(" ") : String(values ?? "");
}
