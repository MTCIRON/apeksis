# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from voxi.audio import Audio, decode_audio, encode_audio
from voxi.contracts import SpeechRequest, TranscriptionRequest
from voxi.errors import PlatformError
from voxi.providers.antalia import AntaliaMiniProvider
from voxi.providers.base import Generation, GenerationCancelled
from voxi.providers.ema import EMAProvider
from voxi.providers.whisper import WhisperProvider
from voxi.workers.stt import create_app as stt_app
from voxi.workers.tts import create_app as tts_app


class DeterministicSpeechEngine:
    """Test injection only; production adapters always import official packages."""

    def __init__(self):
        self.calls = []
        self.closed = 0
        self.after_inference = None
        self.fail = False

    def say(self, text, **kwargs):
        self.calls.append((text, kwargs))
        if self.fail:
            raise RuntimeError("warmup failed")
        rate = kwargs["sample_rate"]
        time = np.arange(rate // 4, dtype=np.float32) / rate
        audio = (0.2 * np.sin(2 * np.pi * 440 * time)).astype(np.float32)
        if self.after_inference:
            self.after_inference()
        return SimpleNamespace(audio=audio, sample_rate=rate, words=())

    def normalize(self, text):
        raise AssertionError("Adapter must never normalize or inspect in a second pass")

    def stream(self, text, **kwargs):
        try:
            self.calls.append((text, kwargs))
            for _ in range(3):
                if self.after_inference:
                    self.after_inference()
                yield np.zeros(kwargs["sample_rate"] // 10, dtype=np.float32)
        finally:
            self.closed += 1


@pytest.fixture(params=[EMAProvider, AntaliaMiniProvider])
def provider(request):
    instance = request.param("unused-test-path", engine=DeterministicSpeechEngine())
    instance.warmup()
    return instance


def speech_request(provider, text="Merhaba.", **kwargs):
    return SpeechRequest(model=provider.model_id, voice=provider.voice, input=text, **kwargs)


def test_cancel_before_native_call(provider):
    token = Generation("old")
    token.cancel()
    before = len(provider.engine.calls)
    with pytest.raises(GenerationCancelled):
        provider.synthesize(speech_request(provider), token)
    assert len(provider.engine.calls) == before


def test_cancel_during_native_inference_drops_late_result(provider):
    token = Generation("old")
    provider.engine.after_inference = token.cancel
    with pytest.raises(GenerationCancelled):
        provider.synthesize(speech_request(provider), token)


def test_stream_orders_tags_and_closes_at_cancel_boundary(provider):
    token = Generation("turn-2")
    source = provider.stream(speech_request(provider), token)
    first = next(source)
    assert (first.sequence, first.generation_id) == (0, "turn-2")
    token.cancel()
    with pytest.raises(GenerationCancelled):
        next(source)
    assert provider.engine.closed == 1


def test_stream_cancel_during_next_chunk_drops_chunk(provider):
    token = Generation("turn-2")
    provider.engine.after_inference = token.cancel
    with pytest.raises(GenerationCancelled):
        next(provider.stream(speech_request(provider), token))
    assert provider.engine.closed == 1


def test_stream_total_duration_limit(provider):
    provider.max_seconds = 0.15
    source = provider.stream(speech_request(provider), Generation("bounded"))
    next(source)
    with pytest.raises(PlatformError) as raised:
        next(source)
    assert raised.value.status == 413
    assert provider.engine.closed == 1


@pytest.mark.parametrize("cls", [EMAProvider, AntaliaMiniProvider])
@pytest.mark.parametrize(
    "settings",
    [
        {"normalization_enabled": False},
        {"normalization_owner": "gateway"},
        {"ambiguity_policy": "preserve"},
        {"ambiguity_policy": "reject"},
        {"context_hints": "account"},
    ],
)
def test_unsupported_normalization_rejected_at_startup(cls, settings):
    with pytest.raises(RuntimeError, match="supports only normalization"):
        cls("unused", **settings)


def test_readiness_requires_successful_warmup():
    engine = DeterministicSpeechEngine()
    engine.fail = True
    instance = EMAProvider("unused", engine=engine)
    with pytest.raises(RuntimeError, match="warmup failed"):
        instance.warmup()
    assert instance.health()["ready"] is False


@pytest.mark.parametrize("response_format", ["wav", "pcm", "mp3"])
def test_internal_speech_returns_real_encoded_audio(provider, monkeypatch, response_format):
    monkeypatch.setenv("VOXI_WORKER_API_KEY", "w" * 32)
    with TestClient(tts_app(provider)) as client:
        assert client.get("/readyz").status_code == 200
        assert client.post("/internal/speech", json={"input": "Merhaba"}).status_code == 401
        headers = {"Authorization": "Bearer " + "w" * 32}
        response = client.post(
            "/internal/speech",
            headers=headers,
            json=speech_request(provider, response_format=response_format).model_dump(),
        )
        assert response.status_code == 200
        assert response.headers["x-normalization-owner"] == provider.normalization_owner
        assert response.headers["x-engine"] == provider.model_id
        if response_format == "pcm":
            assert len(response.content) == 12000
            assert np.max(np.abs(np.frombuffer(response.content, dtype="<i2"))) > 1000
        else:
            assert decode_audio(response.content, max_bytes=100000, max_seconds=1).duration > 0.2
        models = client.get("/internal/models", headers=headers).json()["data"]
        # The default engine also answers to its OpenAI-compatible alias; the
        # second voice engine must not advertise an alias it cannot serve.
        expected = (
            ["tts-1", provider.model_id]
            if provider.model_id == "ema-lightning"
            else [provider.model_id]
        )
        assert [model["id"] for model in models] == expected


def test_internal_speech_stream_frames_pcm_and_rejects_non_pcm(provider, monkeypatch):
    monkeypatch.setenv("VOXI_WORKER_API_KEY", "w" * 32)
    with TestClient(tts_app(provider)) as client:
        headers = {"Authorization": "Bearer " + "w" * 32}
        assert client.post("/internal/speech/stream", json={"input": "Merhaba"}).status_code == 401
        wav = client.post(
            "/internal/speech/stream",
            headers=headers,
            json=speech_request(provider, response_format="wav").model_dump(),
        )
        assert wav.status_code == 400
        assert wav.json()["error"]["code"] == "unsupported_format"

        response = client.post(
            "/internal/speech/stream",
            headers=headers,
            json=speech_request(provider, response_format="pcm").model_dump(),
        )
        assert response.status_code == 200
        assert response.headers["x-engine"] == provider.model_id
        assert response.headers["x-audio-encoding"] == "pcm_s16le"
        assert response.headers["x-audio-channels"] == "1"
        assert response.headers["x-sample-rate"] == "24000"
        assert response.headers["x-normalization-owner"] == provider.normalization_owner
        assert len(response.headers["x-generation-id"]) >= 8
        # Deterministic engine emits three 100 ms chunks at 24 kHz PCM16.
        assert len(response.content) == 3 * 2400 * 2
        assert np.frombuffer(response.content, dtype="<i2").size == 3 * 2400

        wrong_model = client.post(
            "/internal/speech/stream",
            headers=headers,
            json=SpeechRequest(
                model="not-installed", voice=provider.voice, input="Merhaba", response_format="pcm"
            ).model_dump(),
        )
        assert wrong_model.status_code == 404
        assert wrong_model.json()["error"]["code"] == "model_not_found"

        wrong_voice = client.post(
            "/internal/speech/stream",
            headers=headers,
            json=SpeechRequest(
                model=provider.model_id, voice="far-field", input="Merhaba", response_format="pcm"
            ).model_dump(),
        )
        assert wrong_voice.status_code == 400
        assert wrong_voice.json()["error"]["code"] == "unsupported_voice"


def test_internal_speech_stream_releases_the_inference_slot(provider, monkeypatch):
    # Concurrency 1: a leaked slot from the first stream would 429 the second.
    monkeypatch.setenv("VOXI_WORKER_API_KEY", "w" * 32)
    monkeypatch.setenv("VOXI_INFERENCE_CONCURRENCY", "1")
    with TestClient(tts_app(provider)) as client:
        headers = {"Authorization": "Bearer " + "w" * 32}
        body = speech_request(provider, response_format="pcm").model_dump()
        for _ in range(2):
            response = client.post("/internal/speech/stream", headers=headers, json=body)
            assert response.status_code == 200
        assert client.get("/metrics").content.count(b"voxi_worker_inference_active 1") == 0


class DeterministicWhisperEngine:
    supported_languages = ["tr", "en"]

    def __init__(self):
        self.calls = []
        self.vad_warmed = False

    def transcribe(self, audio, **kwargs):
        assert audio.ndim == 1 and audio.dtype == np.float32
        self.calls.append(kwargs)
        words = (
            [
                SimpleNamespace(word=" 25", start=0.0, end=0.15),
                SimpleNamespace(word=" TL", start=0.15, end=0.25),
            ]
            if kwargs.get("word_timestamps")
            else None
        )
        segment = SimpleNamespace(id=0, start=0.0, end=0.25, text=" 25 TL", words=words)
        return iter([segment]), SimpleNamespace(language="tr")

    def warmup_vad(self, audio):
        self.vad_warmed = True


def test_internal_stt_rejects_malformed_and_oversize_uploads(monkeypatch):
    monkeypatch.setenv("VOXI_WORKER_API_KEY", "w" * 32)
    monkeypatch.setenv("VOXI_MAX_UPLOAD_BYTES", "10000")
    monkeypatch.setenv("VOXI_MAX_AUDIO_SECONDS", "1")
    instance = WhisperProvider("unused", engine=DeterministicWhisperEngine())
    with TestClient(stt_app(instance)) as client:
        headers = {"Authorization": "Bearer " + "w" * 32}
        assert client.get("/readyz").status_code == 200
        assert (
            client.post(
                "/internal/transcriptions", headers=headers, files={"file": ("x.wav", b"malformed")}
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/internal/transcriptions", headers=headers, files={"file": ("x.wav", b"x" * 10001)}
            ).status_code
            == 413
        )
        audio = encode_audio(Audio(np.zeros(4000, dtype=np.float32), 16000), "wav")
        response = client.post(
            "/internal/transcriptions",
            headers=headers,
            files={"file": ("misleading.txt", audio)},
            data={"language": "tr"},
        )
        assert response.status_code == 200 and response.json()["text"] == "25 TL"
        assert (
            client.post(
                "/internal/transcriptions",
                headers=headers,
                files={"file": ("x.wav", audio)},
                data={"language": "zz"},
            ).status_code
            == 400
        )
        assert (
            client.post(
                "/internal/transcriptions",
                headers=headers,
                files={"file": ("x.wav", audio)},
                data={"temperature": "2"},
            ).status_code
            == 422
        )


def test_whisper_word_timestamps_are_opt_in():
    instance = WhisperProvider("unused", engine=DeterministicWhisperEngine())
    instance.warmup()
    audio = Audio(np.zeros(16000, dtype=np.float32), 16000)
    plain = instance.transcribe(audio, TranscriptionRequest())
    assert "words" not in plain.segments[0]
    assert plain.duration == 1.0 and plain.language == "tr"
    worded = instance.transcribe(audio, TranscriptionRequest(word_timestamps=True))
    assert worded.segments[0]["words"][0] == {"word": " 25", "start": 0.0, "end": 0.15}
    assert instance.capabilities()["word_timestamps"] is True


def test_internal_stt_returns_words_only_when_requested(monkeypatch):
    monkeypatch.setenv("VOXI_WORKER_API_KEY", "w" * 32)
    instance = WhisperProvider("unused", engine=DeterministicWhisperEngine())
    with TestClient(stt_app(instance)) as client:
        headers = {"Authorization": "Bearer " + "w" * 32}
        audio = encode_audio(Audio(np.zeros(4000, dtype=np.float32), 16000), "wav")
        worded = client.post(
            "/internal/transcriptions",
            headers=headers,
            files={"file": ("x.wav", audio)},
            data={"language": "tr", "word_timestamps": "true"},
        )
        assert worded.status_code == 200
        assert worded.json()["duration"] == 0.25
        assert worded.json()["segments"][0]["words"][0]["word"] == " 25"
        plain = client.post(
            "/internal/transcriptions",
            headers=headers,
            files={"file": ("x.wav", audio)},
            data={"language": "tr"},
        )
        assert "words" not in plain.json()["segments"][0]
