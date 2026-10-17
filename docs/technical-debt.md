# Technical debt tracker

Open follow-ups that must be re-evaluated before F6 sign-off. Each entry
records the current status as of the F5 close so nobody has to re-derive
it from the CHANGELOG.

## Priority-1 · Bearer token in the WebSocket URL — **CLOSED in F5**

- **Status:** primary leak closed at F4, credential-in-URL eliminated at F5.
- **F4 fix (still in effect):** `integrations/nginx/nginx.conf.template` defines
  `log_format voxi_safe` using `$uri` (never `$request`) and installs it via
  `access_log ... voxi_safe;` inside the TLS server block. Nginx therefore
  cannot log any query string on any route.
- **F5 fix:** new `POST /v1/auth/socket` issues short-lived, single-use
  `secrets.token_urlsafe(32)` tickets bound to `(principal, scope)`. Browser
  clients mint a ticket (Bearer-authenticated) and dial the WebSocket with
  `?ticket=<opaque>`; the gateway consumes the ticket on first handshake.
  Replays return 401 `invalid_ticket`, cross-scope uses burn the ticket and
  return 403 `ticket_scope_mismatch`, expiry reaps lazily, and capacity
  overflow refuses without evicting live tickets.
- **Configuration:** `VOXI_WS_TICKET_TTL` (default 30 s, hard-capped at 300 s
  by `Settings.validate`), `VOXI_WS_TICKET_CAPACITY` (default 1000).
- **Backwards compatibility:** `?token=` still works on every WS route so
  existing integrations keep running. This is a documented legacy path, not
  a fallback the browser code chooses; `webui/src/api/stream.ts` always
  prefers the ticket and surfaces an error if the mint fails.
- **Empirical evidence (F5 smoke, 2026-10-13):**
  - 200 recent proxy log lines contain **zero** occurrences of `ticket=`,
    `token=` or the probe sentinel `PROBETICKET`.
  - `smoke_transcript.py` asserts the replayed ticket and a cross-scope
    ticket are both rejected at the proxy (`403` upgrade refusal, matching
    close code 1008 in the raw WS path).
- **F6 review — 401/403 contract made explicit and non-leak proven:** the
  state machine is now documented in `SocketTicketStore.consume` and locked by
  tests. A *fresh* ticket used with the wrong scope returns 403
  `ticket_scope_mismatch` and is burned; **any** later use of that same value
  (right or wrong scope), an expired value, or a never-minted value all return
  the identical 401 `invalid_ticket`, so a caller cannot distinguish replay /
  expiry / unknown. Fixed-text error messages never echo the opaque value:
  `test_ticket_errors_never_leak_the_ticket_value` (store) and
  `test_http_and_ws_error_bodies_never_contain_the_ticket` (HTTP body + WS
  close reason) assert the ticket substring is absent from every failure.
- **Residual (unchanged, accepted):** a compromised browser extension can
  still read the ticket before it is used. That is a browser-trust issue
  orthogonal to logging; the value expires in 30 s and burns on first use,
  so the window is bounded.

## Priority-2 · Two pytest audio tests fail on Windows sandbox tmp_path

- **Status:** root cause CONFIRMED environment-only and **permanently
  mitigated in F6** via a repo-local `conftest.py`.
- **Symptom (before fix):** `tests/test_audio.py::test_input_playlist_cannot_open_file_protocol`
  and `test_recorded_m4a_with_end_metadata_decodes_complete_audio` errored at
  fixture setup with `PermissionError: [WinError 5] ... pytest-of-<user>`.
- **Confirmed diagnosis (F6):** the two test bodies are correct. Running them
  with an explicit writable base — `pytest --basetemp=<writable>` — yields
  `2 passed`; the whole suite with that flag yields **137 passed, 0 errors**.
  The default session root `%TEMP%\pytest-of-<user>` exists on this Windows
  profile but cannot be enumerated/written under its ACL. It is not a code
  bug, and `-p no:cacheprovider` alone does NOT fix it (the cache path is a
  separate, cosmetic warning).
