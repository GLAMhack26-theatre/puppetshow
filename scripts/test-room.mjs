// A room in headless Chrome: a host tab and one or more client tabs on this
// machine, and how they are connected (docs/multiplayer.md). It checks the
// app's settings and our servers (the meeting point, a TURN server); it
// cannot stand in for real devices on a real Wi-Fi.
//
//   node scripts/test-room.mjs [base url] [options]      (default http://localhost:5173)
//
//   --players <n>         tabs in the room (default 2)
//   --relay-only          every tab with &ice=relay: only through the TURN server
//   --client-relay-only   only the clients: a player behind a strict network, the host on an open one
//   --offline             no name resolves but the server's own: no public relays, no STUN
//   --no-camera           without camera permission: browsers then hide the LAN address behind a .local name
//   --stay <seconds>      stay connected that long and report the traffic
//
// Exit code 0 when every tab shows every puppet, 1 otherwise. For a check
// that must fail (relay-only without a TURN server), 1 is the right answer.
//
// Needs Chrome and playwright-core, which is in node_modules through IWSDK
// (not a dependency of ours: if it is gone, `npm i -D playwright-core`).
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const base = (args[0] && !args[0].startsWith("--") ? args[0] : "http://localhost:5173").replace(/\/$/, "");
const players = Number(value("--players", 2));
const stay = Number(value("--stay", 0));

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright-core"));
} catch {
  console.error("playwright-core not found: npm i -D playwright-core");
  process.exit(2);
}

const room = "t" + Math.random().toString(36).slice(2, 10);
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    // WebGL without a window, and no throttling of the tab that is not in front
    ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
    "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    ...(flag("--offline") ? [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE ${new URL(base).hostname}`] : []),
  ],
});

const messages = new Set();
const open = async (query, name) => {
  // ignoreHTTPSErrors: the dev server's self-signed certificate
  const context = await browser.newContext({ viewport: { width: 900, height: 600 }, ignoreHTTPSErrors: true });
  // With camera permission Chrome offers every network interface's own address
  if (!flag("--no-camera")) await context.grantPermissions(["camera", "microphone"]);
  const page = await context.newPage();
  page.on("console", (message) => /\[net\]/.test(message.text()) && messages.add(`${name}: ${message.text().slice(0, 220)}`));
  page.on("pageerror", (error) => messages.add(`${name}: page error: ${error.message}`));
  await page.goto(`${base}/?test=nocurtain&debug&room=${room}${query}`);
  return page;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, timeout) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn().catch(() => false)) return (Date.now() - start) / 1000;
    await wait(500);
  }
};
const puppets = (page) => page.evaluate(() => globalThis.net?.session.puppets().filter(Boolean).length ?? 0);
const report = (page) =>
  page.evaluate(async () => {
    const { transport } = globalThis.net;
    const stats = transport.stats();
    return {
      status: document.getElementById("net-status")?.textContent ?? "",
      signal: `${transport.signaling.label} ${transport.signaling.open()}/${transport.signaling.total()}`,
      peers: stats.peers,
      lossy: stats.lossy,
      path: (await transport.paths()).join(" ") || "-",
    };
  });

const relayOnly = flag("--relay-only") ? "&ice=relay" : "";
const pages = [await open(`&host${relayOnly}`, "host")];
if (!(await until(async () => (await puppets(pages[0])) === 1, 30000))) {
  console.log("FAIL the host's puppet does not stand: is the app served at", base, "?");
  await browser.close();
  process.exit(1);
}
for (let i = 1; i < players; i++) pages.push(await open(relayOnly || (flag("--client-relay-only") ? "&ice=relay" : ""), `client ${i}`));

const took = await until(async () => (await Promise.all(pages.map(puppets))).every((count) => count === players), 30000);
console.log(took === undefined ? `FAIL not every tab shows ${players} puppets after 30 s` : `ok   every tab shows ${players} puppets (${took.toFixed(1)} s)`);
await wait(2500);
for (const [i, page] of pages.entries()) console.log(i ? `client ${i}` : "host    ", JSON.stringify(await report(page).catch(() => "no session")));

if (took !== undefined && stay) {
  const sample = (page) => page.evaluate(() => ({ ...globalThis.net.transport.stats(), lost: globalThis.net.session.lost() }));
  const before = await Promise.all(pages.map(sample));
  await wait(stay * 1000);
  const after = await Promise.all(pages.map(sample));
  for (const [i, page] of pages.entries()) {
    const per = (key) => ((after[i][key] - before[i][key]) / stay).toFixed(0);
    const rtt = await page.evaluate(() => document.getElementById("hud")?.textContent?.match(/rtt\s+(.*)/)?.[1] ?? "-");
    console.log(i ? `client ${i}` : "host    ", `over ${stay} s: in ${per("received")}/s out ${per("sent")}/s, lost ${after[i].lost - before[i].lost}, rtt ${rtt}`);
  }
}
for (const message of [...messages].slice(0, 8)) console.log(message);
await browser.close();
process.exit(took === undefined ? 1 : 0);
