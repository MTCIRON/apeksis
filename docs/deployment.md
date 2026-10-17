# Deployment — file speech and bounded streaming

Base deployment contains **gateway + EMA Lightning + Faster-Whisper only**. It is independent of telephony and n8n. Antalia-2 Mini is opt-in. n8n owns agent decisions when configured; gateway has no LLM, prompts, tools, memory, or business rules. HTTP turn delivery returns validated actions only; the Voxi WebSocket transports additionally carry synthesized audio and transcripts to a connected client. Neither implements a phone agent or SIP media runtime.

## Prerequisites and security

- Docker Engine/Desktop running Linux containers and Docker Compose **v2.24 or newer** (need: the
  proxy overlay uses the Compose `!reset` tag to remove the gateway host port). On Windows, enable
  WSL2-backed Linux containers. Python 3.12 and `uv` are needed for the host smoke client; install
  FFmpeg/ffprobe on that host.
- Online access for image/package builds and explicit model provisioning; no account or paid cloud
  API is required for these public models. Review [upstream audit](upstream-audit.md) and
  [licensing](licensing.md) before distribution. Model pins and integrity verification live in
  `scripts/provision_models.py`. All pinned repositories are public today, so no Hugging Face
  account or token is needed; if a future pin is ever gated, pass a read-scoped token as the
  `HF_TOKEN` environment variable to the `provision-*` services (runtime only — never baked into
  an image, never written to disk, never logged).
- CPU defaults: EMA, multilingual Whisper **small**, four inference threads, one in-flight job per worker. RAM/disk/startup performance depends on hardware and has not been guaranteed by a guessed capacity number. Provisioning and builds consume additional disk.
- `.env` is **optional**. On a fresh clone the install command below generates the worker key, the master key, the local WebUI key and the keyring itself (the one-shot `secrets` service), plus a loopback TLS certificate for the proxy - so `git clone` followed by that one command is a complete install. Copy `.env.example` to `.env` only to **pin** your own values; anything set there wins over generated material, and an existing file is never overwritten. If you do set keys, run `python -c "import secrets; print(secrets.token_urlsafe(48))"` **twice** and put different values into `VOXI_API_KEY` and `VOXI_WORKER_API_KEY` (minimum 32 characters). Do not commit `.env`, recordings, transcripts, or credentials. For LAN or production set `REQUIRE_PROVIDED_CERTS=1` and provide your own certificate pair, and use `pwsh infra/bootstrap.ps1` on Windows for the equivalent host-side path.
- By default only gateway publishes **127.0.0.1:8080**. Worker ports are never published; `/internal/*` requires the separate worker bearer key. Health/ready probes contain no inference output. All containers run UID/GID 10001, read-only rootfs, dropped capabilities, no-new-privileges, bounded `/tmp` tmpfs, and rotated logs. Provisioning alone mounts model volumes read/write; runtime mounts read-only. For a same-LAN client on another device, opt in by setting `VOXI_BIND_IP` to this host's LAN address (never a public/WAN interface), restrict the host firewall inbound rule to the trusted subnet, and keep the bearer key strong; the loopback default otherwise stays authoritative.
- Containers retain outbound bridge-network routing by default so explicit provisioning and an existing n8n deployment can work. Worker offline model flags are not a network firewall. For enforced runtime WAN denial, use the offline override below. Do not attach untrusted containers to the speech network.
- A reverse proxy/TLS/authenticated private route is required for remote clients. Do not simply change localhost binding to a public address. No admin password or cloud credentials are supplied. Any proxy in front of the gateway must forward WebSocket upgrade requests (`Connection: Upgrade`, `Upgrade: websocket`) and allow long-lived connections; a proxy that buffers responses defeats the bounded backpressure of the streaming routes. Keep the proxy idle timeout above `VOXI_WS_IDLE_TIMEOUT` so the gateway, not the proxy, decides when a silent socket is reaped.

## Turnkey local identity (TLS proxy)

