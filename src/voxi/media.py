# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Bounded generation-aware media transport, playout buffer and energy endpointing."""

from __future__ import annotations

import asyncio
import io
import logging
import struct
import uuid
import wave
from collections import deque
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np

logger = logging.getLogger("voxi.media")

HEADER_STRUCT = struct.Struct(">HH")  # 4-byte header: uint16 generation_id, uint16 sequence

VadEventName = Literal["speech_started", "speech_ended", "speech_too_long"]


def pcm_to_wav(pcm_bytes: bytes, sample_rate: int) -> bytes:
    """Wrap raw PCM16 little-endian mono into a decodable WAV container."""
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm_bytes)
    return buffer.getvalue()


def pack_audio_frame(generation_id: int, sequence: int, pcm_bytes: bytes) -> bytes:
    """Pack an audio frame with a big-endian generation and sequence header."""
    return HEADER_STRUCT.pack(generation_id % 65536, sequence % 65536) + pcm_bytes


def unpack_audio_frame(data: bytes) -> tuple[int, int, bytes]:
    """Unpack an audio frame header and return (generation_id, sequence, pcm_bytes)."""
    if len(data) < HEADER_STRUCT.size:
        raise ValueError(f"Frame length {len(data)} is shorter than header {HEADER_STRUCT.size}")
    gen_id, seq = HEADER_STRUCT.unpack_from(data, 0)
    return gen_id, seq, data[HEADER_STRUCT.size :]


@dataclass
class PlayoutStats:
    emitted_chunks: int = 0
    dropped_stale_chunks: int = 0
    barge_in_count: int = 0


class PlayoutBuffer:
    """Maintains generation-aware output queue (audio frames and control events).

    A single ordered queue keeps `clear`/`state` events in the correct position
    relative to audio, so a barge-in flush can never be overtaken by late audio.
    """

    def __init__(self, max_chunks: int = 200):
        self.max_chunks = max_chunks
        self.current_generation: int = 0
        self._queue: asyncio.Queue[bytes | dict | None] = asyncio.Queue(maxsize=max_chunks)
        self.active_task: asyncio.Task[Any] | None = None
        self.stats = PlayoutStats()
        self._closed = False

    def new_generation(self, generation_id: int) -> int:
        """Advance generation, cancel ongoing generation task, and purge stale output queue."""
        self.current_generation = generation_id
        if self.active_task and not self.active_task.done():
            self.active_task.cancel()
            self.active_task = None
        self._drain_queue()
        return self.current_generation

    def barge_in(self) -> int:
        """Immediately interrupt playout on barge-in signal."""
        self.stats.barge_in_count += 1
        return self.new_generation(self.current_generation + 1)

    def _drain_queue(self) -> None:
        """Purge buffered audio; keep pending control events in order."""
        kept: list[dict] = []
        while not self._queue.empty():
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if isinstance(item, dict):
                kept.append(item)
        for event in kept:
            try:
                self._queue.put_nowait(event)
            except asyncio.QueueFull:
                break

    def push_event(self, event: dict) -> bool:
        """Queue a text control event in audio order. Never queues after close."""
        if self._closed:
            return False
        try:
            self._queue.put_nowait(event)
            return True
        except asyncio.QueueFull:
            logger.warning("Playout queue full; dropped control event type=%s", event.get("type"))
            return False

    def push_chunk(self, generation_id: int, sequence: int, pcm_bytes: bytes) -> bool:
        """Enqueues audio frame if matching current generation; drops stale chunks."""
        if self._closed or generation_id != self.current_generation:
            self.stats.dropped_stale_chunks += 1
            return False
        frame = pack_audio_frame(generation_id, sequence, pcm_bytes)
        try:
            self._queue.put_nowait(frame)
            self.stats.emitted_chunks += 1
            return True
        except asyncio.QueueFull:
            self.stats.dropped_stale_chunks += 1
            logger.warning("Playout queue full; dropped audio chunk sequence=%s", sequence)
            return False

    async def get_next(self, timeout: float | None = None) -> bytes | dict | None:
        """Retrieve the next packed audio frame, event dict, or None when closed."""
        if self._closed and self._queue.empty():
            return None
        try:
            if timeout is not None:
                async with asyncio.timeout(timeout):
                    return await self._queue.get()
            return await self._queue.get()
        except (TimeoutError, asyncio.CancelledError):
            return None

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def queued_chunks(self) -> int:
        return self._queue.qsize()

    def close(self) -> None:
        """Close playout buffer and cancel active work."""
        self._closed = True
        if self.active_task and not self.active_task.done():
            self.active_task.cancel()
            self.active_task = None
        self._drain_queue()
        try:
            self._queue.put_nowait(None)
        except asyncio.QueueFull:
            pass


