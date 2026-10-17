# Initial milestone verification

## Trusted-LAN injection (post-release, 2026-10-17)

Opt-in LAN keyless mode (`VOXI_ALLOW_LAN_INJECT`) + stack-merge overlay, all on the
same i7-11800H host. New evidence:

| Check | Observed result |
|---|---|
| Static render safety | busybox `sh -n` parse OK; inside throwaway `nginx:1.27-alpine` the real entrypoint (exec stubbed) rendered all three modes and `nginx -t` succeeded in each (`lan-inject` map shows the RFC1918 regex + extra entries with dedupe; malformed `VOXI_PROXY_EXTRA_HOSTS` token and inject-without-LAN-bind refusals both exercised, inert-flag note exercised) |
| Python suite | `ruff check .` clean, `pytest` **161 passed / 4 skipped** (ruff first flagged one E501 in the new smoke mode code; shortened, re-run clean) |
| WebUI suite | vitest **83 passed** (10 files; 2 new `lan-inject` parser/label cases); production build OK, new bundle `assets/index-HRjqFXOa.js` **476,694 bytes** |
| Compose matrix | 5 CI combinations **plus** the new `infra/compose.lan-stack.example.yaml` (base+proxy+example, external-network reference resolves at config stage): **6/6 `config --quiet` exit 0** |
| Live LAN-inject round | proxy recreated with `VOXI_PROXY_BIND_IP=192.168.16.87`, `VOXI_ALLOW_LAN_INJECT=true`, `VOXI_PROXY_EXTRA_HOSTS=192.168.16.87`; `smoke_proxy.py --mode lan-inject` **PASS** — foreign Host **421**, public cross-site Origin **403**, private-range Origin **200** (relaxed), keyless `/v1/models` **200** (injected — asserted openly), `runtime.json` `lan-inject/needKey=false` |
| Live revert round | env dropped, proxy recreated from `.env` defaults; loopback `--mode loopback` smoke **PASS** (all five original assertions identical to pre-change) — default behavior untouched |
| Live webui ship | `voxi-webui:local` rebuilt, `--force-recreate --no-deps webui` + `restart proxy`; `/ui/` 200 serving the **new** bundle `index-HRjqFXOa.js` (200 / 476,694 B), `runtime.json` loopback intact, final loopback smoke PASS |
| Not measured | real second-device browser access over Wi-Fi (no second device in this session — the guard semantics are proven by script-level HTTP, browser rendering assumed equal); IPv6 ULA range aliases are not covered by the private-range patterns (documented limitation) |

## 0.3.0 first-public-release gates (2026-10-17)

Run on the same i7-11800H host above, immediately before the initial public commit. New evidence:

| Check | Observed result |
|---|---|
| Release commit audits (on the staged index) | 258 tracked files; staged-path pattern audit for `.env`, `certs*`, `models/`, `node_modules`, `dist`, `*.key`, `*.crt`, `secrets`, tmp dirs: **0 violations**; `git grep` over the committed tree: `harfiyen` **0**, recorded-wrong-name **0**, `BEGIN … PRIVATE KEY` **0**, `sk-`/`hf_` live token shapes **0** (only a comment placeholder `hf_xxx…` in `.env.example`) |
| Fresh-clone surrogate (`git clone` to a scratch dir; the true clean-machine test would need wiping the live Docker model volumes, which is not done) | tree parity 258/258, untracked-clean; `up.sh` LF-only with mode `100755`; `uv sync --locked --extra dev` exit 0 (`voxi==0.3.0` resolved from the clone); `ruff check .` clean; `mypy src` clean (22 files); `pytest` **161 passed, 4 skipped** |
| Fresh-clone frontend reproducibility | `npm ci` + `tsc --noEmit` + `vite build` exit 0; main bundle **byte-identical** to the bundle served by the running image: `index-*.js`, **476,524 bytes**, SHA-256 `7C3F8BD1…` (measured both sides) |
| Fresh-clone Compose matrix | 5/5 documented combinations `config --quiet` exit **0** (base, proxy overlay, offline, nvidia with both opt-in profiles, turnstub) |
| Version coherence | `pyproject` / `src/voxi.__version__` / `uv.lock` / re-exported OpenAPI contract all `0.3.0`; CHANGELOG carries `0.1.0`, `0.2.0` (internal milestones) and `0.3.0 — first public release` |
| Production dependency audit (unchanged from R4) | `npm audit --omit=dev`: **0 vulnerabilities** |
| Not measured | live inference timings were not re-run for the release tag (no behavior change intended by release work; last measured live numbers remain those below); a true fresh-Docker first install (`up` from zero images/volumes) was **not** run — it would require destroying the live model volumes |