- **Durable fix:** root `conftest.py::pytest_configure` redirects every
  `tmp_path` to a per-run directory under the workspace (`.test-tmp/`,
  gitignored) unless the operator passed an explicit `--basetemp`. The
  workspace is always writable, so the same run is green with a plain
  `pytest` on this machine and unchanged/hermetic on Linux CI. We deliberately
  do NOT probe `%TEMP%`: touching that locked directory is what failed and it
  can even block.
- **Residual (accepted):** `.pytest_cache/v/cache` still raises 3 harmless
  `PytestCacheWarning`s because the cache dir shares the restricted ACL. These
  are warnings, not errors, and only affect lastfailed/stepwise caching. A
  future tidy-up can relocate the cache the same way, or the operator can run
  once with normal profile permissions.

## Priority-3 · Real browser verification of TTS + microphone STT + Transcript Studio

- **Status:** panels are wired to the exact protocol the raw client speaks
  (verified via `scripts/smoke_stream.py` and `scripts/smoke_transcript.py`),
  but Chrome/Firefox/Safari end-to-end walkthroughs are not yet automated.
- **What to verify manually before F6 close:**
  1. Chrome desktop over `https://localhost:8443/ui/` and the LAN IP:
     - "Canlı TTS": speak → audible playback with first-audio chip; cancel
       mid-stream clears the queue immediately. Mint-error path shows
       `Bilet alınamadı: …` and does NOT silently fall back to `?token=`.
     - "Canlı STT": allow mic, speak Turkish, watch partial revision
       updates, stop, confirm final transcript + level meter release.
     - Unmount mid-stream (tab switch) releases the mic (recording
       indicator in the URL bar disappears).
     - "Oturumlar": create → send turn → validated action shown → press
       "Metni sesli oku" → TTS plays. Close tab → session reaped by TTL.
     - **NEW · "Transkript Stüdyosu"**: upload a real WAV → Sunucu STT →
       waveform appears (no fake bars before decode), click a word → audio
       seeks to `startMs`, active word highlights as playback advances,
       edit a word's text → time stays the same, edit a word's time to
       overlap a sibling → edit is refused with the reason shown, undo 20×
       then redo 20×, click "Orijinal sonuca dön" → original STT payload
       re-appears intact.
  2. Firefox desktop: same list.
  3. iOS Safari + Android Chrome (separate matrix): mic permission on a
     self-signed LAN certificate (import the CA first), autoplay policy
     (`ctx.resume()` must run inside a user gesture), AudioWorklet support.
     iOS also needs `playsinline` on the F5 audio element if we later embed
     the studio in a video surface — not currently required.
- **Automation option for F6+:** Playwright with `--use-fake-device-for-
  media-stream` for Chrome, plus a real-device cloud for iOS/Android.

## Priority-4 · Cancelled STT inference still occupies the worker slot

- **Status:** mitigated (asyncio.Lock + bounded retry), not solved.
- **Current behaviour:** `partial_task.cancel()` on `speech_ended` stops the
  gateway's client-side `await`, but the worker's inference thread keeps
  running to completion because the single-slot gate does not observe the
  HTTP disconnect. The F5 retry policy absorbs the resulting 429.
- **Long-term options to evaluate (do not pick without measurement):**
  - Cooperative cancel: gateway posts `/internal/transcriptions/cancel`
    and the worker checks a flag between windows.
  - Multi-slot worker with priority queue where finals outrank partials.
  - Faster-whisper chunk-level cancel hook (upstream support varies).
- **Definition of done:** a test that fires partial → speech_ended →
  final and asserts the final arrives without a retry AND the worker's
  inference metrics drop the partial early. Add to permanent regression
  coverage.

## Priority-5 · Bounded 429/503 retry — permanent regression coverage — **CLOSED in F5**

- **Status:** the inline retry loop was extracted into `recognize_with_retry`
  at module scope in `src/voxi/gateway.py`; constants `RETRY_STATUSES={429,503}`,
  `RETRY_MAX_ATTEMPTS=4`, `RETRY_BASE_DELAY=0.35` are exported alongside it.
