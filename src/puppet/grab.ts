import RAPIER from "@dimforge/rapier3d-compat";
import { AdditiveBlending, CanvasTexture, Quaternion, Sprite, SpriteMaterial, Vector3, type World } from "@iwsdk/core";
import { cueGrab, cueLetGo } from "../audio/cues";
import { catalogueEntry } from "../catalogue";
import { controlInput, puppetState } from "../input/control-input";
import { GROUP, STEP, physics, renderPose, toQuat, toVec, worldPoint } from "../systems/rapier-system";
import type { Rig } from "./rig";
import type { createStrings } from "./strings";

// The puppet's hands hold props like magnets (docs/architecture.md §3.2, 4).
// While a hand's magnet is on (ControlInput.grip, a level), it takes the
// nearest prop within reach: a fixed joint at the hand's tip, eased from where
// the prop is to a pose in which it hangs upright below the hand. The magnet
// going off does not let go. The prop comes off
//  - when the player says so (ControlInput.release, a counter),
//  - when it is thrown: the hand is whipped by its string and the prop flies on
//    (GRAB.flingSpeed),
//  - when the joint has come apart or the prop is faster than anything on the
//    stage should be (a fuse), or
//  - when something else takes the prop: a scene change, the visitor's mouse.
//
// A held prop is light and meets the stage only: at its real weight on a 12 g
// hand at the end of a string it would be the prop that plays the puppet, and
// colliding with the puppet's own body it would push what it hangs on.

/**
 * Everything that shapes the feel. An object (not constants) so that a
 * headless test can change a value and measure again without a reload.
 * Lengths in m, speeds in m/s, times in physics steps unless they say s.
 */
export const GRAB = {
  /** A free hand's magnet takes a prop whose surface is this close to the hand's tip */
  reach: 0.06,
  /** The hand's tip sits this far inside the prop's top face: on the face itself the prop looks as if it hung on a thread */
  gripInset: 0.008,
  /** kg: the most a prop weighs while it is held (props come at 20…100 g, the puppet's hand at 12 g) */
  heldMass: 0.003,
  /**
   * Getting to the grip pose: at these paces (m/s along the way, rad/s of
   * turning), in not less than `min` and not more than `max` seconds. Slower
   * than the hand can follow: a prop that snapped into place jerked the arm.
   */
  ease: { speed: 0.3, turn: 3, min: 0.2, max: 0.6 },
  /** A prop that came off cannot be taken again for this long, by either hand: it has to get away first */
  regrabLock: 30,
  /**
   * Throwing by motion: the prop comes off when the hand's string has been
   * whipped (pull: the speed of the string's eye against the cross, upwards
   * or sideways, the most in the last `pullSteps` steps) and the hand's tip
   * has reached flingSpeed against the chest and is slowing down again (at the
   * top of the swing the prop has the most speed to fly on with).
   *
   * Measured on the rig (headless, a 7 cm cube of 27 g in the hand;
   * pull / tip speed, m/s). To hold: lifted by the hand bar 0.33 / 0.73
   * (rocked by key) and 0.49 / 0.70 (the bar raised 15 cm in 0.5 s), bows
   * 0.49 / 0.27, walking with a sweep 0 / 0.65. To throw: the hand bar whipped
   * up at the followers' caps 1.5 / 2.13 (the slowest whip tried: 0.97 and
   * 1.36), the cross tipped back 0.6 rad 0.56 / 0.85. Tipping the cross is
   * within 1.2 times of a lift on both signals: it cannot be told from a lift
   * and does not throw. The whips of the hand bar are 1.9 times above the
   * lifts: with flingSpeed 1.05 and pullMin 0.7 (about the geometric means)
   * every motion that has to hold held and the whips threw the prop at
   * 1.7…2.8 m/s. So a whip of the free hand bar throws, nothing else does.
   * flingSpeed = Infinity switches the throw by motion off (then a throw is a
   * swing and a release, which is hard to time: the release gesture takes
   * 0.2 s to read, and 0.1 s after the top of a swing the prop leaves at
   * 0.4…1.8 m/s instead of 2.3). Not tried with a real hand, whose brisk lift
   * of the hand bar may already be a whip.
   */
  pullMin: 0.7,
  pullSteps: 6,
  flingSpeed: 1.05,
  /** Not during the ease and this long after it: the ease itself moves the hand */
  flingAfter: 18,
  /**
   * Let go by the player, the prop keeps its own velocity, times a boost that
   * grows from 1 at dropSpeed to throwBoost at throwSpeed (the hand tip's speed
   * against the chest): the damped puppet moves slower than a real flick, but
   * a prop let go from a hand at rest must simply drop.
   */
  dropSpeed: 0.3,
  throwSpeed: 0.9,
  throwBoost: 1.5,
  /** The most a prop leaves with: m/s and rad/s (beyond that it is through the backdrop before it is seen) */
  maxThrow: 3,
  maxSpin: 12,
  /**
   * The fuse: the joint is this far apart for fuseSteps steps (the prop is
   * stuck, or the solver has given up), or the prop is faster than fuseSpeed:
   * it drops, without a boost
   */
  fuse: 0.002,
  fuseSteps: 3,
  fuseSpeed: 8,
};

