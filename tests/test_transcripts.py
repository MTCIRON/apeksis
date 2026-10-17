# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import pytest

from voxi.errors import PlatformError
from voxi.transcripts import format_srt, format_vtt, resolve_timestamp_granularities


def test_timestamp_granularities_are_authoritative_over_word_timestamps():
    # 'segment' wins even though the boolean asks for words.
    assert (
        resolve_timestamp_granularities(
            response_format="verbose_json",
            word_timestamps=True,
            timestamp_granularities=["segment"],
        )
        is False
    )
    assert (
        resolve_timestamp_granularities(
            response_format="verbose_json",
            word_timestamps=False,
            timestamp_granularities=["word"],
        )
        is True
    )


def test_word_timestamps_boolean_honored_only_without_granularity_list():
    assert (
        resolve_timestamp_granularities(
            response_format="verbose_json", word_timestamps=True, timestamp_granularities=None
        )
        is True
    )
    assert (
        resolve_timestamp_granularities(
            response_format="verbose_json", word_timestamps=False, timestamp_granularities=None
        )
        is False
    )


def test_timing_knob_requires_a_timing_capable_format():
    with pytest.raises(PlatformError) as raised:
        resolve_timestamp_granularities(
            response_format="json", word_timestamps=True, timestamp_granularities=None
        )
    assert raised.value.status == 400 and raised.value.code == "timestamp_requires_format"


def test_invalid_granularity_value_rejected():
    with pytest.raises(PlatformError) as raised:
        resolve_timestamp_granularities(
            response_format="verbose_json",
            word_timestamps=False,
            timestamp_granularities=["phoneme"],
        )
    assert raised.value.code == "invalid_parameter"


def test_subtitle_cues_are_ordered_and_timecoded():
    segments = [
        {"start": 1.0, "end": 2.0, "text": " b"},
        {"start": 0.0, "end": 0.5, "text": "a "},
    ]
    srt = format_srt(segments)
    # Sorted by start time; leading/trailing text whitespace trimmed; comma clock.
    assert srt.startswith("1\n00:00:00,000 --> 00:00:00,500\na")
    assert "\n2\n00:00:01,000 --> 00:00:02,000\nb" in srt
    vtt = format_vtt(segments)
    assert vtt.startswith("WEBVTT")
    assert "00:00:00.000 --> 00:00:00.500" in vtt  # dot clock for WebVTT


def test_blank_segments_are_dropped_and_negative_times_clamped():
    srt = format_srt(
        [{"start": -1.0, "end": 0.0, "text": ""}, {"start": 0.0, "end": 1.0, "text": "x"}]
    )
    assert srt == "1\n00:00:00,000 --> 00:00:01,000\nx\n"
