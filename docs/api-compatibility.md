# API compatibility

OpenAI-compatible **subset**, not a full OpenAI server. Bearer key required for all `/v1/*` endpoints. Default application key scopes: `audio:read`, `audio:write`, `realtime:connect`. Model list requires read; inference and the Voxi streaming/transcription sockets require write; the n8n session media transport requires realtime.

| Endpoint | Supported | Not supported |
|---|---|---|
| GET /v1/models | Ready installed worker models, truthful capability metadata | Uninstalled providers |
| POST /v1/audio/speech | model, input, voice, response_format, speed; sample_rate and seed extensions | instructions, style, cloning, extra properties |
| POST /v1/audio/transcriptions | multipart file, model, language, prompt, temperature, response_format=json/text/verbose_json/srt/vtt; optional `word_timestamps` and `timestamp_granularities[]=word/segment` | OpenAI Realtime, translation, non-`word`/`segment` granularities |
| POST /v1/audio/translations | No: 404 | Translation |
| POST /v1/sessions | HTTP n8n session creation, no media | OpenAI Realtime |
| POST /v1/sessions/{id}/turns | Stable transcript -> n8n validated action | Raw RTP/audio and automatic call control |
| DELETE /v1/sessions/{id} | Invalidate current generation, remove session | PBX hangup |
| WS /v1/sessions/{id}/stream | Voxi session transport: PCM16 in, framed audio + VAD/turn events out | OpenAI Realtime session protocol |
| WS /v1/tts/stream | Voxi streaming synthesis: `speak`/`meta`/framed audio/`done`/`cancel` | OpenAI `/v1/audio/speech` streaming SSE, upstream native stream |
| WS /v1/realtime/transcriptions | Voxi windowed transcription: partial/final with revisions | OpenAI Realtime conversations, token-streaming ASR |
| WS /v1/realtime | No: handshake is refused outright | OpenAI Realtime conversations, `response.create`, `conversation.item.*` |

Speech default model `ema-lightning`, voice `ema-tr`, output `mp3`, speed 1, sample rate 24000. `tts-1` resolves to EMA. `alloy` rejected unless `VOXI_ALLOW_ALLOY=true`, then maps to the same physical EMA voice with Warning header. Antalia opt-in uses model `antalia-mini`, voice `antalia-tr`; no other physical voices. WAV = mono PCM16 container, PCM = signed little-endian mono samples, MP3 = actual FFmpeg encoder output. 8/16/24/48 kHz rates supported. MP3 encoder is required; no disguised WAV fallback. Audio response includes X-Engine, normalization-owner metadata and X-Request-ID. PCM sample rate is request-defined; clients must retain it.

Transcription timing (F-SRV) is additive and opt-in: the default `response_format=json` still returns exactly `{"text": "..."}` and `text` returns the plain transcript, so n8n, OpenWebUI and Hermes are unchanged. `verbose_json` returns `{text, language, duration, segments[]}`; each segment carries `start`/`end`, and per-word `words[]` appear only when word timing is requested. `srt`/`vtt` return ordered subtitle cues (`HH:MM:SS,mmm` comma clock for SRT, `HH:MM:SS.mmm` dot clock for WebVTT) in UTF-8, preserving Turkish characters. Two knobs request granularity with one explicit precedence rule: `timestamp_granularities[]` (`word` and/or `segment`) is authoritative when present; the `word_timestamps` boolean is honored only when that list is absent. Either knob requires a timing-capable format — requesting timing with `json`/`text` returns 400 `timestamp_requires_format` rather than silently ignoring it. Word-level timings are produced by faster-whisper `word_timestamps` on the STT worker; the Whisper capability metadata declares `word_timestamps`, `segment_timestamps`, `timestamp_granularities` and `response_formats`, and distinguishes `realtime:false` (no OpenAI Realtime emulation) from `realtime_windowed:true` (the Voxi `WS /v1/realtime/transcriptions` transport).

Text bounded to 5000 characters, whitespace-only rejected. Unknown JSON/multipart semantics rejected with an OpenAI-style error envelope. Speech sample_rate/seed extensions are not standard OpenAI parameters; SDK users pass `extra_body` when needed. Temperature 0..1; language ISO lowercase 2/3-letter code, `tr` not `tr-TR` for Whisper. No requested timestamps are silently ignored. Default file limit 25 MiB; body envelope adds 64 KiB for multipart. Actual decoded duration also bounded by worker. MIME alone is not trusted.

## Verified against a running deployment (Plan 3 Aşama B, 2026-10-16)

