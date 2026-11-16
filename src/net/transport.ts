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
//    otherwise through a TURN server (scripts/setup-turn.sh). Its credentials
//    are fetched when the room is joined and expire
//    (VITE_TURN_CREDENTIALS_URL, scripts/turn-credentials.mjs), or are fixed
//    ones built into the page (VITE_TURN_URLS, _USERNAME, _CREDENTIAL).
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
/** s to wait for the TURN credentials before joining without them: a dead service must not keep a LAN room from starting */
const CREDENTIALS_TIMEOUT = 3;
/** s between two looks at the credentials: renewed at half their lifetime, asked for again after a failure */
const CREDENTIALS_CHECK = 30;

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
  /**
   * The TURN server's credentials, for the HUD: "-" (none configured),
   * "fixed" (built into the page), "fresh, 42 min left" (fetched), or
   * "no credentials (…)" when the service did not answer.
   */
  turn(): string;
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

/**
 * A TURN server with fixed credentials, built into the page where anyone can
 * read them: VITE_TURN_URLS (comma separated), VITE_TURN_USERNAME,
 * VITE_TURN_CREDENTIAL. For a server that runs for one event, or a hosted
 * one whose credentials expire by themselves.
 */
function fixedTurn(): TurnServerConfig[] {
  const urls = import.meta.env.VITE_TURN_URLS as string | undefined;
  if (!urls) return [];
  return [{ urls: urls.split(","), username: import.meta.env.VITE_TURN_USERNAME, credential: import.meta.env.VITE_TURN_CREDENTIAL }];
}

interface FetchedTurn {
  servers: TurnServerConfig[];
  /** Date.now() of the answer (the wall clock: it also runs while the device sleeps), and how long the pair is valid from then, ms */
  at: number;
  lifetime: number;
}

/**
 * Credentials that expire, from our own service (VITE_TURN_CREDENTIALS_URL:
 * scripts/turn-credentials.mjs; a path is taken on the server the page came
 * from). Nothing lasting is in the page that way, so the TURN server can stay
 * on. The answer is an RTCIceServer plus `ttl` in seconds.
 */
async function fetchTurn(url: string): Promise<FetchedTurn> {
  const response = await fetch(new URL(url, location.href), { cache: "no-store", signal: AbortSignal.timeout(CREDENTIALS_TIMEOUT * 1000) });
  if (!response.ok) throw new Error(`${response.status}`);
  const { urls, username, credential, ttl } = (await response.json()) as { urls?: string[]; username?: string; credential?: string; ttl?: number };
  if (!Array.isArray(urls) || !username || !credential || !ttl) throw new Error("unexpected answer");
  return { servers: [{ urls, username, credential }], at: Date.now(), lifetime: ttl * 1000 };
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

export async function createTransport(roomId: string, { lossy = true, relayOnly = false }: TransportOptions = {}): Promise<Transport> {
  const own = signalUrls();
  // The room id is also the password: it encrypts the handshake on the relays
  const config = {
    appId: APP_ID,
    password: roomId,
    turnConfig: fixedTurn(),
    ...(relayOnly ? { rtcConfig: { iceTransportPolicy: "relay" as const } } : {}),
  };

  // Fetched credentials: before the room is joined, because the first
  // connections are prepared right then; and again at half their lifetime.
  // Trystero reads `config.turnConfig` for every connection it prepares (at
  // most 3 minutes ahead), so replacing the list is enough for the later
  // ones. Connections that stand keep running: coturn only checks the
  // expiry when a connection first asks (tested, docs/multiplayer.md §9).
  const fixed = config.turnConfig;
  const credentialsUrl = (import.meta.env.VITE_TURN_CREDENTIALS_URL as string | undefined)?.trim();
  let fetched: FetchedTurn | undefined;
  let credentialsError = "";
  const valid = () => !!fetched && Date.now() < fetched.at + fetched.lifetime;
  const renew = async () => {
    try {
      fetched = await fetchTurn(credentialsUrl!);
      credentialsError = "";
    } catch (error) {
      credentialsError = error instanceof Error ? error.message : String(error);
      console.warn("[net] TURN credentials:", credentialsError);
    }
    config.turnConfig = [...fixed, ...(valid() ? fetched!.servers : [])];
  };
  if (credentialsUrl) {
    await renew();
    const check = () => {
      if (!fetched || Date.now() > fetched.at + fetched.lifetime / 2) void renew();
    };
    setInterval(check, CREDENTIALS_CHECK * 1000);
    // A device that slept with the page open: its timers stood still
    document.addEventListener("visibilitychange", () => document.hidden || check());
  }

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
    turn: () => {
      if (!credentialsUrl) return fixed.length ? "fixed" : "-";
      if (!valid()) return `no credentials (${credentialsError || "expired"})`;
      const left = Math.round((fetched!.at + fetched!.lifetime - Date.now()) / 60_000);
      return `fresh, ${left} min left${credentialsError ? ` (renewal failed: ${credentialsError})` : ""}`;
    },
  };
}
