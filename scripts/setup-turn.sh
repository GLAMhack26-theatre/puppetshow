#!/usr/bin/env bash
# A TURN server (coturn) for the Puppetshow's rooms: the detour for two
# devices that cannot reach each other directly (a Wi-Fi with client
# isolation, mobile networks, strict firewalls). docs/multiplayer.md says
# when one is needed and how to check that it works.
#
# A TURN server wants a user name and a password from the browser. Two ways
# to give the page one (--auth):
#
#   secret     For a server that stays on. The page fetches a pair that
#              expires within the hour from a small service on this server
#              (scripts/turn-credentials.mjs, which must lie next to this
#              script); coturn and the service share a secret that never
#              leaves the server. Nothing lasting is in the page.
#   password   One fixed pair, built into the page, where anyone can read it
#              (the default: it needs no service). For a laptop at an event,
#              or a server that is switched off afterwards.
#
# On a fresh Debian or Ubuntu server with a public address, as root:
#
#   sudo bash scripts/setup-turn.sh --auth secret --domain turn.example.org --email me@example.org \
#        --origin https://user.github.io
#       # a server that stays on: turn: on 3478 (UDP and TCP), turns: (TLS) on
#       # 5349, the credentials at https://turn.example.org/turn-credentials
#       # for pages of that origin
#   sudo bash scripts/setup-turn.sh                           # fixed password, turn: on 3478 (UDP and TCP)
#   sudo bash scripts/setup-turn.sh --domain turn.example.org --email me@example.org --tls-port 443
#                                                             # fixed password, TLS on 443, for networks that let nothing else out
#
# It installs coturn (and for --auth secret Node and the service), writes
# /etc/turnserver.conf, opens the ports in ufw (if ufw is on) and prints the
# lines for the app's .env.local. Run again to change something: the secret
# and the password are kept unless --secret or --password is given.
#
# Anywhere else (a laptop, Docker), only the config:
#
#   bash scripts/setup-turn.sh --config-only turnserver.conf --external-ip 192.168.1.20 --lan
#   docker run --rm --network host -v "$PWD/turnserver.conf:/etc/coturn/turnserver.conf:ro" coturn/coturn -c /etc/coturn/turnserver.conf
#
# Either way the app has no logins, so whoever can open the page can use the
# server as a relay. That is why it gets limits (allocations, bandwidth) and
# never relays into private networks.
set -euo pipefail

CONFIG=/etc/turnserver.conf
CERTS=/etc/coturn/certs
AUTH=password
USER_NAME=puppet
PASSWORD=
SECRET=
# --auth secret: the service that hands out the expiring pairs
SERVICE=puppetshow-turn-credentials
SERVICE_DIR=/opt/puppetshow
SERVICE_ENV=/etc/puppetshow/turn-credentials.env
SERVICE_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/turn-credentials.mjs"
CREDENTIALS_PORT=443
CREDENTIALS_URL=
LOCAL_URL=
ORIGINS=
TTL=3600
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
# --auth secret: allocations for one fetched pair, that is one device for at
# most an hour. A device makes one per peer and TURN address (measured), so
# 15 in a full room of six with three addresses
PAIR_SESSIONS=100
SESSION_BPS=250000      # bytes per second for one allocation: 3 times a full room's need

usage() {
  sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --auth <secret|password>   how the page gets its credentials (above; default password)
  --domain <name>       DNS name that points to this server: fetches a certificate (certbot) and serves turns:
                        and, with --auth secret, the credentials over HTTPS
  --email <address>     for the certificate's expiry notices (Let's Encrypt)
  --tls-port <port>     port for turns: (default 5349)
  --origin <url>        --auth secret: only pages of this origin may fetch credentials (several: comma
                        separated; default: any page). Keeps other websites off, not scripts
  --credentials-port <port>  --auth secret with --domain: HTTPS port of the credentials (default 443)
  --ttl <seconds>       --auth secret: how long a pair is valid (default 3600)
  --secret <secret>     --auth secret: default random, or the one already in the config
  --user <name>         --auth password: default "puppet"
  --password <secret>   --auth password: default random, or the one already in the config
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
    --auth) AUTH=$2; shift 2 ;;
    --origin) ORIGINS=$2; shift 2 ;;
    --credentials-port) CREDENTIALS_PORT=$2; shift 2 ;;
    --ttl) TTL=$2; shift 2 ;;
    --secret) SECRET=$2; shift 2 ;;
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
random() { head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

case "$AUTH" in
  secret | password) ;;
  *) echo "--auth must be secret or password" >&2; exit 2 ;;
esac

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
  if [ "$AUTH" = secret ]; then
    [ -f "$SERVICE_SOURCE" ] || { echo "--auth secret needs turn-credentials.mjs next to this script (copy both files, or check out the repo)" >&2; exit 1; }
    if [ -n "$DOMAIN" ] && [ "$CREDENTIALS_PORT" = "$TLS_PORT" ]; then
      echo "turns: and the credentials cannot share port $TLS_PORT on one address: pick another --tls-port or --credentials-port (docs/multiplayer.md, 6.1)" >&2
      exit 2
    fi
  fi