The OpenAI SDK path was exercised end to end against the live TLS proxy
(`https://127.0.0.1:8443/v1`) with the `openai==1.78.1` client through `scripts/smoke.py`; every
number below is that run's own report, not an estimate. WAV/MP3 were fully decoded by FFmpeg, and the
transcript is the observed output (never compared with a fixed expected string).

| Model / voice | `GET /v1/models` | WAV (mono PCM16, 24 kHz) | MP3 | STT `whisper-1` (tr) |
|---|---|---|---|---|
| `ema-lightning` / `ema-tr` | present | 3.360 s, 0.735 s request | 3.408 s, 0.391 s | nonempty |
| `tts-1` (alias) / `ema-tr` | present | 3.360 s, 0.297 s request | 3.408 s, 0.297 s | nonempty |
| `antalia-mini` / `antalia-tr` | present | 3.627 s, 0.266 s request | 3.696 s, 0.297 s | nonempty |

`GET /v1/models` returned exactly `antalia-mini, ema-lightning, tts-1, whisper-1, whisper-small`.
`tts-1` and `ema-lightning` produce the same audio for the same input (the alias resolves to EMA);
Antalia is a different engine with its own duration.

That run had the `stt-turbo` profile **disabled**, which is the default.

### whisper-large-v3-turbo (F1, 2026-10-16)

The `stt-turbo` profile was then **enabled and measured** (`STT_TURBO_URL` set, `--profile stt-turbo`).
Both STT workers serve at once and `POST /v1/audio/transcriptions` routes **by model id**, while
`whisper-1` keeps resolving to the default `whisper-small` worker. `GET /v1/models` returned six ids,
each exactly once: `antalia-mini, ema-lightning, tts-1, whisper-1, whisper-large-v3-turbo,
whisper-small`. The duplicate `whisper-1` that the two workers originally produced was a real defect
found by this run and fixed by de-duplicating on id in the gateway.

Same 3.36 s Turkish smoke utterance, CPU, numbers from each run's own report:

| STT model | `transcription_request_seconds` | Transcript (observed) |
|---|---|---|
| `whisper-small` | **1.89 s** | "Merhaba, bu Yerel Türkçe Konuşma Hizmeti'nin ses denemesidir." |
| `whisper-large-v3-turbo` | **6.91 s** | "Merhaba, bu yerel Türkçe konuşma hizmetinin ses denemesidir." |

Turbo is therefore **slower than real time** on this CPU (RTF ≈ 2.1), which is why it is not the default
(decision S5): on this hardware it is a file/batch model, not a live one. The two models also differed in
casing and punctuation on that single sentence — an observation from one utterance, not a quality claim
(no WER was measured here).

> **These numbers are CPU-only and must not be generalised.** Every measurement above comes from the
> CPU image (CTranslate2, no torch). `whisper-large-v3-turbo` is designed for GPU inference, so its
> ranking against `whisper-small` — and its real-time factor — has to be **measured again on the GPU
> deployment** (`INSTALL_CUDA_TORCH=1` plus the CUDA image), not inferred from the table. On GPU the
> turbo variant is expected to be the faster and more accurate of the two, which is why it is shipped
> as an opt-in profile rather than removed. Until that GPU run exists, treat the CPU comparison as the
> only measured fact.

A model id whose profile is off is rejected as 400 `model_not_found`, and the error message names the ids
that really are installed — the gateway checks the target worker's own `/internal/models`, so the catalog
never claims a model the worker cannot serve.

Still **unverified** and untouched by this run: OpenAI Realtime, the WebSocket transports against a
real client, OpenWebUI/Hermes release-specific behavior, first-audio latency on a live microphone, and
concurrent-session capacity.

## Client keys and scopes

One keyring, per-client keys, least privilege. `VOXI_API_KEYS_JSON` holds `{id, sha256, scopes}`
records (`sha256` = lowercase hex of the client secret); remove a record and recreate the gateway to
revoke. `GET /v1/endpoints` reports the scope each route needs, so a client can be wired without
guessing.

| Client | Typical scopes | Why |
|---|---|---|
| Studio (`/ui/`) | loopback keyless injection, or a key with all three | live mic + turns + replies |
| n8n | `realtime:connect` (+ `audio:read`/`audio:write` if it also does file TTS/STT) | agent session loop |
| OpenWebUI | `audio:read`, `audio:write` | file TTS/STT only; no session routes |
| Hermes | `audio:read`, `audio:write` | file TTS/STT only |
| File-only client | `audio:read` to discover, `audio:write` to infer | least privilege |