The nginx TLS proxy (`infra/compose.proxy.yaml` + `integrations/nginx/`) is the **only**
published service; the gateway stays internal on the `speech` network. It makes the console
usable with no key entry on a single local machine. On Windows `bootstrap.ps1` does the same
job from the host; on any platform one command is enough, because the one-shot `secrets`
service generates the keys and a loopback certificate — but that command **must include the
proxy overlay**, since `proxy` is not defined in the base file:

```sh
docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d --wait --wait-timeout 900
```

`docker compose up -d` on the base file alone starts the API (`gateway`, `tts-ema`,
`stt-whisper`) with **no TLS edge and no `/ui/`** — it is not a complete install. On Linux/macOS
`scripts/up.sh` is a reviewed thin wrapper for exactly the command above (it also hard-fails with
install guidance when Docker or the Compose plugin is missing). See
[ADR 0006](adr/0006-turnkey-local-identity.md) for the identity reasoning and
[ADR 0007](adr/0007-compose-native-bootstrap.md) for the first-run secrets/TLS decision.

```powershell
pwsh infra/bootstrap.ps1            # first run: keys + cert + WebUI build + up -d --wait
pwsh infra/bootstrap.ps1 -ShowKey   # reveal the local WebUI key once
pwsh infra/bootstrap.ps1 -RotateKey # revoke + issue a new local WebUI key
pwsh infra/bootstrap.ps1 -ExposeLan -LanIP 192.168.1.50   # LAN: injection OFF
```

What it sets up and why it is safe:

- **Server-side identity.** The proxy injects a **separate** local key
  (`VOXI_WEBUI_KEY`, registered in `VOXI_API_KEYS_JSON` as `webui-local`, never the
  master key) into same-origin `/v1` calls, so the browser holds no credential. Revoke
  by `-RotateKey` (or dropping that one record).
- **Keyless is not just loopback-bound.** While injection is on, the proxy rejects a
  foreign `Host` with **421** (cuts DNS rebinding) and a cross-site request (`Origin`/
  `Sec-Fetch-Site: cross-site`) with **403**, **before** injecting anything; it never
  advertises CORS. Same-origin WebUI is unaffected.
- **Entrypoint guard.** `integrations/nginx/voxi-entrypoint.sh` refuses to start when
  injection is on but `VOXI_PROXY_BIND_IP` is not loopback — **unless the operator
  explicitly set `VOXI_ALLOW_LAN_INJECT=true`** (trusted-LAN injected mode: guards stay
  on and additionally accept the RFC1918 private ranges plus `VOXI_PROXY_EXTRA_HOSTS`;
  every device on that network can then use the gateway without a key) — or when TLS
  material is absent — so editing `.env` by hand cannot bypass the invariant. TLS is
  mandatory in all modes; `-ExposeLan` and trusted-LAN injection therefore require the
  certificate flow in [integrations/nginx/README.md](../integrations/nginx/README.md).
- **Generated vs provided TLS.** A missing pair is generated once (SANs: `localhost`,
  `127.0.0.1`, `::1`, plus `VOXI_PROXY_BIND_IP` when it is not loopback and any
  `VOXI_TLS_SAN` entries) and marked with `certs/.generated-by-voxi`. The published bind
  stays loopback. `REQUIRE_PROVIDED_CERTS=1` restores strict fail-closed behaviour: nothing
  is generated, a missing pair refuses to start, and a certificate carrying that marker is
  refused even though it exists. Use it for LAN and production.
