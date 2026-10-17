# Nginx TLS reverse proxy (LAN HTTPS access to the gateway)

Lets a client on **another LAN device** reach the Voxi gateway over **HTTPS**, and on a
single machine serves the WebUI with a **keyless local identity**. Config lives in
[`infra/compose.proxy.yaml`](../../infra/compose.proxy.yaml) plus the rendered template
[`nginx.conf.template`](nginx.conf.template) and
[`voxi-entrypoint.sh`](voxi-entrypoint.sh) (the old hand-written `nginx.conf` is replaced
by the template + entrypoint, which enforce the identity invariants at container start).

## 0. Turnkey single-machine setup (recommended)

On one local machine you do not generate or paste any key. The stack does it itself on
`docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d`: the one-shot `secrets`
service writes the keys into the `voxi-secrets` volume and a loopback certificate into
`certs/`. On Windows `bootstrap.ps1` does the same job from the host, with extra verbs:

```powershell
pwsh infra/bootstrap.ps1            # keys + self-signed cert + WebUI build + up -d --wait
pwsh infra/bootstrap.ps1 -KeysOnly   # only reconcile .env + cert (no build/compose)
pwsh infra/bootstrap.ps1 -ShowKey     # reveal the local WebUI key once
pwsh infra/bootstrap.ps1 -RotateKey   # revoke + issue a new local WebUI key
```

`bootstrap.ps1` writes its keys to `.env`; the Compose path writes them to the secrets volume
instead. Both are equivalent — the environment always wins over the file, so an existing `.env`
is never overridden by generated material.

The proxy then injects a **separate, revocable** local key (`VOXI_WEBUI_KEY`, stored as
`webui-local` in `VOXI_API_KEYS_JSON`, never the master key) for same-origin `/v1`
calls. This is safe only because the entrypoint binds **loopback** and refuses to start
keyless injection against any other address; on top of that the vhost rejects a foreign
`Host` (→ **421**, cuts DNS rebinding) and a cross-site request (`Origin` /
`Sec-Fetch-Site`, → **403**) before injecting, and advertises **no CORS**. The injected
key is never written to any log. See [ADR 0006](../../docs/adr/0006-turnkey-local-identity.md)
and [ADR 0007](../../docs/adr/0007-compose-native-bootstrap.md) (Compose-native first-run
secrets/TLS).

> **Shared machine?** Loopback trust is same-*host*, not same-*user*. On a shared or
> multi-tenant host, turn local auto-identity off (`VOXI_PROXY_INJECT=false`) and require
> each client to send its own key — use the LAN flow below.

The remaining sections describe the **LAN / cross-device** path (`-ExposeLan`), where
injection is off, the loopback guards do not apply, and every client supplies its own
bearer over TLS.

## Why Caddy's HTTPS failed here

Automatic HTTPS (Let's Encrypt / ACME) can only validate **public domain names**. It
cannot issue a certificate for a private address like `192.168.x.x` or `localhost`. Caddy
on a LAN IP therefore fails to obtain/serve a trusted cert. On a LAN you must terminate TLS
yourself with a **self-signed or private-CA certificate** and make the client trust it.
Nginx does exactly that here.

## 1. Certificate: generated for loopback, provided for LAN

On a fresh clone nothing is needed for single-machine use: the one-shot `secrets` service
generates a loopback self-signed pair (`SAN: localhost, 127.0.0.1, ::1`, plus
`VOXI_PROXY_BIND_IP` when it is not loopback and any `VOXI_TLS_SAN` entries) into `certs/` on the
first `docker compose up -d`, and marks it `certs/.generated-by-voxi`. It is generated once and
never overwritten; a partial pair (`voxi.crt` without `voxi.key`, or the reverse) refuses to
start instead of being repaired silently.

For a **LAN** deployment provide your own pair — a loopback certificate has no SAN for the
address clients dial — and set `REQUIRE_PROVIDED_CERTS=1`, which refuses generated material (a
pair carrying the marker is rejected even if it exists). Needs OpenSSL (Git for Windows ships
it). Put the SAN `IP:` line to **this PC's LAN address** (`ipconfig` → your active adapter's
IPv4, **not** 127.0.0.1). PowerShell:

```powershell
New-Item -ItemType Directory -Force certs | Out-Null
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes `
  -keyout certs/voxi.key -out certs/voxi.crt `
  -subj "/CN=voxi-gateway" `
  -addext "subjectAltName=IP:192.168.1.50,DNS:localhost"
