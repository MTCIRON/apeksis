# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Isolated EMA default / optional Antalia worker. No native route emulation."""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TypedDict

from fastapi import Depends, FastAPI, Request
from fastapi.responses import Response, StreamingResponse

from voxi import __version__
from voxi.audio import MIME_TYPES, encode_audio, require_ffmpeg
from voxi.auth import worker_auth
from voxi.contracts import SpeechRequest
from voxi.errors import PlatformError, install_error_handlers
from voxi.providers.base import Generation, GenerationCancelled, TTSProvider
from voxi.runtime import InferenceGate, install_body_limit
from voxi.workers.common import install_observability, positive_env, require_worker_key

logger = logging.getLogger("voxi.workers.tts")


class ProviderSettings(TypedDict):
    device: str
    max_seconds: int
    normalization_enabled: bool
    ambiguity_policy: str
    context_hints: str | None


def configured_provider() -> TTSProvider:
    selected = os.environ.get("VOXI_TTS_PROVIDER", "ema-lightning")
    common: ProviderSettings = {
        "device": os.environ.get("TTS_DEVICE", "cpu"),
        "max_seconds": positive_env("VOXI_MAX_AUDIO_SECONDS", 600),
        "normalization_enabled": os.environ.get("TTS_NORMALIZATION_ENABLED", "true").lower()
        == "true",
        "ambiguity_policy": os.environ.get(
            "TTS_NORMALIZATION_AMBIGUITY_POLICY",
            "native" if selected == "antalia-mini" else "fallback",
        ),
        "context_hints": os.environ.get("TTS_NORMALIZATION_CONTEXT_HINTS"),
    }
    if selected == "ema-lightning":
        from voxi.providers.ema import EMAProvider

        return EMAProvider(
            os.environ.get("EMA_MODEL_PATH", "/models/ema-lightning"),
            normalization_owner=os.environ.get("TTS_NORMALIZATION_OWNER", "ema_integrated"),
            **common,
        )
    if selected == "antalia-mini":
        from voxi.providers.antalia import AntaliaMiniProvider

        return AntaliaMiniProvider(
            os.environ.get("ANTALIA_MODEL_PATH", "/models/antalia-mini"),
            normalization_owner=os.environ.get("TTS_NORMALIZATION_OWNER", "native"),
            **common,
        )
    raise RuntimeError("VOXI_TTS_PROVIDER must be ema-lightning or antalia-mini")


