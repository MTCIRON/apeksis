# Voxi WebUI · Console integration

The `webui/` package is the operator-facing console served by the nginx TLS
proxy at `/ui/`. It talks to the real gateway; there are no mock responses
and no fake latency numbers. Every state you see is populated from a live
`/v1/*` HTTP response or `/v1/tts/stream`, `/v1/realtime/transcriptions`
WebSocket frame.

## Tabs shipped today

| Tab                 | Route(s) hit                                                     | Phase |
|---------------------|------------------------------------------------------------------|-------|
| Panel (Dashboard)   | `GET /healthz`, `GET /readyz`, `GET /v1/models` + tarayıcı oturumu HTTP-log metrikleri | F1 · **Sprint** |
| Konuşma Üretimi     | `POST /v1/audio/speech`                                          | F2    |
| Konuşma Tanıma      | `POST /v1/audio/transcriptions` (+ `verbose_json`, `srt`, `vtt`)| F2    |
| Canlı TTS           | `WS  /v1/tts/stream` (progressive PCM16, cancel, first-audio)    | F3    |
| Canlı STT           | `WS  /v1/realtime/transcriptions` (mic, partial/final, VAD)      | F3    |
| **Oturumlar**       | `POST /v1/sessions`, `POST /v1/sessions/{id}/turns`, `DELETE /v1/sessions/{id}` | **F4** |
| **Transkript Stüdyosu** | `POST /v1/audio/transcriptions` (`verbose_json` + `word_timestamps`), `POST /v1/auth/socket` for WS mint | **F5** |
| Noktalama (Transkript içinde) | Yerel ONNX model `/models/punctuation-tr/` üzerinden tarayıcıda (WASM/WebGPU fallback) | **F6** |
| **Altyazı Stüdyosu** | — (5 stil · canlı önizleme, aynı `TranscriptDocument` üzerinde tarayıcıda) | **F7** |
| **Dışa Aktarma** | — (SRT/VTT/TXT/JSON tarayıcıda; MP4 yalnızca tarayıcı destekliyorsa) | **F8** |
| **Projeler** | — (IndexedDB otomatik kayıt · aç/sil/yeni · JSON içe/dışa) | **F9** |
| Modeller            | `GET /v1/models`                                                 | F1    |
| Ayarlar             | (writes `voxi.apiKey`, `voxi.baseUrl` to localStorage)           | F1    |
| Hata Konsolu        | in-memory debug ring (never persisted)                           | F1+   |

## Sessions tab (F4) — how it maps to the wire

The panel calls the same endpoints documented in
[`docs/api-compatibility.md`](../../docs/api-compatibility.md) and validated
by `scripts/smoke_sessions.py`. It does **not** invent any request shape.

- Create → `POST /v1/sessions` with `Authorization: Bearer <key>` (scope
  `realtime:connect`). Success is `201 { session_id, call_id }`. Failure
  codes handled and shown:
  - `503 n8n_unconfigured` — the gateway has no `VOXI_N8N_WEBHOOK_URL`;
    configure one (see the F4 verification section below).
  - `429 capacity_exceeded` — the broker hit its TTL-reaped session cap.
- Send turn → `POST /v1/sessions/{id}/turns` with body
  `{ transcript, language?, context? }`. This matches
  `contracts.TurnInput (extra="forbid")`; the panel sends **no** extra
  fields. Success is `200 { generation_id, turn_id, action }` where
  `action` is a `contracts.TurnAction` the gateway already validated
  against its allowlist. Errors shown safely: `404 session_not_found`,
  `409 stale_generation`, `400/422 invalid_request`.
- Terminate → `DELETE /v1/sessions/{id}` → `204`.

## Security rules baked into the Sessions panel

1. **Read-only validated actions.** The panel shows the returned `action`
   (`speak` / `transfer` / `hangup` / `listen` / `fallback`), the text,
   voice, `transfer_target`, `idempotency_key` (truncated), and `metadata`.
   Nothing is executed. **No automatic TTS playback, no automatic transfer
   dispatch.** The only way audio plays is if you explicitly click
   "Metni sesli oku (TTS)", which routes the text through
   `POST /v1/audio/speech` — an action the operator initiated, not the UI.