```

Delete `certs/.generated-by-voxi` if a generated pair was there before. `certs/` is gitignored;
never commit the key. The proxy mounts `./certs` read-only.

## 2. Bring the stack up through the proxy

The proxy override **removes the gateway host port** and reaches it by service DNS on the
internal `speech` network, so the Windows `8080` TCP excluded-port-range conflict disappears.
Always pass both files so relative bind mounts resolve from the repo root:

```powershell
docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d --wait --wait-timeout 600 gateway proxy
```

Open the **8443** port inbound on the host firewall, scoped to your subnet (admin PowerShell):

```powershell
New-NetFirewallRule -DisplayName "Voxi proxy LAN" -Direction Inbound -LocalPort 8443 -Protocol TCP -Action Allow -RemoteAddress 192.168.1.0/24
```

Do **not** forward 8443 to WAN. Verify locally:

```powershell
curl.exe -k https://127.0.0.1:8443/healthz
```

## 3. Point OpenWebUI at the HTTPS base URL

```
AUDIO_TTS_OPENAI_API_BASE_URL=https://<PC-LAN-IP>:8443/v1
AUDIO_STT_OPENAI_API_BASE_URL=https://<PC-LAN-IP>:8443/v1
```

Model/voice/key unchanged (`ema-lightning` / `ema-tr` / your `VOXI_API_KEY`).

## 4. Make the client TRUST the cert (this is the step that "makes https work")

A self-signed cert is rejected unless trusted, which is what makes calls "erişilemedi":

- **Browser**: first visit `https://<PC-LAN-IP>:8443/healthz`, accept the warning once; or
  install `certs/voxi.crt` into that device's **Trusted Root Certification Authorities**.
- **OpenWebUI backend** (server-side HTTPS calls to Voxi): it verifies TLS, so it must trust
  the cert too, or calls fail with a certificate error. Put `voxi.crt` into the OpenWebUI
  container/host trust store, e.g. mount it and run
  `update-ca-certificates`, or set `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE` to its path.

Regenerate and restart the proxy whenever the LAN IP changes.

## About the microphone (read this)

The browser blocks the microphone (`getUserMedia`) whenever **the OpenWebUI page itself** is
loaded over plain HTTP on a non-localhost origin. Fronting **Voxi** with HTTPS does **not**
lift that block — the mic depends on how you open **OpenWebUI**, not on Voxi's URL. To use the
mic you must also make OpenWebUI a secure context:

- Easiest, no cert: on the device with the mic, open OpenWebUI at `http://localhost:<port>`.
  `localhost` is always a secure context. OpenWebUI's backend still calls Voxi over the LAN
  (its own TLS trust handled in step 4).
- Or serve **OpenWebUI** over HTTPS the same way (put nginx/TLS in front of it on its device)
  and open it by its `https://` URL.

What this proxy genuinely gives you: encrypted, network-reachable access to the Voxi audio API
so the bearer key and audio are not sent in cleartext across the LAN, and WebSocket streaming
routes forwarded with `Upgrade`/`Connection` headers and a long read timeout. It is not an
OpenWebUI mic fix by itself.

## Serving the Voxi WebUI

The same TLS proxy also serves the lightweight WebUI console (`webui/`, Vite + React +
Tailwind v4) as a **static bundle** at `https://<host>:8443/ui/`. The host root `/`
redirects there. Build it, then (re)start the proxy:

```powershell
npm --prefix webui install
npm --prefix webui run build          # emits webui/dist (gitignored build artifact)
docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d --wait gateway proxy
```

**After re-building the UI later**, run `up -d --force-recreate proxy`. Vite's build wipes and
recreates `webui/dist` with new content-hashed asset names; on Docker Desktop (Windows) the
proxy's read-only bind mount of that directory does **not** pick up the newly created files, so
requests for the new `assets/index-*.js` silently fall through to the SPA `index.html` (the page
loads with a blank body). Recreating the proxy re-establishes the mount against the fresh `dist`.

`infra/compose.proxy.yaml` mounts `./webui/dist` read-only into the container, and
`nginx.conf.template` serves it via `location /ui/ { alias ... }` with SPA fallback to
`index.html`. The UI calls the real gateway on the **same origin** (`/healthz`, `/readyz`,
`/v1/models`, `/v1/audio/*`, and the `WS /v1/*` streams), so it inherits this proxy's TLS,
WebSocket upgrade and the gateway's own bearer-key auth — there is no separate API host to
configure. In **loopback inject mode** the proxy supplies the bearer for you, so the console
needs no key at all; in **LAN mode** the operator pastes a client key, which is stored only
in that browser's localStorage.

## Verified / unverified

The `nginx:1.27-alpine` proxy identity guards have been exercised against this stack with
`scripts/smoke_proxy.py` (loopback 421/403, runtime.json, no-CORS, config `0600`, no key in
logs; startup refusal on inject+non-loopback and on missing cert). OpenWebUI UI setup,
browser autoplay/decoding and microphone capture remain operator-verified. The Voxi
WebSocket transports (ADR 0005) are custom client protocols OpenWebUI does not speak.
