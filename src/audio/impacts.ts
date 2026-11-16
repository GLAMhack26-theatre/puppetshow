import { impactVelocity } from "../props/contacts";
import { MATERIALS, colliderSounds } from "../props/materials";
import { MEMBER, physics } from "../systems/rapier-system";
import { playSfx, type Zzfx } from "./sfx";

// Physics sounds: when two colliders start touching (Rapier collision
// events, switched on for the puppet parts and the props), the speed at which
// they meet sets the sound and its loudness. What is hit comes from the
// collision group membership (rapier-system.ts MEMBER), so no per-collider
// registry is needed: puppet parts are wood (a wooden marionette clatters),
// props thud or fall. A prop sounds as its material (props/materials.ts:
// metal, stone, glass … by collider); of two props the one that is not wood. Contact force events were the plan, but they also
// fire every step for a puppet standing still on the floor; a contact start
// only fires on the impact itself.

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
  if (!ca || !cb) return;
  const ba = ca.parent();
  const bb = cb.parent();
  const groups = members(a) | members(b);
  const prop = (groups & MEMBER.prop) !== 0;
  // A prop also sounds on the stage floor, a collider without a body (it
  // stands still); it is measured with its speed from before the step, which
  // had already resolved the impact (props/contacts.ts). The puppet still
  // needs two bodies: on the floor it stays silent, as it always was.
  if (!prop && (!ba || !bb)) return;
  let speed: number;
  if (prop) {
    const v = impactVelocity(a, b);
    speed = Math.hypot(v.x, v.y, v.z);
  } else {
    const va = ba!.linvel();
    const vb = bb!.linvel();
    speed = Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z);
  }
  if (speed < MIN_SPEED) return;

  if (now - window0 > 100) {
    window0 = now;
    inWindow = 0;
  }
  if (inWindow >= MAX_PER_WINDOW) return;
  inWindow++;
  lastPlayed.set(pair, now);

  const strength = Math.min(1, (speed - MIN_SPEED) / (FULL_SPEED - MIN_SPEED));
  const xs = [ba, bb].filter((body) => !!body).map((body) => body.translation().x);
  const pan = xs.reduce((sum, x) => sum + x, 0) / xs.length / PAN_WIDTH;

  if (prop) {
    // A prop: thrown or knocked over hard → its fall, otherwise set down
    const sound = propSound(a, b);
    const options = { rate: sound.rate, pan };
    if (strength > 0.55) playSfx(sound.fall, { ...options, volume: sound.volume * (0.4 + 0.5 * strength) });
    else playSfx(sound.hit, { ...options, volume: sound.volume * (0.25 + 0.6 * strength) });
  } else if (groups & MEMBER.puppet) {
    // The small wooden puppet: higher than the samples' (full-size) wood
    if (strength < 0.2) playSfx("tick", { volume: 0.5 * strength + 0.1, pan }, TICK);
    else playSfx("wood", { volume: 0.15 + 0.5 * strength, rate: 1.5, pan });
  }
  if (lastPlayed.size > 500) lastPlayed.clear();
}

const WOOD = MATERIALS.wood.sound;

/** The material sound of the prop in a contact: the one that is not wood if both are props. */
function propSound(a: number, b: number) {
  const sa = colliderSounds.get(a);
  const sb = colliderSounds.get(b);
  if (sa && sb) return sa === WOOD ? sb : sa;
  return sa ?? sb ?? WOOD;
}

export function setupImpacts() {
  physics.onCollision.push(onContact);
}
