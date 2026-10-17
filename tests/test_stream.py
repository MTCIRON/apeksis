# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Streaming transport tests: WS /v1/tts/stream and WS /v1/realtime/transcriptions."""

import asyncio
import hashlib
import json
import time

import httpx
import numpy as np
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from voxi.gateway import Settings, create_app
from voxi.media import unpack_audio_frame

KEY = "k" * 32
WINDOW_BYTES = 640  # 20 ms of 16 kHz PCM16 mono


def loud_windows(count: int, amplitude: int = 4000) -> bytes:
    return b"".join(
        np.full(WINDOW_BYTES // 2, amplitude, dtype="<i2").tobytes() for _ in range(count)
    )


def silent_windows(count: int) -> bytes:
    return b"".join(np.zeros(WINDOW_BYTES // 2, dtype="<i2").tobytes() for _ in range(count))


class PcmBody:
    """Async worker body so the gateway observes genuine chunked synthesis."""

    def __init__(self, frames: list[bytes], delay: float = 0.0):
        self.frames = frames
        self.delay = delay

    async def __aiter__(self):
        for frame in self.frames:
            if self.delay:
                await asyncio.sleep(self.delay)
            yield frame


class Recorder:
    """Reads server frames, keeping audio and JSON events separately and in order."""

    def __init__(self, websocket):
        self.websocket = websocket
        self.events: list[dict] = []
        self.frames: list[bytes] = []

    def until(self, event_type: str, **fields):
        while True:
            message = self.websocket.receive()
            if message.get("type") == "websocket.close":
                raise AssertionError(f"closed before {event_type}: {message}")
            text = message.get("text")
            if text is None:
                self.frames.append(message["bytes"])
                continue
            event = json.loads(text)
            self.events.append(event)
            if event.get("type") == event_type and all(
                event.get(key) == value for key, value in fields.items()
            ):
                return event


def gateway(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def app_with(handler, **overrides):
    """Short idle timeout everywhere: a stalled stream must fail fast, not hang a suite."""
    options: dict = {"api_key": KEY, "worker_key": "w" * 32, "ws_idle_timeout": 5}
    options.update(overrides)
    return create_app(Settings(**options), client=gateway(handler))


def test_tts_stream_rejects_unauthenticated_and_out_of_scope_sockets():
    async def unused(request):
        raise AssertionError("no worker call expected")

    app = app_with(unused)
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as anonymous:
            with client.websocket_connect("/v1/tts/stream"):
                pass
        assert anonymous.value.code == 1008

    realtime_only = "r" * 32
    records = json.dumps(
        [
            {
                "id": "pbx",
                "sha256": hashlib.sha256(realtime_only.encode()).hexdigest(),
                "scopes": ["realtime:connect"],
            }
        ]
    )
    app = create_app(Settings(api_keys_json=records, worker_key="w" * 32), client=gateway(unused))
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as scoped:
            with client.websocket_connect(f"/v1/tts/stream?token={realtime_only}"):
                pass
        assert scoped.value.code == 1008


def test_tts_stream_emits_meta_then_framed_audio_then_done():
    async def handler(request):
        assert request.url.path == "/internal/speech/stream"
        assert json.loads(request.content)["response_format"] == "pcm"
        return httpx.Response(200, content=PcmBody([b"\x01\x02" * 800, b"\x01\x02" * 800]))

    app = app_with(handler)
    with TestClient(app) as client:
        with client.websocket_connect(f"/v1/tts/stream?token={KEY}") as websocket:
            recorder = Recorder(websocket)
            websocket.send_json(
                {
                    "input": "Merhaba dünya",
                    "sample_rate": 16000,
                    "chunk_ms": 20,
                    "generation_id": 7,
                }
            )
            meta = recorder.until("meta")
            assert meta == {
                "type": "meta",
                "generation_id": 7,
                "sample_rate": 16000,
                "channels": 1,
                "encoding": "pcm_s16le",
                "chunk_ms": 20,
            }
            done = recorder.until("done")
            assert done["chunks"] == 5
            # 3200 PCM bytes at 16 kHz is exactly 100 ms.
            assert done["duration_ms"] == 100
            assert len(recorder.frames) == 5
            for index, raw in enumerate(recorder.frames):
                generation, sequence, pcm = unpack_audio_frame(raw)
                assert (generation, sequence) == (7, index)
                assert len(pcm) == WINDOW_BYTES


def test_tts_stream_cancel_stops_at_the_next_chunk_boundary():
    called = 0

    async def handler(request):
        nonlocal called
        called += 1
        # 40 worker chunks x 5 wire frames = 200 frames if never cancelled.
        return httpx.Response(200, content=PcmBody([b"\x01\x02" * 1600] * 40, delay=0.05))

    app = app_with(handler)
    with TestClient(app) as client:
        with client.websocket_connect(f"/v1/tts/stream?token={KEY}") as websocket:
            recorder = Recorder(websocket)
            websocket.send_json({"input": "Uzun metin", "sample_rate": 16000, "chunk_ms": 20})
            recorder.until("meta")
            websocket.send_json({"type": "cancel", "generation_id": 0})
            cancelled = recorder.until("cancelled")
            assert cancelled["generation_id"] == 0
            assert cancelled["chunks"] < 200
            # Everything the server committed to the outbox is still delivered in order.
            assert cancelled["chunks"] == len(recorder.frames)
            assert not any(event["type"] == "done" for event in recorder.events)
    assert called == 1


def test_tts_stream_reports_errors_and_reuses_the_connection():
    responses = [500, 200]

    async def handler(request):
        if responses.pop(0) == 500:
            return httpx.Response(500, content=b"boom")
        return httpx.Response(200, content=PcmBody([b"\x01\x02" * 800]))

    app = app_with(handler)
    with TestClient(app) as client:
        with client.websocket_connect(f"/v1/tts/stream?token={KEY}") as websocket:
            recorder = Recorder(websocket)
            websocket.send_bytes(b"binary is not a control frame")
            assert recorder.until("error")["code"] == "invalid_frame"

            websocket.send_json({"input": "   "})
            assert recorder.until("error")["code"] == "invalid_request"

            websocket.send_json({"input": "Merhaba", "voice": "nadia"})
            assert recorder.until("error")["code"] == "unsupported_voice"

            websocket.send_json({"input": "Merhaba", "model": "antalia-mini"})
            assert recorder.until("error")["code"] == "model_not_found"

            websocket.send_json({"input": "Merhaba"})
            failed = recorder.until("error")
            assert failed["code"] == "worker_failure"

            # The socket survives its mistakes and can serve the next request.
            websocket.send_json({"input": "Merhaba", "chunk_ms": 20})
            assert recorder.until("meta")["chunk_ms"] == 20
            # 1600 bytes: two full 640-byte frames plus the 320-byte tail.
            done = recorder.until("done")
            assert done["chunks"] == 3 and done["duration_ms"] == 50
            assert not responses


def test_realtime_transcriptions_requires_a_valid_handshake():
    async def handler(request):
        raise AssertionError("no worker call expected")

    app = app_with(handler, ws_idle_timeout=2)
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/v1/realtime/transcriptions"):
                pass

        with client.websocket_connect(f"/v1/realtime/transcriptions?token={KEY}") as websocket:
            recorder = Recorder(websocket)
            websocket.send_json({"type": "session.start", "sample_rate": 44100})
            assert recorder.until("error")["code"] == "invalid_request"
            with pytest.raises(WebSocketDisconnect) as closed:
                while True:
                    websocket.receive_json()
            assert closed.value.code == 1008

        # A raw audio frame before session.start is rejected the same way.
        with client.websocket_connect(f"/v1/realtime/transcriptions?token={KEY}") as websocket:
            recorder = Recorder(websocket)
            websocket.send_bytes(loud_windows(2))
            assert recorder.until("error")["code"] == "invalid_request"


def stt_responder(calls: list[bytes], text: str = "bir iki üç", delay: float = 0.0):
    async def handler(request):
        assert request.url.path == "/internal/transcriptions"
        calls.append(request.content)
        if delay:
            await asyncio.sleep(delay)
        return httpx.Response(200, json={"text": text})

    return handler


def test_realtime_transcriptions_windows_one_utterance_into_a_final():
    calls: list[bytes] = []
    app = app_with(stt_responder(calls))
    with TestClient(app) as client:
        with client.websocket_connect(f"/v1/realtime/transcriptions?token={KEY}") as websocket:
            websocket.send_json(
                {
                    "type": "session.start",
                    "sample_rate": 16000,
                    "language": "tr",
                    "partial_interval_ms": 10000,
                }
            )
            recorder = Recorder(websocket)
            started = recorder.until("session.started")
            assert started["mode"] == "windowed"
            assert started["sample_rate"] == 16000 and started["session_id"]
            assert started["vad"] == {
                "start_ms": 100,
                "end_ms": 700,
                "min_speech_ms": 200,
                "max_utterance_ms": 30000,
                "partial_interval_ms": 10000,
            }

            websocket.send_bytes(loud_windows(15) + silent_windows(36))
            final = recorder.until("transcript.final")
            assert final["text"] == "bir iki üç"
            assert final["revision"] == 1 and final["mode"] == "windowed"
            assert final["duration_ms"] > 0 and final["started_ms"] < final["ended_ms"]

            speech_ended = next(
                event for event in recorder.events if event["type"] == "speech.ended"
            )
            assert speech_ended["utterance_id"] == final["utterance_id"]
            assert "rejected_ms" not in speech_ended
            assert not any(event["type"] == "transcript.partial" for event in recorder.events)

            websocket.send_json({"type": "ping"})
            assert recorder.until("pong")["type"] == "pong"
            websocket.send_json({"type": "session.stop"})
            assert recorder.until("session.ended")["type"] == "session.ended"

    # The worker receives a self-describing WAV container, never a bare PCM blob.
    assert len(calls) == 1
    assert b"RIFF" in calls[0]


def test_realtime_transcriptions_suppresses_false_start_and_flushes_active_speech():
    calls: list[bytes] = []
    app = app_with(stt_responder(calls))
    with TestClient(app) as client:
        with client.websocket_connect(f"/v1/realtime/transcriptions?token={KEY}") as websocket:
            websocket.send_json({"type": "session.start", "min_speech_ms": 200})
            recorder = Recorder(websocket)
            recorder.until("session.started")

            # 140 ms of loud audio is below min_speech_ms: reported, never transcribed.
            websocket.send_bytes(loud_windows(7) + silent_windows(36))
            ended = recorder.until("speech.ended")
            assert ended["rejected_ms"] == 140 and "duration_ms" not in ended
            assert not calls

            # An idle flush is a no-op: no events, no transcription work.
            websocket.send_json({"type": "flush"})
            websocket.send_bytes(loud_windows(11))
            second = recorder.until("speech.started")
            websocket.send_json({"type": "flush"})
            final = recorder.until("transcript.final")
            assert final["utterance_id"] == second["utterance_id"]
            assert "rejected_ms" not in final
            assert len(calls) == 1


def test_realtime_transcriptions_reports_partial_revisions_before_the_final():
    calls: list[bytes] = []
    app = app_with(stt_responder(calls, text="kısım", delay=0.05))
    with TestClient(app) as client:
        with client.websocket_connect(f"/v1/realtime/transcriptions?token={KEY}") as websocket:
            websocket.send_json({"type": "session.start", "partial_interval_ms": 300})
            recorder = Recorder(websocket)
            recorder.until("session.started")

            websocket.send_bytes(loud_windows(8))
            time.sleep(0.25)
            websocket.send_bytes(loud_windows(10))
            time.sleep(0.25)
            websocket.send_bytes(silent_windows(36))
            final = recorder.until("transcript.final")

            partials = [event for event in recorder.events if event["type"] == "transcript.partial"]
            assert partials, "windowed near-real-time mode must emit partials"
            assert all(event["utterance_id"] == final["utterance_id"] for event in partials)
            assert max(event["revision"] for event in partials) < final["revision"]
            assert len(calls) == len(partials) + 1
            websocket.send_json({"type": "session.stop"})
            recorder.until("session.ended")


def turn_handler(turns: list[str], transcript: str):
    async def handler(request):
        path = request.url.path
        if path == "/webhook/turn":
            payload = json.loads(request.content)
            turns.append(payload["transcript"])
            return httpx.Response(
                200,
                json={
                    "schema_version": "1.0",
                    "action": "speak",
                    "text": "Buyurun",
                    "idempotency_key": f"{payload['call_id']}:{payload['turn_id']}",
                },
            )
        if path == "/internal/speech/stream":
            # 25 worker chunks x 50 ms keeps synthesis in flight while the caller interrupts.
            return httpx.Response(200, content=PcmBody([b"\x01\x02" * 1600] * 25, delay=0.05))
        if path == "/internal/transcriptions":
            assert b"RIFF" in request.content
            return httpx.Response(200, json={"text": transcript})
        raise AssertionError(path)

    return handler


def open_session(client: TestClient) -> str:
    response = client.post("/v1/sessions", headers={"Authorization": f"Bearer {KEY}"})
    assert response.status_code == 201
    return response.json()["session_id"]


def test_session_stream_barges_in_and_starts_a_turn_from_voice():
    turns: list[str] = []
    app = app_with(
        turn_handler(turns, "sana geldim"),
        n8n_url="http://n8n/webhook/turn",
        n8n_key="n" * 32,
        tts_chunk_ms=20,
    )
    with TestClient(app) as client:
        session_id = open_session(client)
        with client.websocket_connect(f"/v1/sessions/{session_id}/stream?token={KEY}") as websocket:
            recorder = Recorder(websocket)
            recorder.until("state", state="connected")
            websocket.send_json({"type": "turn", "transcript": "merhaba", "language": "tr-TR"})
            recorder.until("action")
            recorder.until("state", state="speaking")

            time.sleep(0.15)
            websocket.send_bytes(loud_windows(6))
            started = recorder.until("speech_started")
            cleared = recorder.until("clear")
            # Generation 1 was the first spoken turn; the caller owns the channel now.
            assert cleared["generation_id"] == 1
            assert started["utterance_id"]
            recorder.until("state", state="listening")
            frames_after_flush = len(recorder.frames)

            # Enough sustained loud audio to clear min_speech_ms, then trailing silence.
            websocket.send_bytes(loud_windows(8) + silent_windows(36))
            second_action = recorder.until("action")
            assert second_action["action"]["action"] == "speak"

            transcript = next(event for event in recorder.events if event["type"] == "transcript")
            assert transcript["text"] == "sana geldim"
            assert transcript["utterance_id"] == started["utterance_id"]

            # No late audio from the interrupted generation may follow the clear.
            assert all(
                unpack_audio_frame(raw)[0] != 1 for raw in recorder.frames[frames_after_flush:]
            )

    assert turns == ["merhaba", "sana geldim"]


def test_session_stream_rejects_unknown_events_hangups_and_idle_sockets():
    turns: list[str] = []
    app = app_with(
        turn_handler(turns, "kullanilmayacak"),
        n8n_url="http://n8n/webhook/turn",
        n8n_key="n" * 32,
        ws_idle_timeout=1,
    )
    with TestClient(app) as client:
        session_id = open_session(client)
        with client.websocket_connect(f"/v1/sessions/{session_id}/stream?token={KEY}") as websocket:
            recorder = Recorder(websocket)
            recorder.until("state", state="connected")

            websocket.send_json({"type": "vibrate"})
            assert recorder.until("error")["code"] == "invalid_event"

            websocket.send_json({"type": "ping"})
            assert recorder.until("pong")["type"] == "pong"

            # A turn with neither transcript nor buffered speech is refused, not sent to n8n.
            websocket.send_json({"type": "turn"})
            assert recorder.until("error")["code"] == "empty_turn"
            assert not turns

            websocket.send_json({"type": "hangup"})
            closed = websocket.receive()
            assert closed["type"] == "websocket.close" and closed["code"] == 1000

        # The hangup terminated the session; the stream cannot be reattached.
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/v1/sessions/{session_id}/stream?token={KEY}"):
                pass

        # A silent socket is reclaimed by the idle TTL instead of pinning a worker slot.
        idle_session = open_session(client)
        with client.websocket_connect(
            f"/v1/sessions/{idle_session}/stream?token={KEY}"
        ) as websocket:
            recorder = Recorder(websocket)
            recorder.until("state", state="connected")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                message = websocket.receive()
                if message["type"] == "websocket.close":
                    assert message["code"] == 1000
                    assert message["reason"] == "Idle timeout"
                    break
            else:
                raise AssertionError("idle socket was never reclaimed")
