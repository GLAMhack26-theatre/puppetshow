# Multiplayer: set-up, networks, servers

How several devices get onto one stage, what each network needs for that, and what to do when a network is in the way. The design (who simulates, which messages, why) is in `docs/architecture.md` §3.3; this file is the operator's side: links, settings, servers, checks, FAQ.

Every claim about a network or a server below carries how it is known:

- **tested**: run here on 2026-11-15, two or three headless Chrome tabs on one Mac (section 9 lists every run). That checks our settings and servers, not a real Wi-Fi.
- **source**: read from the installed Trystero 0.27.0 code or its docs.
- **not tested**: follows from how WebRTC and browsers work, or from a provider's docs. Nobody has run it for this project yet.

**Not tested at all yet: real devices.** No iPhone, no Quest 2, no venue Wi-Fi, no mobile network, no rented server.

## 1. In short

- One device is the **host** (`?room=<secret>&host`). It simulates every puppet. All other devices (`?room=<secret>`) send their input and show what the host sends.
- Three things have to work, in this order. Each can fail on its own, and each has its own fix:

| Layer | What it is | By default | When it fails | Fix |
|---|---|---|---|---|
| 1. Page | The app itself, over HTTPS | GitHub Pages, or `npm run dev:https` on a laptop | The device cannot load the page | Another place to serve it from |
| 2. Meeting (signaling) | The devices of a room find each other and swap connection details | Five public Nostr relays on the internet | No internet, or the relays are blocked | Our own relay (section 6.2) |
| 3. Path (ICE) | A way for packets between two devices | Directly: on the LAN, or through the routers with the help of public STUN servers | The network forbids device-to-device traffic, or both sit behind strict routers | A TURN server (section 6.1) |

- The game data (inputs, poses) only ever travels on the path of layer 3, over WebRTC data channels, encrypted between the two browsers. It never goes through a relay of layer 2.
- **No server of our own is needed** as long as the devices have internet and the network lets them talk to each other. That is the default and what the first slice was built for.

```
   device A                                                device B
      │  1. page   ── HTTPS ──▶  GitHub Pages / laptop  ◀── HTTPS ──  │
      │  2. meet   ── wss ────▶  Nostr relays / our relay ◀── wss ──  │
      │  3. path   ◀═══════ WebRTC, directly where possible ═══════▶  │
      │            ◀══ or: ══▶   TURN server   ◀══════════════════▶   │
```

## 2. Starting a room

| Who | Link |
|---|---|
| Host (the strongest device, exactly one) | `https://<app>/?room=<secret>&host` (without `room` it makes one up and puts it in the address bar) |
| Everyone else | `https://<app>/?room=<secret>` |

- `<app>` is wherever the page is served: the GitHub Pages address, or `https://<laptop's LAN address>:5173` with `npm run dev:https`.
- The page must come over **HTTPS** (or from `localhost`): the camera and the encryption of the handshake only exist on secure pages (not tested: an `http://192.168…` link is expected to fail before it gets anywhere).
- The room id is also the password that encrypts the handshake. Whoever knows it can join. A made-up one has 8 hex digits; for a room that stays open on the internet, pick a longer one.
- The host's line at the top shows `Raum <id> · <n> Spieler`. A client shows `Warte auf die Bühne …` until it has found the host.
- Up to six puppets. A seventh device gets no puppet and watches.
- The host's tab must stay visible: its physics runs in the render loop, and a hidden tab pauses every stage (`Bühne pausiert` on the clients).
- Each device clicks a sign itself (that click is what its camera needs).

Link parameters:

| Parameter | Where | Effect |
|---|---|---|
| `room=<secret>` | all | The room. Same secret, same stage |
| `host` | one device | This device simulates |
| `debug` | any | Shows the HUD with the network lines (section 7); Shift+D does the same |
| `ice=relay` | any | Only through the TURN server, never directly. For checking a TURN server (section 6.1) |
| `lossy=0` | any | Poses over Trystero's ordered channel instead of our lossy one. For comparing on a bad Wi-Fi |
| `contact=0` | host | Puppets pass through each other |

Build-time settings, in `.env.local` next to `package.json` (git-ignored; read by `npm run dev`, `dev:https` and `build`):

