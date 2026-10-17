# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import asyncio
import io
import json
import wave

import httpx
import numpy as np
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from voxi.gateway import Settings, create_app
from voxi.media import (
    InboundAudioBuffer,
    PlayoutBuffer,
    SpeechEndpointer,
    pack_audio_frame,
    pcm_to_wav,
    unpack_audio_frame,
)

KEY = "k" * 32
WINDOW_BYTES = 640  # 20 ms of 16 kHz PCM16 mono


def loud_windows(count: int, amplitude: int = 4000) -> bytes:
    return b"".join(
        np.full(WINDOW_BYTES // 2, amplitude, dtype="<i2").tobytes() for _ in range(count)
    )


def silent_windows(count: int) -> bytes:
    return b"".join(np.zeros(WINDOW_BYTES // 2, dtype="<i2").tobytes() for _ in range(count))


def test_playout_buffer_generation_invariants():
    buffer = PlayoutBuffer(max_chunks=10)
    assert buffer.current_generation == 0

    # Old generation chunk rejected
    assert not buffer.push_chunk(1, 0, b"old_chunk")
    assert buffer.stats.dropped_stale_chunks == 1

    # Advance to generation 1
    buffer.new_generation(1)
    assert buffer.current_generation == 1
    assert buffer.push_chunk(1, 0, b"gen1_chunk0")
    assert buffer.push_chunk(1, 1, b"gen1_chunk1")
    assert buffer.stats.emitted_chunks == 2

    # Barge-in invalidates generation 1 and purges queue
    new_gen = buffer.barge_in()
    assert new_gen == 2
    assert buffer.current_generation == 2
    assert buffer.stats.barge_in_count == 1

    # Chunk from generation 1 is now stale and rejected
    assert not buffer.push_chunk(1, 2, b"gen1_late_chunk")
    assert buffer.stats.dropped_stale_chunks == 2

    # Chunk from new generation 2 accepted
    assert buffer.push_chunk(2, 0, b"gen2_chunk0")


def test_audio_frame_header_packing_and_unpacking():
    payload = b"\x00\x01\x02\x03" * 160  # 640 bytes PCM
    frame = pack_audio_frame(generation_id=42, sequence=7, pcm_bytes=payload)
    assert len(frame) == 4 + len(payload)

    gen_id, seq, pcm = unpack_audio_frame(frame)
    assert gen_id == 42
    assert seq == 7
    assert pcm == payload

    with pytest.raises(ValueError):
        unpack_audio_frame(b"123")  # less than 4 bytes


def test_inbound_audio_buffer_bounds():
    buf = InboundAudioBuffer(max_bytes=1000)
    buf.append(b"a" * 600)
    assert buf.total_bytes == 600
    buf.append(b"b" * 600)
    # Total capped at or near 1000 by dropping oldest chunk
    assert buf.total_bytes == 600
    assert buf.read_all() == b"b" * 600
    assert buf.dropped_bytes == 600
    buf.clear()
    assert buf.total_bytes == 0
    assert buf.dropped_bytes == 0


def test_websocket_stream_auth_and_lifecycle():
    app = create_app(
        Settings(
            api_key=KEY,
            worker_key="w" * 32,
            n8n_url="http://n8n/webhook/turn",
            n8n_key="n" * 32,
        )
    )
    with TestClient(app) as client:
        # 1. Unauthenticated rejected
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/v1/sessions/invalid/stream"):
                pass

        # 2. Authenticated but non-existent session
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/v1/sessions/missing/stream?token={KEY}"):
                pass

        # 3. Create real session first
        resp = client.post("/v1/sessions", headers={"Authorization": f"Bearer {KEY}"})
        assert resp.status_code == 201
        session_id = resp.json()["session_id"]

        # 4. Connect to stream
        with client.websocket_connect(f"/v1/sessions/{session_id}/stream?token={KEY}") as ws:
            # Initial state event
            init_event = ws.receive_json()
            assert init_event["type"] == "state"
            assert init_event["state"] == "connected"

            # Ping-pong
            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            assert pong["type"] == "pong"

            # Barge-in
            ws.send_json({"type": "barge_in"})
            clear_event = ws.receive_json()
            assert clear_event["type"] == "clear"
            state_event = ws.receive_json()
            assert state_event["type"] == "state"
            assert state_event["state"] == "listening"

            # Hangup
            ws.send_json({"type": "hangup"})
            close_msg = ws.receive()
            assert close_msg["type"] == "websocket.close"


def test_websocket_stream_turn_and_audio_playout():
    async def fake_upstream(request):
        url = str(request.url)
        if "/webhook/turn" in url:
            payload = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "schema_version": "1.0",
                    "action": "speak",
                    "text": "Merhaba, size nasıl yardımcı olabilirim?",
                    "idempotency_key": f"{payload['call_id']}:{payload['turn_id']}",
                },
            )
        if "/internal/speech" in url:
            # Return 6400 bytes of dummy PCM (10 chunks of 640 bytes)
            return httpx.Response(200, content=b"\xaa\x55" * 3200)
        return httpx.Response(404)

    async_client = httpx.AsyncClient(transport=httpx.MockTransport(fake_upstream))
    app = create_app(
        Settings(
            api_key=KEY,
            worker_key="w" * 32,
            n8n_url="http://n8n/webhook/turn",
            n8n_key="n" * 32,
            # 20 ms at 16 kHz -> 640-byte wire frames.
            tts_chunk_ms=20,
        ),
        client=async_client,
    )
    with TestClient(app) as client:
        session_resp = client.post("/v1/sessions", headers={"Authorization": f"Bearer {KEY}"})
        assert session_resp.status_code == 201
        session_id = session_resp.json()["session_id"]

        with client.websocket_connect(f"/v1/sessions/{session_id}/stream?token={KEY}") as ws:
            init_event = ws.receive_json()
            assert init_event["type"] == "state"

            # Submit turn
            ws.send_json({"type": "turn", "transcript": "Alo", "language": "tr-TR"})

            events = []
            audio_frames = []
            for _ in range(10):
                msg = ws.receive()
                if "text" in msg:
                    events.append(json.loads(msg["text"]))
                elif "bytes" in msg:
                    audio_frames.append(msg["bytes"])
                if len(events) >= 3 and len(audio_frames) >= 1:
                    break

            assert any(e.get("state") == "thinking" for e in events)
            assert any(
                e.get("type") == "action" and e["action"]["action"] == "speak" for e in events
            )
            assert any(e.get("state") == "speaking" for e in events)
            assert len(audio_frames) >= 1
            gen_id, seq, pcm = unpack_audio_frame(audio_frames[0])
            assert len(pcm) == 640
            assert seq == 0


def test_websocket_stream_mid_stream_barge_in():
    async def fake_upstream(request):
        url = str(request.url)
        if "/webhook/turn" in url:
            payload = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "schema_version": "1.0",
                    "action": "speak",
                    "text": "Uzun yanıt metni...",
                    "idempotency_key": f"{payload['call_id']}:{payload['turn_id']}",
                },
            )
        if "/internal/speech" in url:
            return httpx.Response(200, content=b"\xaa\x55" * 6400)
        return httpx.Response(404)

    async_client = httpx.AsyncClient(transport=httpx.MockTransport(fake_upstream))
    app = create_app(
        Settings(
            api_key=KEY,
            worker_key="w" * 32,
            n8n_url="http://n8n/webhook/turn",
            n8n_key="n" * 32,
        ),
        client=async_client,
    )
    with TestClient(app) as client:
        session_resp = client.post("/v1/sessions", headers={"Authorization": f"Bearer {KEY}"})
        session_id = session_resp.json()["session_id"]

        with client.websocket_connect(f"/v1/sessions/{session_id}/stream?token={KEY}") as ws:
            ws.receive_json()  # connected
            ws.send_json({"type": "turn", "transcript": "Merhaba", "language": "tr-TR"})

            # Read until speaking
            while True:
                msg = ws.receive()
                if "text" in msg:
                    ev = json.loads(msg["text"])
                    if ev.get("state") == "speaking":
                        break

            # Trigger barge-in immediately
            ws.send_json({"type": "barge_in"})

            # Must receive clear event with old generation
            cleared = False
            while not cleared:
                msg = ws.receive()
                if "text" in msg:
                    ev = json.loads(msg["text"])
                    if ev.get("type") == "clear":
                        cleared = True
                        assert ev.get("generation_id") is not None
            assert cleared


