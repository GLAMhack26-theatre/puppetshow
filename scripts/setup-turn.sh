#!/usr/bin/env bash
# A TURN server (coturn) for the Puppetshow's rooms: the detour for two
# devices that cannot reach each other directly (a Wi-Fi with client
# isolation, mobile networks, strict firewalls). docs/multiplayer.md says
# when one is needed and how to check that it works.
#
# On a fresh Debian or Ubuntu server with a public address, as root:
#
#   sudo bash scripts/setup-turn.sh                           # turn: on 3478 (UDP and TCP)
#   sudo bash scripts/setup-turn.sh --domain turn.example.org --email me@example.org
#                                                             # also turns: (TLS) on 5349
#   sudo bash scripts/setup-turn.sh --domain turn.example.org --email me@example.org --tls-port 443
#                                                             # TLS on 443, for networks that let nothing else out
#
# It installs coturn, writes /etc/turnserver.conf, opens the ports in ufw (if
# ufw is on) and prints the VITE_TURN_* lines for the app's .env.local. Run
# again to change something: the password is kept unless --password is given.
#
# Anywhere else (a laptop, Docker), only the config:
#
#   bash scripts/setup-turn.sh --config-only turnserver.conf --external-ip 192.168.1.20 --lan
#   docker run --rm --network host -v "$PWD/turnserver.conf:/etc/coturn/turnserver.conf:ro" coturn/coturn -c /etc/coturn/turnserver.conf
#
# The credentials end up in the page's JavaScript, where anyone can read
# them. That is why the server gets limits (sessions, bandwidth) and why it
# never relays into private networks. Switch it off after the event.
set -euo pipefail

CONFIG=/etc/turnserver.conf
CERTS=/etc/coturn/certs
USER_NAME=puppet
PASSWORD=
DOMAIN=
EMAIL=
TLS_PORT=5349
EXTERNAL_IP=
PRIVATE_IP=
MIN_PORT=49160
MAX_PORT=49399
LAN=0
CONFIG_ONLY=
# Limits. Measured (docs/multiplayer.md): the host sends each player about
# 10 kB/s per puppet on the stage, a player sends 9 kB/s back; a full room of
# six is about 70 kB/s per player.
# An allocation is one browser's reservation on this server for one
# connection and one of the TURN addresses. Every device makes them for every
# other device in the room as soon as a TURN server is configured, used or
# not (a room of six: about 90), and one left behind by a closed page stays
# for 10 minutes. So the count is generous, and there is no cap on the total
# bandwidth: coturn would set SESSION_BPS aside for every allocation, idle
# ones too, and refuse new ones long before the line is full (seen in the
# tests: 8 allocations and the server was "full").
MAX_SESSIONS=1000       # allocations at once
SESSION_BPS=250000      # bytes per second for one allocation: 3 times a full room's need

usage() {
  sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --domain <name>       DNS name that points to this server: fetches a certificate (certbot) and serves turns:
  --email <address>     for the certificate's expiry notices (Let's Encrypt)
  --tls-port <port>     port for turns: (default 5349)
  --user <name>         default "puppet"
  --password <secret>   default: random, or the one already in the config
  --external-ip <ip>    the address players reach the server at (default: looked up)
  --lan                 the server stands in the players' own network: peers with private addresses are allowed
  --min-port, --max-port <port>   UDP ports for relayed traffic (default 49160 to 49399)
  --config-only <file>  write the config to <file> and stop: nothing is installed
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=$2; shift 2 ;;
    --email) EMAIL=$2; shift 2 ;;
    --tls-port) TLS_PORT=$2; shift 2 ;;
    --user) USER_NAME=$2; shift 2 ;;
    --password) PASSWORD=$2; shift 2 ;;
    --external-ip) EXTERNAL_IP=$2; shift 2 ;;
    --min-port) MIN_PORT=$2; shift 2 ;;
    --max-port) MAX_PORT=$2; shift 2 ;;
    --lan) LAN=1; shift ;;
    --config-only) CONFIG_ONLY=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }

