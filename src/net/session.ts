import type RAPIER from "@dimforge/rapier3d-compat";
import type { World } from "@iwsdk/core";
import { controlInput, createControlInput, puppetState, type ControlInput } from "../input/control-input";
import { spawnPuppet, type Puppet } from "../puppet/puppet";
import { currentBackdrop, loadBackdrops, onBackdropChange, setBackdrop } from "../stage/backdrops";
import { MAX_PUPPETS, STEP, addHook, physics } from "../systems/rapier-system";
import {
  PACKET,
  POSE_SIZE,
  PROTOCOL,
  decodeInput,
  decodePoses,
  encodeInput,
  encodePoses,
  inputSequence,
  poseHeader,
  type ByeMessage,
  type HandsMessage,
  type RosterMessage,
  type StageMessage,
} from "./protocol";
import { createTransport, type Transport } from "./transport";
import "./status.css";

// Several players on one stage (docs/architecture.md §3.3). The physics is
// not the same on two devices (step count per frame, the moment an input
// arrives), so only one simulates: the host, opened with ?room=<id>&host. It
// runs every puppet from its player's ControlInput and sends the poses of all
// bodies. The other devices (?room=<id>) send their input and show the poses
// they receive, a moment late, blended between two snapshots.
//
// A puppet's hands are part of its physics, so they are on the host too: it
// tells every player what their puppet holds and could take (puppetState).
//
// Shared besides the puppets: the backdrop. Props (props/requisits.ts) and
// scene presets (plays/) are not: each device sets its own, and only the
// host's props are in the physics the puppets live in.

/** The host sends poses every this many physics steps (60 Hz): 30 times a second */
const SNAPSHOT_EVERY = 2;
/** Clients show the stage this far in the past, s: two snapshots, so there is always a pair to blend between */
const INTERPOLATION_DELAY = 2.2 * SNAPSHOT_EVERY * STEP;
/** Inputs per second from a client */
const INPUT_RATE = 60;
/** No pose for this long, s: the host's tab is hidden or it is gone */
const STALL_AFTER = 0.5;
/** A host that sent nothing for this long, s, is gone: a client may follow another one */
const HOST_TIMEOUT = 3;
/** The host looks every this many physics steps whether a player's hands hold or reach something else: 10 times a second at most */
const HANDS_EVERY = 6;
/** The host repeats who plays what, s: a device that missed a change catches up */
const ROSTER_INTERVAL = 2;
const SNAPSHOTS_KEPT = 8;
/** Bodies per packet at most: bars and bones of a puppet (about 20) */
const MAX_BODIES = 48;

export interface SessionOptions {
  /** The secret that makes a room: every device with the same one plays together */
  room: string;
  /** This device simulates the stage; exactly one per room */
  host: boolean;
  /** Puppets bump into each other (the host decides) */
  contact: boolean;
  /** Pose packets over a lossy channel where it works (transport.ts) */
  lossy: boolean;
  /** Only through the TURN server (&ice=relay): to check that it works */
  relayOnly: boolean;
  hud: Record<string, string>;
}

const seconds = () => performance.now() / 1000;

/** The host's physics time on this device's clock, from the snapshots' step numbers. */
class HostClock {
  private offset = Infinity;

  /** The fastest packets set the offset; it creeps up again so that clock drift is followed */
  observe(hostTime: number) {
    const offset = seconds() - hostTime;
    // Far behind: the host stood still for a while (hidden tab). Start over.
    this.offset = offset > this.offset + 0.25 ? offset : Math.min(offset, this.offset + 0.0005);
  }

  now() {
    return seconds() - this.offset;
  }

  reset() {
    this.offset = Infinity;
  }
}

/** The last snapshots of one group of bodies, to show them at a moment in between. */
class PoseBuffer {
  private readonly snapshots: { time: number; count: number; poses: Float32Array }[] = [];
  /** Snapshots that never arrived (gaps in the step numbers) */
  lost = 0;

