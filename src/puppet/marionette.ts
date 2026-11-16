import { Mesh, Vector3 } from "@iwsdk/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import marionetteUrl from "../../export/marionette.glb?url";
import rigData from "../../export/marionette_rig.json";
import { MAX_ROCK, type RockId, type StringId } from "../input/control-input";
import type { RigDescription, RigJoint } from "./rig";

// The SKKG marionette (docs/marionette-model.md): the skinned model from
// export/marionette.glb and its engine metadata from
// export/marionette_rig.json (colliders, masses, joints, strings). Real size:
// 0.35 m. Loaded straight from export/ until the converter exists.

/** Light parts get at least this fraction of the heaviest part's mass (head 61 g vs hand 0.8 g) */
const MASS_FLOOR = 0.05;
/**
 * Lead in the hands and feet, as real marionettes carry it, far beyond their
 * wooden weight (hands 0.8 g → 12 g, feet 14 g → 40 g): the weight at the end
 * of a limb is what keeps its string taut and lets it swing on like a weight
 * on a line (measured: an arm let go swings for 2.9 s instead of 1.6 s, the
 * elbow bends 6° instead of 8° while the hand bar rocks).
 *
 * Only the ratios count. Scaling every mass alike changes nothing (measured
 * at ×0.2 and ×5: peak speeds within 3 %; gravity, damping and joint friction
 * do not depend on mass). The parts between a weight and the body are raised
 * with it: a heavy hand on a 2.6 g forearm let the elbow bend 35° past its
 * limit when shaken (5° with them, as without any lead).
 *
 * kg, at least: [part, mass]
 */
const WEIGHTS: [RegExp, number][] = [
  [/^hand\./, 0.012],
  [/^(forearm|upper_arm)\./, 0.005],
  [/^foot\./, 0.04],
  [/^shin\./, 0.014],
  [/^thigh\./, 0.012],
];
const weight = (name: string) => WEIGHTS.find(([part]) => part.test(name))?.[1] ?? 0;
/**
 * Lead in the face: the head's centre of mass lies this far in front of its
 * middle, m (the head is 5 cm across). A marionette's head is weighted so that
 * it drops forward when its strings go slack (ControlInput.nod, or a lowered
 * cross). With the weight in the middle it balanced on the neck and fell to
 * whichever side the strings happened to lean: with the cross pitched 0.3 rad
 * a nod threw the head back by 0.6 rad as often as forward.
 */
const HEAD_LEAD = 0.005;
/**
 * Parts that are damped more than the rest (rig.ts: joint friction 10, air
 * drag 0.5 on moving and 1 on turning), 1/s. After a step of the cross the
 * puppet went on wobbling for seconds: waist and hips in many small swings
 * (3 to 6 s), the head nodding (up to 5 s, more since it carries lead in its
 * face), and the whole body swinging and twisting under the cross.
 *
 * Measured on five input steps (cross 10 cm sideways, in depth, there and
 * back, rolled 0.3 rad, a full leg rock), summed over eight signals (swing of
 * the pelvis under the cross, body twist, waist, head, hip): 136 s of settling
 * time and 308 swings as it was; 124 s / 272 with more joint friction alone;
 * 67 s / 157 with the drag below on top. So most of it is not the joints but
 * the body swinging on its strings, which bends the joints as it goes: joint
 * friction takes little out of that, drag on the body takes it out directly.
 * Body and head only: arms and legs stay as lively as they were (an arm let go
 * swings on as before). Unchanged by it: knee lift at a full leg rock (3.9 cm),
 * the nod (0.7 rad), the head turn, the hand lift.
 */
const STIFF: [RegExp, { friction?: number; linearDamping?: number; angularDamping?: number }][] = [
  [/^head$/, { friction: 30, linearDamping: 3 }],
  [/^chest$/, { friction: 40, linearDamping: 3, angularDamping: 8 }],
  [/^pelvis$/, { linearDamping: 3, angularDamping: 8 }],
  [/^thigh\./, { friction: 20 }],
];
const stiff = (name: string) => STIFF.find(([part]) => part.test(name))?.[1];
const LIMBS = /^(upper_arm|forearm|hand)\./;

type Vec = number[];
interface BoneData {
  parent?: string | null;
  head: Vec;
  mass_kg?: number;
  collider?: { radius: number; a: Vec; b: Vec };
  /** cone: swing / twist; hinge: axis, min, max (all in degrees); fixed: rigid on the parent */
  joint?: { type: string; axis?: "X" | "Y" | "Z"; min?: number; max?: number; swing?: number; twist?: number };
}

interface BarData {
  name: string;
  parent: string | null;
  pivot: Vec;
  axis: Vec | null;
  input: RockId | null;
  limit_deg?: number;
  detachable?: boolean;
  sticks: { a: Vec; b: Vec }[];
}

/** Blender (Z up, facing −Y) → glTF / three.js (Y up, facing +Z); also for directions */
const fromBlender = ([x, y, z]: Vec) => new Vector3(x, z, -y);
const AXES = { X: new Vector3(1, 0, 0), Y: new Vector3(0, 1, 0), Z: new Vector3(0, 0, 1) };
const rad = (deg: number) => (deg * Math.PI) / 180;

function joint(data: BoneData["joint"]): RigJoint | undefined {
  if (!data) return undefined;
  if (data.type === "fixed") return { type: "fixed" };
  if (data.type === "hinge" && data.axis) {
    return { type: "revolute", axis: AXES[data.axis].clone(), limits: [rad(data.min ?? 0), rad(data.max ?? 0)] };
  }
  // A cone without numbers is free all round
  return { type: "cone", swing: rad(data.swing ?? 180), twist: rad(data.twist ?? 180) };
}

/**
 * A new marionette: its own skeleton, sharing geometry, materials and
 * textures with every other one. The model (12.7 MB) is downloaded and parsed
 * once, also when several players each bring a puppet.
 */
export async function loadMarionette() {
  const model = await (template ??= loadTemplate());
  return { root: clone(model.root), description: model.description };
}

let template: ReturnType<typeof loadTemplate> | undefined;

async function loadTemplate() {
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
            mass: Math.max(b.mass_kg ?? 0, weight(name), MASS_FLOOR * heaviest),
            // Root-local: the puppet faces +z
            massOffset: name === "head" ? new Vector3(0, 0, HEAD_LEAD) : undefined,
            joint: joint(b.joint),
            ...stiff(name),
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
        limit: b.limit_deg === undefined ? MAX_ROCK : rad(b.limit_deg),
        // Rigs exported before the flag existed: the hand bar is the one that comes off
        detachable: b.detachable ?? b.input === "hands",
        sticks: b.sticks.map((s) => ({ a: fromBlender(s.a), b: fromBlender(s.b) })),
      })),
    },
  };
  return { root, description };
}
