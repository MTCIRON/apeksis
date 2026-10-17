# Apeksis — self-hosted Turkish speech

Apeksis is the product name (the WebUI wordmark and the server provider label). **Technical
identifiers keep the older `voxi` spelling** on purpose — image names (`voxi-gateway`, …), the
Compose project name, volume names (`voxi_secrets`, …) and environment variables (`VOXI_*`). They
are not renamed, so existing installs, keys and volumes keep working.

First executable milestone: independent OpenAI-compatible file speech APIs, isolated EMA Lightning / Faster-Whisper workers, optional Antalia-2 Mini, an authenticated n8n turn-delivery adapter and a bounded WebSocket media layer (streaming synthesis, windowed transcription, VAD turn detection with barge-in). Docker Compose CPU deployment, optional NVIDIA override. No mandatory cloud API.

**Not a completed telephony platform.** SIP hardware gate explicitly deferred in [ADR 0002](docs/adr/0002-sip-stack.md). No OpenAI Realtime compatibility, PBX transfer execution or autonomous gateway agent is advertised: the streaming sockets are Apeksis-defined protocols, transfer is an action a client must execute, and microphone transport has not been qualified against a real phone or measured end-of-turn latency budget. n8n alone owns agent decisions, prompts, tools and memory. HTTP sessions deliver validated actions; they do not synthesize or execute call control.

## Start

**One command, any platform.** Clone and bring the whole stack up — pinned models, local secrets
and the TLS/UI edge included; no `.env` is required:

```sh
git clone <repo> && cd <repo>
scripts/up.sh    # Linux/macOS convenience wrapper — or, directly:
docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d --wait --wait-timeout 900
```

(On Windows, `pwsh infra/bootstrap.ps1` is the equivalent host-side path.)

Then open `https://127.0.0.1:8443/ui/`. The two `-f` flags are required: `proxy` lives only in
`infra/compose.proxy.yaml`, so the bare `docker compose up -d` starts the API without the TLS/UI
edge (`scripts/up.sh` hard-codes both flags so the mistake is impossible). Initial
package/image/model downloads need internet; later runs only re-verify what is
already on the volumes, no network. Offline operation uses provisioned local model artifacts.
Copy `.env.example` to `.env` only to **pin** your own keys, limits or certificate paths —
anything set there always wins over generated material. See
[deployment](docs/deployment.md).

**Hardware and first download.** Linux, macOS or Windows (WSL2 backend); Docker with Compose
**v2.24+**. The defaults (EMA Lightning, Whisper small, four CPU threads, one job per worker)
need nothing but a modest multi-core CPU — the recorded development box is an i7-11800H
(8C/16T, 16 GB RAM), and everything measured on it is in [verification](docs/verification.md);
serving capacity for concurrent calls is hardware-dependent and deliberately **never**
guaranteed anywhere. The first `up` pulls base images and builds the stack (about **7 GB** of
local images measured with `docker images` on that machine) and downloads the pinned models
once: `ema-lightning` **32.8 MB** and `whisper-small` **463.7 MB** (measured on the provisioned
volumes); the opt-in profiles add `antalia-mini` **29.1 MB** and `whisper-large-v3-turbo`
about **1.6 GB**. Every file is verified against its pinned digest before use — nothing runs
unverified, and wall-clock network time is deliberately not promised.

**Turnkey console identity.** On the first `up -d` the one-shot `secrets` service generates the
worker key, the master key, the local WebUI key, the keyring and a loopback self-signed
certificate. The proxy injects a separate, revocable local identity for same-origin `/v1` calls
and refuses a foreign `Host` (421) or a cross-site request (403), so another browser page cannot
ride it. This keyless local identity is meant for a **single-user machine**: on a
shared/multi-tenant host disable it (`VOXI_PROXY_INJECT=false`) and require per-client keys; for
LAN or production set `REQUIRE_PROVIDED_CERTS=1` and provide your own certificate pair. On
Windows `pwsh infra/bootstrap.ps1` is the equivalent host-side path (plus `-ShowKey`/`-RotateKey`).
See [ADR 0006](docs/adr/0006-turnkey-local-identity.md),
[ADR 0007](docs/adr/0007-compose-native-bootstrap.md) and
[integrations/nginx/README.md](integrations/nginx/README.md).