export interface Grabbable {
  name: string;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

/** Small props register here when they stand on the stage (props/requisits.ts). */
export const grabbables: Grabbable[] = [];

/**
 * Grip poses that the rule below gets wrong, by prop name (Grabbable.name):
 * where the hand's tip holds the prop, in the prop body's frame, and whether
 * the prop is turned upright. Empty: no prop has needed one yet.
 */
const GRIPS: Record<string, { anchor: [number, number, number]; upright: boolean }> = {};

/**
 * What a released prop must be clear of before it is a full prop again: props
 * that stand on the stage and the puppet's body (both would throw it out if it
 * came back to life inside them), but not the stage, not the puppet's arms
 * (they pass through props) and not a prop in the other hand.
 * (Collision groups: membership in the high 16 bits, filter in the low 16.)
 */
const CLEAR_OF = (0x0004 << 16) | 0x0005;

type Side = "left" | "right";

interface Held {
  item: Grabbable;
  joint: RAPIER.ImpulseJoint;
  /** The collider's own mass, to give back */
  mass: number;
  /** The prop's rotation against the hand, and where the hand's tip holds it (prop-local): as it was caught … in the grip pose */
  fromRotation: Quaternion;
  toRotation: Quaternion;
  fromAnchor: Vector3;
  toAnchor: Vector3;
  /** Steps since the catch, and how many the ease takes */
  steps: number;
  easeSteps: number;
  /** Steps in a row with the joint apart */
  apart: number;
}

interface Hand {
  side: Side;
  body: RAPIER.RigidBody;
  /** Body-local: the tip, and the direction from the hand's middle to it */
  tip: Vector3;
  direction: Vector3;
  /** The hand string's eye on its bar (bar-local), if the puppet has one */
  eye?: { bar: RAPIER.RigidBody; local: RAPIER.Vector };
  held: Held | null;
  /** After a prop came off: the magnet has to go off once before it takes anything again, or it would take the prop straight back */
  spent: boolean;
  lastRelease: number;
  /** The nearest prop this hand could take now, and how far its surface is */
  near: Grabbable | null;
  nearDistance: number;
  /** The eye against the cross in the step before; the last pulls; and the largest of them */
  eyeBefore: Vector3 | null;
  pulls: number[];
  pull: number;
  /** The tip's speed against the chest, now and in the step before */
  tipSpeed: number;
  tipSpeedBefore: number;
  /** How far the joint is apart (0 with nothing held) */
  separation: number;
  /** Largest values since resetMax(), for the headless measurements */
  max: { pull: number; tipSpeed: number; separation: number };
  halo: Sprite;
}

/** Every puppet's hands, for dropAllHeld() */
const allHands: Array<{ drop(): void }> = [];
let suspended = false;

/** Every puppet lets go of what it holds, without a throw (before it is pulled up out of a scene, or out of the picture). */
export function dropAllHeld() {
  for (const hands of allHands) hands.drop();
}

/** While on, no hand takes anything (the puppets are hidden and hang above the stage during a scene change). */
export function suspendGrab(on: boolean) {
  suspended = on;
}

const IDENTITY = new Quaternion();
const UP = new Vector3(0, 1, 0);
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const smootherstep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
/** As on the prop's card: the catalogue's label, or the file name without its inventory number */
const labelOf = (item: Grabbable) => catalogueEntry("requisits", item.name).label ?? item.name.replace(/_[\d.]+$/, "").replaceAll("_", " ");

let haloTexture: CanvasTexture | undefined;
/** A soft golden disc, drawn once */
function haloMap() {
  if (haloTexture) return haloTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, "rgba(255, 214, 130, 0.9)");
  glow.addColorStop(0.45, "rgba(255, 190, 90, 0.35)");
  glow.addColorStop(1, "rgba(255, 180, 70, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 64, 64);
  return (haloTexture = new CanvasTexture(canvas));
}

export function createGrab(world: World, rig: Rig, strings: ReturnType<typeof createStrings>) {
  const pw = physics.world;
  const chest = (rig.byName.get("chest") ?? rig.parts[0]).body;
  const hands: Hand[] = (["left", "right"] as const).flatMap((side) => {
    const name = side === "left" ? "hand.L" : "hand.R";
    const part = rig.byName.get(name);
    if (!part) return [];
    const string = strings.strings.find((s) => s.id === name);
    // Rendering only: where the magnet would take hold
    const halo = new Sprite(new SpriteMaterial({ map: haloMap(), blending: AdditiveBlending, transparent: true, depthWrite: false, depthTest: false, opacity: 0 }));
    halo.visible = false;
    halo.renderOrder = 5;
    world.scene.add(halo);
    return [{
      side, body: part.body, tip: part.tail.clone(),
      // The hand has a body of its own, whose origin is the middle of its capsule (rig.ts)
      direction: part.tail.clone().normalize(),
      eye: string && { bar: string.bar, local: string.eye },
      held: null, spent: false, lastRelease: controlInput.release[side], near: null, nearDistance: Infinity,
      eyeBefore: null, pulls: [], pull: 0, tipSpeed: 0, tipSpeedBefore: 0, separation: 0, max: { pull: 0, tipSpeed: 0, separation: 0 }, halo,
    }];
  });
  /** Props that came off: steps until they can be taken again */
  const locked = new Map<Grabbable, number>();
  /** Released props that still pass through props and puppet (GROUP.held) until they are clear of them */
  const ghosts = new Set<Grabbable>();

  const projection = new RAPIER.PointProjection({ x: 0, y: 0, z: 0 }, false);
  const tipNow = new Vector3();
  const v = new Vector3();
  const w = new Vector3();
  const q = new Quaternion();
  const alive = (item: Grabbable) => item.body.isValid() && item.collider.isValid();
  const holder = (item: Grabbable) => hands.find((h) => h.held?.item === item);

  const arm = new Vector3();
  const spin = new Vector3();
  const moving = new Vector3();
  /** How fast the hand's tip moves against the chest (v + ω × r of the hand, less the chest's v) */
  const tipSpeed = (hand: Hand) => {
    worldPoint(hand.body, hand.tip, arm).sub(toVec(hand.body.translation(), moving));
    return toVec(hand.body.angvel(), spin).cross(arm).add(toVec(hand.body.linvel(), moving)).sub(toVec(chest.linvel(), moving)).length();
  };

  /** The hand takes the prop: a joint at the pose they are in now, to be eased into the grip pose */
  function take(hand: Hand, item: Grabbable) {
    const handRotation = toQuat(hand.body.rotation());
    const propRotation = toQuat(item.body.rotation());
    const propPosition = toVec(item.body.translation());
    const toProp = (point: Vector3) => point.sub(propPosition).applyQuaternion(q.copy(propRotation).invert());
    worldPoint(hand.body, hand.tip, tipNow);
    const fromRotation = handRotation.clone().invert().multiply(propRotation);
    const fromAnchor = toProp(tipNow.clone());
    const toRotation = fromRotation.clone();
    let toAnchor: Vector3;
    const colliderRotation = toQuat(item.collider.rotation());
    const upright = (axis: Vector3) => {
      // The prop's up axis turns to point back along the hand, by the shortest
      // way (so it keeps its heading): it hangs upright below a hand that hangs
      // down, with its weight on the hand's axis
      const axisInHand = axis.applyQuaternion(colliderRotation).applyQuaternion(handRotation.clone().invert());
      toRotation.premultiply(new Quaternion().setFromUnitVectors(axisInHand, hand.direction.clone().negate()));
    };
    const own = GRIPS[item.name];
    const half = item.collider.halfExtents();
    if (own) {
      toAnchor = new Vector3(...own.anchor);
      if (own.upright) upright(UP.clone());
    } else if (half) {
      // A box: held at the middle of its top face
      toAnchor = toProp(new Vector3(0, half.y - GRAB.gripInset, 0).applyQuaternion(colliderRotation).add(toVec(item.collider.translation())));
      upright(UP.clone());
    } else {
      // A ball (or any other shape): held where it is nearest to the hand, as it lies
      const surface = item.collider.projectPoint(tipNow, false, projection);
      toAnchor = surface ? toProp(toVec(surface.point)) : fromAnchor.clone();
    }
    const ease = GRAB.ease;
    const seconds = clamp(Math.max(fromAnchor.distanceTo(toAnchor) / ease.speed, fromRotation.angleTo(toRotation) / ease.turn), ease.min, ease.max);
    const joint = pw.createImpulseJoint(RAPIER.JointData.fixed(hand.tip, fromRotation, fromAnchor, IDENTITY), hand.body, item.body, true);
    const mass = item.collider.mass();
    item.collider.setMass(Math.min(mass, GRAB.heldMass));
    item.collider.setCollisionGroups(GROUP.held);
    ghosts.delete(item);
    hand.held = { item, joint, mass, fromRotation, toRotation, fromAnchor, toAnchor, steps: 0, easeSteps: Math.round(seconds / STEP), apart: 0 };
    hand.separation = 0;
    // Held now, so in nobody's reach any more
    for (const h of hands) if (h.near === item) h.near = null;
    cueGrab(tipNow.x);
  }

  /**
   * The prop comes off the hand. boost: thrown or let go by the player (it
   * flies on, faster the faster the hand was); without it the prop just drops.
   */
  function letGo(hand: Hand, boost: boolean, speed = hand.tipSpeed) {
    const held = hand.held;
    if (!held) return;
    const { item, joint, mass } = held;
    hand.held = null;
    hand.spent = true;
    hand.separation = 0;
    // A removed body takes its joints with it
    if (joint.isValid()) pw.removeImpulseJoint(joint, true);
    if (!alive(item)) return;
    item.collider.setMass(mass);
    if (!item.body.isDynamic() || !grabbables.includes(item)) {
      // Somebody else has it (lifted off the stage, dragged with the mouse): a full prop again at once
      item.collider.setCollisionGroups(GROUP.prop);
      return;
    }
    const factor = boost ? 1 + (GRAB.throwBoost - 1) * clamp((speed - GRAB.dropSpeed) / (GRAB.throwSpeed - GRAB.dropSpeed), 0, 1) : 1;
    item.body.setLinvel(toVec(item.body.linvel(), v).multiplyScalar(factor).clampLength(0, GRAB.maxThrow), true);
    item.body.setAngvel(toVec(item.body.angvel(), w).clampLength(0, GRAB.maxSpin), true);
    locked.set(item, GRAB.regrabLock);
    ghosts.add(item);
    cueLetGo(item.body.translation().x);
  }

  allHands.push({ drop: () => hands.forEach((hand) => letGo(hand, false)) });

  physics.beforeStep.push(() => {
    // What the hands are doing, from the step that has just been made
    const pivot = strings.bar.translation();
    for (const hand of hands) {
      hand.tipSpeedBefore = hand.tipSpeed;
      hand.tipSpeed = tipSpeed(hand);
      let pull = 0;
      if (hand.eye) {
        // The string's eye against the cross's pivot: moving the whole cross
        // (a sweep, a scene change, a new player's entrance) is no pull. Bars
        // are kinematic, so their speed is the difference of two steps
        worldPoint(hand.eye.bar, hand.eye.local, w).sub(toVec(pivot, v));
        if (hand.eyeBefore) {
          v.subVectors(w, hand.eyeBefore).divideScalar(STEP);
          // An eye that goes down slackens its string
          pull = v.y < 0 ? 0 : v.length();
        }
        (hand.eyeBefore ??= new Vector3()).copy(w);
      }
      hand.pulls.push(pull);
      if (hand.pulls.length > GRAB.pullSteps) hand.pulls.shift();
      hand.pull = Math.max(...hand.pulls);
      hand.max.pull = Math.max(hand.max.pull, hand.pull);
      hand.max.tipSpeed = Math.max(hand.max.tipSpeed, hand.tipSpeed);
    }

    // 1. A held prop that is gone, or that somebody else moves now (removed
    // with its scene, lifted off by a second click on its card, dragged with
    // the mouse: all of these make it kinematic or take it off the list)
    for (const hand of hands) {
      const item = hand.held?.item;
      if (item && (!alive(item) || !item.body.isDynamic() || !grabbables.includes(item))) letGo(hand, false);
    }
    for (const [item, steps] of locked) {
      if (steps <= 1 || !alive(item)) locked.delete(item);
      else locked.set(item, steps - 1);
    }

    // 2. What each free hand could take
    for (const hand of hands) {
      hand.near = null;
      hand.nearDistance = Infinity;
      if (hand.held || suspended) continue;
      worldPoint(hand.body, hand.tip, tipNow);
      for (const item of grabbables) {
        if (!alive(item) || !item.body.isDynamic() || locked.has(item) || holder(item)) continue;
        const nearest = item.collider.projectPoint(tipNow, true, projection);
        if (!nearest) continue;
        const distance = nearest.isInside ? 0 : tipNow.distanceTo(nearest.point as Vector3);
        if (distance <= GRAB.reach && distance < hand.nearDistance) {
          hand.near = item;
          hand.nearDistance = distance;
        }
      }
    }

    // 3. Let go: the player's release
    for (const hand of hands) {
      const release = controlInput.release[hand.side];
      if (release !== hand.lastRelease) letGo(hand, true);
      hand.lastRelease = release;
    }

    // 4. Catch: a free hand whose magnet is on takes the nearest prop in reach;
    // if both hands are at the same prop, the nearer one has it
    const catching = hands.filter((hand) => {
      if (!controlInput.grip[hand.side]) hand.spent = false;
      return controlInput.grip[hand.side] && !hand.spent && !hand.held && hand.near;
    });
    catching.sort((a, b) => a.nearDistance - b.nearDistance);
    for (const hand of catching) if (hand.near && !holder(hand.near)) take(hand, hand.near);

    // 5. What is held: eased into the grip pose; thrown off; the fuse
    const returning = strings.returning();
    for (const hand of hands) {
      const held = hand.held;
      if (!held) continue;
      const { item, joint } = held;
      // How far the last step left the joint apart: before the anchor moves on, which the solver has not seen yet
      hand.separation = worldPoint(hand.body, hand.tip, tipNow).distanceTo(worldPoint(item.body, joint.anchor2(), w));
      hand.max.separation = Math.max(hand.max.separation, hand.separation);
      held.apart = hand.separation > GRAB.fuse ? held.apart + 1 : 0;
      if (held.steps < held.easeSteps) {
        const t = smootherstep(++held.steps / held.easeSteps);
        // Each call sets a whole frame: the hand's side turns, the prop's side moves
        joint.setLocalFrame1(hand.tip, q.slerpQuaternions(held.fromRotation, held.toRotation, t));
        joint.setLocalFrame2(v.lerpVectors(held.fromAnchor, held.toAnchor, t), IDENTITY);
        item.body.wakeUp();
      } else {
        held.steps++;
      }
      if (held.apart >= GRAB.fuseSteps || toVec(item.body.linvel(), v).length() > GRAB.fuseSpeed) {
        letGo(hand, false);
      } else if (
        !suspended && !returning && held.steps > held.easeSteps + GRAB.flingAfter &&
        hand.pull >= GRAB.pullMin && hand.tipSpeedBefore >= GRAB.flingSpeed && hand.tipSpeed < hand.tipSpeedBefore
      ) {
        // Thrown: whipped by the string, and just past the top of the swing
        letGo(hand, true, hand.tipSpeedBefore);
      }
    }

    // A released prop is a full prop again once it is clear of the others and of the puppet
    for (const item of ghosts) {
      if (!alive(item)) ghosts.delete(item);
      else if (!item.body.isDynamic() || !pw.intersectionWithShape(item.collider.translation(), item.collider.rotation(), item.collider.shape, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, CLEAR_OF, item.collider)) {
        item.collider.setCollisionGroups(GROUP.prop);
        ghosts.delete(item);
      }
    }

    for (const hand of hands) {
      puppetState.holding[hand.side] = hand.held ? labelOf(hand.held.item) : null;
      puppetState.inReach[hand.side] = hand.near ? labelOf(hand.near) : null;
    }
  });

  // The halo at the prop a hand could take: brighter while its magnet is on
  // (rendering only). Faint: the renderer has no tone mapping, so additive
  // light on a pale costume is white at once
  const at = new Vector3();
  physics.afterSync.push(() => {
    for (const hand of hands) {
      const item = hand.near;
      // One halo per prop: with both hands at the same one, the second would double it
      const show = !!item && alive(item) && !hands.some((other) => other !== hand && other.near === item && other.halo.visible);
      hand.halo.visible = show;
      if (!show) continue;
      renderPose(item.body, at, q);
      hand.halo.position.copy(at);
      const half = item.collider.halfExtents();
      const size = half ? Math.hypot(half.x, half.y, half.z) : item.collider.radius();
      hand.halo.scale.setScalar(2.6 * size);
      const magnet = hands.some((h) => h.near === item && controlInput.grip[h.side] && !h.spent);
      hand.halo.material.opacity = magnet ? 0.8 : 0.4;
    }
  });

  return {
    /** For the headless measurements: per hand, the signals behind a throw, how far the joint is apart, and their largest values since resetMax() */
    probe: () => hands.map((h) => ({ side: h.side, pull: h.pull, tipSpeed: h.tipSpeed, separation: h.separation, easing: !!h.held && h.held.steps < h.held.easeSteps, max: { ...h.max } })),
    resetMax: () => hands.forEach((h) => (h.max = { pull: 0, tipSpeed: 0, separation: 0 })),
  };
}