fi

# The secret or password of an earlier run stays: the service keeps handing
# out pairs that coturn accepts, and a built app keeps working
if [ "$AUTH" = secret ]; then
  if [ -z "$SECRET" ] && [ -f "$CONFIG" ]; then
    SECRET=$(sed -n "s/^static-auth-secret=//p" "$CONFIG" | head -n 1)
  fi
  [ -n "$SECRET" ] || SECRET=$(random)
else
  if [ -z "$PASSWORD" ] && [ -f "$CONFIG" ]; then
    PASSWORD=$(sed -n "s/^user=$USER_NAME://p" "$CONFIG" | head -n 1)
  fi
  [ -n "$PASSWORD" ] || PASSWORD=$(random)
fi

if [ -z "$CONFIG_ONLY" ]; then
  say "Installing coturn"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq coturn curl iproute2
  if [ "$AUTH" = secret ]; then
    apt-get install -y -qq nodejs
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' ||
      { echo "the credentials service needs Node 18 or newer, this system's package is $(node --version): install a newer Node and run again" >&2; exit 1; }
  fi

  # A cloud server often has a private address on its interface and the
  # public one on the provider's router (1:1 NAT). coturn has to know both:
  # it tells the players the public one and listens on the private one.
  PRIVATE_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -n 1 || true)
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
# the credentials service (--auth secret) reads the certificate when it starts
systemctl try-restart $SERVICE 2>/dev/null || true
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
realm=${DOMAIN:-puppetshow}
EOF
  if [ "$AUTH" = secret ]; then
    cat <<EOF
# Pairs that expire: the user name is the time until which it is valid, the
# password an HMAC of it with this secret (scripts/turn-credentials.mjs
# makes them with the same secret)
use-auth-secret
static-auth-secret=$SECRET
EOF
  else
    cat <<EOF
lt-cred-mech
user=$USER_NAME:$PASSWORD
EOF
  fi
  if [ -n "$PRIVATE_IP" ] && [ "$PRIVATE_IP" != "$EXTERNAL_IP" ]; then
    echo "# Public address / the address on this machine's interface (1:1 NAT)"
    echo "external-ip=$EXTERNAL_IP/$PRIVATE_IP"
  else
    echo "external-ip=$EXTERNAL_IP"
  fi
  cat <<EOF

# Whoever can open the page can use this server: limits
total-quota=$MAX_SESSIONS
user-quota=$([ "$AUTH" = secret ] && echo "$PAIR_SESSIONS" || echo "$MAX_SESSIONS")
max-bps=$SESSION_BPS
stale-nonce=600
no-multicast-peers
EOF
  if [ "$LAN" = 1 ]; then
    echo
    echo "# --lan: the players are in this server's own network, so private peer addresses are allowed"
  else
    cat <<'EOF'

# Never relay into private networks: the server would otherwise be a way
# into whatever stands next to it, for anyone who opens the page
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
    if [ "$AUTH" = secret ] && [ "$TLS" = 1 ]; then ufw allow "$CREDENTIALS_PORT/tcp" >/dev/null; fi
  fi

  say "Starting coturn"
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn
  sleep 2
  systemctl --no-pager --lines 0 status coturn || { journalctl -u coturn --no-pager -n 30; exit 1; }

  if [ "$AUTH" = secret ]; then
    say "Credentials service ($SERVICE)"
    # With a certificate it serves HTTPS itself; without one it only listens
    # on this machine, for a proxy that does the TLS (a page served over
    # HTTPS may only fetch from https)
    if [ "$TLS" = 1 ]; then
      SERVICE_HOST=0.0.0.0
      SERVICE_PORT=$CREDENTIALS_PORT
      CREDENTIALS_URL="https://$DOMAIN$([ "$CREDENTIALS_PORT" = 443 ] || echo ":$CREDENTIALS_PORT")/turn-credentials"
      LOCAL_URL="https://$DOMAIN:$CREDENTIALS_PORT/turn-credentials"
    else
      SERVICE_HOST=127.0.0.1
      SERVICE_PORT=8788
      LOCAL_URL="http://127.0.0.1:8788/turn-credentials"
    fi
    mkdir -p "$SERVICE_DIR" "$(dirname "$SERVICE_ENV")"
    cp "$SERVICE_SOURCE" "$SERVICE_DIR/turn-credentials.mjs"
    {
      echo "# Written by scripts/setup-turn.sh. The secret is coturn's static-auth-secret."
      echo "TURN_SECRET=$SECRET"
      echo "TURN_URLS=$URLS"
      echo "TURN_TTL=$TTL"
      echo "ALLOWED_ORIGINS=$ORIGINS"
      echo "HOST=$SERVICE_HOST"
      echo "PORT=$SERVICE_PORT"
      if [ "$TLS" = 1 ]; then
        echo "TLS_CERT=$CERTS/fullchain.pem"
        echo "TLS_KEY=$CERTS/privkey.pem"
      fi
    } >"$SERVICE_ENV"
    chown root:turnserver "$SERVICE_ENV"
    chmod 640 "$SERVICE_ENV"
    # As coturn's user: it may read the certificate copied for coturn
    cat >"/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Puppetshow: short-lived credentials for the TURN server