```sh
# Our own meeting point instead of the public relays (section 6.2).
# A path means: on the server this page came from. Or a full wss:// address.
VITE_SIGNAL_URLS=/relay

# A TURN server (section 6.1). Several addresses, comma separated.
VITE_TURN_URLS=turn:turn.example.org:3478,turn:turn.example.org:3478?transport=tcp
VITE_TURN_USERNAME=puppet
VITE_TURN_CREDENTIAL=<secret>
```

Without any of them the app behaves as before. For the GitHub Pages build the same four names are read from the repository's Actions **variables** (Settings → Secrets and variables → Actions → Variables), then re-run the deploy workflow.

**Every device of a room must use the same meeting point.** A device on the public relays and one on our own relay never see each other, and nothing fails visibly (tested). With our own relay the client's waiting line names it: `Warte auf die Bühne … (Treffpunkt 192.168.1.20:5173)`.

## 3. How the devices find each other (layer 2)

A web page cannot look for other devices on the Wi-Fi: browsers have no broadcast or mDNS API. So two browsers always need a third place to exchange their first messages, even when they sit on the same table. That place only introduces them; it carries a few kilobytes per connection and none of the game.

**Default: public Nostr relays (serverless for us).**

- Trystero's Nostr strategy opens WebSockets (`wss://`, port 443) to 5 of its 30 built-in public relays. Which five is derived from our app id, so every device picks the same: `nostr.hifish.org`, `fanfares.nostr1.com`, `yabu.me`, `no.str.cr`, `relay.mostro.network` (source). All five answered on 2026-11-15, and 27 of the 30 (tested).
- Each device announces itself under a topic and listens there. The topic is a SHA-256 hash of app id and room id, and offers and answers are encrypted with a key derived from the room id (AES-GCM, PBKDF2), so a relay's operator sees neither the room id nor the connection details (source). A hash can be guessed by trying ids, which is one more reason for a long id on a room that stays open.
- One working relay is enough. In the tests two tabs found each other and had both puppets on screen about 1 s after the second one opened.
- These relays belong to strangers. They can disappear, rate-limit or be blocked by a network's filter. The HUD line `signal nostr 5/5` shows how many are connected right now.

**Our own relay** (section 6.2): the same job on a machine of ours, with `VITE_SIGNAL_URLS`. Needed where there is no internet, or where the public relays are blocked.

**What the meeting point decides:** who can find whom. Nothing else. A room whose devices found each other can still fail at layer 3.

## 4. How a path is found (layer 3)

Once introduced, the two browsers try every way to reach each other at once (ICE) and keep the best that works:

| Kind | What | Needs | HUD `path` |
|---|---|---|---|
| Host address | The device's own address on the Wi-Fi or LAN | Both on one network that lets devices talk to each other | `lan` |
| Server-reflexive (STUN) | The address the router shows to the internet, learnt from a public STUN server (Google, Cloudflare; built into Trystero) | Internet; routers that keep one outside address per device | `nat` |
| Relay (TURN) | Both send to a TURN server, which passes the packets on | A TURN server and its credentials (ours to provide) | `turn/udp`, `turn/tcp`, `turn/tls` |

Details that matter in practice:

- **Camera permission changes what a browser offers.** Without it, browsers hide the device's LAN address behind a random `.local` name, which the other device can only resolve if the network passes multicast DNS. With camera permission the real address is offered. Tested: with no name resolution at all, two tabs with camera permission connect (`lan`), two without do not, and with a TURN server configured they connect through it.
- **The room is joined when the page loads, before the sign click that asks for the camera.** A device that visits for the first time therefore joins without the permission; one that has allowed the camera before (the browser remembers it per address) has it from the start. So on a network where the direct path depends on it: allow the camera on every device, then **reload**. Whether a permission given after joining already helps for devices that join later is not tested. A device that only watches never asks.
- **A VPN as the default route** breaks the direct path even between two tabs of one machine, until the tabs have camera permission (seen on 2026-11-15).
- **Every device connects to every other**, not just to the host (tested: three tabs, two peers each). Only the links to the host carry the game. A failed link between two clients shows as a `peer-connect-failed` warning in the console and does no harm, with one exception in section 10.
- A TURN server is only used by the pairs that need it. Configured and not needed, the devices still connect directly (tested: `path lan`).
- Often only one side goes through the TURN server; the other talks to it directly. The device behind the difficult network shows `turn/…`; the other may show `nat` (tested). Look at both.

## 5. Networks

What each kind of network does to the three layers. "Works today" means: with the default build, no server of ours.