- **No key in logs.** The rendered config embeds the bearer only in a `0600`
  root-only file; `log_format voxi_safe` records `$uri` only and `error_log` stays at
  `warn`. `.env`, when used, is written owner-only (`icacls` / `600`); generated keys live
  root-owned in the `voxi-secrets` volume — see
  [Local secrets](#local-secrets-no-env-required). Keys are never printed except via
  `-ShowKey`.
- **Status, honestly.** The proxy serves `/ui/runtime.json` (`loopback` / `lan` /
  `lan-inject`, `needKey`, `autoIdentity`) — a public static file outside the `/v1`
  contract — so the WebUI Settings screen shows whether this install auto-identifies or
  needs a key.

Verify the guards end-to-end against a running proxy:

```sh
python scripts/smoke_proxy.py --url https://127.0.0.1:8443 --mode loopback --insecure
python scripts/smoke_proxy.py --url https://<lan-ip>:8443 --mode lan --key <VOXI_API_KEY> --insecure
python scripts/smoke_proxy.py --url https://<lan-ip>:8102 --mode lan-inject --insecure
```

**Shared machines:** loopback trust is same-*host*, not same-*user* trust — another
local user/process can reach the keyless port. On any shared or multi-tenant host,
disable local auto-identity (`VOXI_PROXY_INJECT=false`) and require per-client keys.

### Merging into an existing Compose stack

Everything above composes with an environment where other services already run. The
reviewed template overlay `infra/compose.lan-stack.example.yaml` carries four
capabilities: publishing the proxy on a LAN address in trusted-LAN injected mode, serving
models from a central host tree (`VOXI_MODELS_DIR`, default `/opt/ai-models/voxi/models`)
instead of named volumes, joining the consuming stack's network so peers reach the
gateway by a stable name, and fixed `container_name`s (`voxi-gateway`, `voxi-tts-ema`,
`voxi-stt-whisper`, `voxi-webui`, `voxi-proxy`) so OpenWebUI/n8n use
`http://voxi-gateway:8080/v1` regardless of the Compose project prefix. Load it LAST,
load all three files always, and supply the expected env values in the consuming stack's
`.env` (documented at the top of that file).

```sh
docker compose -f compose.yaml -f infra/compose.proxy.yaml \
               -f infra/compose.lan-stack.example.yaml config --quiet
```

`VOXI_MODELS_DIR` is shared by the WORKERS **and the four `provision-*` one-shot
services** — the downloaders write the central tree, the readers mount it read-only, so
both sides always see the same files. The model containers run as UID `10001`; prepare
the host tree accordingly:

```sh
mkdir -p /opt/ai-models/voxi/models /opt/ai-models/voxi/certs
chown -R 10001:10001 /opt/ai-models/voxi
```

`VOXI_PROXY_PORT` picks the published port (any free port; the example `.env` in the
overlay header uses `8102` because 8443 is commonly taken by other gateways), and
`VOXI_CPU_THREADS` caps each CPU worker's thread pool on big-core servers (`8`, or `16`
— per worker, not per process). Certificates stay in the checkout's `./certs`; symlink
your central cert directory there if your storage standard requires it. The OpenWebUI
audio integration envs live in `integrations/openwebui/audio.env.example`.

## Build, install models, start

From a fresh clone, one command installs and starts everything — pinned models, local secrets and the
TLS/UI edge included:

```sh
docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d --wait --wait-timeout 900
docker compose -f compose.yaml -f infra/compose.proxy.yaml ps
```

Two kinds of one-shot service run first, in dependency order:

- `secrets` writes the worker key, the master key, the local WebUI key and the keyring into the
  `voxi-secrets` volume, and — unless `REQUIRE_PROVIDED_CERTS=1` — a loopback self-signed certificate
  into `certs/`. It is idempotent: an existing file, or an explicit `.env` value, is never overwritten,
  so re-running `up -d` cannot rotate a key out from under a running stack. It needs no network.
- the four `provision-*` services download every pinned revision — EMA Lightning, Whisper small, Antalia
  Mini and Whisper large-v3-turbo — from the immutable Hub addresses in
  `src/voxi/providers/inventory.py`, and verify each digest before publishing it. Later runs only re-hash
  what is already on the volume, which needs no network.

`docker compose … ps` then shows `gateway`, `proxy`, `webui`, `tts-ema` and `stt-whisper` up/healthy, and
the five one-shot services `Exited (0)`. `--wait` accepts those exited services because each one is a
`depends_on` target of a long-running service; the gateway depends on the two whose workers stay opt-in,
so a full `up -d --wait` returns 0.

The published surface is the proxy only: **`https://127.0.0.1:8443/ui/`** for the console and
`https://127.0.0.1:8443/v1` for the API. With no `.env` the default install serves the default profile
(`ema-lightning`, `whisper-small` → `/v1/models` returns `tts-1, ema-lightning, whisper-1,
whisper-small`); the opt-in workers are added with `--profile antalia --profile stt-turbo`, whose models
are installed either way.