After=network-online.target
Wants=network-online.target

[Service]
User=turnserver
EnvironmentFile=$SERVICE_ENV
ExecStart=$(command -v node) $SERVICE_DIR/turn-credentials.mjs
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE" >/dev/null 2>&1 || true
    systemctl restart "$SERVICE"
    sleep 1
    systemctl --no-pager --lines 0 status "$SERVICE" || { journalctl -u "$SERVICE" --no-pager -n 30; exit 1; }
  elif [ -f "/etc/systemd/system/$SERVICE.service" ]; then
    # An earlier run with --auth secret: coturn refuses its pairs from now on
    systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
  fi

  # Two relayed clients through this server, as two players behind strict
  # networks would be. Against the address on this machine's interface: its
  # public address may not be reachable from the machine itself.
  if command -v turnutils_uclient >/dev/null; then
    TEST_IP=${PRIVATE_IP:-$EXTERNAL_IP}
    TEST_USER=$USER_NAME
    TEST_PASSWORD=$PASSWORD
    if [ "$AUTH" = secret ]; then
      # With a pair as a page gets it: service and coturn have to agree
      say "Self-test: a pair from the credentials service"
      PAIR=$(curl -fsS --max-time 8 ${DOMAIN:+--resolve "$DOMAIN:$CREDENTIALS_PORT:127.0.0.1"} "$LOCAL_URL" || true)
      TEST_USER=$(printf '%s' "$PAIR" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
      TEST_PASSWORD=$(printf '%s' "$PAIR" | sed -n 's/.*"credential":"\([^"]*\)".*/\1/p')
      if [ -n "$TEST_USER" ] && [ -n "$TEST_PASSWORD" ]; then
        echo "ok: $LOCAL_URL answers (user $TEST_USER)"
      else
        echo "FAILED: no pair from $LOCAL_URL. See journalctl -u $SERVICE" >&2
      fi
    fi
    say "Self-test: two relayed clients through $TEST_IP"
    if [ -n "$TEST_USER" ] && timeout 30 turnutils_uclient -u "$TEST_USER" -w "$TEST_PASSWORD" -y -n 20 -m 1 "$TEST_IP" 2>&1 | grep -q "Total lost packets 0 "; then
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
  3478/udp  3478/tcp  $MIN_PORT-$MAX_PORT/udp$([ "$TLS" = 1 ] && echo "  $TLS_PORT/tcp")$([ "$AUTH" = secret ] && [ "$TLS" = 1 ] && echo "  $CREDENTIALS_PORT/tcp")

EOF

if [ "$AUTH" = password ]; then
  cat <<EOF
For the app, in .env.local next to package.json (then restart the dev server
or rebuild; for GitHub Pages see docs/multiplayer.md). These end up in the
page, where anyone can read them: for a server that stays on, use
--auth secret.

VITE_TURN_URLS=$URLS
VITE_TURN_USERNAME=$USER_NAME
VITE_TURN_CREDENTIAL=$PASSWORD
EOF
elif [ -n "$CONFIG_ONLY" ]; then
  cat <<EOF
The pairs for this server are made by scripts/turn-credentials.mjs. The Vite
server runs it under /turn-credentials with these lines in .env.local next
to package.json (the secret has no VITE_ prefix and stays out of the page):

TURN_SECRET=$SECRET
TURN_URLS=$URLS
VITE_TURN_CREDENTIALS_URL=/turn-credentials
EOF
elif [ -n "$CREDENTIALS_URL" ]; then
  cat <<EOF
For the app, in .env.local next to package.json (then restart the dev server
or rebuild; for GitHub Pages see docs/multiplayer.md). This is an address,
not a secret: the secret stays on this server, in $CONFIG
and $SERVICE_ENV.

VITE_TURN_CREDENTIALS_URL=$CREDENTIALS_URL
EOF
else
  cat <<EOF
The credentials service only listens on $LOCAL_URL.
A page served over HTTPS may only fetch from https: put a proxy with a
certificate in front of it (docs/multiplayer.md, 6.2, has the Caddy lines),
or run this script with --domain. Then, for the app:

VITE_TURN_CREDENTIALS_URL=https://<the proxy's name>/turn-credentials
EOF
fi

cat <<EOF

Check: open the room on two devices with &ice=relay&debug added to the link.
They must connect, and the HUD's "path" line must say turn/udp (or turn/tcp,
turn/tls)$([ "$AUTH" = secret ] && echo '; its "turn" line says how long the fetched pair is still valid').
EOF