class InboundAudioBuffer:
    """Bounded ring buffer for inbound PCM audio chunks (caller speech)."""

    def __init__(self, max_bytes: int = 320000):  # ~10s of 16kHz 16-bit mono
        self.max_bytes = max_bytes
        self._chunks: deque[bytes] = deque()
        self._total_bytes: int = 0
        self.dropped_bytes: int = 0

    def append(self, pcm_data: bytes) -> None:
        if not pcm_data:
            return
        self._chunks.append(pcm_data)
        self._total_bytes += len(pcm_data)
        while self._total_bytes > self.max_bytes and self._chunks:
            dropped = self._chunks.popleft()
            self._total_bytes -= len(dropped)
            self.dropped_bytes += len(dropped)

    def read_all(self) -> bytes:
        return b"".join(self._chunks)

    def clear(self) -> None:
        self._chunks.clear()
        self._total_bytes = 0
        self.dropped_bytes = 0

    @property
    def total_bytes(self) -> int:
        return self._total_bytes


@dataclass(frozen=True)
class Utterance:
    """One caller utterance, ready for bounded windowed transcription."""

    utterance_id: str
    pcm: bytes
    sample_rate: int
    started_ms: int
    ended_ms: int
    speech_ms: int
    utterance_duration_ms: int = 0
    truncated: bool = False

    @property
    def duration_ms(self) -> int:
        return len(self.pcm) * 1000 // (self.sample_rate * 2)


@dataclass(frozen=True)
class VadEvent:
    name: VadEventName
    utterance: Utterance | None = None
    utterance_id: str | None = None
    position_ms: int = 0
    started_ms: int = 0
    rejected_ms: int = 0