| Network | Page | Meeting | Path | Works today | What to do |
|---|---|---|---|---|---|
| Home or office Wi-Fi, internet, devices can reach each other | ✓ | ✓ | `lan` | Yes (tested as far as one machine can) | Nothing |
| Wired LAN with internet | ✓ | ✓ | `lan` | Yes, as above (not tested) | Nothing |
| **Wi-Fi with client isolation** (guest networks, hotels, many venues): devices reach the internet but not each other | ✓ from the internet; ✗ from a laptop on that Wi-Fi | ✓ | ✗ direct; the routers' outside address usually does not loop back either | **No**: clients wait, console shows `peer-connect-failed` | A TURN server on the internet (6.1), or your own Wi-Fi (section 5.1) |
| **Wi-Fi or LAN without internet** (own router, no uplink) | ✓ from a laptop on it | ✗ | `lan`, if cameras are allowed or `.local` names resolve | **No**: `signal nostr 0/5` | Our own relay on the laptop (6.2); tested offline |
| Devices in different places, each behind a home router | ✓ | ✓ | `nat` for most routers; ✗ when both are strict | Mostly (not tested) | A TURN server for the pairs that fail |
| **Mobile networks** (4G/5G) | ✓ | ✓ | Often ✗: carriers put many phones behind one address and give each connection its own port, which STUN cannot predict | Unreliable (not tested) | A TURN server. Expect to need it whenever a phone on mobile data plays |
| Network that blocks UDP | ✓ | ✓ | ✗ | No | TURN over TCP (`?transport=tcp`): tested here |
| Network that only lets web traffic out (TCP 443) | ✓ | ✓ if `wss://` passes | ✗ | No | TURN over TLS on port 443 (`turns:`): the script can set it up, **not tested** |
| Network that blocks or filters the public relays | ✓ | ✗ | – | No: `signal nostr 0/5` | Our own relay on a normal web address (6.2) |
| VPN on a device | ✓ | ✓ | May break `lan` | Sometimes | Switch it off, or allow the camera |

The mobile row in plain words: a direct path needs at least one of the two routers to behave simply. Two phones on mobile data often both do not. A phone on mobile data and a host on a friendly home Wi-Fi often do connect directly. It cannot be predicted from outside: look at the `path` line.

### 5.1 If the Wi-Fi forbids device-to-device traffic: where the packets can go

WebRTC itself still works on such a network; only the direct path is gone. The packets need a detour over a machine both devices can reach. The choices, best first:

1. **Do not use that Wi-Fi for the players.** Bring a small router or use a phone's hotspot: your own Wi-Fi, without isolation. With an uplink (the venue's network on the router's WAN port, or mobile data) everything works as at home. Without an uplink, add our own relay (6.2). No TURN server, no extra delay. Whether a given phone's hotspot lets its guests talk to each other is not tested: check for `path lan`.
2. **A TURN server on the internet** (6.1). Each packet goes device → venue uplink → server → venue uplink → device. Every device needs to reach the server: UDP 3478, or TCP 3478, or TLS on 443 if the venue blocks the rest. Cost: one round trip to the server added to every packet's way, so pick a server close by (same country); and the venue's uplink carries the traffic twice (numbers in section 8).
3. **A TURN server inside the venue's network**, on a machine the isolated devices are allowed to reach, typically a wired port. Isolation on many networks only separates wireless guests from each other; whether a wired machine is reachable is the network admin's to say. Shorter way than 2, same set-up (`setup-turn.sh --lan`). A laptop on the isolated Wi-Fi itself cannot be that machine: it is as isolated as the rest. For the same reason the page cannot come from that laptop either; use the GitHub Pages build.
4. **No WebRTC at all: the game data through a WebSocket server.** Not built. `src/net/transport.ts` is made so that a second transport can replace Trystero: every device would hold one `wss://` connection to a server that passes inputs to the host and poses to the clients. It would work wherever the page loads. The price: a server that carries all traffic all the time, and TCP, where one lost packet holds back all later ones (the reason the poses have their own lossy channel now). A TURN server reached over TCP or TLS has the same weakness and needs no new code, so this only becomes interesting if a network blocks even that.

## 6. Servers

Which servers exist, and which set-up needs which:

