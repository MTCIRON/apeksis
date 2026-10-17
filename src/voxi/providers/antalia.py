# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Official Antalia-2 Mini adapter; native normalization only, no inspection re-pass."""

from __future__ import annotations

import os
from collections.abc import Iterator
from importlib.metadata import version
from pathlib import Path
from typing import Any

from voxi.audio import validate_samples
from voxi.contracts import SpeechRequest
from voxi.errors import PlatformError
from voxi.providers.base import (
    Generation,
    SpeechChunk,
    SpeechOutput,
    TTSProvider,
    validate_normalization,
)
from voxi.providers.models import verify_manifest

ANTALIA_REVISION = "8a79528770af2ed5cb6d3b9ac1248d370429f272"


class AntaliaMiniProvider(TTSProvider):
    model_id = "antalia-mini"
    voice = "antalia-tr"
    normalization_owner = "native"

    def __init__(
        self,
        model_path: str,
        device: str = "cpu",
        *,
        engine: Any = None,
        max_seconds: float = 600,
        normalization_enabled: bool = True,
        normalization_owner: str = "native",
        ambiguity_policy: str = "native",
        context_hints: str | None = None,
    ):
        validate_normalization(
            normalization_owner,
            normalization_enabled,
            ambiguity_policy,
            context_hints,
            self.normalization_owner,
            "native",
        )
        if device not in ("cpu", "cuda"):
            raise ValueError("TTS_DEVICE must be cpu or cuda")
        self.model_path, self.device = Path(model_path), device
        self.engine, self.max_seconds = engine, max_seconds
        self.ready = False

    def load(self) -> None:
        if self.engine is not None:
            return
        verify_manifest(self.model_path, self.model_id, ANTALIA_REVISION)
        if version("antalia-mini") != "1.0.1":
            raise RuntimeError("Antalia worker requires antalia-mini==1.0.1")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        from antalia_mini import Antalia

        self.engine = Antalia(
            model=self.model_path, device=self.device, variant="fp32", warmup=False
        )

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
            "experimental": True,
            "languages": ["tr"],
            "voices": [self.voice],
            "formats": ["wav", "pcm", "mp3"],
            "sample_rates": [8000, 16000, 24000, 48000],
            "speed": {"min": 0.25, "max": 4},
            "seed": True,
            "steps_configurable": False,
            "cfg_configurable": False,
            "normalization": {
                "owner": "native",
                "policy": "native",
                "normalizer_version": "antalia-mini-1.0.1",
                "context_hints": False,
                "complete": None,
                "issues_available": False,
            },
            "cancellation": (
                "drop late results; stream closes at chunk boundary, no mid-kernel abort"
            ),
        }

    def synthesize(self, request: SpeechRequest, generation: Generation) -> SpeechOutput:
        self.validate(request)
        generation.check()
        speech = self.engine.say(
            request.input, speed=request.speed, seed=request.seed, sample_rate=request.sample_rate
        )
        generation.check()
        audio = validate_samples(speech.audio, speech.sample_rate, self.max_seconds)
        # Calling normalize() to inspect say() output would perform a second pass.
        return SpeechOutput(
            audio,
            request.input,
            None,
            {
                "normalization_applied": True,
                "normalization_owner": "native",
                "normalization_complete": None,
                "normalization_issues": None,
                "fallback_used": None,
                "normalizer_version": "antalia-mini-1.0.1",
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
                    raise PlatformError(
                        413, "Generated audio exceeds duration limit", "audio_too_long"
                    )
                yield SpeechChunk(audio, generation.generation_id, sequence)
                sequence += 1
        finally:
            close = getattr(source, "close", None)
            if close:
                close()
