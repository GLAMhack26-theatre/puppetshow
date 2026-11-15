// What a prop is made of (assets/catalogue.json "material"): one name stands
// for how heavy it is for its size, how it slides and bounces, how fast its
// rolling and spinning die down, how soft it looks on impact (props/squish.ts)
// and which samples it sounds with (audio/impacts.ts). The catalogue can
// override single values (bounce, friction, damping, squish). The look stays
// the model's own: the scanned .glb files carry their own PBR materials, often
// with baked texture maps, which a tag here would only fight.

/** Which sample groups (assets/sounds/sfx, scripts/unpack-sounds.sh) a material hits with. */
export interface MaterialSound {
  /** Set down, nudged, a light knock */
  hit: string;
  /** Thrown or knocked over hard */
  fall: string;
  /** Playback rate: above 1 lighter and higher, below 1 duller */
  rate: number;
  /** Times the volume of the wooden sounds */
  volume: number;
}

export interface Material {
  /**
   * kg/m³ of the model's bounding box, for props without a mass in the
   * catalogue. Much lower than the real material: the box is much bigger
   * than the object, and props must stay light against a 0.15 kg puppet.
   */
  density: number;
  /** Rapier friction coefficient (the floor has 0.5; the two are averaged) */
  friction: number;
  /** Restitution 0 … 1: how much of the speed is left after a bounce (the floor has none; the prop's counts) */
  bounce: number;
  /** 1/s: how fast spinning (and a ball's rolling) dies down. A ball never rolls with less than BALL_ROLL_DAMPING */
  angularDamping: number;
  /** 1/s: air drag; how fast moving dies down */
  linearDamping: number;
  /** 0 … 1: how far the model squashes on impact (visual only, props/squish.ts) */
  squish: number;
  sound: MaterialSound;
}

export type MaterialName = "wood" | "metal" | "stone" | "glass" | "ceramic" | "fabric";

/**
 * The presets. Wood is the default and keeps the behaviour props had before
 * materials existed (density 80, Rapier's default friction, no bounce, the
 * old wooden sounds), so props without a material do not change.
 */
export const MATERIALS: Record<MaterialName, Material> = {
  wood: {
    density: 80,
    friction: 0.5,
    bounce: 0,
    angularDamping: 0,
    linearDamping: 0,
    squish: 0,
    sound: { hit: "place", fall: "fall", rate: 1, volume: 1 },
  },
  metal: {
    density: 240,
    friction: 0.3,
    bounce: 0.2,
    angularDamping: 0,
    linearDamping: 0,
    squish: 0,
    sound: { hit: "metal-hit", fall: "metal-fall", rate: 1.2, volume: 0.6 },
  },
  stone: {
    density: 260,
    friction: 0.7,
    bounce: 0.05,
    angularDamping: 0.5,
    linearDamping: 0,
    squish: 0,
    sound: { hit: "stone-hit", fall: "stone-fall", rate: 1.3, volume: 0.8 },
  },
  glass: {
    density: 160,
    friction: 0.25,
    bounce: 0.15,
    angularDamping: 0,
    linearDamping: 0,
    squish: 0,
    sound: { hit: "glass-hit", fall: "glass-fall", rate: 1.2, volume: 0.6 },
  },
  ceramic: {
    density: 140,
    friction: 0.45,
    bounce: 0.1,
    angularDamping: 0,
    linearDamping: 0,
    squish: 0,
    // Duller than glass: its clink played lower, a fall like a light stone
    sound: { hit: "glass-hit", fall: "stone-fall", rate: 0.75, volume: 0.7 },
  },
  fabric: {
    density: 30,
    friction: 0.9,
    bounce: 0,
    angularDamping: 2,
    linearDamping: 0.5,
    squish: 0.5,
    sound: { hit: "soft", fall: "soft", rate: 1.1, volume: 0.8 },
  },
};

/** A ball rolls with at least this angular damping (1/s): Rapier has no rolling resistance (see requisits.ts). */
export const BALL_ROLL_DAMPING = 4;

/** The preset for a catalogue name; unknown or missing names are wood (with a warning for unknown ones). */
export function materialOf(name: string | undefined, id: string): Material {
  if (!name) return MATERIALS.wood;
  const key = name.trim().toLowerCase();
  if (key in MATERIALS) return MATERIALS[key as MaterialName];
  console.warn(`Requisit ${id}: unknown material "${name}" (assets/catalogue.json), using wood. Known: ${Object.keys(MATERIALS).join(", ")}`);
  return MATERIALS.wood;
}

/** A prop's material with the catalogue's overrides applied. */
export interface PropMaterial {
  density: number;
  friction: number;
  bounce: number;
  angularDamping: number;
  linearDamping: number;
  squish: number;
  sound: MaterialSound;
}

export function propMaterial(
  name: string | undefined,
  id: string,
  overrides: { bounce?: number; friction?: number; damping?: number; squish?: number } = {},
): PropMaterial {
  const m = materialOf(name, id);
  return {
    density: m.density,
    friction: overrides.friction ?? m.friction,
    bounce: overrides.bounce ?? m.bounce,
    angularDamping: overrides.damping ?? m.angularDamping,
    linearDamping: m.linearDamping,
    squish: overrides.squish ?? m.squish,
    sound: m.sound,
  };
}

/** The sound of each prop collider, by collider handle (registered while the prop stands on the stage). */
export const colliderSounds = new Map<number, MaterialSound>();