  push(time: number, packet: Uint8Array) {
    const newest = this.snapshots.at(-1);
    if (newest && time <= newest.time) return; // late or twice: a newer one is here already
    if (newest) this.lost += Math.max(0, Math.round((time - newest.time) / (SNAPSHOT_EVERY * STEP)) - 1);
    const snapshot =
      this.snapshots.length >= SNAPSHOTS_KEPT ? this.snapshots.shift()! : { time: 0, count: 0, poses: new Float32Array(MAX_BODIES * POSE_SIZE) };
    snapshot.time = time;
    snapshot.count = decodePoses(packet, snapshot.poses);
    this.snapshots.push(snapshot);
  }

  /** Poses at `time` into `out`; returns how many bodies (0: nothing arrived yet). Never guesses ahead of the newest snapshot. */
  sample(time: number, out: Float32Array) {
    const { snapshots } = this;
    if (!snapshots.length) return 0;
    let next = snapshots.findIndex((s) => s.time > time);
    if (next === 0 || next < 0) {
      const only = snapshots[next === 0 ? 0 : snapshots.length - 1];
      out.set(only.poses);
      return only.count;
    }
    const a = snapshots[next - 1];
    const b = snapshots[next];
    const t = (time - a.time) / (b.time - a.time);
    const count = Math.min(a.count, b.count);
    for (let i = 0; i < count; i++) {
      const at = i * POSE_SIZE;
      for (let k = 0; k < 3; k++) out[at + k] = a.poses[at + k] + (b.poses[at + k] - a.poses[at + k]) * t;
      // Rotation: blend the shorter way round and renormalise (the steps are small)
      let dot = 0;
      for (let k = 3; k < 7; k++) dot += a.poses[at + k] * b.poses[at + k];
      const sign = dot < 0 ? -1 : 1;
      let length = 0;
      for (let k = 3; k < 7; k++) {
        out[at + k] = a.poses[at + k] + (sign * b.poses[at + k] - a.poses[at + k]) * t;
        length += out[at + k] * out[at + k];
      }
      length = Math.sqrt(length) || 1;
      for (let k = 3; k < 7; k++) out[at + k] /= length;
    }
    return count;
  }

  clear() {
    this.snapshots.length = 0;
  }
}

const position = { x: 0, y: 0, z: 0 };
const rotation = { x: 0, y: 0, z: 0, w: 1 };
function applyPoses(bodies: RAPIER.RigidBody[], poses: Float32Array, count: number) {
  for (let i = 0; i < Math.min(count, bodies.length); i++) {
    const at = i * POSE_SIZE;
    position.x = poses[at];
    position.y = poses[at + 1];
    position.z = poses[at + 2];
    rotation.x = poses[at + 3];
    rotation.y = poses[at + 4];
    rotation.z = poses[at + 5];
    rotation.w = poses[at + 6];
    bodies[i]?.setTranslation(position, false);
    bodies[i]?.setRotation(rotation, false);
  }
}

const isMessage = (message: unknown, t: string): message is { t: string } =>
  typeof message === "object" && message !== null && (message as { t?: unknown }).t === t;
const isRoster = (message: unknown): message is RosterMessage => isMessage(message, "roster") && typeof (message as RosterMessage).slots === "object";
const isStage = (message: unknown): message is StageMessage => isMessage(message, "stage");
const isHands = (message: unknown): message is HandsMessage =>
  isMessage(message, "hands") && Array.isArray((message as HandsMessage).holding) && Array.isArray((message as HandsMessage).inReach);

const stageMessage = (): StageMessage => ({ t: "stage", backdrop: currentBackdrop()?.id ?? null });