## 0.2.0 milestone evidence (2026-10-12)

Date: 2026-10-12. This records a file-speech plus bounded-streaming milestone, not completed PRD/MVP or a production qualification. The 0.1.0 live model/Docker evidence below was gathered before the streaming slice; the streaming behavior added in 0.2.0 is currently proven only by model-free contract tests.

## Environment

- Host: Windows x64; Intel Core i7-11800H, 8 cores / 16 logical processors; reported physical RAM 16,908,939,264 bytes.
- Native checks: complete Python 3.12.12 after repairing an incomplete managed installation. Docker Desktop engine 29.7.2, Linux containers.
- CPU inference only: EMA Lightning 1.1.2, Antalia Mini 1.0.1, Faster-Whisper 1.2.1 / CTranslate2 4.6.0 with multilingual Whisper-small INT8. Four CPU threads, one occupied inference slot per worker.
- Docker Hub CDN DNS failed on this host. All four CPU images built successfully using `PYTHON_IMAGE=mirror.gcr.io/library/python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c`, the byte-identical pinned base manifest. See troubleshooting for exact command.

## Exercised behavior

| Check | Observed result |
|---|---|
| Base/dev-only installation, without model packages | 93 tests passed (0.2.0 streaming slice); mypy: no issues in 20 source files; Ruff check and format clean. The 0.1.0 file-only run recorded 65 tests and 19 source files |
| Remaining test warning | Starlette uses deprecated AnyIO BlockingPortal alias; recorded, not suppressed |
| OpenAPI export | OpenAPI 3.1 (`version 0.2.0`), n8n action JSON Schema and the new WebSocket frame contract generated under `packages/contracts/`; the export script describes WebSocket frames because OpenAPI cannot represent those routes |
| Live bearer contract | Served OpenAPI declares `VoxiApiKey` on all six protected route paths; missing bearer returns 401 |
| Swagger browser acceptance | Real Edge rendered `/docs`; Authorize plus Try it out returned HTTP 200 and installed model IDs without exposing credentials |
| Compose configurations | Base, optional Antalia, NVIDIA override and offline override parse successfully; NVIDIA inference not executed |
| Immutable model provisioning | EMA 4 assets, Whisper-small 5 assets, Antalia 6 assets downloaded and verified against pinned Git/LFS identities; offline verify-only passed |
| CPU Docker build/provision/warmup | Gateway, EMA, Whisper and optional Antalia images built; UID10001 model-volume provisioning succeeded; all four services became healthy with `up --wait` |
| Real OpenAI SDK through Docker gateway | EMA and Antalia each returned decodable mono 24 kHz PCM16 WAV and genuine MP3; generated WAV transcribed by real Whisper |
| Native real-provider rate/format boundaries | Both models returned valid WAV and headerless PCM16 at 8/16/24/48 kHz (16 combinations); seed 0, original Turkish text |
| Native real STT formats | WAV, MP3, FLAC, OGG, M4A, 8 kHz A-law WAV and 8 kHz mu-law WAV each returned HTTP 200 with observed Turkish transcripts |
| Native silence | Two-second silent 16 kHz WAV returned exactly `{"text":""}` |
| Native unsupported/malformed requests | Unsupported voice, Opus and style rejected with 400; malformed audio rejected with 422 |
| Recorded M4A seek regression | Valid 30-second AAC/M4A with metadata at file end failed under pipe-only decoding; seekable restricted decode passed after fix |
| n8n transport contracts | HTTP workflow-decision changes, scopes/session isolation, disallowed transfers, timeout/outage/oversized responses and stale-generation rejection covered by deterministic mock-webhook tests |
| Streaming transport contracts (model-free, mock worker) | `WS /v1/tts/stream` meta-then-framed-audio-then-done ordering, exact 4-byte `>HH` chunk framing, cancel-at-next-chunk-boundary, error isolation for invalid frame/request/voice/model/worker failure and connection reuse afterward; `WS /v1/realtime/transcriptions` handshake rejection, one-utterance windowed final, false-start rejection with `rejected_ms`, partial revisions strictly below the final, `flush` endpointing; session stream VAD barge-in plus automatic n8n turn from voice only; unauthenticated and out-of-scope sockets refused during the handshake (pre-accept close) |
| Live WebSocket transport (stub worker, real uvicorn) | `scripts/smoke_stream.py` driven against a gateway served by real uvicorn in a single event loop confirmed the stack actually accepts upgrades: both streaming routes refused anonymous sockets with HTTP 403, `/v1/tts/stream` delivered meta then framed audio then `done` with contiguous `>HH` sequences and a truthful `duration_ms`, reused the connection, honored `cancel` at the next chunk boundary, and `/v1/realtime/transcriptions` completed handshake→speech→final→`session.ended` with monotonic revisions. This closed the contract-test blind spot where Starlette's `TestClient` passed with no server-side WebSocket implementation installed, and it exposed and drove the fix for two real defects: the missing `websockets` dependency and per-chunk `touch()` charging audio frames to the connection rate limit |
| Energy endpointer unit behavior | 20 ms RMS window arithmetic, open/close hysteresis, start/end/min-speech timing, preroll retention, hard `max_utterance_ms` bound with a reopened utterance, invalid threshold rejection, and bare-PCM-to-WAV container wrapping verified against deterministic synthetic windows |
| Playout ordering | Control events keep their position through barge-in, stale-generation audio is dropped with a counted total, and teardown drains queued frames instead of discarding the last event |
| Worker stream admission | `/internal/speech/stream` requires the worker key, frames headerless PCM16 with engine/encoding/rate/generation headers, rejects non-PCM formats, unknown model and physical-voice mismatch, and with one slot occupied a second concurrent stream is a real 429 that releases cleanly |
| Admission under shared STT load | Concurrent provider smoke correctly rejected second STT request with 429 rather than queueing; serial roundtrips passed afterward |
| Isolated offline inference | Docker network inspected `internal=true`; real SDK/FFmpeg smoke client inside network completed both model roundtrips from cached assets without runtime downloads |
| Runtime isolation | All four inference/runtime containers inspected UID/GID10001 and read-only rootfs; only gateway port published |
| Corrected Docker decoder | Real Whisper accepted WAV/MP3/FLAC/OGG/M4A/G.711 WAV and a 30-second recorded M4A through the isolated gateway after the seek fix |
| NVIDIA dependency graph | CUDA 12.6 / cuDNN 9.5 graph resolved successfully against lock constraints using official cu126 metadata; GPU image installation and inference remain untested |