| Set-up | Page | Meeting | Path | Servers of ours |
|---|---|---|---|---|
| **A. Serverless** (default) | GitHub Pages | Public relays | Direct | None |
| **B. Difficult networks with internet** | GitHub Pages | Public relays | Direct, TURN where needed | TURN (hosted, or `setup-turn.sh` on a rented server) |
| **C. One laptop, no internet** | The laptop (`dev:https` or `preview`) | The laptop (`/relay`) | Direct on the LAN | None beyond the laptop; TURN on it only if devices cannot be given camera permission |
| **D. All our own** | Any static web server | Our relay (`signal-relay.mjs`) | Direct, TURN where needed | A rented server with relay and TURN |

### 6.1 A TURN server

**Hosted** (no machine to look after; none of these was tried here):

- Cloudflare Realtime TURN: credentials are made with an API call and expire after the time asked for. Make them shortly before the event with a lifetime longer than the event, and copy `urls`, `username` and `credential` from the answer into `VITE_TURN_*` (leave out any address on port 53, which browsers block). Docs: <https://developers.cloudflare.com/realtime/turn/generate-credentials/>. It offers UDP and TCP on 3478 and TLS on 443 and 5349 (from those docs).
- Others of the same kind: Metered, Twilio Network Traversal, Xirsys. Prices and free allowances: see each provider.

**Our own**, with coturn on a rented Linux server (Debian or Ubuntu, a public address, the smallest size is enough):

```sh
# on the server, as root, from a checkout of this repo (or just copy the one file)
sudo bash scripts/setup-turn.sh
# with a DNS name pointing at the server: also TLS (turns:), for networks that only let TLS out
sudo bash scripts/setup-turn.sh --domain turn.example.org --email you@example.org
# TLS on 443 instead of 5349, for networks that only let web traffic out (the port must be free: no web server on this machine)
sudo bash scripts/setup-turn.sh --domain turn.example.org --email you@example.org --tls-port 443
```

It installs coturn, writes `/etc/turnserver.conf`, opens the ports in `ufw` if that is on, starts the service, runs coturn's own test with two relayed clients, and prints the three `VITE_TURN_*` lines. `--help` lists the options.

What it does and does not cover:

