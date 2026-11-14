import type RAPIER from "@dimforge/rapier3d-compat";
import { STRING_IDS, type ControlInput, type ControlSource } from "../input/control-input";

// What travels between the devices of a room (docs/architecture.md §3.3).
// Pose traffic is binary, little-endian, one small packet per puppet: every
// packet holds absolute values and stays far below the ~1100 bytes above which
// a packet is split in two (and lost as a whole if one half is).

/** Raised when a packet's layout changes: devices with different versions do not play together */
export const PROTOCOL = 1;

/** First byte of a pose packet. 0 is the transport's probe (transport.ts). */
export const PACKET = { input: 1, puppet: 2, props: 3 } as const;

// The reliable messages are JSON. Type aliases, not interfaces: only those count as JSON values for the transport.

/** Who plays which puppet; sent by the host, complete, on every change */
export type RosterMessage = {
  t: "roster";
  v: number;
  /** Peer id → the puppet's slot on the stage */
  slots: Record<string, number>;
};

/** The stage set, from whoever changed it to everyone (and from the host to a device that joins) */
export type StageMessage = {
  t: "stage";
  /** Backdrop id (src/stage/backdrops.ts), null for none */
  backdrop: string | null;
};

/** A device leaves on purpose (page closed): its puppet goes at once, not after the connection times out */
export type ByeMessage = {
  t: "bye";
};

const SOURCES: ControlSource[] = ["mouse", "mediapipe", "phone", "remote-phone", "xr-3dof", "xr-6dof"];
const ROCKS = ["hands", "legs", "head"] as const;

/** Positions as 16 bit steps of 0.2 mm: ±6.5 m around the stage's middle */
const POSITION_STEP = 0.0002;
/** Rocking angles as 16 bit steps of 0.1 mrad: ±3.2 rad */
const ANGLE_STEP = 0.0001;
const QUAT_SCALE = 32767;
const clamp16 = (value: number) => Math.max(-32768, Math.min(32767, Math.round(value)));

const view = (packet: Uint8Array) => new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

function writeQuat(data: DataView, offset: number, q: Quat) {
  data.setInt16(offset, clamp16(q.x * QUAT_SCALE), true);
  data.setInt16(offset + 2, clamp16(q.y * QUAT_SCALE), true);
  data.setInt16(offset + 4, clamp16(q.z * QUAT_SCALE), true);
  data.setInt16(offset + 6, clamp16(q.w * QUAT_SCALE), true);
}

// ── Input: a player's ControlInput, to the host ──────────────────────────────
//
// type u8 · sequence u16 · flags u8 (grip left, grip right, hand bar detached)
// · source u8 · bar position 3 × f32 · bar rotation 4 × i16 · rock 3 × i16
// · hand bar position 3 × f32 · hand bar rotation 4 × i16 · pulls 9 × u8

const INPUT_BYTES = 5 + 12 + 8 + 6 + 12 + 8 + STRING_IDS.length;

/** A new buffer every time: the transport may still hold the last one */
export function encodeInput(input: ControlInput, sequence: number) {
  const packet = new Uint8Array(INPUT_BYTES);
  const data = view(packet);
  data.setUint8(0, PACKET.input);
  data.setUint16(1, sequence & 0xffff, true);
  data.setUint8(3, (input.grip.left ? 1 : 0) | (input.grip.right ? 2 : 0) | (input.handBar.detached ? 4 : 0));
  data.setUint8(4, Math.max(0, SOURCES.indexOf(input.source)));
  let at = 5;
  const position = (p: { x: number; y: number; z: number }) => {
    data.setFloat32(at, p.x, true);
    data.setFloat32(at + 4, p.y, true);
    data.setFloat32(at + 8, p.z, true);
    at += 12;
  };
  const quat = (q: Quat) => {
    writeQuat(data, at, q);
    at += 8;
  };
  position(input.bar.position);
  quat(input.bar.rotation);
  for (const rock of ROCKS) {
    data.setInt16(at, clamp16(input.rock[rock] / ANGLE_STEP), true);
    at += 2;
  }
  position(input.handBar.position);
  quat(input.handBar.rotation);
  for (const id of STRING_IDS) data.setUint8(at++, Math.round(Math.max(0, Math.min(1, input.pulls[id])) * 255));
  return packet;
}