def create_app(provider: TTSProvider | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        require_worker_key()
        require_ffmpeg()
        application.state.provider = provider or configured_provider()
        application.state.gate = InferenceGate(positive_env("VOXI_INFERENCE_CONCURRENCY", 1))
        await asyncio.to_thread(application.state.provider.warmup)
        yield
        application.state.provider.ready = False

    application = FastAPI(title="Voxi internal TTS worker", version=__version__, lifespan=lifespan)
    install_error_handlers(application)
    install_body_limit(application, 64 * 1024)
    install_observability(application)

    @application.get("/healthz")
    async def health():
        return {"status": "alive"}

    @application.get("/readyz")
    async def ready():
        current = getattr(application.state, "provider", None)
        if current is None or not current.ready:
            raise PlatformError(503, "Speech provider has not completed warmup", "not_ready")
        return current.health()

    @application.get("/internal/models", dependencies=[Depends(worker_auth)])
    async def models():
        current = application.state.provider
        names: tuple[str, ...] = (current.model_id,)
        if current.model_id == "ema-lightning":
            # The gateway's OpenAI-compatible alias for the default engine; only
            # the worker that actually serves it advertises it.
            names = ("tts-1", current.model_id)
        return {
            "data": [
                {
                    "id": name,
                    "object": "model",
                    "created": 0,
                    "owned_by": "local",
                    "capabilities": current.capabilities(),
                }
                for name in names
            ]
        }

    @application.post("/internal/speech", dependencies=[Depends(worker_auth)])
    async def speech(body: SpeechRequest, request: Request):
        current = application.state.provider
        generation = Generation(uuid.uuid4().hex)

        def render():
            output = current.synthesize(body, generation)
            encoded = encode_audio(output.audio, body.response_format, body.sample_rate)
            generation.check()
            return encoded, output.normalization

        try:
            async with asyncio.timeout(positive_env("VOXI_INFERENCE_TIMEOUT_SECONDS", 120)):
                encoded, normalization = await application.state.gate.run(render)
            if await request.is_disconnected():
                generation.cancel()
                raise PlatformError(499, "Client disconnected", "request_cancelled")
            return Response(
                encoded,
                media_type=MIME_TYPES[body.response_format],
                headers={
                    "X-Engine": current.model_id,
                    "X-Normalization-Owner": current.normalization_owner,
                    "X-Normalizer-Version": normalization["normalizer_version"],
                    "X-Normalization-Complete": "unknown",
                    "X-Sample-Rate": str(body.sample_rate),
                    "X-Audio-Channels": "1",
                    "X-Generation-ID": generation.generation_id,
                },
            )
        except TimeoutError as exc:
            raise PlatformError(
                504, "Speech exceeded inference timeout", "inference_timeout"
            ) from exc
        finally:
            generation.cancel()

    @application.post("/internal/speech/stream", dependencies=[Depends(worker_auth)])
    async def speech_stream(body: SpeechRequest, request: Request):
        """Chunked PCM16 mono output; first frame leaves as soon as the engine emits it."""
        if body.response_format != "pcm":
            raise PlatformError(
                400,
                "Streaming speech supports response_format=pcm only",
                "unsupported_format",
                "response_format",
            )
        current = application.state.provider
        current.validate(body)
        gate = application.state.gate
        # Reserve before the response starts so saturation is a real 429, not a cut-off stream.
        gate.acquire()
        released = False

        def release_once() -> None:
            nonlocal released
            if not released:
                released = True
                gate.release()

        generation = Generation(uuid.uuid4().hex)
        source = current.stream(body, generation)

        def pull():
            try:
                return next(source, None)
            except (GenerationCancelled, PlatformError) as failure:
                return failure

        async def pump() -> AsyncIterator[bytes]:
            try:
                async with asyncio.timeout(positive_env("VOXI_INFERENCE_TIMEOUT_SECONDS", 120)):
                    while True:
                        if await request.is_disconnected():
                            generation.cancel()
                            return
                        chunk = await asyncio.to_thread(pull)
                        if isinstance(chunk, GenerationCancelled):
                            return
                        if isinstance(chunk, PlatformError):
                            raise chunk
                        if chunk is None:
                            return
                        yield encode_audio(chunk.audio, "pcm", body.sample_rate)
            except TimeoutError:
                logger.warning("Streaming speech exceeded inference timeout")
            except GenerationCancelled:
                return
            finally:
                release_once()
                generation.cancel()
                close = getattr(source, "close", None)
                if close:
                    try:
                        close()
                    except ValueError:
                        # A prior next(source) may still be running in its to_thread
                        # worker (asyncio cannot preempt the thread on cancel). The
                        # generator is then "already executing" and cannot be closed
                        # explicitly; generation.cancel() above already signalled it
                        # to stop, so skipping the close is correct, not a leak.
                        logger.debug("Stream generator still executing; close() skipped")

        return StreamingResponse(
            pump(),
            media_type=MIME_TYPES["pcm"],
            headers={
                "X-Engine": current.model_id,
                "X-Sample-Rate": str(body.sample_rate),
                "X-Audio-Channels": "1",
                "X-Audio-Encoding": "pcm_s16le",
                "X-Normalization-Owner": current.normalization_owner,
                "X-Generation-ID": generation.generation_id,
            },
        )

    return application


app = create_app()