**Apeksis studio (`/ui/`).** The console is **one React app** served at `/ui/` by the
`webui` container, with the cross-origin isolation headers (COOP/COEP) that
`onnxruntime-web` + SharedArrayBuffer need. Every capability (speech-to-text,
dubbing, caption + timeline editing, export, live conversation) runs either on the
gateway (`/v1` — the default, needs no download) or in the browser; "Tarayıcı |
Sunucu" is a per-task choice in the UI. **The server path is canonical and needs no
download.** Browser model packs (Seda/Duyu/Whisper ASR, punctuation, translation, EMA
Lightning / Antalia Mini voices) are **not part of this release** — they remain a
deferred, optional path. If they are ever added, they would be served read-only from
the shared `/models` path (see **Ayarlar → Modeller**), never baked into the image,
and a browser pack's own `manifest.json` would be saved as `manifest.web.json` so it
cannot be confused with the server's hash-verified manifest.

```bash
curl http://127.0.0.1:8080/readyz
curl http://127.0.0.1:8080/v1/audio/speech \
  -H "Authorization: Bearer $VOXI_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"ema-lightning","input":"Merhaba, size nasıl yardımcı olabilirim?","voice":"ema-tr","response_format":"wav"}' \
  --output response.wav
curl http://127.0.0.1:8080/v1/audio/transcriptions \
  -H "Authorization: Bearer $VOXI_API_KEY" \
  -F file=@response.wav -F model=whisper-1 -F language=tr
```

See [compatibility](docs/api-compatibility.md), [architecture](docs/architecture.md), [licensing](docs/licensing.md), [threat model](docs/threat-model.md), [troubleshooting](docs/troubleshooting.md), and `integrations/` for n8n, OpenWebUI, Hermes and UCM lab checklist. API docs: `/docs`; machine-readable OpenAPI 3.1: `/openapi.json`, exported to `packages/contracts/openapi.json`. The WebSocket frame shapes (which OpenAPI cannot express) are exported next to it as `packages/contracts/stream-protocol.schema.json`, and the n8n action as `packages/contracts/n8n-action.schema.json`.

## Local development

```bash
uv sync --locked --extra dev
uv run ruff check .
uv run mypy src
uv run pytest
uv run python scripts/export_openapi.py
```

Contract tests inject deterministic inference boundaries; they do not prove model quality. `scripts/smoke.py` exercises deployed real file inference. Actual evidence and unverified gates are recorded in [verification](docs/verification.md).

## Milestone boundaries

- Implemented: file WAV/PCM/MP3 speech, multipart JSON/text transcription, API scopes/limits, warmup/readiness, internal worker isolation, native provider normalization once, real offline provisioning, n8n session isolation and stale-generation rejection, plus the streaming slice: chunked worker-side PCM synthesis, `WS /v1/tts/stream`, `WS /v1/realtime/transcriptions`, generation-aware playout, energy-VAD turn detection/barge-in and WebSocket idle TTL.
- Not yet measured: first-audio/end-of-turn latency, RTF and concurrent-call capacity on real hardware; token-safe streaming normalization; OpenAI Realtime or upstream-native protocol emulation. n8n responses remain the sole decision source.
- Hardware-dependent gate: LiveKit SIP/UCM interop, actual RTP, DTMF, transfer and human failover. No canned benchmark numbers or fabricated PBX success.

## License

This project is licensed under the **GNU Affero General Public License, version 3 or later**
(`AGPL-3.0-or-later`) — full text in [`LICENSE`](LICENSE). Contributions are accepted under the
[Developer Certificate of Origin](CONTRIBUTING.md); source files carry an SPDX header.

The repository license covers **this project's own code only**. Model weights, fonts and
third-party packages keep their own licenses, including the GPLv3+ `cmudict` wrapper and the
OFL-1.1 fonts bundled into the WebUI. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and
[`docs/licensing.md`](docs/licensing.md) for pinned provenance and the verified dependency scan.

**Running AGPL software.** Running this repository unmodified as a network service adds no
condition beyond the distribution terms. If you **modify** it and offer it over a network, AGPL §13
requires you to offer your users the Corresponding Source. When you publish a container image,
point its tag at the source commit it was built from.

**Security and conduct.** Vulnerability reports go to the private
[Security Advisories](SECURITY.md) channel, never to public issues; conduct matters follow
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
