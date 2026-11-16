// Hands out short-lived credentials for our TURN server (docs/multiplayer.md,
// section 6.1), so that no password is built into the page and the server
// can stay on.
//
// A TURN server wants a user name and a password from the browser, so
// something always reaches the page. Here it is a pair that expires: the
// user name is the time until which it is valid, the password is an HMAC of
// that name made with a secret that only this service and coturn know
// (coturn's `use-auth-secret`, written by `setup-turn.sh --auth secret`).
// coturn recomputes the HMAC and refuses a name whose time has passed.
//
// What this does not do: tell our page from a copy of it. The app has no
// logins, so whoever can open the page can ask here too. It keeps a lasting
// password off the page, lets a pair die within the hour, and puts a limit
// on how fast pairs are handed out; the TURN server's own limits (rate per
// allocation, allocations per pair, no private addresses) bound the rest.
//
// Three ways to run it:
//
// - On its own (needs only Node 18 or newer, no npm install: setup-turn.sh
//   copies this one file to the server):
//
//     TURN_SECRET=… TURN_URLS=turn:turn.example.org:3478,… node scripts/turn-credentials.mjs
//
//   TURN_TTL          seconds a pair is valid (default 3600; the page fetches a new one at half time)
//   ALLOWED_ORIGINS   comma separated origins of the pages that may ask (https://user.github.io);
//                     empty: any page. Keeps other websites off, not scripts.
//   PORT, HOST        default 8788 on 127.0.0.1 (behind a proxy that does the TLS)
//   TLS_CERT, TLS_KEY PEM files: serve HTTPS itself, without a proxy
//
// - Inside scripts/signal-relay.mjs, when TURN_SECRET and TURN_URLS are set:
//   one process behind one proxy for the meeting point and the credentials.
// - Inside the Vite server (vite.config.ts), for the same two variables in
//   .env.local: for trying it out on a laptop.
//
// The page asks GET /turn-credentials and gets
//   { "urls": [...], "username": "<expiry>:<random>", "credential": "<base64>", "ttl": 3600 }
// which is the shape of an RTCIceServer plus the lifetime.
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { pathToFileURL } from "node:url";

export const CREDENTIALS_PATH = "/turn-credentials";

/** Pairs handed out per minute to one address: a class behind one router reloading, not a script in a loop */
const PER_MINUTE = 60;

/**
 * One pair, as coturn's `use-auth-secret` checks it ("TURN REST API"): the
 * name is "<unix time it expires>:<anything>", the password
 * base64(HMAC-SHA1(secret, name)). The random part makes every pair its own
 * user for coturn, so its `user-quota` is a limit per pair, not for everyone.
 */
export function turnCredentials(secret, { urls, ttl = 3600, now = Date.now() }) {
  const username = `${Math.floor(now / 1000) + ttl}:${randomBytes(6).toString("hex")}`;
  return { urls, username, credential: createHmac("sha1", secret).update(username).digest("base64"), ttl };
}

/** The settings from the environment (or a Vite env map); undefined when the service is not configured */
export function turnCredentialsOptions(env = process.env) {
  const secret = env.TURN_SECRET?.trim();
  const urls = (env.TURN_URLS ?? "").split(",").map((url) => url.trim()).filter(Boolean);
  if (!secret || !urls.length) return undefined;
  return {
    secret,
    urls,
    ttl: Number(env.TURN_TTL) || 3600,
    origins: (env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean),
  };
}

/**
 * A handler for node's http server (also as a connect middleware: it calls
 * `next` for every other path). Answers GET and OPTIONS on /turn-credentials.
 */
export function turnCredentialsHandler({ secret, urls, ttl = 3600, origins = [] }) {
  const asked = new Map(); // address → times of its last requests
  const tooMany = (address) => {
    const now = Date.now();
    const times = (asked.get(address) ?? []).filter((time) => now - time < 60_000);
    times.push(now);
    asked.set(address, times);
    // forget addresses that went quiet, so the map does not grow for ever
    if (asked.size > 10_000) for (const [key, value] of asked) if (now - value.at(-1) > 60_000) asked.delete(key);
    return times.length > PER_MINUTE;
  };

  return (request, response, next) => {
    if (new URL(request.url ?? "/", "http://turn").pathname !== CREDENTIALS_PATH) {
      if (next) return next();
      response.writeHead(404, { "Content-Type": "text/plain" });
      return response.end("Puppetshow TURN credentials: GET /turn-credentials\n");
    }
    // A page of another site sends its Origin; the app's own server (same
    // origin) sends none on a GET, and neither does curl
    const origin = request.headers.origin;
    const allowed = !origin || !origins.length || origins.includes(origin);
    const headers = {
      "Cache-Control": "no-store",
      Vary: "Origin",
      ...(origin && allowed ? { "Access-Control-Allow-Origin": origin } : {}),
    };
    const answer = (status, body) => {
      response.writeHead(status, { ...headers, "Content-Type": typeof body === "string" ? "text/plain" : "application/json" });
      response.end(typeof body === "string" ? `${body}\n` : JSON.stringify(body));
    };
    if (!allowed) return answer(403, "this page's origin is not in ALLOWED_ORIGINS");
    if (request.method === "OPTIONS") return answer(204, "");
    if (request.method !== "GET") return answer(405, "GET only");
    // Behind our own proxy the socket is the proxy: take the address it reports
    const forwarded = request.socket.remoteAddress?.includes("127.0.0.1") || request.socket.remoteAddress === "::1" ? request.headers["x-forwarded-for"] : undefined;
    const address = String(forwarded ?? request.socket.remoteAddress ?? "?").split(",").at(-1).trim();
    if (tooMany(address)) return answer(429, "too many requests, try again in a minute");
    answer(200, turnCredentials(secret, { urls, ttl }));
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = turnCredentialsOptions();
  if (!options) {
    console.error("TURN_SECRET and TURN_URLS are needed (docs/multiplayer.md, section 6.1)");
    process.exit(2);
  }
  const port = Number(process.env.PORT ?? 8788);
  const host = process.env.HOST ?? "127.0.0.1";
  const tls = process.env.TLS_CERT && process.env.TLS_KEY;
  const handler = turnCredentialsHandler(options);
  const server = tls ? createTlsServer({ cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }, handler) : createServer(handler);
  server.listen(port, host, () => {
    console.log(`TURN credentials on ${tls ? "https" : "http"}://${host}:${port}${CREDENTIALS_PATH}, valid ${options.ttl} s, for ${options.origins.join(", ") || "any page"}`);
  });
}
