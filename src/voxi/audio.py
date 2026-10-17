# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Bounded, shell-free FFmpeg decoding and honest mono PCM/WAV/MP3 codecs."""

from __future__ import annotations

import io
import shutil
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from voxi.errors import PlatformError

MIME_TYPES = {"wav": "audio/wav", "pcm": "audio/pcm", "mp3": "audio/mpeg"}
RATES = (8000, 16000, 24000, 48000)


@dataclass(frozen=True)
class Audio:
    samples: np.ndarray
    sample_rate: int

    @property
    def duration(self) -> float:
        return len(self.samples) / self.sample_rate


def require_ffmpeg() -> str:
    executable = shutil.which("ffmpeg")
    if not executable:
        raise RuntimeError("FFmpeg is required for speech codecs and trusted input decoding")
    return executable


def _ffmpeg(arguments: list[str], data: bytes, *, timeout: float = 60) -> bytes:
    try:
        result = subprocess.run(
            [require_ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", *arguments],
            input=data,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise PlatformError(
            422, "Audio processing exceeded its time limit", "audio_timeout", "file"
        ) from exc
    if result.returncode:
        # Decoder diagnostics may contain supplied media metadata; never echo them.
        raise PlatformError(422, "Audio cannot be decoded or encoded", "invalid_audio", "file")
    return result.stdout


def validate_samples(samples: np.ndarray, sample_rate: int, max_seconds: float) -> Audio:
    values = np.asarray(samples, dtype=np.float32)
    if values.ndim != 1 or not len(values) or not np.isfinite(values).all():
        raise PlatformError(422, "Audio must contain finite mono samples", "invalid_audio", "file")
    if sample_rate not in RATES:
        raise PlatformError(422, "Unsupported audio sample rate", "invalid_sample_rate")
    if len(values) > int(max_seconds * sample_rate):
        raise PlatformError(
            413, "Audio duration exceeds configured limit", "audio_too_long", "file"
        )
    return Audio(values, sample_rate)


def decode_audio(
    data: bytes, *, max_bytes: int, max_seconds: float, sample_rate: int = 16000
) -> Audio:
    """Decode bounded, seekable input; restrict demuxers and external references."""
    if not data:
        raise PlatformError(422, "Empty audio upload", "invalid_audio", "file")
    if len(data) > max_bytes:
        raise PlatformError(
            413, "Audio upload exceeds configured limit", "upload_too_large", "file"
        )
    if sample_rate not in RATES or max_seconds <= 0:
        raise ValueError("Invalid decoder limits")
    # A seekable file also handles recorded MP4/M4A with metadata after media.
    # Accept only self-contained audio containers, never playlist demuxers.
    # MOV external-track and absolute-alias access remain at audited default false.
    with tempfile.TemporaryDirectory(prefix="voxi-audio-") as directory:
        source = Path(directory) / "upload"
        source.write_bytes(data)
        # One extra sample identifies overlong audio without decoding its remainder.
        decoded = _ffmpeg(
            [
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                "wav,mp3,mov,flac,ogg",
                "-i",
                str(source),
                "-map",
                "0:a:0",
                "-vn",
                "-sn",
                "-dn",
                "-t",
                str(max_seconds + 1 / sample_rate),
                "-ac",
                "1",
                "-ar",
                str(sample_rate),
                "-f",
                "f32le",
                "pipe:1",
            ],
            b"",
        )
    if len(decoded) % 4:
        raise PlatformError(422, "Malformed decoded audio", "invalid_audio", "file")
    return validate_samples(np.frombuffer(decoded, dtype="<f4"), sample_rate, max_seconds)


def encode_audio(audio: Audio, response_format: str, sample_rate: int | None = None) -> bytes:
    rate = sample_rate or audio.sample_rate
    if response_format not in MIME_TYPES or rate not in RATES:
        raise PlatformError(
            400, "Supported audio formats: wav, pcm, mp3", "unsupported_format", "response_format"
        )
    if audio.samples.ndim != 1 or not np.isfinite(audio.samples).all() or not len(audio.samples):
        raise PlatformError(422, "Engine returned invalid audio", "invalid_audio")
    samples = np.clip(audio.samples, -1.0, 1.0)
    if response_format == "mp3":
        return _ffmpeg(
            [
                "-f",
                "f32le",
                "-ar",
                str(audio.sample_rate),
                "-ac",
                "1",
                "-i",
                "pipe:0",
                "-ar",
                str(rate),
                "-ac",
                "1",
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "64k",
                "-f",
                "mp3",
                "pipe:1",
            ],
            samples.astype("<f4", copy=False).tobytes(),
        )
    if rate == audio.sample_rate:
        pcm = np.rint(samples * 32767).astype("<i2").tobytes()
    else:
        pcm = _ffmpeg(
            [
                "-f",
                "f32le",
                "-ar",
                str(audio.sample_rate),
                "-ac",
                "1",
                "-i",
                "pipe:0",
                "-ar",
                str(rate),
                "-ac",
                "1",
                "-codec:a",
                "pcm_s16le",
                "-f",
                "s16le",
                "pipe:1",
            ],
            samples.astype("<f4", copy=False).tobytes(),
        )
    if response_format == "pcm":
        return pcm
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(pcm)
    return buffer.getvalue()