def test_websocket_stream_inbound_audio_transcription():
    stt_called = False

    async def fake_upstream(request):
        nonlocal stt_called
        url = str(request.url)
        if "/internal/transcriptions" in url:
            stt_called = True
            return httpx.Response(200, json={"text": "Sesli selam"})
        if "/webhook/turn" in url:
            payload = json.loads(request.content)
            assert payload["transcript"] == "Sesli selam"
            return httpx.Response(
                200,
                json={
                    "schema_version": "1.0",
                    "action": "listen",
                    "idempotency_key": f"{payload['call_id']}:{payload['turn_id']}",
                },
            )
        return httpx.Response(404)

    async_client = httpx.AsyncClient(transport=httpx.MockTransport(fake_upstream))
    app = create_app(
        Settings(
            api_key=KEY,
            worker_key="w" * 32,
            n8n_url="http://n8n/webhook/turn",
            n8n_key="n" * 32,
        ),
        client=async_client,
    )
    with TestClient(app) as client:
        session_resp = client.post("/v1/sessions", headers={"Authorization": f"Bearer {KEY}"})
        session_id = session_resp.json()["session_id"]

        with client.websocket_connect(f"/v1/sessions/{session_id}/stream?token={KEY}") as ws:
            ws.receive_json()  # connected

            # Stream binary audio from client
            ws.send_bytes(b"\x00\x01" * 320)  # 640 bytes audio

            # Send turn without transcript
            ws.send_json({"type": "turn", "transcript": None, "language": "tr-TR"})

            # Whisper must be invoked and n8n receives transcript
            while True:
                msg = ws.receive()
                if "text" in msg:
                    ev = json.loads(msg["text"])
                    if ev.get("type") == "action":
                        assert ev["action"]["action"] == "listen"
                        break
            assert stt_called