/** The stage set is the same for everyone: whoever changes the backdrop tells the others. */
function shareStage(world: World, transport: Transport) {
  let applying = false; // a change that came from another device is not sent back
  onBackdropChange(() => {
    if (!applying) transport.sendReliable(stageMessage());
  });
  transport.onReliable(async (message) => {
    if (!isStage(message)) return;
    const backdrop = (await loadBackdrops()).find((b) => b.id === message.backdrop) ?? null;
    applying = true;
    setBackdrop(world, backdrop);
    applying = false;
  });
}

/**
 * What a client shows until it has found the host. With our own meeting point
 * it names it: a device that uses another one (the public relays, another
 * server) waits forever, and nothing else on the screen says why.
 */
const waiting = (transport: Transport) => `Warte auf die Bühne …${transport.signaling.own ? ` (Treffpunkt ${transport.signaling.label})` : ""}`;

/** A line at the top of the screen: the room on the host, what a client waits for */
function createStatus() {
  const element = document.createElement("div");
  element.id = "net-status";
  document.body.append(element);
  return (text: string) => {
    if (element.textContent !== text) element.textContent = text;
    element.hidden = !text;
  };
}

/**
 * Joins the room and puts the players' puppets on the stage. On
 * the host it resolves when its own puppet stands; on a client as soon as the
 * room is joined (its puppet comes when the host is there).
 */
export async function startSession(world: World, options: SessionOptions) {
  const transport = createTransport(options.room, { lossy: options.lossy, relayOnly: options.relayOnly });
  const status = createStatus();
  const { hud } = options;
  hud.net = "verbinde …";
  status(options.host ? `Raum ${options.room} …` : waiting(transport));
  transport.onError((message) => {
    console.warn("[net]", message);
    hud.neterr = message.slice(0, 60);
  });
  const selfId = await transport.ready;
  shareStage(world, transport);
  // Closing the page: tell the others, so the puppet leaves the stage at once
  addEventListener("pagehide", () => transport.sendReliable({ t: "bye" } satisfies ByeMessage));

  const session = options.host ? await runHost(world, transport, selfId, options, status) : await runClient(world, transport, selfId, status);

  // HUD: role, peers, how many of them over the lossy channel, where the
  // devices meet, how the traffic to each peer travels, round trip, packets
  // per second (what each line tells about a network: docs/multiplayer.md)
  let last = transport.stats();
  const { signaling } = transport;
  setInterval(() => {
    const stats = transport.stats();
    hud.net = `${options.host ? "host" : "client"} ${options.room} · ${stats.peers} peers · ${stats.lossy} lossy`;
    hud.signal = `${signaling.label} ${signaling.open()}/${signaling.total()}`;
    transport.paths().then((paths) => (hud.path = `${paths.join(" ") || "-"}${options.relayOnly ? " (ice=relay)" : ""}`));
    hud.rate = `in ${stats.received - last.received}/s out ${stats.sent - last.sent}/s lost ${session.lost()}`;
    last = stats;
    const target = session.pingTarget();
    if (target) transport.ping(target).then((ms) => (hud.rtt = `${ms.toFixed(0)} ms`), () => (hud.rtt = "-"));
    else hud.rtt = "-";
  }, 1000);

  // ?debug: handles for headless tests
  if (new URLSearchParams(location.search).has("debug")) Object.assign(globalThis, { net: { transport, session, selfId } });
  return session;
}

// ── Host ─────────────────────────────────────────────────────────────────────

interface Player {
  slot: number;
  input: ControlInput;
  /** Sequence number of the last input taken (−1: none yet) */
  sequence: number;
  puppet?: Puppet;
  /** What its device was last told about its hands (a HandsMessage as text) */
  hands?: string;
}