- **Tests added (`tests/test_retry_policy.py`, 13 cases):**
  - success first try, no sleep
  - retry-until-success with exact backoff schedule `[0.35, 0.70]`
  - ceiling reached: last transient is re-raised, exactly 3 sleeps occur
  - non-retryable statuses (400, 413, 422, 504) short-circuit without sleeping
  - `asyncio.CancelledError` propagates (guards against a future refactor
    that would broaden the `except` clause)
  - `RETRY_STATUSES` set is asserted to remain `{429, 503}` — a new transient
    code requires updating the test on purpose
  - final-after-cancelled-partial priority race (the STT-07 case that motivated
    the policy) is asserted
  - `attempts < 1` raises `ValueError`
- **What is still open:** the smoke-level injection of a "flaky worker" to
  drive the ceiling through a real socket (currently the ceiling is proven
  only at unit level). Nice-to-have for F8+ if the retry policy needs to be
  re-tuned.

## F6 · Turkish punctuation — status at F6 build (2026-10-13)

- **CLOSED — real model, not regex.** The ONNX + int8 artifacts were produced
  for real in-environment by `scripts/export_punctuation_onnx.py` from the pinned
  source (`uygarkurt/bert-restore-punctuation-turkish` @ `dd8b9481…`, MIT).
  Measured: FP32 = 440,373,948 B (~420 MB), int8 = 111,298,716 B (~106 MB);
  int8-vs-FP32 label agreement = 45/45 tokens (ratio 1.0) over five Turkish
  probes (`models/punctuation-tr/quality.json`). Source + artifact digests are
  pinned in `inventory.py::PUNCTUATION_SOURCE` and `manifest.json`.
- **CLOSED — offline/self-hosted serving.** nginx serves `/models/punctuation-tr/`
  read-only from the same host; the engine sets `allowRemoteModels=false`, so no
  runtime Hugging Face/third-party request is possible. Provisioning is a separate
  optional step, never wired into gateway startup.
- **CLOSED — integrity + single undo + Turkish casing + token/512 alignment**
  are proven by 54 vitest cases (pure modules never import the model).
- **OPEN acceptance criterion — real browser inference.** The WASM/WebGPU
  fallback loading the actual `model_quantized.onnx` and restoring a real
  Turkish STT transcript **in a live browser** has NOT been executed in this
  sandbox (no browser + the 106 MB asset served over TLS). The pure pipeline,
  the engine adapter (`transformersEngine.ts`) and the exported asset are ready,
  but end-to-end on-device verification is deliberately left OPEN and must be
  closed at the F6 review session (Chrome + a WebGPU-less/WASM-only client),
  together with the Priority-3 browser/microphone matrix below. Do NOT treat the
  Node/vitest fixture coverage as proof of browser inference.

## Frontend Sprint · F7–F9 (Altyazı / Dışa aktarma / Projeler) — status (2026-10-13)

- **CLOSED — coherent usable UI.** Shared studio store (`webui/src/lib/studioStore.tsx`)
  now owns the single `TranscriptDocument`, its undo/redo history, the retained
  original ASR payload, one shared `useAudioPlayer` (peaks + playback clock), the
  subtitle style and the current project. Transcript Studio was refactored to
  consume it; App shell wraps everything in `StudioProvider` with grouped
  responsive navigation and Turkish throughout. `tsc --noEmit`, `vite build`
  (ORT-WASM/transformers code-split preserved) and 67 vitest cases are green.
- **CLOSED — F7 five styles + live preview.** Klasik/Karaoke/Vurgu/Pop/Sade render
  off the shared player clock; Karaoke/Vurgu degrade to whole-line with an honest
  Turkish reason when the document has no word timings (never a fake highlight).
  Covered by `webui/tests/subtitles.test.ts` (buildCues/activeCue/activeWordIndex).