Artifacts remain in ignored `smoke-output/` directories for listening and operator review. Temporary acceptance scripts and native credentials/services were removed/stopped. Audio is synthetic test material, not real caller recordings.

Strict internal networking refused host access to the published port on this Docker Desktop setup. The permanent `smoke` profile runs a real prebuilt client inside the isolated network instead; it does not replace inference or weaken routing. LAN ingress plus host/router WAN blocking is a distinct deployment gate.

Default CPU gateway/EMA/Whisper deployment was restored after isolation checks. Optional Antalia stays disabled by default; model volumes/images are retained for explicit opt-in.

Final host SDK smoke after the gateway auth-schema deployment returned valid 24 kHz WAV/MP3 and the observed transcript `Merhaba, bu Yerel Türkçe Konuşma Hizmeti'nin ses denemesidir.` Browser automation used a dedicated installed Edge process after the shared Chromium daemon was unavailable; that process was closed afterward.

## Observed file-request timings

One cached CPU run per format, through the isolated Docker gateway. Full binary response time, not first audio or telephone end-of-turn latency. The STT backend was the same Whisper-small worker; each input came from its listed renderer. These samples are not p50/p95 or a provider ranking.

| TTS renderer | WAV request (s) | MP3 request (s) | STT request (s) |
|---|---:|---:|---:|
| EMA Lightning | 0.412 | 0.289 | 1.730 |
| Antalia Mini | 0.708 | 0.244 | 1.662 |