async function runHost(world: World, transport: Transport, selfId: string, options: SessionOptions, status: (text: string) => void) {
  const players = new Map<string, Player>();
  let lost = 0;
  let secondHost = false;

  const sendRoster = () => {
    const slots = Object.fromEntries([...players].map(([id, player]) => [id, player.slot]));
    transport.sendReliable({ t: "roster", v: PROTOCOL, slots } satisfies RosterMessage);
    status(secondHost ? "Zwei Bühnen im selben Raum: nur ein Gerät mit &host öffnen" : `Raum ${options.room} · ${players.size} Spieler`);
  };

  const add = async (id: string, input: ControlInput) => {
    if (players.has(id)) return;
    const taken = new Set([...players.values()].map((p) => p.slot));
    const slot = Array.from({ length: MAX_PUPPETS }, (_, i) => i).find((i) => !taken.has(i));
    if (slot === undefined) return sendRoster(); // the stage is full: this device watches
    const player: Player = { slot, input, sequence: -1 };
    players.set(id, player);
    sendRoster(); // before the model is cloned: the other devices load theirs meanwhile
    const puppet = await spawnPuppet(world, { slot, input, contact: options.contact });
    if (players.get(id) === player) player.puppet = puppet;
    else puppet.dispose(); // left while it loaded
  };

  const remove = (id: string) => {
    if (!players.has(id)) return;
    players.get(id)?.puppet?.dispose();
    players.delete(id);
    sendRoster();
  };

  await add(selfId, controlInput);
  transport.onPeerJoin((id) => {
    void add(id, createControlInput());
    // The backdrop that already stands; later changes reach everyone as they happen
    if (currentBackdrop()) transport.sendReliable(stageMessage(), id);
  });
  transport.onPeerLeave(remove);
  setInterval(sendRoster, ROSTER_INTERVAL * 1000);

  transport.onReliable((message, from) => {
    if (isMessage(message, "bye")) remove(from);
    // Only a host sends rosters
    if (isRoster(message)) secondHost = true;
  });

  transport.onFast((packet, from) => {
    const player = players.get(from);
    if (!player || packet[0] !== PACKET.input) return;
    const sequence = inputSequence(packet);
    if (sequence < 0) return;
    // 16 bit, wrapping: newer means less than half the range ahead
    const ahead = (sequence - player.sequence) & 0xffff;
    if (player.sequence >= 0) {
      if (ahead === 0 || ahead > 0x8000) return; // twice, or older than what we have
      lost += ahead - 1;
    }
    player.sequence = sequence;
    decodeInput(packet, player.input);
  });

  let step = 0;
  addHook(physics.afterStep, () => {
    step++;
    if (!transport.peers().length) return;
    if (step % HANDS_EVERY === 0) {
      // To each player what their own puppet's hands do, when it changes (the host's own write puppetState directly)
      for (const [id, player] of players) {
        const state = player.puppet?.grab?.state;
        if (!state || id === selfId) continue;
        const message: HandsMessage = { t: "hands", holding: [state.holding.left, state.holding.right], inReach: [state.inReach.left, state.inReach.right] };
        const text = JSON.stringify(message);
        if (text === player.hands) continue;
        player.hands = text;
        transport.sendReliable(message, id);
      }
    }
    if (step % SNAPSHOT_EVERY) return;
    for (const player of players.values()) {
      if (player.puppet) transport.sendFast(encodePoses(PACKET.puppet, player.slot, step, player.puppet.bodies));
    }
  });

  return {
    host: true,
    puppet: () => players.get(selfId)?.puppet,
    /** All puppets on the stage, by slot (tests) */
    puppets: () => [...players.values()].sort((a, b) => a.slot - b.slot).map((p) => p.puppet),
    players: () => players.size,
    lost: () => lost,
    pingTarget: () => transport.peers()[0],
  };
}

// ── Client ───────────────────────────────────────────────────────────────────

interface Remote {
  slot: number;
  buffer: PoseBuffer;
  puppet?: Puppet;
}

