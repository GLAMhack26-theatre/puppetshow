import { getRelaySockets as nostrSockets, joinRoom as joinOverNostr, type JsonValue, type TurnServerConfig } from "trystero";
import { getRelaySockets as ownSockets, joinRoom as joinOverOwnRelay } from "@trystero-p2p/ws-relay";

// How the devices of one room talk (docs/architecture.md §3.3, set-up and
// troubleshooting in docs/multiplayer.md). Three things have to work:
//
// 1. Meeting (signaling). Through Trystero: public Nostr relays carry the
//    WebRTC handshake, encrypted with the room id. No server of our own.
//    With VITE_SIGNAL_URLS the devices meet at our own relay instead
//    (scripts/signal-relay.mjs; the Vite server runs one under /relay), for
//    a network without internet or one that blocks the public relays.
// 2. A path between two devices (ICE): directly where the network lets them;
//    otherwise through a TURN server (VITE_TURN_*, scripts/setup-turn.sh).
// 3. The data: WebRTC data channels on that path, never through a relay of
//    the first kind.
//
// Everything else in src/net/ only knows the Transport interface, so another
// way to connect (game data over a WebSocket server, without WebRTC) can
// replace this file's Trystero part.

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

/**
 * How the traffic to a peer travels: "lan" (directly, between addresses of
 * the devices themselves), "nat" (directly, through a router's address
 * translation), "turn/udp|tcp|tls" (through a TURN server, reached that way
 * from here), "turn" (through the other side's TURN server), "?" (not known).
 * A device always knows its own detour; the other side's it may take for
 * "nat", so look at the device behind the difficult network.
 */
export type PeerPath = string;

export interface Signaling {
  /** Our own relay instead of the public Nostr relays (VITE_SIGNAL_URLS) */
  own: boolean;
  /** "nostr", or our relay's host */
  label: string;
  /** Relay sockets that are open, of how many */
  open(): number;
  total(): number;
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
  /** Where the devices of the room meet. Every device must use the same place, or they never see each other */
  signaling: Signaling;
  /** One entry per peer, in the order of peers() */
  paths(): Promise<PeerPath[]>;
}

export interface TransportOptions {
  /**
   * Pose packets over an unordered channel without retransmits. Trystero's own
   * channel is ordered and complete: on a congested Wi-Fi one lost packet
   * holds back everything behind it. Off: everything over that one.
   */
  lossy?: boolean;
  /** Only through the TURN server, never directly: shows whether the TURN server works (&ice=relay) */
  relayOnly?: boolean;
}

/** TURN relay for networks that block direct connections: VITE_TURN_URLS (comma separated), VITE_TURN_USERNAME, VITE_TURN_CREDENTIAL */
function turnConfig(): TurnServerConfig[] | undefined {
  const urls = import.meta.env.VITE_TURN_URLS as string | undefined;
  if (!urls) return undefined;
  return [{ urls: urls.split(","), username: import.meta.env.VITE_TURN_USERNAME, credential: import.meta.env.VITE_TURN_CREDENTIAL }];
}

/**
 * Our own meeting point: VITE_SIGNAL_URLS, comma separated. A path ("/relay")
 * is taken on the server the page came from, so a certificate accepted for
 * the page also covers the relay.
 */
function signalUrls(): string[] | undefined {
  const urls = import.meta.env.VITE_SIGNAL_URLS as string | undefined;
  if (!urls?.trim()) return undefined;
  return urls.split(",").map((entry) => {
    const url = new URL(entry.trim(), location.href);
    url.protocol = url.protocol.replace("http", "ws");
    return url.href;
  });
}

/** The pair of addresses in use on a connection, as a PeerPath */
async function pathOf(connection: RTCPeerConnection): Promise<PeerPath> {
  try {
    const stats = await connection.getStats();
    let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
    });
    // Browsers without a transport report: the pair that was chosen
    if (!pair) {
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && (report.selected || (report.nominated && report.state === "succeeded"))) pair ??= report;
      });
    }
    const local = pair?.localCandidateId ? stats.get(pair.localCandidateId) : undefined;
    const remote = pair?.remoteCandidateId ? stats.get(pair.remoteCandidateId) : undefined;
    if (!local) return "?";
    // relayProtocol also marks an address that was only found through the
    // TURN server (type "prflx"): the traffic still goes through it
    if (local.candidateType === "relay" || local.relayProtocol) return `turn/${local.relayProtocol ?? local.protocol ?? "?"}`;
    // The other side's relay does not always show here (it may be "prflx"
    // too, without a mark): its own device tells for sure
    if (remote?.candidateType === "relay") return "turn";
    return local.candidateType === "host" && (!remote || remote.candidateType === "host") ? "lan" : "nat";
  } catch {
    return "?";
  }
}

interface LossyChannel {
  channel: RTCDataChannel;
  /** The other side has it too: it answered on it */
  confirmed: boolean;
  probe?: ReturnType<typeof setInterval>;
}

export function createTransport(roomId: string, { lossy = true, relayOnly = false }: TransportOptions = {}): Transport {
  const turn = turnConfig();
  const own = signalUrls();
  // The room id is also the password: it encrypts the handshake on the relays
  const config = {
    appId: APP_ID,
    password: roomId,
    ...(turn ? { turnConfig: turn } : {}),
    ...(relayOnly ? { rtcConfig: { iceTransportPolicy: "relay" as const } } : {}),
  };
  const room = own ? joinOverOwnRelay({ ...config, relayConfig: { urls: own } }, roomId) : joinOverNostr(config, roomId);
  const sockets = own ? ownSockets : nostrSockets;
  const signaling: Signaling = {
    own: !!own,
    label: own ? new URL(own[0]).host : "nostr",
    open: () => Object.values(sockets()).filter((socket) => socket.readyState === WebSocket.OPEN).length,
    total: () => Object.keys(sockets()).length,
  };
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
    signaling,
    paths: () => Promise.all(Object.values(room.getPeers()).map((peer) => (peer.connection ? pathOf(peer.connection) : "?"))),
  };
}
