import data from "../assets/catalogue.json";

// Hand-edited settings for the impro props and backdrops
// (assets/catalogue.json): card label, scale, mass and shape (props only) and the source
// in the SKKG collection, shown behind the round "i" on each card. Vite
// reloads the page when the file is saved.

export interface CatalogueEntry {
  label?: string;
  /** 1 = original size. */
  scale?: number;
  /** kg, as shown (after scale). Without it the mass is estimated from the size. */
  mass?: number;
  /** "ball" rolls like a ball; anything else is a box. */
  shape?: string;
  /** wood (default), metal, stone, glass, ceramic, fabric: physics and sound (src/props/materials.ts) */
  material?: string;
  /** Overrides of the material: restitution 0…1, friction, angular damping (1/s), visual squash 0…1 */
  bounce?: number;
  friction?: number;
  damping?: number;
  squish?: number;
  /** Link to the SKKG collection, "ai" for an invented object, "" for not known yet. */
  source?: string;
}

const sections = data as unknown as Record<"requisits" | "backdrops", Record<string, CatalogueEntry>>;

export type PropShape = "box" | "ball";

/** The collider shape; unknown values are a box. */
export function propShape(shape: string | undefined): PropShape {
  return shape?.trim().toLowerCase() === "ball" ? "ball" : "box";
}

/** A usable mass in kg, or undefined (estimate from the size) for a missing or invalid value. */
export function propMass(mass: unknown): number | undefined {
  return typeof mass === "number" && Number.isFinite(mass) && mass > 0 ? mass : undefined;
}

/** A number within [min, max], or undefined (keep the material's value) for a missing or invalid one. */
export function propNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined;
}

export function catalogueEntry(kind: "requisits" | "backdrops", id: string): CatalogueEntry {
  return sections[kind]?.[id] ?? {};
}

/** What the "i" does: open a link, reveal an invented object, or nothing (no button). */
export function sourceKind(source: string | undefined): "link" | "fake" | null {
  if (!source) return null;
  return source.trim().toLowerCase() === "ai" ? "fake" : "link";
}

/** "1 : 5" for 0.2, "2 : 1" for 2; empty at original size. */
export function scaleCaption(scale: number) {
  if (Math.abs(scale - 1) < 0.005) return "";
  const round = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");
  return scale < 1 ? `Massstab 1 : ${round(1 / scale)}` : `Massstab ${round(scale)} : 1`;
}
