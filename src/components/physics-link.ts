import { createComponent, Types } from "@iwsdk/core";

/** Links an entity's Object3D to a Rapier rigid body (by handle). */
export const PhysicsLink = createComponent("PhysicsLink", {
  body: { type: Types.Float64, default: -1 },
});