/** The packet's sequence number; −1 if it is not an input packet of this version. */
export function inputSequence(packet: Uint8Array) {
  return packet.byteLength === INPUT_BYTES ? view(packet).getUint16(1, true) : -1;
}

/** Writes the packet into `input` (the puppet's own ControlInput on the host). */
export function decodeInput(packet: Uint8Array, input: ControlInput) {
  if (packet.byteLength !== INPUT_BYTES) return;
  const data = view(packet);
  const flags = data.getUint8(3);
  input.grip.left = (flags & 1) !== 0;
  input.grip.right = (flags & 2) !== 0;
  input.handBar.detached = (flags & 4) !== 0;
  input.source = SOURCES[data.getUint8(4)] ?? "mouse";
  let at = 5;
  const position = (out: { set(x: number, y: number, z: number): unknown }) => {
    out.set(data.getFloat32(at, true), data.getFloat32(at + 4, true), data.getFloat32(at + 8, true));
    at += 12;
  };
  const quat = (out: { set(x: number, y: number, z: number, w: number): { normalize(): unknown } }) => {
    const part = (i: number) => data.getInt16(at + i * 2, true) / QUAT_SCALE;
    out.set(part(0), part(1), part(2), part(3)).normalize();
    at += 8;
  };
  position(input.bar.position);
  quat(input.bar.rotation);
  for (const rock of ROCKS) {
    input.rock[rock] = data.getInt16(at, true) * ANGLE_STEP;
    at += 2;
  }
  // While the bar sits on the cross, the host's engine owns its pose (strings.ts)
  if (input.handBar.detached) {
    position(input.handBar.position);
    quat(input.handBar.rotation);
  } else {
    at += 20;
  }
  for (const id of STRING_IDS) input.pulls[id] = data.getUint8(at++) / 255;
}

// ── Poses: the bodies of one puppet, or the moving props, from the host ──────
//
// type u8 · id u8 (the puppet's slot) · physics step u32 · per body: position
// 3 × i16, rotation 4 × i16. Bodies are told apart by their place in the list
// (puppet.bodies, propBodies), which is the same on every device.

const POSE_HEADER = 6;
const POSE_BYTES = 14;
/** Numbers per body in a decoded pose: x y z, qx qy qz qw */
export const POSE_SIZE = 7;

export function encodePoses(type: number, id: number, step: number, bodies: RAPIER.RigidBody[]) {
  const packet = new Uint8Array(POSE_HEADER + bodies.length * POSE_BYTES);
  const data = view(packet);
  data.setUint8(0, type);
  data.setUint8(1, id);
  data.setUint32(2, step, true);
  let at = POSE_HEADER;
  for (const body of bodies) {
    const p = body.translation();
    data.setInt16(at, clamp16(p.x / POSITION_STEP), true);
    data.setInt16(at + 2, clamp16(p.y / POSITION_STEP), true);
    data.setInt16(at + 4, clamp16(p.z / POSITION_STEP), true);
    writeQuat(data, at + 6, body.rotation());
    at += POSE_BYTES;
  }
  return packet;
}

export function poseHeader(packet: Uint8Array) {
  const data = view(packet);
  return { id: data.getUint8(1), step: data.getUint32(2, true), count: Math.floor((packet.byteLength - POSE_HEADER) / POSE_BYTES) };
}

/** Decodes as many bodies as fit `out` (POSE_SIZE numbers each). */
export function decodePoses(packet: Uint8Array, out: Float32Array) {
  const data = view(packet);
  const count = Math.min(Math.floor(out.length / POSE_SIZE), Math.floor((packet.byteLength - POSE_HEADER) / POSE_BYTES));
  for (let i = 0; i < count; i++) {
    const from = POSE_HEADER + i * POSE_BYTES;
    const to = i * POSE_SIZE;
    for (let k = 0; k < 3; k++) out[to + k] = data.getInt16(from + k * 2, true) * POSITION_STEP;
    for (let k = 0; k < 4; k++) out[to + 3 + k] = data.getInt16(from + 6 + k * 2, true) / QUAT_SCALE;
  }
  return count;
}
