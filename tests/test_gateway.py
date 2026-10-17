# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import asyncio
import hashlib
import io
import json
import wave
from contextlib import asynccontextmanager

import httpx
import pytest
from openai import AsyncOpenAI, BadRequestError

from voxi.audio import MIME_TYPES, decode_audio, encode_audio
from voxi.gateway import Settings, create_app

KEY = "test-application-key-" + "x" * 32
WORKER_KEY = "test-worker-key-" + "y" * 32


def wav_fixture():
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(24000)
        writer.writeframes(b"\x00\x00" * 2400)
    return output.getvalue()


async def upstream(request):
    if request.url.path == "/readyz":
        return httpx.Response(200, json={"status": "ready"})
    if request.url.path == "/internal/models":
        # The real workers advertise the OpenAI alias AND their own model id, so
        # this mock must too or a routing bug could hide behind it.
        ids = {
            "stt": ["whisper-1", "whisper-small"],
            "stt-turbo": ["whisper-1", "whisper-large-v3-turbo"],
        }.get(request.url.host, ["ema-lightning"])
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": name, "object": "model", "created": 0, "owned_by": "local"}
                    for name in ids
                ]
            },
        )
    if request.url.path == "/internal/speech":
        body = json.loads(request.content)
        audio = decode_audio(
            wav_fixture(), max_bytes=100000, max_seconds=1, sample_rate=body["sample_rate"]
        )
        return httpx.Response(
            200,
            content=encode_audio(audio, body["response_format"]),
            headers={
                "Content-Type": MIME_TYPES[body["response_format"]],
                "X-Normalization-Owner": "ema_integrated",
            },
        )
    return httpx.Response(200, json={"text": "Merhaba, iyi günler.", "language": "tr"})


@asynccontextmanager
async def serving(handler=upstream, **overrides):
    settings = Settings(
        api_key=KEY, worker_key=WORKER_KEY, tts_url="http://tts", stt_url="http://stt", **overrides
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as workers:
        app = create_app(settings, workers)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://gateway"
            ) as client:
                yield client


async def test_openai_sdk_file_contract_and_error_envelope():
    async with serving() as http:
        sdk = AsyncOpenAI(api_key=KEY, base_url="http://gateway/v1", http_client=http)
        speech = await sdk.audio.speech.create(
            model="ema-lightning", voice="ema-tr", input="Merhaba.", response_format="wav"
        )
        with wave.open(io.BytesIO(speech.content), "rb") as reader:
            assert (reader.getframerate(), reader.getsampwidth(), reader.getnchannels()) == (
                24000,
                2,
                1,
            )
        default_speech = await sdk.audio.speech.create(
            model="ema-lightning", voice="ema-tr", input="Merhaba."
        )
        assert default_speech.content.startswith(b"ID3") or default_speech.content[0] == 0xFF
        assert decode_audio(default_speech.content, max_bytes=100000, max_seconds=1).duration >= 0.1
        transcription = await sdk.audio.transcriptions.create(
            model="whisper-1", file=("sample.wav", wav_fixture(), "audio/wav"), language="tr"
        )
        assert transcription.text == "Merhaba, iyi günler."
        models = await sdk.models.list()
        assert {row.id for row in models.data} == {"ema-lightning", "whisper-1", "whisper-small"}
        with pytest.raises(BadRequestError) as exc:
            await sdk.audio.speech.create(model="ema-lightning", voice="alloy", input="Merhaba")
        assert exc.value.code == "unsupported_voice"


@pytest.mark.parametrize(
    "update",
    [
        {"input": " "},
        {"speed": 0.24},
        {"speed": 4.01},
        {"response_format": "flac"},
        {"instructions": "whisper"},
        {"model": "antalia-mini"},
        {"seed": -1},
    ],
)
async def test_unsupported_speech_rejected_before_inference(update):
    async def forbidden(request):
        pytest.fail("Rejected speech must not invoke inference")

    async with serving(forbidden) as client:
        response = await client.post(
            "/v1/audio/speech",
            headers={"Authorization": f"Bearer {KEY}"},
            json={"input": "Merhaba", **update},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] in {"invalid_parameter", "model_not_found"}


