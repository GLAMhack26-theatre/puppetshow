import { Mesh, Vector3 } from "@iwsdk/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import marionetteUrl from "../../export/marionette.glb?url";
import rigData from "../../export/marionette_rig.json";
import type { RockId, StringId } from "../input/control-input";
import type { RigDescription, RigJoint } from "./rig";

// The SKKG marionette (README, "Marionette model"): the skinned model from
// export/marionette.glb and its engine metadata from
// export/marionette_rig.json (colliders, masses, joints, strings). Real size:
// 0.35 m. Loaded straight from export/ until the converter exists.

/** Light parts get at least this fraction of the heaviest part's mass (head 61 g vs hand 0.8 g) */
const MASS_FLOOR = 0.05;
const LIMBS = /^(upper_arm|forearm|hand)\./;

type Vec = number[];
interface BoneData {
  parent?: string | null;
  head: Vec;
  mass_kg?: number;
  collider?: { radius: number; a: Vec; b: Vec };
  joint?: { type: string; axis?: "X" | "Y" | "Z"; min?: number; max?: number };
}

interface BarData {
  name: string;
  parent: string | null;
  pivot: Vec;
  axis: Vec | null;
  input: RockId | null;
  sticks: { a: Vec; b: Vec }[];
}

/** Blender (Z up, facing −Y) → glTF / three.js (Y up, facing +Z); also for directions */
const fromBlender = ([x, y, z]: Vec) => new Vector3(x, z, -y);
const AXES = { X: new Vector3(1, 0, 0), Y: new Vector3(0, 1, 0), Z: new Vector3(0, 0, 1) };
const rad = (deg: number) => (deg * Math.PI) / 180;

function joint(data: BoneData["joint"]): RigJoint | undefined {
  if (!data) return undefined;
  if (data.type === "hinge" && data.axis) {
    return { type: "revolute", axis: AXES[data.axis].clone(), limits: [rad(data.min ?? 0), rad(data.max ?? 0)] };
  }
  // Cone (swing/twist) limits don't exist for Rapier's spherical joint in JS;
  // the rig damps them instead
  return { type: "spherical" };
}

export async function loadMarionette() {
  const root = (await new GLTFLoader().loadAsync(marionetteUrl)).scene;
  root.traverse((o) => {
    // Dress_Sim is the welded mesh for a later cloth simulation; the skinned Dress is shown
    if (o.name === "Dress_Sim") o.visible = false;
    if (o instanceof Mesh) {
      o.castShadow = true;
      o.frustumCulled = false; // skinned: the bind-pose bounds don't follow the puppet
      // The dress's COLOR_0 holds cloth pin weights (R = pinned, G = free),
      // not colours: GLTFLoader would tint the satin red and green. The data
      // stays on the geometry for a later cloth simulation.
      for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
        if (material.vertexColors) {
          material.vertexColors = false;
          material.needsUpdate = true;
        }
      }
    }
  });

  const entries = Object.entries(rigData.bones as Record<string, BoneData>);
  const heaviest = Math.max(...entries.map(([, b]) => b.mass_kg ?? 0));
  const description: RigDescription = {
    bones: entries.flatMap(([name, b]) =>
      b.collider
        ? [{
            name,
            parent: b.parent ?? undefined,
            head: fromBlender(b.head),
            a: fromBlender(b.collider.a),
            b: fromBlender(b.collider.b),
            radius: b.collider.radius,
            mass: Math.max(b.mass_kg ?? 0, MASS_FLOOR * heaviest),
            joint: joint(b.joint),
            group: LIMBS.test(name) ? ("limb" as const) : ("body" as const),
          }]
        : [],
    ),
    strings: rigData.strings.map((s) => ({
      id: s.socket.replace(/^string_/, "") as StringId,
      bone: s.bone,
      position: fromBlender(s.position),
      bar: s.controller,
      barPoint: fromBlender(s.controller_point),
      restLength: s.rest_length,
    })),
    // The real SKKG cross: main bar (shoulder crossbar and head bar fixed on it),
    // rocking leg bar and hand bar
    controller: {
      stickSize: rigData.controller.stick_size_m,
      bars: (rigData.controller.bars as BarData[]).map((b) => ({
        name: b.name,
        parent: b.parent ?? undefined,
        pivot: fromBlender(b.pivot),
        axis: b.axis ? fromBlender(b.axis).normalize() : undefined,
        input: b.input ?? undefined,
        sticks: b.sticks.map((s) => ({ a: fromBlender(s.a), b: fromBlender(s.b) })),
      })),
    },
  };
  return { root, description };
}