## Plan 3 Aşama B — OpenAI SDK through the TLS proxy (2026-10-16)

Later addition; the sections above remain the 2026-10-12 snapshot. `scripts/smoke.py`
(`openai==1.78.1`) ran against the deployed TLS proxy (`https://127.0.0.1:8443/v1`,
`--ca-bundle certs/voxi.crt`) for three model/voice pairs. Every run listed `antalia-mini,
ema-lightning, tts-1, whisper-1, whisper-small`, returned decodable mono 24 kHz PCM16 WAV and genuine
MP3, and transcribed the generated WAV to nonempty Turkish (content observed, never compared with a
fixed string). Single-sample observations from each run's own `report.json`, not p50/p95:

| Model / voice | WAV request (s) | MP3 request (s) | STT request (s) |
|---|---:|---:|---:|
| `ema-lightning` / `ema-tr` | 0.735 | 0.391 | 2.391 |
| `tts-1` / `ema-tr` | 0.297 | 0.297 | 1.938 |
| `antalia-mini` / `antalia-tr` | 0.266 | 0.297 | 1.890 |

`--ca-bundle` / `--insecure` were added to the smoke script for the self-signed proxy. The proxy overlay
removes the gateway host port (`ports: !reset []`), so there is no `127.0.0.1:8080` on the host, and the
gateway image carries no `openai` client — the client comes from the `smoke` image or the host dev
environment. Details: Plan 3 §7 and Plan 2 §16.

## Plan 3 F1 + F1b — turbo STT and turnkey model install (2026-10-16)

`whisper-large-v3-turbo` was provisioned, served as a second STT worker, and measured; the pinned-model
install path was also made turnkey.

| Check | Observed result |
|---|---|
| Provisioned revision | `whisper-large-v3-turbo: 4df90f75321148c3a29a9e2351b7ddf8f5b115a8`, 6 assets |
| `GET /v1/models` (proxy) | 6 ids, each exactly once: `antalia-mini, ema-lightning, tts-1, whisper-1, whisper-large-v3-turbo, whisper-small` |
| `POST /v1/audio/transcriptions` `whisper-large-v3-turbo` | nonempty Turkish, 6.906 s for a 3.360 s utterance |
| `POST /v1/audio/transcriptions` `whisper-small` | nonempty Turkish, 1.890 s for the same utterance |
| Full stack `docker compose up -d --wait --wait-timeout 900` | exit 0; all four `provision-*` services `Exited (0)` |
| Re-run of `up -d` with models already present | re-hashes only, no network, exit 0 |

The duplicate `whisper-1` that the two STT workers originally produced was found by this live run and
fixed by de-duplicating on id in the gateway — the unit tests only caught it once the assertion was added.
Turbo is slower than real time on this CPU (RTF ≈ 2.1), so it stays opt-in. At the time of this run,
`git clone` plus `docker compose up -d` alone still did **not** work on a fresh clone: `.env` (worker key)
and `certs/` (TLS) were required and gitignored. The T1 section below closes that gap. Details: Plan 3
§8.2–§8.3 and Plan 2 §17.

## Plan 3 T1 — self-bootstrapping secrets and TLS on a fresh clone (2026-10-16/17)

`.env` and `certs/` are gitignored, so before T1 a fresh clone could not come up at all. A one-shot
`secrets` service now generates the worker key, master key, local WebUI key, keyring and a loopback
certificate on the first `up -d`, without removing the fail-closed guards.

**Generator contract, exercised live inside the real `voxi-gateway:local` image** (the dev host has no
`openssl`, so this is where it actually runs):

| Check | Observed result |
|---|---|
| Generate keys + keyring + certificate | exit 0; the log names files only |
| Modes / ownership | `webui.key`/`voxi.key` `0600 root:root`; `worker.key`/`app.key`/`api-keys.json` `0640 root:10001`; `voxi.crt` `0644` |
| Generated SANs | `DNS:localhost, IP:127.0.0.1, IP:::1` |
| Secret value in the log | none (60+ char scan empty) |
| Second run | all six files **byte-identical**, every line `present, left untouched` |
| `REQUIRE_PROVIDED_CERTS=1`, no certificate | exit **1** |
| `REQUIRE_PROVIDED_CERTS=1`, auto-generated certificate | exit **1** |
| `REQUIRE_PROVIDED_CERTS=1`, operator certificate | exit 0 |
| `VOXI_WORKER_API_KEY` set | `worker.key` not generated |
| `VOXI_WEBUI_KEY` set | keyring SHA-256 equals the environment value exactly |

