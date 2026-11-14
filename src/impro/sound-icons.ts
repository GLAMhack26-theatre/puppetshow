// Card pictures for the Sound page: line drawings in ink on the paper card,
// one gold accent, as SVG data URLs (the slider cards take an image URL).
// viewBox 0 0 100 100.

const ICONS: Record<string, { line: string; accent: string }> = {
  // Drum with two sticks
  drum: {
    line: `<ellipse cx="50" cy="48" rx="28" ry="9"/><path d="M22 48 V72 C22 80 78 80 78 72 V48 M30 56 L38 76 M50 57 V79 M70 56 L62 76"/>`,
    accent: `<path d="M30 14 L48 40 M70 14 L52 40"/>`,
  },
  // Speaking head with sound lines
  voice: {
    line: `<path d="M30 84 V70 C18 64 16 50 20 40 C26 22 52 18 62 32 L68 46 L62 48 L64 58 C64 64 58 66 52 66 V84"/>`,
    accent: `<path d="M76 34 A14 14 0 0 1 76 58 M84 26 A26 26 0 0 1 84 66"/>`,
  },
  // Three small heads
  voices: {
    line: `<circle cx="28" cy="46" r="9"/><circle cx="50" cy="40" r="9"/><circle cx="72" cy="46" r="9"/>
      <path d="M14 82 C14 64 42 64 42 82 M36 76 C36 56 64 56 64 76 M58 82 C58 64 86 64 86 82"/>`,
    accent: `<path d="M44 18 L40 24 M50 14 V22 M56 18 L60 24"/>`,
  },
  // Harp: neck, pillar and sound box, strings in gold
  harp: {
    line: `<path d="M28 86 V20 C46 14 58 30 80 40 L34 86 Z"/>`,
    accent: `<path d="M38 22 V76 M48 24 V66 M58 30 V56 M68 36 V46"/>`,
  },
  // Two beamed notes
  notes: {
    line: `<ellipse cx="34" cy="74" rx="10" ry="7"/><ellipse cx="70" cy="66" rx="10" ry="7"/><path d="M44 74 V28 M80 66 V20"/>`,
    accent: `<path d="M44 28 L80 20 M44 38 L80 30"/>`,
  },
  // Xylophone bars on two rails, one mallet
  xylophone: {
    line: `<path d="M14 54 L86 46 M14 76 L86 70 M22 46 V82 M36 46 V80 M50 44 V78 M64 42 V76 M78 40 V74"/>`,
    accent: `<path d="M58 32 L84 12"/><circle cx="56" cy="34" r="4"/>`,
  },
};

export function soundIcon(kind: string) {
  const icon = ICONS[kind] ?? ICONS.notes;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
    <g stroke="#3b2f1e">${icon.line}</g><g stroke="#b8862f">${icon.accent}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
