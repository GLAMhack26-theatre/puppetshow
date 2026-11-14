import { physics } from "../systems/rapier-system";
import { playSfx, type Zzfx } from "./sfx";

// Physics sounds: when two colliders start touching (Rapier collision
// events, switched on for the puppet parts and the props), the speed at which
// they meet sets the sound and its loudness. What is hit comes from the
// collision group membership (rapier-system.ts GROUP), so no per-collider
// registry is needed: puppet parts are wood (a wooden marionette clatters),
// props thud or fall. Contact force events were the plan, but they also
// fire every step for a puppet standing still on the floor; a contact start
// only fires on the impact itself.

const MEMBER = { puppet: 0x0001, stage: 0x0002, prop: 0x0004 };

/** Below this relative speed (m/s) a contact is silent: settling, sliding, standing */
const MIN_SPEED = 0.12;
/** Relative speed at which a hit is at full volume */
const FULL_SPEED = 1.4;
/** Per collider pair: the joints jitter, and a resting part starts touching again and again */
const PAIR_COOLDOWN_MS = 120;
/** At most this many impact sounds per 100 ms, so a puppet dropped in a heap does not roar */
const MAX_PER_WINDOW = 4;
/** Stage half width (m): the stereo pan runs from −1 to 1 across it */
const PAN_WIDTH = 0.7;

// A dry little wooden tick for soft puppet contacts (ZzFX: volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide, pitchJump, pitchJumpTime, repeatTime, noise)
const TICK: Zzfx = [0.6, 0.1, 900, 0, 0.005, 0.03, 1, 1.5, 0, 0, 0, 0, 0, 6];

const lastPlayed = new Map<string, number>();
let window0 = 0;
let inWindow = 0;

function members(handle: number) {
  const collider = physics.world.getCollider(handle);
  return collider ? collider.collisionGroups() >>> 16 : 0;
}

function onContact(a: number, b: number, started: boolean) {
  if (!started) return;
  const now = performance.now();
  const pair = a < b ? `${a}:${b}` : `${b}:${a}`;
  if (now - (lastPlayed.get(pair) ?? -Infinity) < PAIR_COOLDOWN_MS) return;

  const ca = physics.world.getCollider(a);
  const cb = physics.world.getCollider(b);
  const ba = ca?.parent();
  const bb = cb?.parent();
  if (!ba || !bb) return;
  const va = ba.linvel();
  const vb = bb.linvel();
  const speed = Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z);
  if (speed < MIN_SPEED) return;

  if (now - window0 > 100) {
    window0 = now;
    inWindow = 0;
  }
  if (inWindow >= MAX_PER_WINDOW) return;
  inWindow++;
  lastPlayed.set(pair, now);

  const strength = Math.min(1, (speed - MIN_SPEED) / (FULL_SPEED - MIN_SPEED));
  const pan = (ba.translation().x + bb.translation().x) / 2 / PAN_WIDTH;
  const groups = members(a) | members(b);

  if (groups & MEMBER.prop) {
    // A prop: thrown or knocked over hard → falling wood, otherwise set down
    if (strength > 0.55) playSfx("fall", { volume: 0.4 + 0.5 * strength, pan });
    else playSfx("place", { volume: 0.25 + 0.6 * strength, pan });
  } else if (groups & MEMBER.puppet) {
    // The small wooden puppet: higher than the samples' (full-size) wood
    if (strength < 0.2) playSfx("tick", { volume: 0.5 * strength + 0.1, pan }, TICK);
    else playSfx("wood", { volume: 0.15 + 0.5 * strength, rate: 1.5, pan });
  }
  if (lastPlayed.size > 500) lastPlayed.clear();
}

export function setupImpacts() {
  physics.onCollision.push(onContact);
}
