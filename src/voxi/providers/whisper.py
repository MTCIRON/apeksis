# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Pinned Faster-Whisper file inference; transcripts are never speech-normalized."""

from __future__ import annotations

import os
from importlib.metadata import version
from pathlib import Path
from typing import Any

import numpy as np

from voxi.audio import Audio
from voxi.contracts import TranscriptionRequest, TranscriptionResult
from voxi.errors import PlatformError
from voxi.providers.models import verify_manifest

WHISPER_MODELS = {
    "whisper-small": "536b0662742c02347bc0e980a01041f333bce120",
    "whisper-large-v3-turbo": "4df90f75321148c3a29a9e2351b7ddf8f5b115a8",
}


class WhisperProvider:
    def __init__(
        self,
        model_path: str,
        model_id: str = "whisper-small",
        device: str = "cpu",
        *,
        compute_type: str | None = None,
        cpu_threads: int = 4,
        engine: Any = None,
    ):
        if model_id not in WHISPER_MODELS:
            raise ValueError("WHISPER_MODEL_ID must be whisper-small or whisper-large-v3-turbo")
        if device not in ("cpu", "cuda") or cpu_threads < 1:
            raise ValueError("Invalid Whisper device/thread settings")
        self.model_path, self.model_id, self.device = Path(model_path), model_id, device
        self.compute_type = compute_type or ("int8" if device == "cpu" else "float16")
        self.cpu_threads, self.engine, self.ready = cpu_threads, engine, False

    def load(self) -> None:
        if self.engine is not None:
            return
        verify_manifest(self.model_path, self.model_id, WHISPER_MODELS[self.model_id])
        for asset in ("model.bin", "config.json", "tokenizer.json"):
            if not (self.model_path / asset).is_file():
                raise RuntimeError(f"Missing offline Whisper asset: {asset}")
        if version("faster-whisper") != "1.2.1":
            raise RuntimeError("STT worker requires faster-whisper==1.2.1")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        from faster_whisper import WhisperModel

        self.engine = WhisperModel(
            str(self.model_path),
            device=self.device,
            compute_type=self.compute_type,
            cpu_threads=self.cpu_threads,
            num_workers=1,
            local_files_only=True,
        )

    def warmup(self) -> None:
        self.load()
        # VAD-disabled warmup forces encoder/decoder execution even for silence.
        silence = np.zeros(16000, dtype=np.float32)
        segments, _ = self.engine.transcribe(
            silence, language="tr", temperature=0.0, vad_filter=False
        )
        list(segments)
        if getattr(self.engine, "warmup_vad", None):
            self.engine.warmup_vad(silence)
        else:
            from faster_whisper.vad import get_speech_timestamps

            get_speech_timestamps(silence)
        self.ready = True

    def transcribe(self, audio: Audio, request: TranscriptionRequest) -> TranscriptionResult:
        if not self.ready:
            raise PlatformError(503, "Whisper has not completed warmup", "provider_not_ready")
        if audio.sample_rate != 16000:
            raise ValueError("Whisper requires trusted 16 kHz mono decode")
        if request.language and request.language not in self.engine.supported_languages:
            raise PlatformError(
                400, "Unsupported transcription language", "unsupported_language", "language"
            )
        segments, info = self.engine.transcribe(
            audio.samples,
            language=request.language,
            initial_prompt=request.prompt,
            temperature=request.temperature,
            task="transcribe",
            vad_filter=True,
            word_timestamps=request.word_timestamps,
        )
        values = []
        for segment in segments:
            entry: dict[str, Any] = {
                "id": segment.id,
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
            }
            if request.word_timestamps:
                entry["words"] = [
                    {"word": word.word, "start": word.start, "end": word.end}
                    for word in (segment.words or ())
                ]
            values.append(entry)
        return TranscriptionResult(
            text="".join(segment["text"] for segment in values).strip(),
            language=info.language,
            segments=values,
            duration=audio.samples.size / audio.sample_rate,
        )

    def capabilities(self) -> dict[str, Any]:
        return {
            "stt": True,
            "file_transcription": True,
            # OpenAI Realtime protocol is never emulated; realtime transcription is
            # available only through the Voxi windowed WS transport (ADR 0005).
            "realtime": False,
            "realtime_windowed": True,
            "vad": True,
            "word_timestamps": True,
            "segment_timestamps": True,
            "timestamp_granularities": ["word", "segment"],
            "response_formats": ["json", "text", "verbose_json", "srt", "vtt"],
            "languages": list(self.engine.supported_languages),
            "engine": "faster-whisper",
            "sample_rate": 16000,
            "normalization": False,
        }
