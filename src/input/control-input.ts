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
/** The cross's rocking bars (export/marionette_rig.json, controller.bars[].input) */
export type RockId = "hands" | "legs" | "head";
/** Default rocking range, rad (a bar's own limit_deg in the rig JSON overrides it): further would flip strings over the bar */
export const MAX_ROCK = 0.6;

/** m: how much longer than in the rig the strings are unless set otherwise (ControlInput.stringExtra) */
export const DEFAULT_STRING_EXTRA = 0.15;

export const createControlInput = () => ({
  // The main bar of the cross; set to its rest position when the puppet is created (strings.ts)
  // Rig coordinates: the cross at the height it was modelled at. The engine lifts
  // it by stringExtra on top, so no source has to know how long the strings are
  bar: { position: new Vector3(0, 0.62, 0), rotation: new Quaternion() },
  /**
   * m: every string is this much longer than in the rig, and the whole cross
   * hangs that much higher above the puppet. The puppet stands the same at any
   * value (cross and strings change together): it sets how far above the
   * puppet the cross is, not whether the feet reach the floor.
   */
  stringExtra: DEFAULT_STRING_EXTRA,
  /**
   * Rocking angle of the hand bar, the leg bar and the head bar, rad (clamped
   * to each bar's limit), about the main bar's long axis; + lifts the puppet's
   * left (.L) string. Rocking the leg bar walks, rocking the hand bar lifts one
   * hand and lowers the other, rocking the head bar tilts the head.
   */
  rock: { hands: 0, legs: 0, head: 0 } as Record<RockId, number>,
  /**
   * The hand bar sits on the front tip of the main bar like on a magnet and
   * can be taken off. While `detached`, the source writes its world pose here
   * and the bar leaves the cross (its strings stay on it, so the puppet's
   * hands follow); otherwise the engine keeps the pose at where the bar sits
   * (strings.ts), so that a source taking it off starts from there. When it
   * is let go, the engine eases it back onto the magnet.
   */
  handBar: { detached: false, position: new Vector3(), rotation: new Quaternion() },
  /**
   * A string caught by the other hand or arm moving against it: the string then
   * runs eye → hook → socket, which shortens what is left below the hook and
   * drags the socket towards it. `id` null: nothing caught. `along` (0…1) is
   * where on the straight string the hook sits, from the eye (0) to the socket
   * (1); `offset` is how far it has been pushed off that line, world metres.
   * The engine eases the hook in and out, so a source may just drop `id`.
   */
  hook: { id: null as StringId | null, along: 0.5, offset: new Vector3() },
  /** 0…1 per string: how far it is pulled up, on top of the cross (plucking a single string) */
  pulls: Object.fromEntries(STRING_IDS.map((id) => [id, 0])) as Record<StringId, number>,
  grip: { left: false, right: false },
  source: "mouse" as ControlSource,
});
export type ControlInput = ReturnType<typeof createControlInput>;

/**
 * The local player's input: what mouse, keys and hand tracking write to. With
 * several players (src/net/), every other puppet has its own ControlInput,
 * filled from the network.
 */
export const controlInput = createControlInput();