- **Tested here, with browsers:** the config it writes with `--config-only --lan`, run with coturn 4.19 in Docker on this Mac: two and three browser tabs with `&ice=relay` connect through it over UDP and over TCP, lossy channel included, none of 60 packets a second lost.
- **Tested here, without browsers:** the whole script in a Debian 12 container (apt's coturn 4.6.1, a made-up public address, a stand-in for systemd): it installs, writes the config, coturn accepts every line, its self-test passes (two relayed clients reach each other through the public/private address pair, as on a cloud server behind 1:1 NAT), and a second run keeps the password. The rules against private addresses work: a peer on another private address is refused (`403 Forbidden IP`).
- **Not tested:** a real server with a public address, systemd, ufw, the certificate from Let's Encrypt and `turns:`. Expect to fix something on the first real run, and read `journalctl -u coturn`.
- **The cloud provider's own firewall** (security group) is outside the script's reach. Open there too: UDP 3478, TCP 3478, UDP 49160 to 49399, and the TLS port if used.
- **The credentials are public.** They are in the page's JavaScript; anyone who opens the page can read them and use the server as a relay. Hence: a cap on bandwidth per allocation, no relaying into private address ranges, and the advice to switch the server off after the event (`systemctl disable --now coturn`). Running the script again with `--password <new>` changes the password (and needs a rebuild of the app).
- **About the limits**, learnt the hard way in the tests: a browser reserves a place on the TURN server (an allocation) for every connection and every TURN address, whether it ends up using it or not, and a page that is closed leaves its allocations behind for 10 minutes. With coturn's `bps-capacity` set, every allocation takes its full `max-bps` out of that total, and the server was "full" after 8 allocations (`486 Allocation Bandwidth Quota Reached` in its log, `peer-connect-failed` in the browser). The script therefore sets a generous number of allocations (1000), a rate cap per allocation, and no total.

**Checking a TURN server**, in this order:

1. Outside the app: <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/> with the address and credentials. A line of type `relay` must appear.
2. In the app: open the room on two devices with `&ice=relay&debug` added on both. They must connect, and `path` must read `turn/udp` (or `turn/tcp`, `turn/tls`). Without a working TURN server this link does not connect at all (tested), so it cannot pass by accident.
3. Without `&ice=relay`: the same devices should show `lan` or `nat` again where the network allows it.
4. Headless, from the repo: `node scripts/test-room.mjs <app address> --relay-only --stay 10`.

To check TCP or TLS alone, put only that address into `VITE_TURN_URLS` for the test.

**On a laptop in the players' own network** (set-up C, or choice 3 of section 5.1), with Docker:

```sh
bash scripts/setup-turn.sh --config-only turnserver.conf --external-ip <laptop's LAN address> --lan
# Linux:
docker run -d --name puppet-turn --network host -v "$PWD/turnserver.conf:/etc/coturn/turnserver.conf:ro" coturn/coturn -c /etc/coturn/turnserver.conf
# macOS (as tested; add --min-port 49160 --max-port 49200 to the line above so the range matches):
docker run -d --name puppet-turn -p 3478:3478/udp -p 3478:3478/tcp -p 49160-49200:49160-49200/udp \
  -v "$PWD/turnserver.conf:/etc/coturn/turnserver.conf:ro" coturn/coturn -c /etc/coturn/turnserver.conf
```

The image has to be pulled while there is still internet.

### 6.2 Our own meeting point

`scripts/signal-relay.mjs` is Trystero's small WebSocket relay (`@trystero-p2p/ws-relay`): topics and encrypted blobs, nothing stored. Two ways to run it.

**Inside the Vite server (set-up C: a laptop, no internet).** The dev server and `vite preview` always answer on `/relay`. The app uses it when started or built with `VITE_SIGNAL_URLS=/relay`: the relay is then on the very address the page came from, so one certificate warning covers both.

```sh
# once, while there is internet
npm ci
bash scripts/fetch-mediapipe-models.sh
echo "VITE_SIGNAL_URLS=/relay" >> .env.local

# at the venue
npm run dev:https                                    # or: npm run build && npx vite preview --mode https --host
# host:    https://<laptop's LAN address>:5173/?room=abc&host        (4173 for preview)
# others:  https://<laptop's LAN address>:5173/?room=abc
```

- Tested with every name but the laptop's own made unresolvable (no public relays, no STUN): dev server over HTTP and HTTPS, the production build in `vite preview` over HTTP and HTTPS, all connect with `signal <laptop> 1/1` and `path lan`.
- Over plain HTTP (`npm run dev`), Vite refuses requests for host names it does not know ("Blocked request. This host is not allowed"): open the page by the laptop's IP address. Over HTTPS (`dev:https`, `preview --mode https`) a name works too (tested with a made-up `Host` header: 403 over HTTP, 200 over HTTPS).
- Every device has to accept the self-signed certificate once. **Not tested on a real phone:** whether iOS Safari then also accepts the WebSocket to the same address. If it does not, the client stays at `Warte auf die Bühne …` with `signal … 0/1`.
- Without internet the background music (streamed from archive.org) stays silent.
- Remove the line from `.env.local` again afterwards: with it, the laptop's build no longer meets devices that use the public relays.

**On its own (set-up D: a rented server).** The relay speaks plain WebSocket on `127.0.0.1:8787`; a reverse proxy in front does the TLS, because an HTTPS page may only open `wss://`.

```sh
# on the server: Node 22 or newer, a checkout of this repo
npm ci
node scripts/signal-relay.mjs          # PORT and HOST change where it listens; GET /health answers "ok"
```

```
# /etc/caddy/Caddyfile: Caddy fetches the certificate itself (ports 80 and 443 open, DNS pointing here)
signal.example.org {
	reverse_proxy 127.0.0.1:8787
}
```

```ini
# /etc/systemd/system/puppet-signal.service, then: systemctl enable --now puppet-signal
[Unit]
Description=Puppetshow signal relay
After=network.target

[Service]
WorkingDirectory=/opt/puppetshow
ExecStart=/usr/bin/node scripts/signal-relay.mjs
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

Then build the app with `VITE_SIGNAL_URLS=wss://signal.example.org/relay` (for GitHub Pages: the Actions variable).

- Tested: the relay behind Caddy in Docker with Caddy's own test certificate, the page on another address than the relay: connects (`signal localhost:8443 1/1`).
- Not tested: a real domain and certificate, the systemd unit.
- The relay accepts anyone. It has rate limits (200 messages a second per socket) and stores nothing; what it passes is encrypted with the room id.
- To serve the page from the same server, let Caddy hand out `dist/` and pass only the relay on, and build with `VITE_SIGNAL_URLS=/relay` (not tested in this form):

```
puppet.example.org {
	root * /opt/puppetshow/dist
	file_server
	reverse_proxy /relay 127.0.0.1:8787
}
```

- A TURN server with TLS on port 443 and Caddy cannot share one address. Use 5349 for `turns:`, or a second small server for TURN.

## 7. Tools

**The HUD** (`&debug` or Shift+D), the lines that matter here:

| Line | Example | Reading |
|---|---|---|
| `net` | `client abc · 2 peers · 2 lossy` | Role, room, connected devices, how many of them use the lossy channel for poses |
| `signal` | `nostr 5/5`, `192.168.1.20:5173 1/1` | Where this device meets the others, and how many of those relays are connected. `0/…`: layer 2 is down |
| `path` | `lan`, `nat`, `turn/udp`, `turn` | How the traffic to each peer travels (section 4). `turn` without a protocol: through the other side's TURN server |
| `rtt` | `23 ms` | Round trip to the host (on the host: to the first peer) |
| `rate` | `in 60/s out 60/s lost 0` | Pose and input packets per second, and how many never arrived |
| `neterr` | `peer-connect-failed: …` | The last error from Trystero |

**The line at the top** (always visible):

| Text | Meaning |
|---|---|
| `Raum <id> · <n> Spieler` | Host: the room and who is in it |
| `Warte auf die Bühne …` | Client: no host found yet. Wrong room id, no host, layer 2 or layer 3 down (section 11) |
| `Warte auf die Bühne … (Treffpunkt <address>)` | The same, and this build meets at our own relay there |
| `Bühne pausiert` | No poses for 0.5 s: the host's tab is hidden, or the connection is gone |
| `Zwei Bühnen im selben Raum: …` | Two devices opened the room with `&host` |
| `Die Bühne läuft mit einer anderen Version: …` | Host and client run different builds: reload both |

**Console messages** (`[net] …`):

| Message | Meaning |
|---|---|
| `relay-failed: … failed to connect to relay wss://…` | A meeting point is unreachable. Harmless while others are connected |
| `peer-connect-failed: could not connect to peer … configure TURN …` | The devices met but found no path, and no TURN server is configured: layer 3 |
| `peer-connect-failed: … verify TURN server URLs and credentials` | The same with a TURN server configured: it is unreachable, refuses the credentials, or is full |

**Scripts:**

| Script | For |
|---|---|
| `node scripts/test-room.mjs [app address] [--players n] [--relay-only] [--client-relay-only] [--offline] [--no-camera] [--stay s]` | A room in headless Chrome on this machine: do the tabs meet, over which path, with how much traffic. Exit code 0 when every tab shows every puppet |
| `bash scripts/setup-turn.sh` | A TURN server (6.1) |
| `node scripts/signal-relay.mjs` | Our own meeting point (6.2) |

**Outside the project:** the Trickle ICE page (above) shows which kinds of addresses a device gets on a network: only `host` lines means no STUN reaches out; a `relay` line means the TURN server works. `chrome://webrtc-internals` (Chrome) and `about:webrtc` (Firefox) show every connection attempt in detail. On the TURN server: `journalctl -u coturn -f`.

## 8. Traffic

Measured at the TURN server for one host and one client, two puppets on the stage, 60 Hz input and 30 Hz poses:

| Direction | Bytes per second | Packets per second |
|---|---|---|
| Host → one client | about 20 kB/s (10 kB/s per puppet on the stage) | 89 |
| Client → host | about 9.4 kB/s | 89 |

From that, not measured: a full room of six is about 70 kB/s per client and 350 kB/s (2.8 Mbit/s) at the host for its five clients. Through a TURN server that is at most 1.3 GB per hour for a full room and 0.1 GB per hour for two players, if every device is relayed. Direct paths cost the server nothing.

Delay: a client shows the stage 73 ms in the past, plus the way to the host and back (`rtt`). On one machine the round trip through the TURN server was 1 to 6 ms; on a real one it is the way to the server and back, added once.

## 9. What was run

All on 2026-11-15, headless Chrome on one Mac, with `scripts/test-room.mjs` or its predecessors. "Offline" means Chrome was started so that no name resolves except the server's own: no public relay, no STUN server.

| # | Set-up | Result |
|---|---|---|
| 1 | The five public relays, from Node | All five accept a subscription; 27 of Trystero's 30 |
| 2 | Default build, two tabs | Meet in about 1 s, `signal nostr 5/5`, `path lan`; client leaves, host back to one player |
| 3 | Default build, offline | Never meet, `signal nostr 0/5` (expected) |
| 4 | TURN (UDP) configured, `&ice=relay` on both | Connect, `path turn/udp`, lossy channel in use, 60 packets/s each way, 0 lost over 20 s |
| 5 | No TURN configured, `&ice=relay` | Do not connect, `peer-connect-failed` (expected: the switch really forces the relay) |
| 6 | TURN over TCP only, `&ice=relay` | Connect, `path turn/tcp`, 0 lost over 30 s |
| 7 | TURN configured, no `ice` parameter | Stay direct, `path lan` |
| 8 | TURN configured, only the client `&ice=relay` | Connect; client `turn/udp`, host `nat` |
| 9 | Three tabs, TURN, `&ice=relay` | Three puppets everywhere, each tab two peers over `turn/udp` |
| 10 | Six two-tab sessions in a row through the TURN server | All connect, 24 allocations, none refused (after the limits were fixed, section 6.1) |
| 11 | Own relay in the dev server, online and offline | Connect, `signal localhost:… 1/1`, `path lan` |
| 12 | Own relay, HTTPS dev server at the LAN address, offline | Connect |
| 13 | As 12, tabs without camera permission | Do **not** connect: no path (the `.local` names do not resolve either) |
| 14 | As 13, with the TURN server configured | Connect through it |
| 15 | Own relay and TURN, offline, `&ice=relay`, no camera permission | Connect, `path turn/udp`: nothing from the internet in use |
| 16 | Production build in `vite preview`, own relay, offline, HTTP and HTTPS | Connect |
| 17 | Standalone relay behind Caddy (TLS), page on another address | Connect |
| 18 | Host on the public relays, client on the own relay | Never meet; the client's line names its meeting point |
| 19 | `setup-turn.sh` from start to end in a Debian 12 container (coturn 4.6.1), run twice | Installs, self-test passes, password kept; a peer on a private address is refused, two relayed clients are not |
| 20 | The documented route: the four settings in `.env.local`, `npm run dev:https`, at the LAN address, offline, `&ice=relay` | Connect, `signal 192.168.1.143:… 1/1`, `path turn/udp` |
| 21 | `npm run build`, `tsc`, `test-hand-tracking.ts`, `test-body-frame.ts` | Pass |

Not run, and the first things to do with real hardware:

- Two real devices on a home Wi-Fi; then iPhone, Quest 2 and laptop on the venue's Wi-Fi (the hard pair is Quest and laptop: neither has camera permission).
- A phone on mobile data against a host on Wi-Fi, with and without TURN.
- `setup-turn.sh` on a real server, and `turns:` from a network that blocks UDP.
- iPhone against the laptop's self-signed `dev:https` with `VITE_SIGNAL_URLS=/relay`.
- Whether the data channel survives entering VR on the Quest.

## 10. Known limits

- **One host, chosen by hand.** A second device with `&host` is reported but not prevented. If the host leaves, the puppets freeze until a host is back; there is no election.
- **A hidden host tab pauses everyone.**
- **A failed link between two clients loses that pair's backdrop changes.** The backdrop is sent by whoever changed it to all its peers; the host does not pass it on. If two clients cannot reach each other (both behind strict networks, no TURN), one misses the other's change. Until the host forwards it: change the backdrop on the host, or configure TURN.
- **Props and scene presets are per device** (architecture §3.3): in a room, use props on the host only.
- **The TURN credentials and the relay address are public** once built into the page.
- **Many watching devices do not scale.** Every device connects to every other; that is fine for six, not for an audience of dozens (architecture §3.3, "Later").
- **Clients on a second lossy channel only where it opens**; otherwise poses share Trystero's ordered channel, which stutters on a congested Wi-Fi (`net … 0 lossy`).

## 11. FAQ

**A client stays at "Warte auf die Bühne …".** Walk the layers with `&debug` on both devices:

1. Same room id on both, and exactly one device with `&host`? Does the host show `Raum … · 1 Spieler`?
2. `signal`: `0/…` on either device means it cannot reach the meeting point (no internet, relays blocked, certificate not accepted). Do both show the same meeting point (`nostr`, or the same address)?
3. `signal` fine on both, host still at one player, `neterr` or the console shows `peer-connect-failed`: no path. Allow the camera on both and reload (section 4); switch off VPNs; if that does not help, the network forbids it and a TURN server is needed (section 5.1).
4. With a TURN server configured and still `peer-connect-failed`: check the server (section 6.1).

**It works between two tabs but not between two devices.** Two tabs prove layers 1 and 2 and nothing about the network between devices. See 3 above.

**It works at home but not at the venue.** Most likely client isolation, or a filter on the public relays. `signal` tells which: `5/5` with no connection is isolation (layer 3), `0/5` is the filter (layer 2).

**Do we need internet?** With the default build, yes, even when all devices are in one room: they meet on the internet. Without internet: set-up C.

**Does the game data go through the Nostr relays or our relay?** No. They only carry the handshake.

**Can the relay's operator or the TURN server read anything?** No. The handshake is encrypted with the room id; the data channels are encrypted between the two browsers, also when a TURN server passes the packets on (it sees how much, and between which addresses).

**Is a room private?** As private as its id. Anyone with the link can join and gets a puppet.

**Can the host be a phone?** It can, but it simulates everyone and must keep the tab visible and the screen on. Use the strongest device.

**How many players?** Six puppets. More devices connect and watch, at the cost of more connections for everyone.

**Can several rooms run at once?** Yes: different room ids, on the same relays and the same TURN server.

**On a Mac the direct path fails although the Wi-Fi is fine.** Not tested here, but known from the system: macOS asks per app for access to the local network (System Settings → Privacy & Security → Local Network). A browser that was refused cannot reach devices on the LAN.

**Vite answers "Blocked request. This host is not allowed".** The page was opened over plain HTTP by a name Vite does not know. Use `npm run dev:https` (needed for the camera anyway), or the laptop's IP address.

**A phone warns about the certificate.** `dev:https` uses a self-signed one: accept it once per device. For an event, a real certificate (a server with a domain, or the GitHub Pages build) spares everyone the step.

**The TURN server refuses connections after a while.** Look for `486` in `journalctl -u coturn`: a quota is used up, usually by allocations that closed pages left behind (they expire after 10 minutes). The script's limits are meant to be far above that; raise `total-quota` and `user-quota` in `/etc/turnserver.conf` if a large event gets there.

**What does a TURN server cost in traffic?** Section 8: at most about 1.3 GB per hour for a full room in which every device is relayed.

**Why not a simple WebSocket server for everything?** It would need a server always, where now none is needed in the common case, and it would put the poses on TCP. It stays the last resort (section 5.1, choice 4).

## 12. Before an event

1. Decide where the page comes from (GitHub Pages, or the laptop) and build or deploy it once; every device must run the same build.
2. Ask the venue: do Wi-Fi devices reach each other? Is there internet? If either answer is no or unknown, bring your own router, or have a TURN server ready (and, without internet, set-up C).
3. On the venue's network, with two real devices: allow the camera on both, reload, open the room with `&debug`, read `signal` and `path`.
4. If a TURN server is configured: once with `&ice=relay` on both devices.
5. Keep the host's tab in front, the laptop on power, its screen from sleeping.
6. Afterwards: switch the TURN server off, remove `VITE_SIGNAL_URLS` from `.env.local`.

## 13. Files

| File | What |
|---|---|
| `src/net/transport.ts` | Trystero room (public relays or our own), TURN, the lossy channel, `signaling` and `paths()` for the HUD |
| `src/net/session.ts`, `protocol.ts` | Host and client logic, messages (architecture §3.3) |
| `scripts/signal-relay.mjs` | Our own meeting point; also attached to the Vite server under `/relay` (`vite.config.ts`) |
| `scripts/setup-turn.sh` | coturn on a Debian or Ubuntu server, or just its config |
| `scripts/test-room.mjs` | A room in headless Chrome |
| `.github/workflows/deploy.yml` | Passes the four `VITE_*` settings from the repository's Actions variables into the Pages build |
| `.env.local` | The same settings for local runs and builds (git-ignored) |

Ports, for whoever configures a firewall:

| From | To | Port | For |
|---|---|---|---|
| Every device | Public Nostr relays, or our relay | TCP 443 (`wss://`) | Meeting |
| Every device | `stun*.l.google.com`, `stun.cloudflare.com` | UDP 19302, 3478 | Finding the router's outside address |
| Device ↔ device | each other | UDP, any high port | The direct path |
| Every device | TURN server | UDP 3478, TCP 3478, TCP 5349 or 443 (TLS) | The detour |
| TURN server | the internet | UDP 49160 to 49399 | Relayed traffic |
