import data from "../assets/catalogue.json";

// Hand-edited settings for the impro props and backdrops
// (assets/catalogue.json): card label, scale (props only) and the source
// in the SKKG collection, shown behind the round "i" on each card. Vite
// reloads the page when the file is saved.

export interface CatalogueEntry {
  label?: string;
  /** 1 = original size. */
  scale?: number;
  /** Link to the SKKG collection, "ai" for an invented object, "" for not known yet. */
  source?: string;
}

const sections = data as unknown as Record<"requisits" | "backdrops", Record<string, CatalogueEntry>>;

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