Because `.env` and `certs/` are gitignored and no longer required, `git clone <repo> && cd <repo> &&
docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d` is a complete install. Provide your own
values only to override generated material. The two `-f` flags are required, not optional: `proxy` lives
only in `infra/compose.proxy.yaml`, so the bare `docker compose up -d` starts the API without the TLS/UI
edge.

To pre-provision explicitly — air-gapped host, CI, or to re-check a pinned revision — run the same
one-shot services directly; this is also the only path that offers `--verify-only`:

```sh
docker compose run --rm --no-deps provision-ema python /app/scripts/provision_models.py --help
docker compose run --rm --no-deps provision-ema
docker compose run --rm --no-deps provision-whisper
docker compose run --rm --no-deps provision-antalia
docker compose run --rm --no-deps provision-whisper-turbo
docker compose run --rm --no-deps provision-ema python /app/scripts/provision_models.py --root /models --models ema-lightning --verify-only
```

The provision services are deliberately **not** profile-gated. A profile enables services but does not
order them ahead of runtime, and Compose refuses `depends_on` against a profile-gated service (it is
"undefined" whenever the profile is off). Their runtime workers stay opt-in (`--profile antalia`,
`--profile stt-turbo`); the models they need are installed either way.

### Local secrets (no `.env` required)

`scripts/bootstrap_secrets.py` runs as the one-shot `secrets` service. It has no network access
(`network_mode: none`), drops every capability except `CHOWN`, and writes root-owned files with no world
access:

| File | Reader | Mode |
|---|---|---|
| `/run/voxi-secrets/worker.key` | gateway + workers (UID 10001) | `0640 root:voxi` |
| `/run/voxi-secrets/app.key` | gateway | `0640 root:voxi` |
| `/run/voxi-secrets/api-keys.json` | gateway keyring (SHA-256 only) | `0640 root:voxi` |
| `/run/voxi-secrets/webui.key` | root proxy process only | `0600 root:root` |
| `certs/voxi.key` | root proxy process only | `0600 root:root` |

`0600 root:root` is used only where the reader is root. The files read by the UID 10001 runtime are
`0640 root:voxi` (group `voxi` = GID 10001), because a `0600` root-owned file would be unreadable to a
non-root reader — this is the honest deviation from "root-only 0600". Nothing is world-readable, and no
generated value is printed, logged, or placed in a container's environment; `docker compose logs secrets`
shows only file names.

Every reader accepts three sources, in this order: the environment variable
(`VOXI_WORKER_API_KEY`, `VOXI_API_KEY`, `VOXI_API_KEYS_JSON`, `VOXI_WEBUI_KEY`), then `<NAME>_FILE`,
then the default path under `VOXI_SECRETS_DIR`.

