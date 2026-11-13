import { Quaternion, Vector3 } from "@iwsdk/core";

// The one input model every control source writes to (docs/architecture.md
// §3.1). A plain mutable object, written once per frame: no allocations and
// no ECS round trip on the hot path.

export type StringId = "head" | "handL" | "handR";
export type ControlSource = "mouse" | "mediapipe" | "phone" | "remote-phone" | "xr-3dof" | "xr-6dof";

export const controlInput = {
  bar: { position: new Vector3(0, 2.1, 0), rotation: new Quaternion() },
  pulls: { head: 0, handL: 0, handR: 0 } as Record<StringId, number>,
  grip: { left: false, right: false },
  source: "mouse" as ControlSource,
};
