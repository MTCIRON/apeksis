# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Adapter for official ema-lightning==1.1.2, without external normalization."""

from __future__ import annotations

from collections.abc import Iterator
from importlib.metadata import version
from pathlib import Path
from typing import Any

from voxi.audio import validate_samples
from voxi.contracts import SpeechRequest
from voxi.providers.base import (
    Generation,
    SpeechChunk,
    SpeechOutput,
    TTSProvider,
    validate_normalization,
)
from voxi.providers.models import EMA_REVISION, configure_offline_hub


class EMAProvider(TTSProvider):
    model_id = "ema-lightning"
    voice = "ema-tr"
    normalization_owner = "ema_integrated"

    def __init__(
        self,
        model_path: str,
        device: str = "cpu",
        *,
        engine: Any = None,
        max_seconds: float = 600,
        normalization_enabled: bool = True,
        normalization_owner: str = "ema_integrated",
        ambiguity_policy: str = "fallback",
        context_hints: str | None = None,
    ):
        validate_normalization(
            normalization_owner,
            normalization_enabled,
            ambiguity_policy,
            context_hints,
            self.normalization_owner,
            "fallback",
        )
        if device not in ("cpu", "cuda"):
            raise ValueError("TTS_DEVICE must be cpu or cuda")
        self.model_path, self.device = Path(model_path), device
        self.engine, self.max_seconds = engine, max_seconds
        self.ready = False

    def load(self) -> None:
        if self.engine is not None:
            return
        configure_offline_hub(
            self.model_path, "canberkkkkkk/ema-lightning", self.model_id, EMA_REVISION
        )
        if version("ema-lightning") != "1.1.2" or version("normalizer-tr") != "0.7.0":
            raise RuntimeError("EMA worker requires ema-lightning==1.1.2 and normalizer-tr==0.7.0")
        from ema_lightning import EMA

        self.engine = EMA(device=self.device)

    def warmup(self) -> None:
        self.load()
        speech = self.engine.say("Merhaba.", speed=1.0, seed=0, sample_rate=24000)
        validate_samples(speech.audio, speech.sample_rate, self.max_seconds)
        self.ready = True

    def capabilities(self) -> dict[str, Any]:
        return {
            "tts": True,
            "provider_stream": True,
            "public_stream": False,
            "languages": ["tr"],
            "voices": [self.voice],
            "formats": ["wav", "pcm", "mp3"],
            "sample_rates": [8000, 16000, 24000, 48000],
            "speed": {"min": 0.25, "max": 4},
            "seed": True,
            "normalization": {
                "owner": self.normalization_owner,
                "policy": "fallback",
                "normalizer_version": "0.7.0",
                "context_hints": False,
                "complete": None,
                "issues_available": False,
            },
            "cancellation": "drop late results; native stream closes at chunk boundary",
        }

    def synthesize(self, request: SpeechRequest, generation: Generation) -> SpeechOutput:
        self.validate(request)
        generation.check()
        speech = self.engine.say(
            request.input, speed=request.speed, seed=request.seed, sample_rate=request.sample_rate
        )
        generation.check()
        audio = validate_samples(speech.audio, speech.sample_rate, self.max_seconds)
        words = getattr(speech, "words", ())
        spoken_text = " ".join(word.text for word in words) if words else None
        return SpeechOutput(
            audio,
            request.input,
            spoken_text,
            {
                "normalization_applied": True,
                "normalization_owner": self.normalization_owner,
                "normalization_complete": None,
                "normalization_issues": None,
                "fallback_used": None,
                "normalizer_version": "0.7.0",
            },
            generation.generation_id,
        )

    def stream(self, request: SpeechRequest, generation: Generation) -> Iterator[SpeechChunk]:
        self.validate(request)
        generation.check()
        source = iter(
            self.engine.stream(
                request.input,
                speed=request.speed,
                seed=request.seed,
                sample_rate=request.sample_rate,
            )
        )
        total = 0
        try:
            sequence = 0
            while True:
                generation.check()
                chunk = next(source, None)
                if chunk is None:
                    break
                generation.check()
                audio = validate_samples(chunk, request.sample_rate, self.max_seconds)
                total += len(audio.samples)
                if total > int(self.max_seconds * request.sample_rate):
                    from voxi.errors import PlatformError

                    raise PlatformError(
                        413, "Generated audio exceeds duration limit", "audio_too_long"
                    )
                yield SpeechChunk(audio, generation.generation_id, sequence)
                sequence += 1
        finally:
            close = getattr(source, "close", None)
            if close:
                close()