2. **No server-side contract change.** The panel calls the existing
   gateway endpoints and does not modify action validation or
   authorization logic in `src/voxi/n8n.py::TurnBroker.validate` or
   `gateway.authorize*`.
3. **Session/Turn content stays in tab memory.** `transcript`, `context`,
   and the returned `action.text` are React component state only. The
   panel does not write them to `localStorage`, `sessionStorage`, or the
   Debug Console. `webui/src/lib/debug.ts` is an in-memory ring capped at
   500 rows, never persisted.
4. **Debug Console masks identifiers.** `api/client.ts::redactPath` shortens
   `/v1/sessions/<hex>` to `/v1/sessions/<8>…<4>` before `pushLog`, so the
   capability-bearing session id does not linger in the console. Only
   `method`, redacted `path`, `status`, `ms`, and `X-Request-ID` are
   logged for HTTP calls, and only `route`, event `type`, counts and
   latencies for WebSocket calls.
5. **API key handling unchanged.** The bearer is stored in `localStorage`
   (`voxi.apiKey`) with the same browser-session default as every earlier
   phase. It is never logged. It is sent to REST calls via the
   `Authorization` header.

## WebSocket authentication and the `?token=` URL leak

Browser `WebSocket` constructors cannot set an `Authorization` header, so
the gateway's `socket_token()` fallback accepts `?token=<key>` (and the
older `?api_key=<key>`) on `/v1/tts/stream`, `/v1/realtime/transcriptions`
and `/v1/sessions/{id}/stream`. Putting a bearer into the URL is only safe
if nothing downstream logs the query string. F4 audited each surface:

| Surface                                     | Behaviour                                                            | Fix applied |
|---------------------------------------------|----------------------------------------------------------------------|-------------|
| nginx default `combined` access log         | logs `$request` — the raw request line **includes the query**        | **YES — leaked before** |
| Gateway uvicorn access log                  | WebSocket handshakes log `"WebSocket /path" [accepted]` (no query)   | already safe |
| Gateway structured request log              | emits `{request_id, method, status, duration_seconds}` (no URL)      | already safe |
| Browser history                             | WebSocket handshakes are **not** navigation entries                  | already safe |
| Browser DevTools Network (session-scoped)   | visible, but only to whoever already has the browser                 | not a new leak |
| Referrer / third-party telemetry            | WebUI ships no analytics; the WS handshake never crosses origin      | already safe |
| Client Debug Console (`pushLog`)            | only the path (`/v1/tts/stream`) is logged, never the token          | already safe |

The nginx leak was closed in `integrations/nginx/nginx.conf.template`:

```
log_format voxi_safe '$remote_addr - $remote_user [$time_local] '
                     '"$request_method $uri $server_protocol" '
                     '$status $body_bytes_sent '
                     '"$http_referer" "$http_user_agent" "$http_x_forwarded_for"';
```

`$uri` is the normalised path only. Verified end-to-end: a `curl` and a real
`websockets.connect('wss://…?token=…')` both produce access-log entries
without the query string, while the gateway still authenticates the socket.

### F5 — short-lived single-use ticket (implemented)

Suppressing the query in the nginx log closes the biggest leak, but the
bearer was still **transiently visible** in the URL for anyone with live
packet capture, a browser extension observing WebSocket URLs, or a future
nginx plugin that re-adds `$args`. F5 removed that residual exposure:

1. Browser calls `POST /v1/auth/socket` with the normal
   `Authorization: Bearer <key>` header and body `{scope}` (one of
   `audio:write` / `audio:read` / `realtime:connect`). Gateway authorises
   the principal against that scope (`insufficient_scope` → 403 otherwise)
   and returns `201 {ticket, expires_in}` where `ticket` is
   `secrets.token_urlsafe(32)` and TTL defaults to 30 s.
2. Browser dials `wss://…/v1/tts/stream?ticket=<opaque>`.
3. `authorize_socket()` consumes the ticket on first handshake (pop from
   the store). Replay → 401 `invalid_ticket`; expiry → 401; cross-scope use
   burns the ticket and returns 403 `ticket_scope_mismatch`; capacity
   overflow returns 429 `ticket_capacity_exceeded` and refuses to evict a
   live ticket (better to reject a new mint than to break someone else's
   socket).
