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

export const controlInput = {
  // Set to the bar's rest position when the puppet is created (strings.ts)
  bar: { position: new Vector3(0, 0.62, 0), rotation: new Quaternion() },
  /** 0…1 per string: how far it is pulled up */
  pulls: Object.fromEntries(STRING_IDS.map((id) => [id, 0])) as Record<StringId, number>,
  grip: { left: false, right: false },
  source: "mouse" as ControlSource,
};
