# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Synchronous provider boundary; callers run inference behind the shared gate."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field
from threading import Event
from typing import Any

from voxi.audio import Audio
from voxi.contracts import SpeechRequest
from voxi.errors import PlatformError


class GenerationCancelled(Exception):
    """A cancelled generation must never return or emit late audio."""


@dataclass(frozen=True)
class Generation:
    generation_id: str
    cancelled: Event = field(default_factory=Event, compare=False)

    def cancel(self) -> None:
        self.cancelled.set()

    def check(self) -> None:
        if self.cancelled.is_set():
            raise GenerationCancelled(self.generation_id)


@dataclass(frozen=True)
class SpeechOutput:
    audio: Audio
    canonical_text: str
    spoken_text: str | None
    normalization: dict[str, Any]
    generation_id: str


@dataclass(frozen=True)
class SpeechChunk:
    audio: Audio
    generation_id: str
    sequence: int


class TTSProvider(ABC):
    ready = False
    model_id: str
    voice: str
    normalization_owner: str

    @abstractmethod
    def load(self) -> None: ...

    @abstractmethod
    def synthesize(self, request: SpeechRequest, generation: Generation) -> SpeechOutput: ...

    @abstractmethod
    def stream(self, request: SpeechRequest, generation: Generation) -> Iterator[SpeechChunk]: ...

    @abstractmethod
    def capabilities(self) -> dict[str, Any]: ...

    @abstractmethod
    def warmup(self) -> None: ...

    def health(self) -> dict[str, Any]:
        return {
            "model": self.model_id,
            "ready": self.ready,
            "normalization_owner": self.normalization_owner,
        }

    def validate(self, request: SpeechRequest) -> None:
        if not self.ready:
            raise PlatformError(503, "Speech provider is not warmed up", "provider_not_ready")
        if request.model != self.model_id:
            raise PlatformError(
                404, "Model is not loaded in this worker", "model_not_found", "model"
            )
        if request.voice != self.voice:
            raise PlatformError(400, f"Supported voice: {self.voice}", "unsupported_voice", "voice")
        if not request.input.strip():
            raise PlatformError(400, "Speech input must contain text", "invalid_input", "input")


def validate_normalization(
    owner: str,
    enabled: bool,
    policy: str,
    hints: str | None,
    expected_owner: str,
    expected_policy: str,
) -> None:
    if owner != expected_owner or not enabled or policy != expected_policy or hints:
        raise RuntimeError(
            f"Pinned provider supports only normalization enabled=true, owner={expected_owner}, "
            f"ambiguity_policy={expected_policy}, no context hints; "
            "gateway/disabled normalization is unsupported"
        )
