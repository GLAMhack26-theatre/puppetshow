/**
 * "Der Froschkönig" → "der-froschkoenig": the file name for something named
 * in the UI (a play, a lighting scene); `fallback` if nothing usable is left.
 */
export function slug(name: string, fallback: string) {
  return (
    name
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || fallback
  );
}