class SpeechEndpointer:
    """Deterministic energy VAD with hysteresis, preroll and hard duration bounds.

    Deliberately model-free: the gateway must stay installable without extra
    inference dependencies, and telephony noise profiles require operator
    tuning. A short burst below `min_speech_ms` is suppressed as a false start
    (RT-02) and reported with `rejected_ms` instead of an utterance.
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        *,
        window_ms: int = 20,
        start_ms: int = 100,
        end_ms: int = 700,
        min_speech_ms: int = 200,
        preroll_ms: int = 160,
        open_rms: float = 350.0,
        close_rms: float = 200.0,
        max_utterance_ms: int = 30000,
    ):
        if min(sample_rate, window_ms, start_ms, end_ms, min_speech_ms) <= 0:
            raise ValueError("VAD timing and sample rate must be positive")
        if close_rms > open_rms:
            raise ValueError("close_rms must not exceed open_rms")
        if max_utterance_ms < end_ms + min_speech_ms:
            raise ValueError("max_utterance_ms must exceed endpoint timing")
        self.sample_rate = sample_rate
        self.window_ms = window_ms
        self.start_ms = start_ms
        self.end_ms = end_ms
        self.min_speech_ms = min_speech_ms
        self.open_rms = open_rms
        self.close_rms = close_rms
        self.max_utterance_ms = max_utterance_ms
        self.window_samples = max(1, sample_rate * window_ms // 1000)
        self._preroll_limit = max(1, preroll_ms // window_ms)
        self._pending = bytearray()
        self._preroll: deque[bytes] = deque(maxlen=self._preroll_limit)
        self._current: list[bytes] = []
        self._current_samples = 0
        self.position_ms = 0
        self.speech_ms = 0
        self.loud_ms = 0
        self.silence_ms = 0
        self.in_speech = False
        self._started_ms = 0
        self._utterance_id = ""
        self.active_utterance_id: str | None = None

    def feed(self, pcm_bytes: bytes) -> list[VadEvent]:
        """Consume PCM16 little-endian mono and return endpointing events."""
        events: list[VadEvent] = []
        if not pcm_bytes:
            return events
        self._pending.extend(pcm_bytes)
        frame_bytes = self.window_samples * 2
        while len(self._pending) >= frame_bytes:
            window = bytes(self._pending[:frame_bytes])
            del self._pending[:frame_bytes]
            self._process(window, events)
        return events

    def flush(self) -> list[VadEvent]:
        """Force-end an active utterance (hangup or transport close)."""
        events: list[VadEvent] = []
        self._pending.clear()
        if self.in_speech:
            self._finalize(events, truncated=False)
        else:
            self._preroll.clear()
        return events

    def active_pcm(self) -> bytes:
        """Audio captured so far in the active utterance; empty when no speech."""
        return b"".join(self._current) if self.in_speech else b""

    def reset(self) -> None:
        """Drop all pending audio and endpointing state without emitting events."""
        self._pending.clear()
        self._preroll.clear()
        self._current.clear()
        self._current_samples = 0
        self.in_speech = False
        self.active_utterance_id = None
        self.speech_ms = 0
        self.loud_ms = 0
        self.silence_ms = 0

    def _rms(self, window: bytes) -> float:
        samples = np.frombuffer(window, dtype="<i2").astype(np.float32)
        return float(np.sqrt(np.mean(np.square(samples))))

    def _process(self, window: bytes, events: list[VadEvent]) -> None:
        rms = self._rms(window)
        self.position_ms += self.window_ms
        if not self.in_speech:
            self._preroll.append(window)
            loud = rms >= self.open_rms
            self.speech_ms = self.speech_ms + self.window_ms if loud else 0
            if self.speech_ms >= self.start_ms:
                self._begin()
                events.append(
                    VadEvent(
                        "speech_started",
                        utterance_id=self.active_utterance_id,
                        position_ms=self.position_ms,
                        started_ms=self._started_ms,
                    )
                )
            return

        loud = rms >= self.close_rms
        self._current.append(window)
        self._current_samples += self.window_samples
        self.speech_ms += self.window_ms
        self.loud_ms = self.loud_ms + self.window_ms if loud else self.loud_ms
        self.silence_ms = 0 if loud else self.silence_ms + self.window_ms
        if self.silence_ms >= self.end_ms:
            self._finalize(events, truncated=False)
        elif self.speech_ms >= self.max_utterance_ms:
            events.append(
                VadEvent(
                    "speech_too_long",
                    utterance_id=self.active_utterance_id,
                    position_ms=self.position_ms,
                )
            )
            self._finalize(events, truncated=True)

    def _begin(self) -> None:
        self.in_speech = True
        self._utterance_id = uuid.uuid4().hex
        self.active_utterance_id = self._utterance_id
        self._current = list(self._preroll)
        self._current_samples = sum(len(row) // 2 for row in self._current)
        self._started_ms = max(
            0, self.position_ms - self._current_samples * 1000 // self.sample_rate
        )
        self.loud_ms = self.speech_ms
        self._preroll.clear()
        self.silence_ms = 0

    def _finalize(self, events: list[VadEvent], *, truncated: bool) -> None:
        # Trailing silence is kept for natural word boundaries; leading preroll too.
        pcm = b"".join(self._current)
        speech_ms = self.speech_ms
        loud_ms = self.loud_ms
        utterance_id = self._utterance_id
        started_ms, ended_ms = self._started_ms, self.position_ms
        self.in_speech = False
        self.active_utterance_id = None
        self._current = []
        self._current_samples = 0
        self.speech_ms = 0
        self.loud_ms = 0
        self.silence_ms = 0
        if loud_ms < self.min_speech_ms and not truncated:
            events.append(
                VadEvent(
                    "speech_ended",
                    utterance_id=utterance_id,
                    position_ms=ended_ms,
                    started_ms=started_ms,
                    rejected_ms=loud_ms,
                )
            )
            return
        events.append(
            VadEvent(
                "speech_ended",
                utterance=Utterance(
                    utterance_id=utterance_id or uuid.uuid4().hex,
                    pcm=pcm,
                    sample_rate=self.sample_rate,
                    started_ms=started_ms,
                    ended_ms=ended_ms,
                    speech_ms=loud_ms,
                    utterance_duration_ms=speech_ms,
                    truncated=truncated,
                ),
                utterance_id=utterance_id,
                position_ms=ended_ms,
                started_ms=started_ms,
            )
        )
