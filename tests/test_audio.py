# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import io
import subprocess
import wave

import numpy as np
import pytest

from voxi.audio import Audio, decode_audio, encode_audio
from voxi.errors import PlatformError


def tone(rate=24000, seconds=0.25):
    time = np.arange(int(rate * seconds), dtype=np.float32) / rate
    return Audio((0.2 * np.sin(2 * np.pi * 440 * time)).astype(np.float32), rate)


@pytest.mark.parametrize("rate", [8000, 16000, 24000, 48000])
def test_wav_is_consumer_decodable_pcm16(rate):
    encoded = encode_audio(tone(), "wav", rate)
    with wave.open(io.BytesIO(encoded), "rb") as source:
        assert source.getnchannels() == 1
        assert source.getsampwidth() == 2
        assert source.getframerate() == rate
        assert source.getnframes() == int(0.25 * rate)
        assert len(source.readframes(source.getnframes())) == int(0.25 * rate) * 2
    decoded = decode_audio(encoded, max_bytes=100000, max_seconds=1)
    assert decoded.sample_rate == 16000
    assert len(decoded.samples) == 4000


def test_pcm_is_headerless_little_endian_clipped_pcm16():
    encoded = encode_audio(Audio(np.array([-2, -1, 0, 1, 2], dtype=np.float32), 24000), "pcm")
    assert np.frombuffer(encoded, dtype="<i2").tolist() == [-32767, -32767, 0, 32767, 32767]
    assert not encoded.startswith(b"RIFF")


def test_mp3_is_real_mpeg_and_ffmpeg_decodable():
    encoded = encode_audio(tone(), "mp3")
    assert not encoded.startswith(b"RIFF")
    assert encoded.startswith(b"ID3") or encoded[0] == 0xFF
    decoded = decode_audio(encoded, max_bytes=100000, max_seconds=1)
    assert 0.24 <= decoded.duration <= 0.4
    assert np.max(np.abs(decoded.samples)) > 0.05


@pytest.mark.parametrize("data", [b"", b"not audio", b"RIFF\x00\x00\x00\x00WAVE"])
def test_malformed_audio_rejected(data):
    with pytest.raises(PlatformError) as raised:
        decode_audio(data, max_bytes=100000, max_seconds=1)
    assert raised.value.status == 422


def test_compressed_duration_is_limited_after_trusted_decode():
    encoded = encode_audio(tone(seconds=1.5), "mp3")
    with pytest.raises(PlatformError) as raised:
        decode_audio(encoded, max_bytes=100000, max_seconds=0.5)
    assert raised.value.status == 413


def test_exact_wav_duration_is_allowed_and_oversize_is_rejected():
    encoded = encode_audio(tone(seconds=0.5), "wav")
    assert decode_audio(encoded, max_bytes=len(encoded), max_seconds=0.5).duration == 0.5
    with pytest.raises(PlatformError) as raised:
        decode_audio(encoded, max_bytes=len(encoded) - 1, max_seconds=1)
    assert raised.value.status == 413


def test_input_playlist_cannot_open_file_protocol(tmp_path):
    local = tmp_path / "tone.wav"
    local.write_bytes(encode_audio(tone(), "wav"))
    playlist = f"#EXTM3U\n{local.as_uri()}\n".encode()
    with pytest.raises(PlatformError):
        decode_audio(playlist, max_bytes=100000, max_seconds=1)


def test_recorded_m4a_with_end_metadata_decodes_complete_audio(tmp_path):
    recording = tmp_path / "recording.m4a"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-c:a", "aac", str(recording)],
        input=encode_audio(tone(seconds=30), "wav"),
        check=True,
        capture_output=True,
    )
    decoded = decode_audio(recording.read_bytes(), max_bytes=2000000, max_seconds=31)
    assert decoded.duration == pytest.approx(30, abs=0.1)
    assert np.max(np.abs(decoded.samples)) > 0.05
