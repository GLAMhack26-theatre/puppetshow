// Line icons for the outlook (slide 3), in the style of the hand icons on
// slide 2 (hand-demo.ts): cream lines, one gold accent. viewBox 0 0 100 100.

const ICONS = {
  // Two marionettes on one control cross
  together: {
    line: `<path d="M32 18 V36 M68 18 V36"/>
      <circle cx="32" cy="42" r="6"/><path d="M32 48 V68 M24 58 L32 52 L40 58 M32 68 L26 82 M32 68 L38 82"/>
      <circle cx="68" cy="42" r="6"/><path d="M68 48 V68 M60 58 L68 52 L76 58 M68 68 L62 82 M68 68 L74 82"/>`,
    accent: `<path d="M20 18 H80 M50 12 V24"/>`,
  },
  // VR headset
  vr: {
    line: `<path d="M20 38 H80 A8 8 0 0 1 88 46 V60 A8 8 0 0 1 80 68 H62 L56 60 H44 L38 68 H20 A8 8 0 0 1 12 60 V46 A8 8 0 0 1 20 38 Z"/>
      <path d="M20 38 C26 26 74 26 80 38"/>`,
    accent: `<circle cx="33" cy="52" r="6"/><circle cx="67" cy="52" r="6"/>`,
  },
  // Steps up to a star: getting better bit by bit
  tasks: {
    line: `<path d="M12 84 H32 V68 H50 V52 H68 V36 H88"/>`,
    accent: `<path d="M78 10 L81 17 L88 18 L83 23 L84 30 L78 27 L72 30 L73 23 L68 18 L75 17 Z"/>`,
  },
  // The stage with open curtains
  stories: {
    line: `<path d="M16 22 V84 M84 22 V84 M10 84 H90"/>
      <path d="M17 23 C30 40 34 62 40 84 M17 23 V84"/>
      <path d="M83 23 C70 40 66 62 60 84 M83 23 V84"/>`,
    accent: `<path d="M10 20 H90"/>`,
  },
  // A museum
  collection: {
    line: `<path d="M24 42 V74 M40 42 V74 M60 42 V74 M76 42 V74 M14 78 H86 M18 84 H82"/>`,
    accent: `<path d="M14 38 L50 16 L86 38 Z"/>`,
  },
} as const;

export function lineIcon(kind: keyof typeof ICONS) {
  const icon = ICONS[kind];
  return `<svg class="line-icon" viewBox="0 0 100 100" aria-hidden="true">
    <g class="line">${icon.line}</g><g class="accent">${icon.accent}</g>
  </svg>`;
}
