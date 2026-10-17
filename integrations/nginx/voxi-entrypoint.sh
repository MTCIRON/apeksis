#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

# -----------------------------------------------------------------------------
# Voxi proxy container entrypoint.
#
# Renders nginx.conf.template -> conf.d/default.conf and ENFORCES the identity
# invariants at container start (not only in bootstrap.ps1), so editing `.env`
# by hand cannot bypass them:
#   * keyless injection is refused on a non-loopback bind UNLESS the operator
#     explicitly opt-ed in with VOXI_ALLOW_LAN_INJECT=true (trusted-LAN mode:
#     injection stays on, guards stay on, but the Host/origin allowlists accept
#     private-network addresses plus VOXI_PROXY_EXTRA_HOSTS entries — which
#     means every device on that network can use the gateway WITHOUT a key);
#   * TLS is mandatory (no plaintext bearer) — no cert, no start;
#   * the rendered config may embed a bearer, so it is written 0600 root-only.
# Runs as root (stock nginx image); substitutes env vars with `envsubst`.
# -----------------------------------------------------------------------------
set -eu

TEMPLATE=/etc/nginx/voxi-nginx.conf.template
CONF_OUT=/etc/nginx/conf.d/default.conf
TLS_DIR=/etc/nginx/tls

is_true() {
    case "${1:-}" in
        true|TRUE|1|yes|YES) return 0 ;;
        *) return 1 ;;
    esac
}

# Loopback binds that make keyless identity sound. Empty == compose default loopback.
is_loopback_bind() {
    case "${VOXI_PROXY_BIND_IP:-}" in
        ""|127.0.0.1|::1|localhost|\[::1\]) return 0 ;;
        *) return 1 ;;
    esac
}

INJECT_ON=0
MODE_LABEL="per-client key"
# Extra `map` allow-lines rendered into the Host/origin allowlists. Empty unless
# trusted-LAN injection is on; the template keeps a substitution slot so nginx
# vars and structure stay under template control, never operator input alone.
LAN_HOST_ALLOW=""
LAN_ORIGIN_ALLOW=""
# Secret file fallback: on a fresh clone (no .env) the one-shot `secrets` service
# writes the local WebUI key into the shared volume. An explicit VOXI_WEBUI_KEY
# always wins and is never overwritten. The value stays in a shell variable — it
# is never echoed, and the rendered config that embeds it is written 0600.
SECRETS_DIR="${VOXI_SECRETS_DIR:-/run/voxi-secrets}"
if [ -z "${VOXI_WEBUI_KEY:-}" ] && [ -f "$SECRETS_DIR/webui.key" ]; then
    VOXI_WEBUI_KEY=$(cat "$SECRETS_DIR/webui.key")
fi

lan_inject=false
if is_true "${VOXI_PROXY_INJECT:-false}"; then
    if ! is_loopback_bind && ! is_true "${VOXI_ALLOW_LAN_INJECT:-false}"; then
        echo "REFUSING TO START: VOXI_PROXY_INJECT=true but VOXI_PROXY_BIND_IP='${VOXI_PROXY_BIND_IP:-<empty>}' is not loopback." >&2
        echo "Keyless identity must never be reachable off-box. Either expose the LAN in per-client-key" >&2
        echo "mode (VOXI_PROXY_INJECT=false, every client sends its own key over TLS), or on a TRUSTED" >&2
        echo "private network explicitly accept the risk with VOXI_ALLOW_LAN_INJECT=true (injection" >&2
        echo "stays on; guards accept private ranges + VOXI_PROXY_EXTRA_HOSTS; every LAN device can" >&2
        echo "then use the gateway without a key). See integrations/nginx/README.md." >&2
        exit 1
    fi
    if [ -z "${VOXI_WEBUI_KEY:-}" ]; then
        echo "REFUSING TO START: injection is enabled but no local WebUI key is available." >&2
        echo "The one-shot 'secrets' service generates one; bootstrap.ps1 generates one too." >&2
        echo "Neither an explicit VOXI_WEBUI_KEY nor $SECRETS_DIR/webui.key was found." >&2
        exit 1
    fi
    INJECT_ON=1
    VOXI_INJECT_AUTH="Bearer ${VOXI_WEBUI_KEY}"
    if is_loopback_bind; then
        MODE_LABEL="loopback keyless (injected)"
        VOXI_RUNTIME_JSON='{"mode":"loopback","needKey":false,"autoIdentity":true}'
    else
        lan_inject=true
        MODE_LABEL="trusted-LAN keyless (injected)"
        VOXI_RUNTIME_JSON='{"mode":"lan-inject","needKey":false,"autoIdentity":true}'
    fi
else
    # LAN / explicit mode: no injection, guards off, per-client keys required.
    if is_true "${VOXI_ALLOW_LAN_INJECT:-false}"; then
        echo "NOTE: VOXI_ALLOW_LAN_INJECT is set but VOXI_PROXY_INJECT is false — the flag is inert" >&2
        echo "      here: per-client-key mode never injects and never relaxes anything." >&2
    fi
    VOXI_INJECT_AUTH=""
    VOXI_RUNTIME_JSON='{"mode":"lan","needKey":true,"autoIdentity":false}'
fi

# TLS is always required on this listener — never fall back to a plaintext bearer,
# in either mode. Missing cert => refuse to start with a documented fix.
if [ ! -f "$TLS_DIR/voxi.crt" ] || [ ! -f "$TLS_DIR/voxi.key" ]; then
    echo "REFUSING TO START: TLS material missing under $TLS_DIR (voxi.crt / voxi.key)." >&2
    echo "The one-shot 'secrets' service generates a loopback certificate unless" >&2
    echo "REQUIRE_PROVIDED_CERTS=1; for LAN/production provide your own — see" >&2
    echo "integrations/nginx/README.md." >&2
    exit 1
