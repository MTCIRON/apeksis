# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Authenticated file STT worker; no arbitrary model downloads or paths."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, UploadFile
from pydantic import ValidationError

from voxi import __version__
from voxi.audio import decode_audio, require_ffmpeg
from voxi.auth import worker_auth
from voxi.contracts import TranscriptionRequest, TranscriptionResult
from voxi.errors import PlatformError, install_error_handlers
from voxi.providers.whisper import WhisperProvider
from voxi.runtime import InferenceGate, install_body_limit
from voxi.workers.common import install_observability, positive_env, require_worker_key


def create_app(provider: WhisperProvider | None = None) -> FastAPI:
    max_bytes = positive_env("VOXI_MAX_UPLOAD_BYTES", 25 * 1024 * 1024)
    max_seconds = positive_env("VOXI_MAX_AUDIO_SECONDS", 600)

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        require_worker_key()
        require_ffmpeg()
        application.state.provider = provider or WhisperProvider(
            os.environ.get("WHISPER_MODEL_PATH", "/models/whisper-small"),
            model_id=os.environ.get("WHISPER_MODEL_ID", "whisper-small"),
            device=os.environ.get("STT_DEVICE", "cpu"),
            compute_type=os.environ.get("STT_COMPUTE_TYPE"),
            cpu_threads=positive_env("WHISPER_CPU_THREADS", 4),
        )
        application.state.gate = InferenceGate(positive_env("VOXI_INFERENCE_CONCURRENCY", 1))
        await asyncio.to_thread(application.state.provider.warmup)
        yield
        application.state.provider.ready = False

    application = FastAPI(title="Voxi internal STT worker", version=__version__, lifespan=lifespan)
    install_error_handlers(application)
    # Bounded multipart framing overhead, followed by exact file limit below.
    install_body_limit(application, max_bytes + 64 * 1024)
    install_observability(application)

    @application.get("/healthz")
    async def health():
        return {"status": "alive"}

    @application.get("/readyz")
    async def ready():
        current = getattr(application.state, "provider", None)
        if current is None or not current.ready:
            raise PlatformError(503, "Whisper has not completed warmup", "not_ready")
        return {"model": current.model_id, "ready": True}

    @application.get("/internal/models", dependencies=[Depends(worker_auth)])
    async def models():
        current = application.state.provider
        return {
            "data": [
                {
                    "id": name,
                    "object": "model",
                    "created": 0,
                    "owned_by": "local",
                    "capabilities": current.capabilities(),
                }
                for name in ("whisper-1", current.model_id)
            ]
        }

    @application.post(
        "/internal/transcriptions",
        dependencies=[Depends(worker_auth)],
        response_model=TranscriptionResult,
    )
    async def transcriptions(
        file: Annotated[UploadFile, File()],
        language: Annotated[str | None, Form()] = None,
        prompt: Annotated[str | None, Form()] = None,
        temperature: Annotated[float, Form()] = 0,
        word_timestamps: Annotated[bool, Form()] = False,
    ):
        try:
            options = TranscriptionRequest(
                language=language,
                prompt=prompt,
                temperature=temperature,
                word_timestamps=word_timestamps,
            )
        except ValidationError as exc:
            raise PlatformError(422, "Invalid transcription parameters", "invalid_request") from exc
        try:
            data = await file.read(max_bytes + 1)
        finally:
            await file.close()

        def recognize():
            audio = decode_audio(data, max_bytes=max_bytes, max_seconds=max_seconds)
            return application.state.provider.transcribe(audio, options)

        try:
            async with asyncio.timeout(positive_env("VOXI_INFERENCE_TIMEOUT_SECONDS", 120)):
                return await application.state.gate.run(recognize)
        except TimeoutError as exc:
            raise PlatformError(
                504, "Transcription exceeded inference timeout", "inference_timeout"
            ) from exc

    return application


app = create_app()
