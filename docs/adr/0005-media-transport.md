# ADR 0005: Bounded media transport and generation-aware playout
Status: Accepted

## Context
Milestone 1 implemented file-based speech APIs and authenticated n8n turn decision delivery. Telephone adapters, streaming agents and local voice clients require low-latency audio delivery with immediate barge-in interruption. ADR 0001 requires that n8n remains the sole decision owner; gateway must never embed LLMs or business prompts. ADR 0002 explicitly defers PBX hardware qualification.

## Decision
1. Implement a bounded WebSocket transport on `/v1/sessions/{session_id}/stream` requiring bearer token with `realtime:connect` scope.
2. Inbound stream frames:
   - Binary frames: raw PCM16 mono audio samples (8 kHz or 16 kHz).
   - Text JSON control messages: `{"type": "barge_in"}` (immediate interruption), `{"type": "hangup"}` (call teardown), `{"type": "turn", "transcript": "..."}` (caller utterance), `{"type": "ping"}`.
3. Outbound stream events:
   - Binary audio frames: 4-byte header (`generation_id` uint16, `sequence` uint16) + raw PCM16 mono samples.
   - Text JSON events: `{"type": "clear", "generation_id": N}` (tells media endpoint to flush playout buffer immediately), `{"type": "action", "action": ...}` (validated n8n action), `{"type": "state", "state": ...}`, `{"type": "error", "code": ..., "message": ...}`.
4. Playout & barge-in invariants:
   - Each spoken turn increments session `generation`.
   - On `barge_in` or new user utterance: current generation increments immediately; ongoing TTS worker stream is cancelled; gateway transmits `{"type": "clear", "generation_id": old_gen}`.
   - Playout buffer rejects any audio chunk where `chunk.generation_id != session.generation`. Late worker chunks are discarded without hitting client stream.
5. Separation of concerns:
   - Gateway media transport executes media playout and STT/TTS coordination only.
   - User utterance is forwarded to n8n webhook via `TurnBroker`.
   - n8n determines next action (`speak`, `listen`, `transfer`, `hangup`, `fallback`).
   - If `speak`, gateway streams synthesis chunks to client. If `transfer`, gateway emits action for PBX client to execute. Gateway never touches SIP trunks directly.
6. Resource bounds:
   - WebSocket connection count bounded by `VOXI_MAX_CONCURRENCY`.
   - Inbound audio buffer limited in duration (max 10 seconds unconsumed).
   - Idle connection TTL enforces cleanup on disconnect or hangup.

## Amendment (M2 streaming slice)
1. Session stream turn detection: inbound PCM16 is fed to an energy endpointer (20 ms RMS windows, hysteresis `VOXI_VAD_OPEN_RMS`/`VOXI_VAD_CLOSE_RMS`, `VOXI_VAD_START_MS` sustained run before opening, `VOXI_VAD_END_MS` trailing-silence endpointing, `VOXI_VAD_MIN_SPEECH_MS` false-start suppression measured on loud time, `max_utterance_ms` hard bound). Sustained caller voice now triggers the same barge-in as an explicit `barge_in` control frame and automatically starts a turn once the utterance ends; explicit `turn`/`barge_in` frames remain supported for clients that own their own VAD. The endpointer never decides anything about the conversation: it only delimits audio, and the transcript still travels exclusively through `TurnBroker` to n8n.
2. Inbound utterances are wrapped in a RIFF container (`pcm_to_wav`) before being posted to the STT worker, because the worker's FFmpeg decoder requires a self-describing file and must never be handed bare PCM.
3. Additional session-stream outbound events: `{"type": "speech_started", "utterance_id": ...}`, `{"type": "speech_ended", "utterance_id": ..., "duration_ms": ..., "rejected_ms": ...}` and `{"type": "transcript", "utterance_id": ..., "text": ..., "duration_ms": ...}`. Every server frame is validated through `StreamOutboundEvent` before it is sent.
4. Ordered playout: audio and control events share one queue per session, so a `clear` can never be overtaken by audio already queued for the interrupted generation. Teardown drains the sender instead of cancelling it, so the last queued `error`/`state` frame still reaches the client.
5. Two additional platform-specific WebSocket protocols, neither of which impersonates OpenAI Realtime or the upstream native contract:
   - `WS /v1/tts/stream` (bearer `audio:write`): one `{"type":"speak", ...}` request per turn, `{"type":"meta"}` first, then framed binary audio with the same 4-byte `>HH` header, then `done`/`cancelled`/`error`. `{"type":"cancel","generation_id":N}` stops at the next chunk boundary. The outbox is bounded, so a stalled consumer applies backpressure rather than unbounded buffering.
   - `WS /v1/realtime/transcriptions` (bearer `audio:write`): `session.start` handshake, then raw PCM16 mono; server emits `session.started`, `speech.started`, `transcript.partial`, `transcript.final` (monotonic per-utterance `revision`), `speech.ended`, `error`, `session.ended`. Transcription is windowed: each partial/final is a real bounded STT worker call on the accumulated utterance, not token streaming, so the worker's single inference slot is never held open by a conversation.
6. Worker admission for streams: the TTS worker reserves its inference slot before response headers are written, so a saturated worker returns a true HTTP 429 instead of a silently truncated stream, and releases exactly once from the generator's `finally`. `InferenceGate` therefore exposes explicit `acquire()`/`release()` ownership rather than a context manager a stream could not use.
7. Rejection semantics differ by phase. Anything issued before `accept()` — missing or invalid credentials, a missing scope, the connection rate limit, or an over-concurrency connect — closes the socket pre-accept, which a real ASGI server surfaces as an **HTTP 403 handshake refusal** (`websockets` raises `InvalidStatus`), not a WebSocket close code. Starlette's in-process `TestClient` hides this distinction, so it was confirmed against a live uvicorn server via `scripts/smoke_stream.py`. Only post-accept failures carry close codes: `1008` invalid opening frame, `1013` per-socket audio-budget limit, `1011` internal transport failure, `1000` hangup, idle TTL or normal completion. Idle TTL is `VOXI_WS_IDLE_TIMEOUT`; per-stream STT allowance is `VOXI_STREAM_STT_TIMEOUT`.
8. Serving and admission accounting: uvicorn needs an explicit WebSocket implementation, so `websockets` is a pinned runtime dependency — without it every `/v1/*/stream` upgrade fails while `TestClient`-only tests stay green. The per-key `VOXI_RATE_LIMIT_PER_MINUTE` budget counts connections and HTTP requests only; per-chunk activity must never be charged to it, or a single legitimate stream would lock its own key out of the next connection.
9. Unchanged: SIP/RTP, DTMF and PBX transfer remain deferred (ADR 0002); the gateway still owns no LLM, prompt, memory or business rule.