fi

# REQUIRE_PROVIDED_CERTS=1 means "no generated material": a certificate this
# project created itself does not count as provided. The marker exists only when
# we generated the pair, so the fail-closed promise survives a stale certs/ dir.
if is_true "${REQUIRE_PROVIDED_CERTS:-false}" && [ -f "$TLS_DIR/.generated-by-voxi" ]; then
    echo "REFUSING TO START: REQUIRE_PROVIDED_CERTS=1 but the certificate under $TLS_DIR" >&2
    echo "was auto-generated by Voxi. Provide your own voxi.crt + voxi.key, delete" >&2
    echo "$TLS_DIR/.generated-by-voxi, and restart." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Trusted-LAN injection: relax the inject-mode guards to RFC1918 private ranges
# plus operator-listed extra hosts. Entries are character-validated and
# fail-closed — this value is interpolated into nginx `map` blocks, so a stray
# `;`, `{` or quote in VOXI_PROXY_EXTRA_HOSTS must never be able to break out
# of the map context.
# ---------------------------------------------------------------------------
if [ "$lan_inject" = true ]; then
    RANGE_HOST='~^(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]{1,3}\.[0-9]{1,3})$'
    RANGE_ORIGIN='~^https?://(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]{1,3}\.[0-9]{1,3})(:[0-9]+)?$'
    LAN_HOST_ALLOW="    # Trusted-LAN allowances (VOXI_ALLOW_LAN_INJECT=true): private-network
    # hosts accepted so LAN browsers can use the injected identity. Any device
    # on this network can then call the gateway WITHOUT a key.
    \"${RANGE_HOST}\"  0;
"
    LAN_ORIGIN_ALLOW="    \"${RANGE_ORIGIN}\"  0;
"
    # Already-allowed loopback literals; listed extras may not duplicate them
    # (nginx aborts on duplicate exact map keys) or each other.
    lan_seen=" localhost 127.0.0.1 ::1 [::1] "
    if [ -n "${VOXI_PROXY_EXTRA_HOSTS:-}" ]; then
        oldIFS=$IFS
        IFS=,
        # Deliberate word-splitting on commas.
        set -- ${VOXI_PROXY_EXTRA_HOSTS}
        IFS=$oldIFS
        for lan_token in "$@"; do
            lan_token=$(printf '%s' "$lan_token" | tr -d ' \t')
            [ -z "$lan_token" ] && continue
            case "$lan_token" in
                *[!A-Za-z0-9.-]*|.*|*..*|.|*.|*-)
                    echo "REFUSING TO START: VOXI_PROXY_EXTRA_HOSTS entry '${lan_token}' is not a plain" >&2
                    echo "host name: letters, digits, dots and hyphens only; no leading/trailing or" >&2
                    echo "doubled dots. It is interpolated into the nginx map blocks and must stay inert." >&2
                    exit 1 ;;
            esac
            case "$lan_seen" in
                *" ${lan_token} "*)
                    # duplicate of a loopback literal or an earlier entry — skip
                    ;;
                *)
                    lan_seen="${lan_seen}${lan_token} "
                    LAN_HOST_ALLOW="${LAN_HOST_ALLOW}    ${lan_token}  0;
"
                    lan_esc=$(printf '%s' "$lan_token" | sed 's/\./\\./g')
                    LAN_ORIGIN_ALLOW="${LAN_ORIGIN_ALLOW}    \"~^https?://${lan_esc}(:[0-9]+)?\$\"  0;
" ;;
            esac
        done
    fi
    echo "WARNING (trusted-LAN inject): guards accept private-range Hosts for bind IP '${VOXI_PROXY_BIND_IP:-}'." >&2
    echo "  Every device on this network can call the gateway WITHOUT a key while injection is on." >&2
    echo "  Only enable on a network you fully trust; keep TLS on this listener in every case." >&2
    echo "  If the certificate has no SAN for this LAN IP, browsers will show a name warning." >&2
fi

if [ ! -f "$TEMPLATE" ]; then
    echo "REFUSING TO START: template not found at $TEMPLATE." >&2
    exit 1
fi

export VOXI_INJECT_ON="$INJECT_ON"
export VOXI_INJECT_AUTH
export VOXI_RUNTIME_JSON
# The build block works with unprefixed local names; the render list (template
# slots) uses the VOXI_* names.
export VOXI_LAN_HOST_ALLOW="$LAN_HOST_ALLOW"
export VOXI_LAN_ORIGIN_ALLOW="$LAN_ORIGIN_ALLOW"

# Substitute ONLY our five variables so nginx runtime vars ($host, $uri, ...)
# survive verbatim.
envsubst '${VOXI_INJECT_ON} ${VOXI_INJECT_AUTH} ${VOXI_RUNTIME_JSON} ${VOXI_LAN_HOST_ALLOW} ${VOXI_LAN_ORIGIN_ALLOW}' \
    < "$TEMPLATE" > "$CONF_OUT"

# The rendered file can contain a bearer in keyless mode: owner(root)-only, no
# group/world read. nginx reads it once at startup as the root master process.
chown root:root "$CONF_OUT"
chmod 600 "$CONF_OUT"

echo "Voxi proxy: identity mode = ${MODE_LABEL}, guards = $([ "$INJECT_ON" = 1 ] && echo 'host-allowlist+cross-site' || echo 'off')." >&2

exec nginx -g 'daemon off;'
