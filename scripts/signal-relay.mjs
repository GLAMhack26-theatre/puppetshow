// Our own meeting point for the devices of a room (docs/multiplayer.md), for
// when the public Nostr relays cannot be used: a network without internet,
// or one that blocks them. It only passes the WebRTC handshake between the
// devices (Trystero's ws-relay: topics and encrypted blobs); the puppets'
// data never goes through it.
//
// Two ways to run it:
//
// - Inside the Vite server (vite.config.ts attaches it under /relay, in dev
//   and in preview). The page and the relay then share one address and one
//   certificate. The app uses it when it is built or served with
//   VITE_SIGNAL_URLS=/relay.
// - On its own, behind a reverse proxy that does the TLS (a page served over
//   HTTPS may only open wss://):
//
//     node scripts/signal-relay.mjs            # 127.0.0.1:8787, path /relay
//     PORT=9000 HOST=0.0.0.0 node scripts/signal-relay.mjs
//
//   and the app built with VITE_SIGNAL_URLS=wss://signal.example.org/relay.
//   With TURN_SECRET and TURN_URLS set it also hands out the TURN server's
//   short-lived credentials under /turn-credentials (turn-credentials.mjs),
//   so one process behind one proxy does both.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createWsRelayServer } from "@trystero-p2p/ws-relay/server";
import { CREDENTIALS_PATH, turnCredentialsHandler, turnCredentialsOptions } from "./turn-credentials.mjs";

export const RELAY_PATH = "/relay";

/**
 * Answers WebSocket upgrades for `path` on an existing HTTP(S) server. Every
 * other upgrade is left alone: the Vite dev server has its own socket (HMR)
 * on the same server, and a WebSocket server bound to a path with ws'
 * `server` option would refuse those.
 */
export function attachSignalRelay(httpServer, path = RELAY_PATH) {
  const relay = createWsRelayServer({ noServer: true, onError: (error) => console.warn("[signal-relay]", error.message) });
  httpServer.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://relay").pathname !== path) return;
    relay.wss.handleUpgrade(request, socket, head, (client) => relay.wss.emit("connection", client, request));
  });
  return relay;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  // Behind a proxy on the same machine by default; HOST=0.0.0.0 opens it to the network
  const host = process.env.HOST ?? "127.0.0.1";
  const turn = turnCredentialsOptions();
  const credentials = turn && turnCredentialsHandler(turn);
  const rest = (request, response) => {
    // For the proxy's or a monitor's health check
    const ok = request.url === "/health";
    response.writeHead(ok ? 200 : 404, { "Content-Type": "text/plain" });
    response.end(ok ? `ok ${relay.getSubscriberCount()} subscriptions\n` : "Puppetshow signal relay: WebSocket on /relay\n");
  };
  const server = createServer((request, response) => (credentials ? credentials(request, response, () => rest(request, response)) : rest(request, response)));
  const relay = attachSignalRelay(server);
  server.listen(port, host, () => {
    console.log(`signal relay on ws://${host}:${port}${RELAY_PATH} (put TLS in front: docs/multiplayer.md)`);
    if (turn) console.log(`TURN credentials on http://${host}:${port}${CREDENTIALS_PATH}, valid ${turn.ttl} s, for ${turn.origins.join(", ") || "any page"}`);
  });
}