4. The legacy `?token=` fallback is still honoured so existing
   integrations keep running, but `webui/src/api/stream.ts` always prefers
   the ticket and surfaces a `Bilet alınamadı: …` error to the operator
   instead of silently falling back.

Configuration: `VOXI_WS_TICKET_TTL` (≤ 300 s enforced by
`Settings.validate`), `VOXI_WS_TICKET_CAPACITY`. Empirical evidence from
the F5 smoke (see *Verification (F5)* below): 200 recent proxy log lines
contain **zero** occurrences of `ticket=`, `token=` or the probe sentinel
`PROBETICKET`.

Residual (accepted): a compromised browser extension can still read the
ticket before it is used. That is a browser-trust issue orthogonal to
logging; the value expires in 30 s and burns on first use, so the window
is bounded.

## Transcript Studio (F5)

New **Transkript Stüdyosu** tab. Everything on screen is either a real
`/v1/*` response or a user-uploaded file — nothing is invented.

- **Data model** (`webui/src/lib/transcript.ts`): engine-agnostic
  `TranscriptDocument { documentId, language, durationMs, segments[], words[],
  source ∈ gateway|local, revision, createdAt, updatedAt }`. Internal unit is
  milliseconds; `fromVerboseJson()` converts gateway seconds on entry. The
  original STT payload is preserved as `originalRef` — editing the working
  copy never mutates it, and "Orijinal sonuca dön" re-applies it via
  `replaceDocument` (which still lands in the undo stack).
- **Validation** (`validateDocument`): enforces every F5 safety rule —
  no negative / inverted / exceeds-file times, words sorted and
  non-overlapping, words contained in their segment, unique ids, segment
  references resolved, Turkish double-encoding heuristic
  (`text-encoding-suspect`). Issues are surfaced as red chips in the panel,
  never swallowed.
- **Editor** (`webui/src/lib/transcriptEdit.ts`): `applyEdit` /
  `undo` / `redo` with a **200-step** history (contract requires ≥100).
  Rejected edits (would eject a child word, overlap a sibling, exceed
  `durationMs`, invert a range) return the previous state unchanged and
  produce an explanatory `reason`. Text edits never touch timings.
- **Player + waveform** (`webui/src/lib/player.ts`): `AudioContext.decodeAudioData`
  → `computePeaks(buffer, 240)` max-abs bucketing → canvas draw with
  played-progress shading. **Nothing renders before the buffer actually
  decodes** — the canvas is blank and a `Ses yüklenmedi` note is shown.
  `useAudioPlayer` uses `requestAnimationFrame` (not `timeupdate`) to emit
  `currentTimeMs` at ~60 fps so the active-word highlight tracks playback
  smoothly. Click-to-seek on any word jumps the `<audio>` element to
  `word.startMs`.
