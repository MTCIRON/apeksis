# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = "ema-lightning"
    input: str = Field(min_length=1, max_length=5000)
    voice: str = "ema-tr"
    response_format: Literal["wav", "pcm", "mp3"] = "mp3"
    speed: float = Field(default=1, ge=0.25, le=4)
    sample_rate: Literal[8000, 16000, 24000, 48000] = 24000
    seed: int | None = Field(default=None, ge=0)

    @field_validator("input")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("input must contain text")
        return value


class TranscriptionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    language: str | None = Field(default=None, pattern=r"^[a-z]{2,3}$")
    prompt: str | None = Field(default=None, max_length=2000)
    temperature: float = Field(default=0, ge=0, le=1)
    # F-SRV: opt-in per-word timings; default False keeps the historical path.
    word_timestamps: bool = False


class TranscriptionResult(BaseModel):
    text: str
    language: str | None = None
    segments: list[dict] = Field(default_factory=list)
    duration: float | None = None


class SocketTicketMintRequest(BaseModel):
    """Body for POST /v1/auth/socket (F5 security).

    Browser WebSocket clients cannot set an Authorization header, so they
    previously sent the bearer in the URL via `?token=`. That leaks the long-
    lived key into any component that records the request line (packet capture,
    extensions, third-party log pipelines). This endpoint short-circuits the
    exposure: the caller authenticates with the normal Bearer header, receives
    an opaque single-use ticket bound to the requested scope, and dials the
    socket with `?ticket=<value>`. The old `?token=` path is retained for
    backwards compatibility; nothing in this contract breaks existing clients.
    """

    model_config = ConfigDict(extra="forbid")
    scope: Literal["audio:write", "audio:read", "realtime:connect"]


class SocketTicketMintResponse(BaseModel):
    ticket: str = Field(min_length=16, max_length=128)
    # Seconds of remaining validity; the store reaps expired entries lazily.
    expires_in: int = Field(ge=1, le=300)


class TurnInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transcript: str = Field(min_length=1, max_length=10000)
    language: str = "tr-TR"
    context: dict = Field(default_factory=dict)

    @field_validator("transcript")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("transcript must contain text")
        return value


class TurnAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["1.0"]
    action: Literal["speak", "transfer", "hangup", "listen", "fallback"]
    text: str | None = Field(default=None, max_length=5000)
    language: str = "tr-TR"
    voice: str | None = None
    transfer_target: str | None = None
    metadata: dict = Field(default_factory=dict)
    idempotency_key: str = Field(min_length=1, max_length=200)


class StreamInboundEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["barge_in", "hangup", "ping", "turn"]
    transcript: str | None = Field(default=None, max_length=10000)
    language: str = "tr-TR"
    context: dict = Field(default_factory=dict)


class StreamOutboundEvent(BaseModel):
    """Server frames on the session stream (ADR 0005)."""

    model_config = ConfigDict(extra="forbid")
    type: Literal[
        "clear", "action", "state", "pong", "error", "transcript", "speech_started", "speech_ended"
    ]
    generation_id: int | None = None
    action: TurnAction | None = None
    state: str | None = None
    utterance_id: str | None = None
    text: str | None = None
    duration_ms: int | None = None
    rejected_ms: int | None = None
    truncated: bool | None = None
    code: str | None = None
    message: str | None = None


class TtsStreamRequest(BaseModel):
    """Opening frame of WS /v1/tts/stream (TTS-05, platform-specific protocol)."""

    model_config = ConfigDict(extra="forbid")
    type: Literal["speak"] = "speak"
    model: str = "ema-lightning"
    input: str = Field(min_length=1, max_length=5000)
    voice: str = "ema-tr"
    sample_rate: Literal[8000, 16000, 24000, 48000] = 16000
    speed: float = Field(default=1, ge=0.25, le=4)
    seed: int | None = Field(default=None, ge=0)
    generation_id: int = Field(default=0, ge=0, le=65535)
    chunk_ms: Literal[20, 40, 60, 100, 120, 200] = 100

    @field_validator("input")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("input must contain text")
        return value


class TtsStreamControl(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["cancel", "ping"]
    generation_id: int | None = Field(default=None, ge=0, le=65535)


class TtsStreamOutboundEvent(BaseModel):
    """Server frames on WS /v1/tts/stream; audio travels as framed binary."""

    model_config = ConfigDict(extra="forbid")
    type: Literal["meta", "done", "cancelled", "error", "pong"]
    generation_id: int | None = Field(default=None, ge=0, le=65535)
    sample_rate: int | None = None
    channels: int | None = None
    encoding: str | None = None
    chunk_ms: int | None = None
    chunks: int | None = None
    duration_ms: int | None = None
    code: str | None = None
    message: str | None = None


class RealtimeTranscriptionStart(BaseModel):
    """Opening frame of WS /v1/realtime/transcriptions (STT-07 custom protocol)."""

    model_config = ConfigDict(extra="forbid")
    type: Literal["session.start"] = "session.start"
    model: str = "whisper-1"
    language: str = Field(default="tr", pattern=r"^[a-z]{2,3}$")
    prompt: str | None = Field(default=None, max_length=2000)
    sample_rate: Literal[8000, 16000] = 16000
    start_ms: int = Field(default=100, ge=20, le=1000)
    end_ms: int = Field(default=700, ge=100, le=5000)
    min_speech_ms: int = Field(default=200, ge=20, le=2000)
    partial_interval_ms: int = Field(default=1200, ge=300, le=10000)
    max_utterance_ms: int = Field(default=30000, ge=1000, le=120000)


class RealtimeTranscriptionControl(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["flush", "session.stop", "ping"]


class TranscriptionOutboundEvent(BaseModel):
    """Server frames for WS /v1/realtime/transcriptions."""

    model_config = ConfigDict(extra="forbid")
    type: Literal[
        "session.started",
        "speech.started",
        "transcript.partial",
        "transcript.final",
        "speech.ended",
        "error",
        "session.ended",
        "pong",
    ]
    session_id: str | None = None
    utterance_id: str | None = None
    text: str | None = None
    revision: int | None = Field(default=None, ge=0)
    mode: str | None = None
    sample_rate: int | None = None
    started_ms: int | None = None
    ended_ms: int | None = None
    duration_ms: int | None = None
    rejected_ms: int | None = None
    truncated: bool | None = None
    vad: dict | None = None
    code: str | None = None
    message: str | None = None