async def test_alias_is_explicit_and_physical_voice_unchanged():
    async with serving(allow_alloy=True) as client:
        response = await client.post(
            "/v1/audio/speech",
            headers={"Authorization": f"Bearer {KEY}"},
            json={"model": "tts-1", "voice": "alloy", "input": "Merhaba", "response_format": "wav"},
        )
        assert response.status_code == 200
        assert response.headers["X-Engine"] == "ema-lightning"
        assert "single ema-tr" in response.headers["Warning"]


async def test_whisper_turbo_is_opt_in_and_routed_to_its_own_worker():
    """Both STT models serve at once; the gateway picks the worker by model id."""
    hosts: list[str] = []

    async def handler(request):
        if request.url.path == "/internal/models":
            ids = {
                "stt": ["whisper-1", "whisper-small"],
                "stt-turbo": ["whisper-1", "whisper-large-v3-turbo"],
            }.get(request.url.host, ["ema-lightning"])
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"id": name, "object": "model", "created": 0, "owned_by": "local"}
                        for name in ids
                    ]
                },
            )
        if request.url.path == "/internal/transcriptions":
            hosts.append(request.url.host)
        return httpx.Response(200, json={"text": "Merhaba.", "language": "tr"})

    async with serving(handler, stt_turbo_url="http://stt-turbo") as client:
        models = await client.get("/v1/models", headers={"Authorization": f"Bearer {KEY}"})
        rows = models.json()["data"]
        assert {row["id"] for row in rows} == {
            "ema-lightning",
            "whisper-1",
            "whisper-small",
            "whisper-large-v3-turbo",
        }
        # Both STT workers advertise the whisper-1 alias; it must appear once.
        ids = [row["id"] for row in rows]
        assert len(ids) == len(set(ids)), f"duplicate model ids: {ids}"
        for model, expected in (
            ("whisper-large-v3-turbo", "stt-turbo"),
            ("whisper-small", "stt"),
            ("whisper-1", "stt"),
        ):
            response = await client.post(
                "/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {KEY}"},
                data={"model": model},
                files={"file": ("a.wav", wav_fixture(), "audio/wav")},
            )
            assert response.status_code == 200, response.text
            assert hosts[-1] == expected, f"{model} should be served by {expected}"


async def test_whisper_turbo_disabled_is_not_advertised_and_rejected():
    """Without the opt-in profile the model is neither listed nor routed anywhere."""

    async def handler(request):
        if request.url.path == "/internal/models":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"id": name, "object": "model", "created": 0, "owned_by": "local"}
                        for name in ("whisper-1", "whisper-small")
                    ]
                },
            )
        if request.url.path == "/internal/transcriptions":
            pytest.fail("A disabled model must not reach inference")
        return httpx.Response(200, json={"text": "Merhaba."})

    async with serving(handler) as client:
        models = await client.get("/v1/models", headers={"Authorization": f"Bearer {KEY}"})
        assert "whisper-large-v3-turbo" not in {row["id"] for row in models.json()["data"]}
        response = await client.post(
            "/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {KEY}"},
            data={"model": "whisper-large-v3-turbo"},
            files={"file": ("a.wav", wav_fixture(), "audio/wav")},
        )
        assert response.status_code == 400
        error = response.json()["error"]
        assert error["code"] == "model_not_found"
        # The message names what really is installed instead of a fixed alias.
        assert "whisper-small" in error["message"]