Docker targets use the pinned Python 3.12.12 Bookworm manifest and `uv==0.6.17` to export transitive constraints from `uv.lock`; installation is `pip install .`, `.[tts]`, `.[stt]`, or `.[antalia]` under those constraints. CPU TTS explicitly installs `torch==2.7.0` from the official CPU wheel index. STT CPU uses CTranslate2 without torch. OS packages are installed from Debian repositories, not a frozen Debian snapshot; rebuild security/SBOM review remains necessary. Python base manifest: [Docker Hub metadata](https://hub.docker.com/v2/repositories/library/python/tags/3.12.12-slim-bookworm).

Named volumes are `voxi_secrets` (the generated local keys and keyring — see
[Local secrets](#local-secrets-no-env-required)), `voxi_ema-models`, `voxi_whisper-models`,
`voxi_whisper-turbo-models`, and `voxi_antalia-models`. First creation copies UID10001-owned `/models` from the image; model snapshots/caches remain across `docker compose down`. **`down -v` destroys model caches.** Provision script contract:

```sh
python scripts/provision_models.py --root ./models --models ema-lightning whisper-small
python scripts/provision_models.py --root ./models --models ema-lightning whisper-small --verify-only
```

Host directories are an alternative, not what base Compose mounts. To run outside Docker, set `EMA_MODEL_PATH`, `WHISPER_MODEL_PATH`, `ANTALIA_MODEL_PATH` to their provisioned directories and follow worker entrypoints; never substitute model IDs that silently trigger runtime downloads.

## Real OpenAI SDK smoke

With services ready, install **development client dependencies only**:

```sh
uv sync --locked --extra dev
```

PowerShell, load only the needed audio key without printing it:

```powershell
$env:VOXI_API_KEY = (Get-Content .env | Select-String '^VOXI_API_KEY=').Line.Split('=', 2)[1]
uv run python scripts/smoke.py --base-url http://127.0.0.1:8080/v1
```

POSIX, set `VOXI_API_KEY` in your shell from the secret store (do not source arbitrary unreviewed `.env` files), then:

```sh
uv run python scripts/smoke.py --base-url http://127.0.0.1:8080/v1
```

Script checks readiness/models, requests **real Turkish WAV and MP3 via OpenAI SDK**, validates WAV mono PCM16/24 kHz and positive duration, probes MP3, decodes both entirely with FFmpeg, uploads the generated WAV to Faster-Whisper, and saves observed nonempty transcription. It never asserts fixed transcript contents. Artifacts: `smoke-output/response.wav`, `response.mp3`, `report.json`. Listen to both files and assess Turkish intelligibility separately; file decoding is not a quality benchmark. HTTP SDK streaming is file response delivery, not realtime inference. `--model tts-1 --voice ema-tr` exercises the OpenAI alias and `--model antalia-mini --voice antalia-tr` the opt-in Antalia engine; both resolve to a physical voice.

**With the TLS proxy override** (`-f infra/compose.proxy.yaml`) the gateway's host port is removed (`ports: !reset []`), so there is no `127.0.0.1:8080` on the host. Run the smoke client in its own image, or from the host through the proxy:

```sh
# Dedicated client image, inside the speech network (its default base-url is gateway:8080):
docker compose -f compose.yaml -f infra/compose.proxy.yaml --profile smoke run --rm --no-deps smoke
```

```powershell
# From the host, through the TLS proxy (self-signed cert => pass its PEM):
$env:VOXI_API_KEY = (Get-Content .env | Select-String '^VOXI_API_KEY=').Line.Split('=', 2)[1]
uv run python scripts/smoke.py --base-url https://127.0.0.1:8443/v1 --ca-bundle certs/voxi.crt
```

`--ca-bundle` trusts the proxy's PEM for both the readiness probe and the SDK transport; `--insecure` skips verification for a self-signed proxy on this machine only, and the two are mutually exclusive. The gateway image installs no `openai` client, so the client comes from the `smoke` image or from the host dev environment — `docker compose exec gateway python scripts/smoke.py` cannot work.

## Enforced offline smoke

Build/provision online first, including the real SDK client image, then recreate network without removing volumes:

```sh
docker compose --profile smoke build smoke
docker compose down
docker compose -f compose.yaml -f infra/compose.offline.yaml up -d --wait --wait-timeout 600 gateway tts-ema stt-whisper
docker compose --profile smoke -f compose.yaml -f infra/compose.offline.yaml run --rm --no-deps smoke
```

The override sets the speech bridge network `internal: true`; external n8n is unavailable and must not be needed for these file APIs. On the tested Windows Docker Desktop setup, host access to the published gateway port was refused on this internal network. The `smoke` profile therefore runs the actual OpenAI SDK and FFmpeg client **inside the isolated network**, without runtime installation/download or fake inference. It prints the report; its audio files live in container `/tmp` and are removed with `--rm`. For permanent LAN access while denying WAN, enforce host/router firewall policy separately; do not weaken this isolated-network check. Full host/router WAN-block and packet-capture evidence remains a separate release gate.

The smoke profile defaults to `VOXI_API_KEY`. If gateway uses hashed keys only, supply `VOXI_SMOKE_API_KEY` with a real client secret carrying both `audio:read` and `audio:write`. No key is baked into the image.

## Optional Antalia

EMA remains default. First provision Antalia, then enable worker **and** gateway registration:

```sh
docker compose --profile antalia build tts-antalia
docker compose run --rm --no-deps provision-antalia
docker compose run --rm --no-deps provision-antalia python /app/scripts/provision_models.py --root /models --models antalia-mini --verify-only
```

The default `docker compose up -d` already installs `antalia-mini`; the `run` lines above only re-check
it or pre-provision it before the worker starts.

Set `ANTALIA_URL=http://tts-antalia:8083` in `.env`, then:

```sh
docker compose --profile antalia up -d --wait --wait-timeout 600 gateway tts-ema stt-whisper tts-antalia
uv run python scripts/smoke.py --model antalia-mini --voice antalia-tr --output-dir smoke-output/antalia
```

Worker sets `VOXI_TTS_PROVIDER=antalia-mini`; model ID and physical voice are `antalia-mini` / `antalia-tr`. Do not set `ANTALIA_URL` before worker is provisioned/ready. Profile alone does not register a gateway provider. EMA native normalization uses native fallback policy; Antalia retains its native policy. Gateway does not normalize text. No SSML, alternate voices, style or cloning is implied, and neither optional worker changes the transport protocol.

## Optional whisper-large-v3-turbo STT

The default STT worker serves `whisper-small`. The higher-accuracy CTranslate2 build runs as a **separate
opt-in worker**, so both models can serve at once and a client picks by model id:

```sh
docker compose run --rm --no-deps provision-whisper-turbo python /app/scripts/provision_models.py --root /models --models whisper-large-v3-turbo --verify-only
```

The default `docker compose up -d` already installs `whisper-large-v3-turbo` (about 1.6 GB); the line
above only re-checks the pinned revision.

Set `STT_TURBO_URL=http://stt-whisper-turbo:8084` in `.env`, then:

```sh
docker compose --profile stt-turbo up -d --wait --wait-timeout 900 gateway tts-ema stt-whisper stt-whisper-turbo
uv run python scripts/smoke.py --stt-model whisper-large-v3-turbo --output-dir smoke-output/stt-turbo
```

`GET /v1/models` then lists `whisper-small` and `whisper-large-v3-turbo`; `POST /v1/audio/transcriptions`
routes each id to its own worker, and `whisper-1` keeps resolving to the default worker. Do not set
`STT_TURBO_URL` before the worker is provisioned and ready: the gateway validates the requested id against
that worker's own `/internal/models`, so a disabled or unprovisioned profile fails as `model_not_found`
instead of silently serving the small model under a bigger name. Leaving `STT_TURBO_URL` empty is the
default and the model is then neither advertised nor routable.

CPU cost is real — turbo is several times the weights and much slower per request, which is why it is
never the default (decision S5). Measured on this CPU stack for the same 3.36 s Turkish smoke utterance:
`whisper-small` **1.89 s**, `whisper-large-v3-turbo` **6.91 s** — 3.65× slower, RTF ≈ 2.1, i.e. slower
than real time, so on CPU it is a file/batch model rather than a live one. For that sentence the two also
returned different casing and punctuation; that is an observation from one utterance, not a quality claim.
Provisioning downloads about 1.6 GB; the worker health grace is 600 seconds and the startup wait budget
above is 900. The `--verify-only` pass is the honest check that the volume holds the pinned revision.

## Optional NVIDIA GPU

Requires NVIDIA GPU, compatible host driver for CUDA 12.6, and NVIDIA Container Toolkit. [Compose GPU reservations](https://docs.docker.com/compose/how-tos/gpu-support/) require `capabilities: [gpu]`. Both CUDA workers reserve one GPU; they can share it, so total memory/concurrency must be measured, not assumed.

```sh
docker compose -f compose.yaml -f infra/compose.nvidia.yaml build gateway tts-ema stt-whisper
docker compose -f compose.yaml -f infra/compose.nvidia.yaml up -d --wait --wait-timeout 600 gateway tts-ema stt-whisper
uv run python scripts/smoke.py --output-dir smoke-output/nvidia
```

Use CPU provisioning commands first; snapshots are device-independent. GPU override installs `torch==2.7.0` from `https://download.pytorch.org/whl/cu126`, matching `uv.lock`'s CUDA 12.6 / cuDNN 9.5 dependencies; cu128 requires different pins and must not be substituted. STT CUDA uses `ctranslate2==4.6.0` and `float16`, with `LD_LIBRARY_PATH` pointing to wheel-provided libraries. Do not mix cuDNN8 with this CTranslate2 version: [upstream CUDA requirements](https://github.com/SYSTRAN/faster-whisper#gpu). GPU inference/driver operation remains unverified. CUDA initialization is fail-fast, not silent CPU fallback.

To enable Antalia on GPU, add `--profile antalia` to the same override commands and include `tts-antalia`, after provisioning it and setting `ANTALIA_URL`.

## Startup and operations

- Each worker has a **300-second initial health grace**, then eight 15-second failure intervals; deployment wait budget is 600 seconds. Gateway waits for core workers to become healthy, then probes its own readiness. Antalia is not a base `depends_on` dependency; configured gateway readiness must still report provider health.
- Workers have exactly one Uvicorn process and one inference slot; more processes would duplicate model memory. CPU threads default four. Gateway admits four concurrent requests and 60 requests/minute per key; defaults are not load-test results. HTTP inference timeout defaults 120 seconds; smoke client allows 180.
- WebSockets consume the same **per-key** `VOXI_MAX_CONCURRENCY` budget **for their whole lifetime**, so four open streams on one key leave that key no HTTP inference capacity. One TTS slot also means concurrent streams serialize or receive 429 rather than queueing invisibly; measure before raising slots, threads or process counts. Streaming behavior is tunable in `.env`: `VOXI_STREAM_SAMPLE_RATE`, `VOXI_TTS_CHUNK_MS`, `VOXI_WS_IDLE_TIMEOUT`, `VOXI_STREAM_STT_TIMEOUT` and the five `VOXI_VAD_*` thresholds. Sustained sockets keep a worker slot busy for the duration of each utterance/chunk sequence, which is why transcription here is windowed rather than token-streamed.
- Uvicorn has no built-in WebSocket protocol, so `websockets` (pinned) must be installed or every `/v1/*/stream` upgrade is refused while `TestClient`-only tests stay green. `VOXI_RATE_LIMIT_PER_MINUTE` counts connections and HTTP requests, never individual audio chunks. Verify a deployed gateway truly serves upgrades with `python scripts/smoke_stream.py --base-url ws://<host>:<port> --api-key <key>`; a green suite is not proof the serving stack accepts WebSockets.
- `docker compose ps`, `docker compose logs --since 10m gateway tts-ema stt-whisper` for status. Treat transcript-bearing logs/metrics/execution data as private. Record policy before storing recordings; smoke artifacts contain speech/text and are operator-owned.
- Rotate keys and recreate affected services. Optional `VOXI_API_KEYS_JSON` is a JSON list of `{id,sha256,scopes}` records; `sha256` is the 64-character lowercase SHA256 hash of the client's random secret. Allowed scopes here are `audio:read`, `audio:write`, `realtime:connect`; reserved scopes have no implemented endpoints yet — `telephony:admin` (no admin endpoints) and `text:process` (reserved for the Plan 3 text endpoints, not built). The keyring accepts any scope string, so a reserved scope grants nothing today. Remove records to revoke access, then recreate gateway. Default `VOXI_API_KEY` adds an application key with all three implemented scopes; leave it empty when using only scoped records. Never assign the same ID/hash twice. Worker key remains independent and required.
- Stop with `docker compose down` (preserves caches). Do not delete caches blindly to mask corruption; verify manifests and reprovision intentionally.

## Client and phone gates

Import [n8n workflows](../integrations/n8n/README.md), use [OpenWebUI audio env](../integrations/openwebui/audio.env.example), and [Hermes guidance](../integrations/hermes/README.md). Client UI/workflow runs remain unverified until exercised against this gateway; n8n ownership is not a claim that SIP media exists. The WebSocket transports are likewise unverified against any real client: `scripts/smoke.py` exercises file inference only, so first-audio latency, endpointing quality against a live microphone/telephony feed and concurrent-session capacity remain open gates. [UCM6510 lab checklist](../integrations/ucm6510/checklist.md) explicitly defers phone/SIP/RTP/transfer/concurrent-call gates. CI runs model-free lint/typechecks/contracts/OpenAPI export only, not live audio, hardware, phones, or upstream client acceptance.
