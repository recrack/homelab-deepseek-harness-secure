#!/bin/sh
# Install the network policy before dropping every capability and starting DSH.
set -eu

fail() { printf '%s\n' "dsh offline: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail 'initialization requires container root'
profile=${1:-web}
if [ "$#" -gt 0 ]; then shift; fi
case "$profile" in web|headless) ;; *) fail 'profile must be web or headless';; esac

: "${MODEL_GATEWAY_HOST:?MODEL_GATEWAY_HOST is required}"
: "${MODEL_GATEWAY_PORT:?MODEL_GATEWAY_PORT is required}"
: "${DSH_MODEL_ID:?DSH_MODEL_ID is required}"
: "${DSH_UID:?DSH_UID is required}"
: "${DSH_GID:?DSH_GID is required}"
DSH_HERMES_ACP_ENABLED=${DSH_HERMES_ACP_ENABLED:-0}
case "$DSH_HERMES_ACP_ENABLED" in 0|1) ;; *) fail 'DSH_HERMES_ACP_ENABLED must be 0 or 1';; esac
DSH_WEB_PORT=${DSH_WEB_PORT:-3080}
DSH_BROWSER_ALLOWED_ORIGINS=${DSH_BROWSER_ALLOWED_ORIGINS:-[]}
export DSH_HERMES_ACP_ENABLED DSH_WEB_PORT DSH_BROWSER_ALLOWED_ORIGINS
if [ "$DSH_HERMES_ACP_ENABLED" = 1 ] && [ ! -S /run/hermes-acp/agent.sock ]; then
    fail 'the mounted Hermes ACP socket is unavailable'
fi

gateway_ip=$(python3 - <<'PY'
import ipaddress
import os
import socket

for name, fallback in (('MODEL_GATEWAY_PORT', '3080'), ('DSH_WEB_PORT', '3080'), ('DSH_COLLECTOR_PORT', '8080')):
    value = os.environ.get(name, fallback)
    if not value.isascii() or not value.isdecimal() or not 1 <= int(value) <= 65535:
        raise SystemExit(f'{name} must be a TCP port')
for name in ('DSH_UID', 'DSH_GID'):
    value = os.environ[name]
    if not value.isascii() or not value.isdecimal() or not 0 <= int(value) < 2**31:
        raise SystemExit(f'{name} must be a numeric uid/gid')
if int(os.environ['DSH_UID']) == 0:
    raise SystemExit('DSH_UID must not be root')
host = os.environ['MODEL_GATEWAY_HOST']
if host == 'host.docker.internal':
    # Docker Desktop resolves this name locally before DNS is disabled.
    host = socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
address = ipaddress.IPv4Address(host)
if not address.is_private or address.is_unspecified or address.is_multicast or address.is_loopback or address.is_link_local:
    raise SystemExit('model gateway must be a dedicated bridge or Docker host address')
print(address)
collector = os.environ.get('DSH_COLLECTOR_HOST')
if collector:
    address = ipaddress.IPv4Address(collector)
    if not address.is_private or address.is_unspecified or address.is_multicast or address.is_loopback or address.is_link_local:
        raise SystemExit('collector must be a dedicated private container IPv4 address')
PY
)
DSH_WEB_HOST=$(GATEWAY_IP="$gateway_ip" python3 - <<'PY'
import os
import socket

with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
    # UDP connect selects a source address without sending a datagram.
    route.connect((os.environ['GATEWAY_IP'], int(os.environ['MODEL_GATEWAY_PORT'])))
    print(route.getsockname()[0])
PY
)
export DSH_WEB_HOST
collector_rule=
expected_rules=5
web_input_rule=
expected_input_rules=3
if [ "$profile" = web ]; then
    web_input_rule="-A INPUT -p tcp --dport $DSH_WEB_PORT -m conntrack --ctstate NEW -j ACCEPT"
    expected_input_rules=4
fi
unset DSH_COLLECTOR_URL
if [ -n "${DSH_COLLECTOR_HOST:-}" ]; then
    DSH_COLLECTOR_PORT=${DSH_COLLECTOR_PORT:-8080}
    export DSH_COLLECTOR_PORT
    export DSH_COLLECTOR_URL="http://$DSH_COLLECTOR_HOST:$DSH_COLLECTOR_PORT"
    collector_rule="-A OUTPUT -d $DSH_COLLECTOR_HOST/32 -p tcp --dport $DSH_COLLECTOR_PORT -m conntrack --ctstate NEW -j ACCEPT"
    expected_rules=6