**Proxy entrypoint, against the real `nginx:1.27-alpine` image:** strict mode refuses a generated
certificate (exit 1) and missing TLS (exit 1); with a key only in the file the injection guard passes;
a provided pair renders a `0600 root:root` config whose bearer came from the file, and nginx starts.

**Fresh-clone end-to-end** — `.env` moved to `.env.saved`, `certs/` moved to `certs.saved`, the
`voxi_secrets` volume deleted, then one command:

```sh
docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d --wait --wait-timeout 900
```

| Check | Observed result |
|---|---|
| `up` exit | **0** |
| Services | `gateway`, `proxy`, `webui`, `tts-ema`, `stt-whisper` healthy; `secrets` + four `provision-*` `Exited (0)` |
| `certs/` | `voxi.crt` + `voxi.key` + `.generated-by-voxi`; loopback SANs |
| `GET /readyz` (8443) | `{"status":"ready","workers":{"tts":true,"stt":true}}` |
| `GET /ui/` (8443, HTTPS) | **HTTP 200** |
| `GET /v1/models` with **no** key (proxy injected) | `tts-1, ema-lightning, whisper-1, whisper-small` — 4 ids, 4 unique |
| `GET /v1/models` with a wrong key | **HTTP 401** |
| Second `up -d` | every key + the marker + the certificate byte-identical |
| Operator certificate restored | certificate unchanged, no marker added, log `present, left untouched` |
| Full restore | `.env` and `certs/voxi.crt` hashes identical to pre-run; the certificate served on 8443 has the same SHA-256 fingerprint as `certs/voxi.crt`; `/readyz` `antalia:true`; 6 unique model ids |
| With everything provided | `secrets` logs *"wins at read time, nothing generated"* for each value and leaves `voxi_secrets` **empty** |

Two corrections this run forced: the canonical install **must** include `-f infra/compose.proxy.yaml`
(plain `docker compose up -d` starts the API with no TLS/UI edge, because `proxy` is defined only in
the overlay), and with no `.env` the default install serves the default profile only (the opt-in
workers need `--profile antalia --profile stt-turbo`). Details: Plan 3 §8.4 and Plan 2 §18.

## Not proven

- Actual n8n workflow import/execution, OpenWebUI UI, Hermes runtime and JavaScript SDK examples. Source-checked configurations/examples and mock contracts are not client runtime acceptance.
- Full WAN-block/packet-capture proof involving n8n/local LLM, host traffic or telephony. Container routing isolation is narrower than that full acceptance gate.
- NVIDIA/CUDA execution; Turkish WER/MOS/listening corpus; cold-start/first-audio/RTF/peak memory/p50/p95/concurrency benchmarks.
- Live-network realtime acceptance. The streaming transports now have a real-uvicorn transport proof (`scripts/smoke_stream.py` against an in-process gateway and a stub worker), but still no deployed-Docker roundtrip against a **real model** behind the stream, no real microphone, browser, telephone or PBX consumer, and no measured first-audio, endpointing or barge-in latency budget. The smoke client's wall-clock numbers are single-sample observations, not p50/p95 evidence. Default VAD thresholds are uncalibrated against real caller audio. Token-safe streaming normalizer, SIP/RTP, DTMF, Grandstream routes, human transfer/fallback and concurrent phone calls remain unproven.
- Advanced normalizer preserve/reject/context hints. Pinned native providers cannot honor these; unsupported settings fail startup rather than silently ignore policy.
- Persistent tenants/admin key lifecycle, credential-at-rest encryption, full image/model SBOM, vulnerability/license release audit, production privacy controls and soak tests.

Next gates: exercise the streaming transports against deployed real workers (first-audio and end-of-turn measurement, VAD calibration on real caller recordings, concurrent sessions), then the SIP hardware gate, which remains explicitly deferred in ADR 0002. n8n remains the only decision runtime.