def test_pcm_to_wav_produces_decodable_container():
    pcm = np.zeros(1600, dtype="<i2").tobytes()
    container = pcm_to_wav(pcm, 16000)
    assert container[:4] == b"RIFF" and container[8:12] == b"WAVE"
    with wave.open(io.BytesIO(container), "rb") as reader:
        assert reader.getnchannels() == 1
        assert reader.getsampwidth() == 2
        assert reader.getframerate() == 16000
        assert reader.readframes(reader.getnframes()) == pcm
    with pytest.raises(ValueError):
        pcm_to_wav(pcm, 0)


def test_playout_buffer_keeps_control_events_through_barge_in():
    buffer = PlayoutBuffer(max_chunks=10)
    assert buffer.push_chunk(0, 0, b"a" * 640)
    assert buffer.push_event({"type": "state", "state": "speaking"})
    assert buffer.push_chunk(0, 1, b"b" * 640)
    assert buffer.push_event({"type": "clear", "generation_id": 0})

    buffer.barge_in()
    assert buffer.queued_chunks == 2  # audio purged, events preserved in order

    async def collect():
        return [await buffer.get_next(timeout=0.5), await buffer.get_next(timeout=0.5)]

    first, second = asyncio.run(collect())
    assert isinstance(first, dict) and first["state"] == "speaking"
    assert isinstance(second, dict) and second["type"] == "clear"


def test_endpointer_opens_on_sustained_speech_and_endpoints_on_silence():
    endpointer = SpeechEndpointer(16000, start_ms=100, end_ms=700, min_speech_ms=200)
    events = endpointer.feed(loud_windows(15) + silent_windows(36))
    names = [event.name for event in events]
    assert names == ["speech_started", "speech_ended"]
    started, ended = events
    assert started.utterance_id and endpointer.active_utterance_id is None
    assert ended.utterance is not None
    assert ended.utterance.speech_ms >= 200
    assert not ended.utterance.truncated
    assert ended.utterance.duration_ms == len(ended.utterance.pcm) * 1000 // 32000
    assert ended.utterance.started_ms < started.position_ms
    assert endpointer.feed(b"") == []


def test_endpointer_suppresses_false_starts_below_min_speech():
    endpointer = SpeechEndpointer(16000, start_ms=100, end_ms=700, min_speech_ms=200)
    events = endpointer.feed(loud_windows(7) + silent_windows(36))
    assert [event.name for event in events] == ["speech_started", "speech_ended"]
    assert events[1].utterance is None
    assert events[1].rejected_ms == 140


def test_endpointer_hysteresis_keeps_quiet_speech_inside_the_window():
    endpointer = SpeechEndpointer(16000, start_ms=100, end_ms=700, min_speech_ms=200)
    # Above close_rms (200) but below open_rms (350): never a new start, never silence.
    assert endpointer.feed(np.full(320, 300, dtype="<i2").tobytes() * 10) == []
    events = endpointer.feed(loud_windows(5) + (np.full(320, 300, dtype="<i2").tobytes() * 10))
    assert [event.name for event in events] == ["speech_started"]
    assert endpointer.silence_ms == 0


def test_endpointer_caps_long_utterances_and_flushes_active_speech():
    endpointer = SpeechEndpointer(
        16000, start_ms=100, end_ms=700, min_speech_ms=200, max_utterance_ms=1000
    )
    events = endpointer.feed(loud_windows(60))
    assert [event.name for event in events][:3] == [
        "speech_started",
        "speech_too_long",
        "speech_ended",
    ]
    assert events[2].utterance is not None and events[2].utterance.truncated
    # The bound forces a window boundary and the endpointer opens the next utterance.
    assert events[3].name == "speech_started"

    endpointer = SpeechEndpointer(16000, start_ms=100, end_ms=700, min_speech_ms=200)
    assert [event.name for event in endpointer.feed(loud_windows(6))] == ["speech_started"]
    assert endpointer.active_pcm()
    flushed = endpointer.flush()
    assert [event.name for event in flushed] == ["speech_ended"]
    assert not endpointer.active_utterance_id

    endpointer = SpeechEndpointer(16000, start_ms=100, end_ms=700, min_speech_ms=200)
    endpointer.feed(loud_windows(6))
    endpointer.reset()
    assert endpointer.flush() == []
    assert endpointer.active_pcm() == b""


def test_endpointer_rejects_ambiguous_thresholds():
    with pytest.raises(ValueError):
        SpeechEndpointer(16000, open_rms=100, close_rms=400)
    with pytest.raises(ValueError):
        SpeechEndpointer(16000, end_ms=700, min_speech_ms=200, max_utterance_ms=800)