async function runClient(world: World, transport: Transport, selfId: string, status: (text: string) => void) {
  const remotes = new Map<string, Remote>();
  const clock = new HostClock();
  let hostId: string | undefined;
  let lastPose = 0;

  const remove = (id: string) => {
    remotes.get(id)?.puppet?.dispose();
    remotes.delete(id);
  };
  const add = async (id: string, slot: number) => {
    const remote: Remote = { slot, buffer: new PoseBuffer() };
    remotes.set(id, remote);
    // Our own puppet takes the local input: its cross starts where the puppet hangs
    const puppet = await spawnPuppet(world, { slot, mode: "replicated", input: id === selfId ? controlInput : undefined });
    if (remotes.get(id) !== remote) return puppet.dispose(); // left, or moved, while it loaded
    remote.puppet = puppet;
  };

  transport.onReliable((message, from) => {
    if (!isRoster(message)) return;
    if (message.v !== PROTOCOL) return status("Die Bühne läuft mit einer anderen Version: Seite neu laden");
    if (from !== hostId) {
      // A second host in the room by mistake: stay with the one that is alive,
      // instead of jumping between the two with every roster
      if (hostId && seconds() - lastPose < HOST_TIMEOUT) return;
      // A new host counts its steps from 0: forget the old one's time (and
      // what the old one's hands held: the new one tells)
      hostId = from;
      clock.reset();
      puppetState.holding.left = puppetState.holding.right = puppetState.inReach.left = puppetState.inReach.right = null;
      for (const remote of remotes.values()) remote.buffer.clear();
    }
    for (const [id, remote] of remotes) if (message.slots[id] !== remote.slot) remove(id);
    for (const [id, slot] of Object.entries(message.slots)) if (!remotes.has(id)) void add(id, slot);
  });
  const hostLeft = (id: string) => {
    // The puppets stay where they are until a host is back
    if (id === hostId) hostId = undefined;
  };
  transport.onPeerLeave(hostLeft);
  transport.onReliable((message, from) => {
    if (isMessage(message, "bye")) hostLeft(from);
    // Our puppet's hands are on the host: what they hold and could take
    if (from === hostId && isHands(message)) {
      [puppetState.holding.left = null, puppetState.holding.right = null] = message.holding;
      [puppetState.inReach.left = null, puppetState.inReach.right = null] = message.inReach;
    }
  });

  transport.onFast((packet, from) => {
    if (from !== hostId || packet[0] !== PACKET.puppet) return;
    const { id, step } = poseHeader(packet);
    const time = step * STEP;
    clock.observe(time);
    lastPose = seconds();
    for (const remote of remotes.values()) if (remote.slot === id) remote.buffer.push(time, packet);
  });

  // Every physics step: the bodies take the poses of a moment ago. Set before
  // the step, so rendering blends between two steps as for simulated bodies.
  const poses = new Float32Array(MAX_BODIES * POSE_SIZE);
  addHook(physics.beforeStep, () => {
    const time = clock.now() - INTERPOLATION_DELAY;
    for (const remote of remotes.values()) {
      if (remote.puppet) applyPoses(remote.puppet.bodies, poses, remote.buffer.sample(time, poses));
    }
  });

  // Every frame: our input to the host, and whether the stage is alive
  let sequence = 0;
  let lastInput = 0;
  addHook(physics.afterSync, () => {
    const now = seconds();
    status(!hostId ? waiting(transport) : now - lastPose > STALL_AFTER ? "Bühne pausiert" : "");
    // Not before our puppet stands: until then the input still holds a default place
    if (!hostId || !remotes.get(selfId)?.puppet || now - lastInput < 1 / INPUT_RATE - 0.002) return;
    lastInput = now;
    transport.sendFast(encodeInput(controlInput, sequence++), hostId);
  });

  return {
    host: false,
    puppet: () => remotes.get(selfId)?.puppet,
    puppets: () => [...remotes.values()].sort((a, b) => a.slot - b.slot).map((r) => r.puppet),
    players: () => remotes.size,
    lost: () => [...remotes.values()].reduce((sum, remote) => sum + remote.buffer.lost, 0),
    pingTarget: () => hostId,
  };
}