A key without `realtime:connect` is refused on `/v1/sessions*` with 403 `insufficient_scope`; that
enforcement is covered by `tests/test_gateway.py` and `tests/test_socket_ticket.py`. In the
`/v1/endpoints` catalog a route normally lists exactly one scope; `POST /v1/auth/socket` lists two as a
**choice**, not a conjunction — the ticket is minted for the scope named in the request body
(`audio:write` for the streaming sockets, `realtime:connect` for session sockets), and the socket route
then enforces that scope. Reserved scopes (`telephony:admin`, `text:process`) exist in no route yet and
grant nothing.

## Normalization

EMA integrated normalizer-tr owns normalization; gateway never pre-normalizes. Antalia owns its distinct native normalizer. Raw canonical text remains intact; inspect provider metadata when rendering. Full normalized text is not logged or claimed available if upstream does not expose it. The pinned providers do not expose the PRD's complete preserve/reject/context-hint semantics through their normal inference APIs. Those policies and streaming token-safe chunking remain explicit later-milestone work; unsupported configuration must fail startup, never no-op. For financial/identity-sensitive content, verify audible rendering before production.

## n8n transport

Configured fixed webhook URL and separate key required for session creation. Calls/transcripts never determine webhook destinations. Payload schema 1.0 includes event_type `utterance.final`, call/session/turn IDs, positive monotonic sequence and generation_id, correlation_id, UTC timestamp, original transcript, language, redacted caller and context. n8n response action must be `speak`, `transfer`, `hangup`, `listen` or `fallback`; schema_version 1.0 and idempotency_key `call_id:turn_id` required. Transfer targets must match configured allowlist; validation does not execute transfer. Spoken actions require nonblank text and truthful Turkish voice. n8n timeout, malformed schema and disallowed action produce operational fallback, not unbounded retries. New turn/hangup invalidates prior generations; stale result returns 409. Sessions owner-scoped, capped at 100 and expire after 600 seconds of inactivity; ephemeral across restarts.

## Streaming transports