- **CLOSED — F8 SRT/VTT/TXT/JSON.** Generated in-browser from the live document.
- **PARTIAL — F8 MP4.** `lib/mp4.ts` records real H.264 via `MediaRecorder` only
  when the browser advertises support; the UI detects it honestly. The recording
  path itself was NOT exercised in this sandbox (no live audio playback); treat
  "MP4 üretildi" as unverified until run against real audio in a supporting browser.
- **CLOSED — F9 IndexedDB.** Autosave/open/delete/new + JSON import/export, storing
  the audio Blob so a reopened project restores the player + waveform. Degrades
  honestly (`yerel kayıt kapalı`) when IndexedDB is unavailable.
- **Real browser pass (Chromium via `npm run dev`, 2026-10-13):** all five studio
  views mount with zero runtime JS errors; the gateway-absent Dashboard degrades
  to a red 404 banner + `bilinmiyor` tiles rather than crashing; the 420px layout
  swaps the sidebar for the scrollable top strip. Fixed a spurious
  "audio-load-failed" notice on an empty studio (player `error` guard).
- **OPEN (deferred to the full compose stack, same bucket as F6/Priority-3):**
  live `/healthz`·`/readyz`·`/v1/models` metrics over TLS from a real gateway, a
  real mic live-STT walkthrough, and — carried from F6 — the on-device WASM
  punctuation inference. None are claimed as passing.

## Not-tracked but adjacent

- **`webui.baseUrl` in localStorage:** same default as before; fine for LAN
  operators. Not a security issue (host name, not a secret). The API key is
  still session-memory only per the F4 contract.
- **Audio buffer leak in `PcmPlayer.stop()`:** current code nulls the source
  list before stopping; a follow-up should confirm the browser GC actually
  frees the underlying `AudioBuffer`s on very long sessions.
- **F5/F9 · TranscriptDocument is now persisted (F9 shipped):** IndexedDB
  autosave (`webui/src/lib/idb.ts`, debounced in the studio store) writes the
  document, style and audio Blob. The model shape (`documentId`, `source`,
  `revision`, `createdAt`, `updatedAt`) is what F9 consumes; if it changes, the
  stored `ProjectRecord` needs a version bump + migration in `idb.openDb`.
- **F5 · Undo/redo cap (200) is generous for F5 needs:** if we later add
  collaborative editing or F8 export snapshots, revisit the cap and consider
  a CRDT or diff-based history instead of full deep clones.

## Priority-1 · Loopback keyless local identity (ADR 0006) — accepted residual risk

- **The design:** in inject mode the proxy adds a separate, revocable local key
  (`VOXI_WEBUI_KEY` → `webui-local` in `VOXI_API_KEYS_JSON`) to same-origin `/v1`
  calls, binds loopback, and rejects a foreign `Host` (421) / cross-site request
  (403) before injecting. Guards are enforced in `voxi-entrypoint.sh`, so a hand-edit
  of `.env` cannot pair injection with a non-loopback bind.
- **Accepted residual risk:** loopback trust is same-*host*, not same-*user*. On a
  **shared / multi-tenant machine**, another local user or process can reach the
  loopback port and consume the injected identity keyless. This is consciously
  accepted for the single-user, single-host turnkey case only.
- **Mitigation when NOT single-user:** disable local auto-identity
  (`VOXI_PROXY_INJECT=false`, or `bootstrap.ps1 -ExposeLan`) so no credential is
  injected for anonymous loopback callers and each client supplies its own key over
  TLS. Documented in `docs/deployment.md`, the nginx README and ADR 0006.
- **Still open (not a blocker):** live end-to-end proof of the injected 200 / LAN 401
  through the **full** compose stack (gateway + workers + proxy) — so far verified at
  the proxy boundary with `scripts/smoke_proxy.py` against a standalone proxy and the
  startup guards via Docker; the `--wait` full-stack exercise needs provisioned model
  images and is an operator gate.

## Compose-native first-run secrets and TLS (ADR 0007) — status (2026-10-16)

