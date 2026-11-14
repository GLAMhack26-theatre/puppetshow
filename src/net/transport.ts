import { joinRoom, type JsonValue, type TurnServerConfig } from "trystero";

// How the devices of one room talk (docs/architecture.md §3.3). Peers meet
// through Trystero: public Nostr relays carry the WebRTC handshake, encrypted
// with the room id, and after that the devices talk directly. No server of our
// own. Everything else in src/net/ only knows the Transport interface, so
// another way to connect (a WebSocket relay on the machine serving the app, if
// a Wi-Fi blocks direct connections) can replace this file's Trystero part.

const APP_ID = "skkg-puppetshow";

/** SCTP stream of our own lossy channel; Trystero's channel uses the first ones */
const LOSSY_CHANNEL_ID = 100;
/** Until the other side answered on the lossy channel, s between two probes */
const PROBE_INTERVAL = 0.5;
/** A lossy channel with this much queued is congested: drop, the next pose is newer anyway */
const MAX_QUEUED_BYTES = 16_384;
/** First byte of a probe; pose packets start at 1 (protocol.ts) */
const PROBE = 0;

export interface TransportStats {
  /** Peers whose pose traffic runs over the lossy channel, of all peers */
  lossy: number;
  peers: number;
  sent: number;
  received: number;
}

export interface Transport {
  /** Our own peer id, once the room is joined */
  ready: Promise<string>;
  peers(): string[];
  /** Also called for the peers that are already there */
  onPeerJoin(handler: (id: string) => void): void;
  onPeerLeave(handler: (id: string) => void): void;
  /** Ordered and complete: who plays which puppet, the state of the stage */
  sendReliable(message: JsonValue, to?: string): void;
  onReliable(handler: (message: JsonValue, from: string) => void): void;
  /** Poses: small packets many times a second, of which only the newest counts */
  sendFast(packet: Uint8Array, to?: string): void;
  onFast(handler: (packet: Uint8Array, from: string) => void): void;
  /** Round trip to a peer, ms */
  ping(id: string): Promise<number>;
  onError(handler: (message: string) => void): void;
  stats(): TransportStats;
}

/** TURN relay for networks that block direct connections: VITE_TURN_URLS (comma separated), VITE_TURN_USERNAME, VITE_TURN_CREDENTIAL */
function turnConfig(): TurnServerConfig[] | undefined {
  const urls = import.meta.env.VITE_TURN_URLS as string | undefined;
  if (!urls) return undefined;
  return [{ urls: urls.split(","), username: import.meta.env.VITE_TURN_USERNAME, credential: import.meta.env.VITE_TURN_CREDENTIAL }];
}

interface LossyChannel {
  channel: RTCDataChannel;
  /** The other side has it too: it answered on it */
  confirmed: boolean;
  probe?: ReturnType<typeof setInterval>;
}

/**
 * @param lossy Pose packets over an unordered channel without retransmits.
 * Trystero's own channel is ordered and complete: on a congested Wi-Fi one
 * lost packet holds back everything behind it. Off: everything over that one.
 */
export function createTransport(roomId: string, lossy = true): Transport {
  // The room id is also the password: it encrypts the handshake on the public relays
  const turn = turnConfig();
  const room = joinRoom({ appId: APP_ID, password: roomId, ...(turn ? { turnConfig: turn } : {}) }, roomId);
  const state = room.makeAction<JsonValue>("state");
  const pose = room.makeAction<Uint8Array>("pose");

  const fastHandlers: ((packet: Uint8Array, from: string) => void)[] = [];
  const errorHandlers: ((message: string) => void)[] = [];
  const channels = new Map<string, LossyChannel>();
  const counts = { sent: 0, received: 0 };
  const ignore = () => {}; // a peer that just left: nothing to do, the next packet is newer

  const receive = (packet: Uint8Array, from: string) => {
    counts.received++;
    for (const handler of fastHandlers) handler(packet, from);
  };
  pose.onMessage((data, { peerId }) => receive(data, peerId));

  // Our own channel next to Trystero's, on the same connection. Both sides
  // create it with the same id ("negotiated"), so nothing is announced in-band
  // and Trystero does not see it. It reports "open" even when the other side
  // never created it, so it is only used after the other side answered on it.
  const openLossy = (id: string) => {
    const connection = room.getPeers()[id]?.connection;
    if (!connection) return;
    let channel: RTCDataChannel;
    try {
      channel = connection.createDataChannel("puppet-poses", { negotiated: true, id: LOSSY_CHANNEL_ID, ordered: false, maxRetransmits: 0 });
    } catch {
      return; // stays on Trystero's channel
    }
    channel.binaryType = "arraybuffer";
    const entry: LossyChannel = { channel, confirmed: false };
    channels.set(id, entry);
    const probe = () => {
      if (channel.readyState === "open") channel.send(new Uint8Array([PROBE]));
    };
    channel.onopen = () => {
      probe();
      entry.probe = setInterval(() => (entry.confirmed ? clearInterval(entry.probe) : probe()), PROBE_INTERVAL * 1000);
    };
    channel.onmessage = (event) => {
      if (!entry.confirmed) {
        entry.confirmed = true;
        probe(); // so the other side knows too, whoever was first
      }
      const packet = new Uint8Array(event.data as ArrayBuffer);
      if (packet[0] !== PROBE) receive(packet, id);
    };
    channel.onclose = () => closeLossy(id);
  };
  const closeLossy = (id: string) => {
    const entry = channels.get(id);
    if (!entry) return;
    clearInterval(entry.probe);
    channels.delete(id);
  };

  room.onPeerJoin(({ peerId }) => lossy && openLossy(peerId));
  room.onPeerLeave(({ peerId }) => closeLossy(peerId));
  room.onError((error) => {
    for (const handler of errorHandlers) handler(`${error.code}: ${error.message}`);
  });

  const peers = () => Object.keys(room.getPeers());

  return {
    ready: room.getSelf().then((self) => self.peerId),
    peers,
    // replay: also the peers that were there before the handler (a host that
    // loads its stage first, or comes back after a reload, must not miss them)
    onPeerJoin: (handler) => void room.onPeerJoin(({ peerId }) => handler(peerId), { replay: true }),
    onPeerLeave: (handler) => void room.onPeerLeave(({ peerId }) => handler(peerId)),
    sendReliable: (message, to) => void state.send(message, to ? { target: to } : undefined).catch(ignore),
    onReliable: (handler) => void state.onMessage((data, { peerId }) => handler(data, peerId)),
    sendFast(packet, to) {
      const rest: string[] = [];
      for (const id of to ? [to] : peers()) {
        const entry = channels.get(id);
        if (!entry?.confirmed || entry.channel.readyState !== "open") {
          rest.push(id);
          continue;
        }
        counts.sent++;
        if (entry.channel.bufferedAmount > MAX_QUEUED_BYTES) continue;
        try {
          entry.channel.send(packet as Uint8Array<ArrayBuffer>);
        } catch {
          // closing: the next packet goes over Trystero's channel
        }
      }
      if (!rest.length) return;
      counts.sent += rest.length;
      pose.send(packet, { target: rest }).catch(ignore);
    },
    onFast: (handler) => void fastHandlers.push(handler),
    ping: (id) => room.ping(id),
    onError: (handler) => void errorHandlers.push(handler),
    stats: () => ({
      lossy: [...channels.values()].filter((c) => c.confirmed).length,
      peers: peers().length,
      sent: counts.sent,
      received: counts.received,
    }),
  };
}