if [ -n "$CONFIG_ONLY" ]; then
  CONFIG=$CONFIG_ONLY
  if [ -z "$EXTERNAL_IP" ]; then
    echo "--config-only needs --external-ip <address the players reach this server at>" >&2
    exit 2
  fi
else
  [ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
  command -v apt-get >/dev/null || { echo "needs Debian or Ubuntu (apt-get); elsewhere use --config-only with Docker" >&2; exit 1; }
  if [ -n "$DOMAIN" ] && [ -z "$EMAIL" ]; then
    echo "--domain needs --email (Let's Encrypt sends expiry notices there)" >&2
    exit 2
  fi
fi

# The password of an earlier run stays, so that a built app keeps working
if [ -z "$PASSWORD" ] && [ -f "$CONFIG" ]; then
  PASSWORD=$(sed -n "s/^user=$USER_NAME://p" "$CONFIG" | head -n 1)
fi
if [ -z "$PASSWORD" ]; then
  PASSWORD=$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')
fi

if [ -z "$CONFIG_ONLY" ]; then
  say "Installing coturn"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq coturn curl

  # A cloud server often has a private address on its interface and the
  # public one on the provider's router (1:1 NAT). coturn has to know both:
  # it tells the players the public one and listens on the private one.
  PRIVATE_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -n 1)
  if [ -z "$EXTERNAL_IP" ]; then
    if [ "$LAN" = 1 ]; then
      EXTERNAL_IP=$PRIVATE_IP
    else
      EXTERNAL_IP=$(curl -4 -fsS --max-time 8 https://api.ipify.org || curl -4 -fsS --max-time 8 https://ifconfig.me || true)
    fi
  fi
  [ -n "$EXTERNAL_IP" ] || { echo "could not find this server's public address: pass --external-ip" >&2; exit 1; }
fi

TLS=0
if [ -n "$DOMAIN" ] && [ -z "$CONFIG_ONLY" ]; then
  say "Certificate for $DOMAIN (Let's Encrypt, needs port 80 free and $DOMAIN pointing to $EXTERNAL_IP)"
  apt-get install -y -qq certbot
  mkdir -p "$CERTS"
  # coturn runs as its own user and cannot read /etc/letsencrypt: copy the
  # certificate over now and after every renewal
  HOOK=/etc/letsencrypt/renewal-hooks/deploy/coturn.sh
  mkdir -p "$(dirname "$HOOK")"
  cat >"$HOOK" <<EOF
#!/bin/sh
# Written by scripts/setup-turn.sh: hands the renewed certificate to coturn
cp -L /etc/letsencrypt/live/$DOMAIN/fullchain.pem /etc/letsencrypt/live/$DOMAIN/privkey.pem $CERTS/
chown turnserver:turnserver $CERTS/*.pem
chmod 600 $CERTS/privkey.pem
systemctl restart coturn
EOF
  chmod +x "$HOOK"
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; fi
  certbot certonly --standalone --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN" --keep-until-expiring
  TLS=1
fi

say "Writing $CONFIG"
{
  cat <<EOF
# coturn for the Puppetshow's rooms. Written by scripts/setup-turn.sh: run it
# again instead of editing by hand (docs/multiplayer.md).
listening-port=3478
min-port=$MIN_PORT
max-port=$MAX_PORT
fingerprint
lt-cred-mech
realm=${DOMAIN:-puppetshow}
user=$USER_NAME:$PASSWORD
EOF
  if [ -n "$PRIVATE_IP" ] && [ "$PRIVATE_IP" != "$EXTERNAL_IP" ]; then
    echo "# Public address / the address on this machine's interface (1:1 NAT)"
    echo "external-ip=$EXTERNAL_IP/$PRIVATE_IP"
  else
    echo "external-ip=$EXTERNAL_IP"
  fi
  cat <<EOF

# The credentials are public (they are in the page's JavaScript): limits
total-quota=$MAX_SESSIONS
user-quota=$MAX_SESSIONS
max-bps=$SESSION_BPS
stale-nonce=600
no-multicast-peers
EOF
  if [ "$LAN" = 1 ]; then
    echo
    echo "# --lan: the players are in this server's own network, so private peer addresses are allowed"
  else
    cat <<'EOF'

# Never relay into private networks: with public credentials the server would
# otherwise be a way into whatever stands next to it
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
EOF
  fi
  if [ "$TLS" = 1 ]; then
    cat <<EOF

# turns: (TURN over TLS), for networks that only let TLS out
tls-listening-port=$TLS_PORT
cert=$CERTS/fullchain.pem
pkey=$CERTS/privkey.pem
no-tlsv1
no-tlsv1_1
EOF
  fi
} >"$CONFIG"
chmod 640 "$CONFIG" 2>/dev/null || true

URLS="turn:${DOMAIN:-$EXTERNAL_IP}:3478,turn:${DOMAIN:-$EXTERNAL_IP}:3478?transport=tcp"
if [ "$TLS" = 1 ]; then URLS="$URLS,turns:$DOMAIN:$TLS_PORT?transport=tcp"; fi

if [ -z "$CONFIG_ONLY" ]; then
  chown root:turnserver "$CONFIG"
  if [ "$TLS" = 1 ]; then
    sh /etc/letsencrypt/renewal-hooks/deploy/coturn.sh || true
    if [ "$TLS_PORT" -lt 1024 ]; then
      # A port below 1024 needs a capability the service may not have
      mkdir -p /etc/systemd/system/coturn.service.d
      printf '[Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE\n' >/etc/systemd/system/coturn.service.d/low-port.conf
      systemctl daemon-reload
    fi
  fi
  # Older packages only start with this switch
  if [ -f /etc/default/coturn ]; then
    sed -i 's/^#\{0,1\}TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  fi

  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    say "Opening ports in ufw"
    ufw allow 3478/udp >/dev/null
    ufw allow 3478/tcp >/dev/null
    ufw allow "$MIN_PORT:$MAX_PORT/udp" >/dev/null
    if [ "$TLS" = 1 ]; then ufw allow "$TLS_PORT/tcp" >/dev/null; fi
  fi

  say "Starting coturn"
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn
  sleep 2
  systemctl --no-pager --lines 0 status coturn || { journalctl -u coturn --no-pager -n 30; exit 1; }

  # Two relayed clients through this server, as two players behind strict
  # networks would be. Against the address on this machine's interface: its
  # public address may not be reachable from the machine itself.
  if command -v turnutils_uclient >/dev/null; then
    TEST_IP=${PRIVATE_IP:-$EXTERNAL_IP}
    say "Self-test: two relayed clients through $TEST_IP"
    if timeout 30 turnutils_uclient -u "$USER_NAME" -w "$PASSWORD" -y -n 20 -m 1 "$TEST_IP" 2>&1 | grep -q "Total lost packets 0 "; then
      echo "ok: the two clients reached each other through the server"
    else
      echo "FAILED: the two clients did not reach each other. See journalctl -u coturn" >&2
    fi
  fi
fi

say "Done"
cat <<EOF
Ports that must be open from the internet (also in the cloud provider's own
firewall or security group, which this script cannot reach):
  3478/udp  3478/tcp  $MIN_PORT-$MAX_PORT/udp$([ "$TLS" = 1 ] && echo "  $TLS_PORT/tcp")

For the app, in .env.local next to package.json (then restart the dev server
or rebuild; for GitHub Pages see docs/multiplayer.md):

VITE_TURN_URLS=$URLS
VITE_TURN_USERNAME=$USER_NAME
VITE_TURN_CREDENTIAL=$PASSWORD

Check: open the room on two devices with &ice=relay&debug added to the link.
They must connect, and the HUD's "path" line must say turn/udp (or turn/tcp,
turn/tls).
EOF