- **CLOSED — one-command install.** `git clone` + `docker compose up -d` now generates the
  worker key, master key, local WebUI key, keyring and a loopback TLS certificate itself
  (one-shot `secrets` service), so no `.env` and no host bootstrap script are required on any
  platform. Precedence (environment wins), idempotency (never overwrite), strict
  `REQUIRE_PROVIDED_CERTS=1` fail-closed behaviour, and "no secret value in a log" are locked
  by `tests/test_secrets.py` (17 cases). The proxy entrypoint's file fallback and strict-mode
  marker check were verified live against the real nginx image.
- **OPEN — certificate-generation unit tests skip on this host.** The dev host has no
  `openssl` CLI, so the `requires_openssl` cases skip; the generator is exercised live inside the
  container instead, which is where it actually runs (verified for real on 2026-10-17 — see
  `docs/verification.md`). A CI runner with `openssl` installed would cover them without the skip.
  The skip is deliberate, not a silent pass.
- **OPEN — the fresh-clone end-to-end run is a manual simulation, not an automated test.** It was
  performed on 2026-10-17 by moving `.env` and `certs/` aside, deleting the `voxi_secrets` volume and
  running the install command, then restoring and byte-comparing (`.env`, `certs/voxi.crt` and the
  certificate served on 8443 all matched the pre-run state). Automating it needs a throwaway Compose
  project name, which would re-download every pinned model. Accepted for now.
- **CLOSED (2026-10-17) — every image was rebuilt with the T1 code.** The heavy `torch` layer
  crashed the Docker Desktop engine here several times, so the rebuilds were done one service at a
  time (`gateway`, `tts`, `stt`, then `smoke`, then `antalia`). `stt-whisper-turbo` shares
  `voxi-stt:local`, so it was covered by the `stt` build. All five images were then checked for the
  seam itself (`grep read_secret` inside each: `workers/common.py` and `secrets.py` present in
  `gateway`, `tts`, `stt`, `antalia`; `scripts/smoke.py` in `smoke`), and the rebuilt `smoke` image
  ran the full OpenAI SDK end-to-end against the live stack (exit 0, non-empty Turkish transcript).
  One cosmetic residue remains: `voxi-tts` and `voxi-stt` still embed the pre-hardening copy of
  `scripts/bootstrap_secrets.py` — a file neither image ever executes; only the `secrets` service
  does, and it runs the current `voxi-gateway` image. No functional impact.
- **Deviation, documented rather than hidden:** generated files read by the UID 10001 runtime
  (`worker.key`, `app.key`, `api-keys.json`) are `0640 root:voxi`, not `0600 root:root`,
  because a root-owned `0600` file is unreadable to a non-root reader. Only `webui.key` and
  `certs/voxi.key`, read by the root proxy process, are `0600 root:root`. No file is
  world-readable and no generated value is passed through a container environment.
- **CLOSED (decision, 2026-10-17) — the two `-f` flags stay.** `proxy` is defined only in
  `infra/compose.proxy.yaml`, so the canonical install carries both `-f` flags; docs (README,
  `deployment.md`, ADR 0007, CHANGELOG, `.env.example`) say so. The operator chose to keep the proxy
  opt-in: a mis-set `VOXI_PROXY_BIND_IP` or missing TLS material then fails only the proxy, never an
  otherwise working API, and an auto-loaded `compose.override.yaml` would have hidden that default.
  `.env.example` offers a **commented** `COMPOSE_FILE=compose.yaml:infra/compose.proxy.yaml` for
  anyone who prefers the bare command (explicit `-f` still wins).
- **OPEN (small) — wrap the canonical install command.** A bare `docker compose up -d` still starts
  the API without the proxy and `/ui/`, and that can be mistaken for a broken console. A single
  documented entry point (`make up`, or `scripts/up.sh` / `infra/up.ps1`) that expands to
  `docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d --wait --wait-timeout 900` would
  remove the foot-gun without changing Compose behaviour. Not done yet; docs carry the warning in the
  meantime.