fi
browser_rules=$(GATEWAY_IP="$gateway_ip" python3 - <<'PY'
import ipaddress
import json
import os
from urllib.parse import urlsplit

origins = json.loads(os.environ['DSH_BROWSER_ALLOWED_ORIGINS'])
if not isinstance(origins, list) or any(not isinstance(origin, str) for origin in origins):
    raise SystemExit('browser origins must be a JSON string array')
allowed = tuple(map(ipaddress.ip_network, ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')))
gateway = (ipaddress.IPv4Address(os.environ['GATEWAY_IP']), int(os.environ['MODEL_GATEWAY_PORT']))
collector = (ipaddress.IPv4Address(os.environ['DSH_COLLECTOR_HOST']), int(os.environ['DSH_COLLECTOR_PORT'])) if os.environ.get('DSH_COLLECTOR_HOST') else None
seen = set()
for origin in origins:
    url = urlsplit(origin)
    try:
        address = ipaddress.IPv4Address(url.hostname or '')
        port = url.port if url.port is not None else (443 if url.scheme == 'https' else 80)
    except ValueError:
        raise SystemExit('browser origins must use literal local IPv4 addresses') from None
    if url.scheme not in ('http', 'https') or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment or not 1 <= port <= 65535 or not (address.is_loopback or address in allowed[0] or address in allowed[1] or address in allowed[2]):
        raise SystemExit('browser origins must be exact HTTP(S) loopback or private IPv4 origins')
    target = (address, port)
    if address.is_loopback or target == gateway or target == collector or target in seen:
        continue
    seen.add(target)
    print(f'-A OUTPUT -d {address}/32 -p tcp --dport {port} -m conntrack --ctstate NEW -j ACCEPT')
PY
)
if [ -n "$browser_rules" ]; then
    browser_rule_count=$(printf '%s\n' "$browser_rules" | wc -l)
    expected_rules=$((expected_rules + browser_rule_count))
fi

# Replace the complete filter table; no inherited ACCEPT rule may precede these rules.
iptables-restore <<EOF
*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT DROP [0:0]
-A INPUT -i lo -j ACCEPT
-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$web_input_rule
-A OUTPUT -d 127.0.0.11/32 -j DROP
-A OUTPUT -o lo -j ACCEPT
-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A OUTPUT -d $gateway_ip/32 -p tcp --dport $MODEL_GATEWAY_PORT -m conntrack --ctstate NEW -j ACCEPT
$collector_rule
$browser_rules
COMMIT
EOF
ip6tables-restore <<'EOF'
*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT DROP [0:0]
-A INPUT -i lo -j ACCEPT
-A OUTPUT -o lo -j ACCEPT
COMMIT
EOF
iptables -C OUTPUT -d "$gateway_ip/32" -p tcp --dport "$MODEL_GATEWAY_PORT" -m conntrack --ctstate NEW -j ACCEPT
if [ -n "${DSH_COLLECTOR_HOST:-}" ]; then
    iptables -C OUTPUT -d "$DSH_COLLECTOR_HOST/32" -p tcp --dport "$DSH_COLLECTOR_PORT" -m conntrack --ctstate NEW -j ACCEPT
fi
iptables -S OUTPUT | python3 -c 'import sys; rules=sys.stdin.read().splitlines(); assert rules[0] == "-P OUTPUT DROP" and rules[1] == "-A OUTPUT -d 127.0.0.11/32 -j DROP" and len(rules) == int(sys.argv[1]), (rules, sys.argv)' "$expected_rules"
iptables -S INPUT | python3 -c 'import sys; rules=sys.stdin.read().splitlines(); assert rules[0] == "-P INPUT DROP" and len(rules) == int(sys.argv[1]), rules' "$expected_input_rules"
ip6tables -S INPUT | python3 -c 'import sys; rules=sys.stdin.read().splitlines(); assert rules == ["-P INPUT DROP", "-A INPUT -i lo -j ACCEPT"], rules'
ip6tables -S OUTPUT | python3 -c 'import sys; rules=sys.stdin.read().splitlines(); assert rules == ["-P OUTPUT DROP", "-A OUTPUT -o lo -j ACCEPT"], rules'

if ! getent group "$DSH_GID" >/dev/null; then
    printf 'dsh%s:x:%s:\n' "$DSH_GID" "$DSH_GID" >> /etc/group
fi
if ! getent passwd "$DSH_UID" >/dev/null; then
    printf 'dsh%s:x:%s:%s:DSH:/state/home:/bin/sh\n' "$DSH_UID" "$DSH_UID" "$DSH_GID" >> /etc/passwd
fi
export HOME=/state/home DSH_HOME=/state/home/.dsh TMPDIR=/state/tmp
export MODEL_GATEWAY_HOST="$gateway_ip"
export DSH_MODEL_BASE_URL="http://$gateway_ip:$MODEL_GATEWAY_PORT/v1"
export DSH_LOCAL_MODEL_KEY=local
export DSH_TELEMETRY_DISABLED=1 DSH_TELEMETRY_MODE=DISABLED DO_NOT_TRACK=1
export HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1
export TSX_TSCONFIG_PATH=/opt/dsh/tsconfig.base.json
export DSH_WORKSPACE=${DSH_WORKSPACE:-/workspace}
cd "$DSH_WORKSPACE"

# This check runs after the irreversible drop and before loading any application code.
exec setpriv --reuid="$DSH_UID" --regid="$DSH_GID" --clear-groups \
    --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
    sh -c '
        set -eu
        profile=$1
        shift
        python3 -c '\''from pathlib import Path; s=dict(line.split(":",1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line); assert all(int(s[k].strip(),16)==0 for k in ("CapInh","CapPrm","CapEff","CapBnd","CapAmb")); assert s["NoNewPrivs"].strip()=="1"'\''
        mkdir -p /state/home /state/tmp
        if [ "$profile" = web ]; then
            python3 /opt/dsh/deploy/offline/profile_plugins.py
            node /opt/dsh/deploy/offline/prepare-presets.mjs "$TMPDIR/offline-presets.patch.yml"
            set -- --patch /opt/dsh/deploy/offline/web.patch.yml \
                --patch "$TMPDIR/offline-presets.patch.yml" "$@"
        fi
        if [ "$DSH_HERMES_ACP_ENABLED" = 1 ]; then
            set -- --patch /opt/dsh/deploy/offline/hermes.patch.yml "$@"
        fi
        exec node --import /opt/dsh/node_modules/tsx/dist/esm/index.mjs \
            /opt/dsh/apps/cli/src/bin.ts --profile "$profile" \
            --patch /opt/dsh/deploy/offline/cordis.patch.yml "$@"
    ' sh "$profile" "$@"