- **Timing-disabled path**: when the response is `{text}` only or has no
  `words[]`, the panel keeps editing enabled but disables click-to-seek /
  active-word / time inputs and shows the explicit reason ("Bu yanıtta
  kelime zamanı yok"). No fake timings, ever.
- **Turkish characters** round-trip untouched end-to-end; the encoding
  heuristic catches the `Ä±`/`Ã¼` mojibake pattern before it reaches the
  editor. F6 auto-punctuation and F8 export will consume the same
  `TranscriptDocument` — timings are preserved as a documented invariant.

Tests live in `webui/tests/transcript.test.ts` and
`webui/tests/transcriptEdit.test.ts` (27 vitest cases: adapter shape,
validator branches, active-word boundaries, undo/redo ceiling, rejected
edit semantics, `replaceDocument` history).

## Deploy

The console is a static Vite bundle mounted into the nginx proxy. It does
not run in its own container. Steps (from the repo root):

```powershell
# 1) Build once
npm --prefix webui install
npm --prefix webui run build          # tsc --noEmit && vite build → webui/dist

# 2) Bring the stack up (TLS proxy serves /ui/ from the mounted dist)
docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d --wait

# 3) Prove the correct assets are actually being served
.venv\Scripts\python.exe scripts\smoke_ui.py --url https://localhost:8443 --insecure
```

`infra/redeploy.ps1` wraps all three (and now optionally the F4 turn-stub).
Common switches:

- default — rebuild WebUI, recreate proxy, verify assets.
- `-Backend` — also rebuild `gateway`, `tts-ema`, `stt-whisper` images.
- `-SkipBuild` — reuse the existing `webui/dist`.
- `-TurnStub` — include `infra/compose.turnstub.yaml` so Sessions/Turns can
  be exercised when the operator has no real n8n webhook.

Windows bind-mount + Docker Desktop caveats (both fixed permanently, not
just documented):

- `emptyOutDir` deletes `webui/dist/` and re-creates it; the running proxy
  does not always see the new files. `redeploy.ps1` always passes
  `--force-recreate proxy` and `smoke_ui.py` fails the deploy if any hashed
  asset falls back to the SPA `index.html`.
- Any change under `src/voxi/**` invalidates the shared base layer of every
  backend image. `redeploy.ps1 -Backend` rebuilds them all.

## Verification (F4)

Run each smoke once; every check is a real call against the live gateway
through the nginx TLS proxy at `https://localhost:8443`.

```powershell
# 1. Bring up the sessions fixture + backend + proxy
pwsh infra/redeploy.ps1 -SkipBuild -TurnStub

# 2. Sessions + Turn round-trip (create / deliver / validate / terminate)
.venv\Scripts\python.exe scripts\smoke_sessions.py --base-url https://localhost:8443 --insecure

# 3. WebSocket streaming regression (TTS stream, cancel, realtime STT)
.venv\Scripts\python.exe scripts\smoke_stream.py `
  --base-url https://localhost:8443 --insecure --audio stream-sample.wav `
  --pace --output-dir smoke-output/stream-f4 --timeout 90

# 4. Asset-correctness regression
.venv\Scripts\python.exe scripts\smoke_ui.py --url https://localhost:8443 --insecure
```

## Verification (F5)

F5 adds a ticket-auth + transcript-shape e2e probe plus a vitest suite for
the studio model. Run after `redeploy.ps1 -Backend -TurnStub`.

```powershell
# Backend + proxy must be fresh; then:

# 1. Ticket + WS + verbose_json e2e through nginx TLS
.venv\Scripts\python.exe scripts\smoke_transcript.py `
  --base-url https://localhost:8443 --insecure `
  --audio smoke-output/acceptance/sample.wav `
  --output smoke-output/transcript/transcript-report.json

# 2. Python unit + integration regression (ticket store, retry, gateway, n8n)
.venv\Scripts\python.exe -m pytest -q tests

# 3. WebUI unit tests + typecheck + production build
npm --prefix webui run test            # vitest run → 27 cases
npm --prefix webui run build           # tsc --noEmit && vite build

# 4. Non-F5 smokes must still pass
.venv\Scripts\python.exe scripts\smoke_stream.py --base-url https://localhost:8443 --insecure --audio stream-sample.wav --output-dir smoke-output/stream-f5 --timeout 90
.venv\Scripts\python.exe scripts\smoke_sessions.py --base-url https://localhost:8443 --insecure
.venv\Scripts\python.exe scripts\smoke_ui.py --url https://localhost:8443 --insecure

# 5. Log audit — after running the smokes above, no credential echoes:
docker logs voxi-proxy-1 --tail 200 | Select-String -Pattern 'ticket=|token=|PROBETICKET'
# expected: no output
```

Expected PASS lines:

- `sessions-report.json` — 8 checks: `unauth_refusal=401`, `session_created`,
  `turn_ok.action="speak"`, `blank_rejected=400`, `extra_forbid_rejected=400`,
  `turn_unauth_refusal=401`, `terminated=204`, `post_terminate_rejected=404`.
- `stream-report.json` — `tts_stream` (frames + first-audio ms),
  `tts_stream_cancel` (frames at cancel + `cancelled` reply),
  `realtime_transcriptions` (final transcript, monotonic revisions).
- `smoke_ui` — `PASS — WebUI assets are fresh and correctly typed`.
- **F5** `transcript-report.json` — 7 checks: `unauth_mint=401`,
  `ticket_mint` (opaque ≥ 16 chars, `expires_in ≥ 1`),
  `ws_with_ticket_opens="meta"`, `ticket_replay_rejected=403`,
  `cross_scope_rejected=403`, `nginx_no_echo` (probe sentinel absent from
  response body), `verbose_shape` (≥ 1 segment with `start`/`end`, ≥ 1 word
  with numeric `word`/`start`/`end`, `end ≥ start`, `last_end ≤ file_duration*1.1`).

The gateway structured log line (`{"request_id":…,"method":…,"status":…}`)
deliberately omits URL + query so bearer values cannot leak through it even
if the app code changes. Nginx access log uses `voxi_safe` (`$uri` only).
Verify the nginx behaviour directly if you change the format:

```powershell
curl.exe -k -s "https://localhost:8443/healthz?token=AUDITPROBE_DO_NOT_LOG"
docker logs voxi-proxy-1 --tail 3   # path is logged, ?token=... is not
```

## Troubleshooting

| Symptom                                                | Likely cause                                                                 | Fix |
|--------------------------------------------------------|------------------------------------------------------------------------------|-----|
| `503 n8n_unconfigured` in the Sessions tab             | `VOXI_N8N_WEBHOOK_URL` empty                                                 | Point at a real n8n webhook or use `-TurnStub` for verification only |
| Sessions turn returns `409 stale_generation` immediately | Same `session_id` reused after a `DELETE` (or TTL reaped)                  | Create a new session; do not cache `session_id` across browser sessions |
| STT final transcript shows `worker_failure`           | Cancelled partial still occupies the single worker slot                      | Already mitigated (asyncio.Lock + 429/503 retry) — see CHANGELOG F3 |
| Console loads but "Modeller" is empty                  | Proxy served a stale `dist` from before `npm run build`                     | `pwsh infra/redeploy.ps1 -SkipBuild` (recreate proxy + verify assets) |
| `Canlı STT` mic permission prompt is denied permanently | Browser cached the deny for this origin                                   | Reset via browser settings → site permissions → Microphone → reset |
| WebSocket connects but no `meta` arrives               | nginx re-enabled `http2 on;` somewhere                                     | Ensure `integrations/nginx/nginx.conf.template` keeps HTTP/2 OFF for this vhost |
| **F5** · WebUI shows `Bilet alınamadı: 401 unauthorized` on TTS/STT connect | `POST /v1/auth/socket` refused — no `voxi.apiKey` in localStorage, or key lacks the requested scope | Re-enter the API key in Ayarlar; verify the key's scopes include `audio:write` / `realtime:connect` for the target route |
| **F5** · Replay of the same ticket returns 403 upgrade refusal | The browser reused a ticket after a quick reconnect — tickets are single-use by design | The panel mints a fresh ticket per `connect*` call; if you patched the client, do not cache the ticket value |
| **F5** · `429 ticket_capacity_exceeded` on mint | Too many simultaneously-unconsumed tickets (default cap 1000) | Raise `VOXI_WS_TICKET_CAPACITY` or lower `VOXI_WS_TICKET_TTL` so entries reap faster |
| **F5** · Transkript Stüdyosu waveform stays blank after upload | Decode failed or the file is not a format `AudioContext.decodeAudioData` accepts (e.g. bare `mulaw` WAV) | Convert to PCM WAV / MP3 / Ogg before uploading; the panel intentionally does **not** render a placeholder waveform |
| **F5** · Timing controls greyed out with "Bu yanıtta kelime zamanı yok" | STT response was `{text}` or `segments` had no `words[]` | Re-request with `verbose_json` + `word_timestamps=true` (or `timestamp_granularities[]=word`); the panel disables the controls instead of fabricating values |

## Related docs

- [`docs/api-compatibility.md`](../../docs/api-compatibility.md) — the exact
  OpenAI-style + platform-specific surface (Sessions/Turns included).
- [`docs/architecture.md`](../../docs/architecture.md) — where the WebUI sits
  in the stack (behind `proxy`, over the `gateway`, no direct worker access).
- [`docs/troubleshooting.md`](../../docs/troubleshooting.md) — cross-cutting
  failures (ports, TLS, DNS rebinding).
- [`docs/technical-debt.md`](../../docs/technical-debt.md) — open items
  tracked after F5 (Windows `tmp_path` pytest errors, real
  browser/microphone verification matrix, worker-cancel leak). Priority-1
  (WS URL token leak) and Priority-5 (429/503 retry tests) closed in F5.