async def test_scope_auth_and_revocation():
    read_key = "read-client-key-" + "z" * 32
    keys = json.dumps(
        [
            {
                "id": "read",
                "sha256": hashlib.sha256(read_key.encode()).hexdigest(),
                "scopes": ["audio:read"],
            }
        ]
    )
    async with serving(api_keys_json=keys) as client:
        assert (await client.get("/v1/models")).status_code == 401
        assert (
            await client.get("/v1/models", headers={"Authorization": "Bearer revoked"})
        ).status_code == 401
        response = await client.post(
            "/v1/audio/speech",
            json={"input": "Merhaba"},
            headers={"Authorization": f"Bearer {read_key}"},
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "insufficient_scope"
        assert (
            await client.get("/v1/models", headers={"Authorization": f"Bearer {read_key}"})
        ).status_code == 200


async def test_multipart_limits_and_unknown_semantics():
    async with serving(max_upload=100) as client:
        headers = {"Authorization": f"Bearer {KEY}"}
        for content, status in [(b"", 400), (b"x" * 101, 413)]:
            response = await client.post(
                "/v1/audio/transcriptions",
                headers=headers,
                data={"model": "whisper-1"},
                files={"file": ("x.wav", content)},
            )
            assert response.status_code == status
        response = await client.post(
            "/v1/audio/transcriptions",
            headers=headers,
            data={"response_format": "flac"},
            files={"file": ("x.wav", b"x")},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "unsupported_format"
        # A timing knob without a timing-capable format is rejected (single precedence rule).
        response = await client.post(
            "/v1/audio/transcriptions",
            headers=headers,
            data={"timestamp_granularities[]": "word"},
            files={"file": ("x.wav", b"x")},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "timestamp_requires_format"
        assert (await client.post("/v1/audio/translations", headers=headers)).status_code == 404


async def test_readiness_failure_and_rate_limit():
    async def offline(request):
        return httpx.Response(503)

    async with serving(offline, rate_limit=1) as client:
        response = await client.get("/readyz")
        assert response.status_code == 503
        assert response.json()["workers"] == {"tts": False, "stt": False}
        headers = {"Authorization": f"Bearer {KEY}"}
        assert (await client.get("/v1/models", headers=headers)).status_code == 503
        assert (await client.get("/v1/models", headers=headers)).status_code == 429


async def test_concurrent_admission_fails_without_waiting():
    entered = asyncio.Event()
    release = asyncio.Event()

    async def slow(request):
        entered.set()
        await release.wait()
        return await upstream(request)

    async with serving(slow, concurrency=1) as client:
        headers = {"Authorization": f"Bearer {KEY}"}
        pending = asyncio.create_task(
            client.post(
                "/v1/audio/speech",
                headers=headers,
                json={"input": "Merhaba", "response_format": "wav"},
            )
        )
        await entered.wait()
        rejected = await client.post("/v1/audio/speech", headers=headers, json={"input": "Merhaba"})
        assert rejected.status_code == 429
        release.set()
        assert (await pending).status_code == 200


async def test_http_n8n_workflow_can_change_action_without_gateway_redeploy():
    workflow_action = {"schema_version": "1.0", "action": "speak", "text": "Hoş geldiniz."}

    async def webhook(request):
        assert request.headers["Authorization"] == "Bearer " + "n" * 32
        payload = json.loads(request.content)
        assert payload["transcript"] == "25 TL, hesap 00123"
        return httpx.Response(
            200,
            json={
                **workflow_action,
                "idempotency_key": f"{payload['call_id']}:{payload['turn_id']}",
            },
        )

    async with serving(webhook, n8n_url="http://n8n/webhook/turn", n8n_key="n" * 32) as client:
        headers = {"Authorization": f"Bearer {KEY}"}
        session = await client.post("/v1/sessions", headers=headers)
        assert session.status_code == 201
        session_id = session.json()["session_id"]
        url = f"/v1/sessions/{session_id}/turns"
        first = await client.post(url, headers=headers, json={"transcript": "25 TL, hesap 00123"})
        assert first.json()["action"]["text"] == "Hoş geldiniz."
        workflow_action.clear()
        workflow_action.update({"schema_version": "1.0", "action": "listen"})
        second = await client.post(url, headers=headers, json={"transcript": "25 TL, hesap 00123"})
        assert second.json()["action"]["action"] == "listen"
        assert second.json()["generation_id"] == 2
        assert (
            await client.delete(f"/v1/sessions/{session_id}", headers=headers)
        ).status_code == 204
        assert (
            await client.post(url, headers=headers, json={"transcript": "Merhaba"})
        ).status_code == 404


async def timed_upstream(request):
    if request.url.path == "/internal/transcriptions":
        return httpx.Response(
            200,
            json={
                "text": "Merhaba dünya",
                "language": "tr",
                "duration": 1.5,
                "segments": [
                    {
                        "id": 0,
                        "start": 0.0,
                        "end": 0.7,
                        "text": " Merhaba",
                        "words": [{"word": " Merhaba", "start": 0.0, "end": 0.7}],
                    },
                    {
                        "id": 1,
                        "start": 0.7,
                        "end": 1.5,
                        "text": " dünya",
                        "words": [{"word": " dünya", "start": 0.7, "end": 1.5}],
                    },
                ],
            },
        )
    return await upstream(request)


async def test_verbose_json_exposes_timings_and_default_stays_plain():
    async with serving(timed_upstream) as client:
        headers = {"Authorization": f"Bearer {KEY}"}
        verbose = await client.post(
            "/v1/audio/transcriptions",
            headers=headers,
            data={"response_format": "verbose_json", "timestamp_granularities[]": "word"},
            files={"file": ("x.wav", wav_fixture())},
        )
        assert verbose.status_code == 200
        body = verbose.json()
        assert body["duration"] == 1.5 and body["language"] == "tr"
        assert body["segments"][0]["words"][0]["word"] == " Merhaba"
        assert body["segments"][1]["start"] == 0.7
        # Regression: the OpenAI-style default {text} response is byte-for-byte unchanged.
        default = await client.post(
            "/v1/audio/transcriptions",
            headers=headers,
            files={"file": ("x.wav", wav_fixture())},
        )
        assert default.json() == {"text": "Merhaba dünya"}
        assert "segments" not in default.json()


async def test_granularity_precedence_strips_words_for_segment():
    async with serving(timed_upstream) as client:
        headers = {"Authorization": f"Bearer {KEY}"}
        # timestamp_granularities is authoritative: 'segment' wins over word_timestamps=true.
        segment = await client.post(
            "/v1/audio/transcriptions",
            headers=headers,
            data={
                "response_format": "verbose_json",
                "word_timestamps": "true",
                "timestamp_granularities[]": "segment",
            },
            files={"file": ("x.wav", wav_fixture())},
        )
        assert segment.status_code == 200
        assert "words" not in segment.json()["segments"][0]


async def test_srt_vtt_order_timecodes_and_turkish_utf8():
    async def tr_upstream(request):
        if request.url.path == "/internal/transcriptions":
            return httpx.Response(
                200,
                json={
                    "text": "Istanbul'a hos geldiniz",
                    "language": "tr",
                    "duration": 2.0,
                    "segments": [
                        {"id": 1, "start": 1.0, "end": 2.0, "text": " hoş geldiniz"},
                        {"id": 0, "start": 0.0, "end": 1.0, "text": " İstanbul'a"},
                    ],
                },
            )
        return await upstream(request)

    async with serving(tr_upstream) as client:
        headers = {"Authorization": f"Bearer {KEY}"}
        srt = await client.post(
            "/v1/audio/transcriptions",
            headers=headers,
            data={"response_format": "srt"},
            files={"file": ("x.wav", wav_fixture())},
        )
        assert srt.status_code == 200
        assert srt.headers["content-type"].startswith("text/plain")
        # Cues are sorted by start time regardless of the upstream id order.
        assert "1\n00:00:00,000 --> 00:00:01,000\nİstanbul'a" in srt.text
        assert "2\n00:00:01,000 --> 00:00:02,000\nhoş geldiniz" in srt.text
        vtt = await client.post(
            "/v1/audio/transcriptions",
            headers=headers,
            data={"response_format": "vtt"},
            files={"file": ("x.wav", wav_fixture())},
        )
        assert vtt.text.startswith("WEBVTT")
        assert "00:00:00.000 --> 00:00:01.000" in vtt.text
        assert vtt.headers["content-type"].startswith("text/vtt")
