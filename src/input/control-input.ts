import { Quaternion, Vector3 } from "@iwsdk/core";

// The one input model every control source writes to (docs/architecture.md
// §3.1). A plain mutable object, written once per frame: no allocations and
// no ECS round trip on the hot path.

/**
 * The marionette's 9 strings (export/marionette_rig.json, sockets string_<id>);
 * ".L" is the puppet's left (+x, facing the audience).
 */
export const STRING_IDS = [
  "head.L", "head.R", "shoulder.L", "shoulder.R", "back", "hand.L", "hand.R", "knee.L", "knee.R",
] as const;
export type StringId = (typeof STRING_IDS)[number];
export type ControlSource = "mouse" | "mediapipe" | "phone" | "remote-phone" | "xr-3dof" | "xr-6dof";
/** The cross's two rocking bars (export/marionette_rig.json, controller.bars[].input) */
export type RockId = "hands" | "legs";
/** Rocking range, rad: further would flip strings over the bar */
export const MAX_ROCK = 0.6;

export const controlInput = {
  // The main bar of the cross; set to its rest position when the puppet is created (strings.ts)
  bar: { position: new Vector3(0, 0.62, 0), rotation: new Quaternion() },
  /**
   * Rocking angle of the hand bar and the leg bar, rad (±MAX_ROCK), about the
   * main bar's long axis; + lifts the puppet's left (.L) string. Rocking the
   * leg bar walks, rocking the hand bar lifts one hand and lowers the other.
   */
  rock: { hands: 0, legs: 0 } as Record<RockId, number>,
  /** 0…1 per string: how far it is pulled up, on top of the cross (plucking a single string) */
  pulls: Object.fromEntries(STRING_IDS.map((id) => [id, 0])) as Record<StringId, number>,
  grip: { left: false, right: false },
  source: "mouse" as ControlSource,
};