These are Voxi's own protocols (ADR 0005). They are not OpenAI Realtime and not the upstream native HTTP/WebSocket contract; no upstream SDK method maps onto them. Machine-readable frame shapes are exported to [`packages/contracts/stream-protocol.schema.json`](../packages/contracts/stream-protocol.schema.json) from the same pydantic models the gateway validates with, because OpenAPI cannot describe a WebSocket route. All three require a bearer key, accept `Authorization: Bearer <key>` or a `token`/`api_key` query parameter, and share the per-key `VOXI_MAX_CONCURRENCY` socket budget plus the `VOXI_WS_IDLE_TIMEOUT` TTL. The per-key `VOXI_RATE_LIMIT_PER_MINUTE` budget counts connections and HTTP requests, never individual audio chunks, so one long stream is not charged frame by frame. Rejections issued before the socket is accepted never complete the upgrade: a real ASGI server answers the client's handshake with **HTTP 403** (`websockets` raises `InvalidStatus`), not a WebSocket close code — this covers missing or invalid credentials, a missing scope, the connection rate limit and an over-concurrency connect (Starlette's `TestClient` masks this by implementing the protocol in-process). WebSocket close codes apply only after accept: `1008` invalid opening frame, `1013` per-socket audio budget exceeded, `1011` internal transport failure, `1000` hangup, idle TTL or normal completion. Every text frame the gateway sends is validated against a strict pydantic model first, so an event shape the client was not designed to receive cannot leak out; unknown inbound fields are rejected rather than ignored.

`WS /v1/tts/stream` requires `audio:write`. Client sends one `{"type":"speak","model","input","voice","sample_rate","speed","seed","generation_id","chunk_ms"}` per request; `chunk_ms` is 20/40/60/100/120/200 and `generation_id` is 0..65535. Server replies `{"type":"meta",...}` (sample rate, channels, `pcm_s16le` encoding, chunk length), then binary frames, then `done` with `chunks` and `duration_ms`, or `cancelled`, or `error`. Binary frame layout is a 4-byte big-endian `>HH` header (`generation_id`, `sequence`) followed by PCM16 mono LE. `{"type":"cancel","generation_id":N}` halts at the next chunk boundary; an active native kernel is not promised preemptible. One request is served at a time and the connection is reusable afterward. The outbound queue is bounded, so a non-reading client applies backpressure to synthesis instead of growing memory.

`WS /v1/realtime/transcriptions` requires `audio:write`. First frame must be `{"type":"session.start","model","language","prompt","sample_rate","start_ms","end_ms","min_speech_ms","partial_interval_ms","max_utterance_ms"}`; `sample_rate` is 8000 or 16000 only. After that the client sends raw PCM16 mono and the server emits `session.started` (with the effective `vad` parameter set and `mode:"windowed"`), `speech.started`, `transcript.partial`, `transcript.final`, `speech.ended`, `error` and `session.ended`. Partials and finals carry a strictly increasing per-utterance `revision`; a false start produces `speech.ended` with `rejected_ms` and no transcript. Partial results are windowed re-decodes of the accumulated utterance through the real STT worker, not an incremental decoder, so latency and accuracy reflect whole-utterance transcription. `{"type":"flush"}` forces an endpoint, `{"type":"session.stop"}` ends cleanly, `{"type":"ping"}` yields `pong`. Each socket is capped at 10 minutes of audio.

`WS /v1/sessions/{id}/stream` requires `realtime:connect` and an existing session owned by the same key. Optional `?sample_rate=8000|16000` selects the inbound PCM rate (default `VOXI_STREAM_SAMPLE_RATE`). Inbound: binary PCM16 mono, or `{"type":"barge_in"|"hangup"|"ping"|"turn","transcript","language","context"}`. Server-side energy VAD performs endpointing and false-start suppression, so transmitting voice alone is enough: sustained speech barges into active playout (`clear` plus generation increment) and the completed utterance is transcribed and delivered to n8n as a turn; `speech_started`, `speech_ended`, `transcript`, `state`, `action`, `clear`, `pong` and `error` events describe what happened. A `turn` without `transcript` falls back to buffered unconsumed audio (bounded at 10 seconds). n8n remains the sole decision owner: the transport never chooses an action itself.

Worker-side HTTP `POST /internal/speech/stream` (bearer `VOXI_WORKER_API_KEY`, `response_format=pcm` only) is internal: it reserves an inference slot before headers, so saturation is a genuine 429, and returns `pcm_s16le` with `X-Engine`, `X-Sample-Rate`, `X-Normalization-Owner` and `X-Generation-ID` metadata. It is never publicly routed.

## Error/status subset

400 invalid/unsupported parameter; 401 invalid key; 403 insufficient scope; 404 missing route/session; 409 stale generation; 413 upload/body limit; 429 rate/admission limit; 503 unavailable worker/n8n config; 504 worker timeout. Envelope `{error:{message,type,param,code}}`. No input text or secrets echoed in validation errors.

No native `/v1/speak` or `/v1/stream` migration contract is claimed: this new repository has no legacy callers, and the upstream native request/stream contract has not been adopted or emulated. The streaming routes above are Voxi-defined protocols; connecting an OpenAI Realtime or upstream-native client to them will not work. OpenWebUI and Hermes release-specific behavior must be tested on selected releases; examples are not proof that those applications ran.

## SDK examples

Voxi's streaming routes are raw WebSocket, not OpenAI SDK surface. `websockets` is a pinned
runtime dependency because uvicorn needs a WebSocket implementation to serve these routes at
all; the same package is the natural client here (the snippet below was validated against a
real uvicorn server by `scripts/smoke_stream.py`, not only Starlette's in-process `TestClient`):

```python
import json, os
import websockets

async def speak(text: str) -> None:
    url = f"ws://127.0.0.1:8080/v1/tts/stream?token={os.environ['VOXI_API_KEY']}"
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "speak", "input": text, "chunk_ms": 100}))
        while True:
            frame = await ws.recv()
            if isinstance(frame, bytes):
                generation, sequence = int.from_bytes(frame[:2], "big"), int.from_bytes(frame[2:4], "big")
                pcm16le = frame[4:]  # mono; rate is in the meta event
            elif (event := json.loads(frame))["type"] in {"done", "cancelled", "error"}:
                print(event)
                break
```

Python (`openai` installed with development extras):

```python
import os
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key=os.environ["VOXI_API_KEY"])
with client.audio.speech.with_streaming_response.create(
    model="ema-lightning", voice="ema-tr", input="Merhaba.", response_format="wav"
) as response:
    response.stream_to_file("answer.wav")
with open("answer.wav", "rb") as audio:
    print(client.audio.transcriptions.create(model="whisper-1", file=audio, language="tr").text)
```

JavaScript (Node runtime with official `openai` package; example not executed here):

```javascript
import OpenAI from "openai";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8080/v1",
  apiKey: process.env.VOXI_API_KEY,
});
const audio = await client.audio.speech.create({
  model: "ema-lightning", voice: "ema-tr", input: "Merhaba.", response_format: "wav",
});
await writeFile("answer.wav", Buffer.from(await audio.arrayBuffer()));
const transcript = await client.audio.transcriptions.create({
  model: "whisper-1", file: createReadStream("answer.wav"), language: "tr",
});
console.log(transcript.text);
```
