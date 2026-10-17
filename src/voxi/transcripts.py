# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Timestamp granularity resolution and subtitle (SRT/VTT) serialization.

Pure helpers with no I/O so the F-SRV acceptance rules (precedence between
``timestamp_granularities`` and ``word_timestamps``, OpenAI-compatible formats,
ordered/timecoded UTF-8 Turkish subtitles) can be unit-tested directly.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from voxi.errors import PlatformError

# Response formats that are allowed to carry timing information.
TIMING_FORMATS = frozenset({"verbose_json", "srt", "vtt"})
# Formats that always return the plain transcript body, exactly as before F-SRV.
PLAIN_FORMATS = frozenset({"json", "text"})


def resolve_timestamp_granularities(
    *,
    response_format: str,
    word_timestamps: bool,
    timestamp_granularities: list[str] | None,
) -> bool:
    """Return whether word-level timings are requested.

    Precedence is single and explicit (no ambiguity when both knobs are sent):

    * ``timestamp_granularities`` is authoritative when present. It must be a
      subset of ``{"word", "segment"}``; only ``"word"`` implies per-word work.
    * ``word_timestamps`` (the boolean convenience flag) is honored **only**
      when ``timestamp_granularities`` is absent.
    * Either timing knob requires a timing-capable ``response_format``
      (``verbose_json``/``srt``/``vtt``); requesting it with ``json``/``text``
      is rejected rather than silently ignored.
    """
    if timestamp_granularities is not None:
        values = set(timestamp_granularities)
        invalid = values - {"word", "segment"}
        if invalid:
            raise PlatformError(
                400,
                "timestamp_granularities must be 'word' and/or 'segment'",
                "invalid_parameter",
                "timestamp_granularities",
            )
        timing_requested = bool(values)
        words = "word" in values
    else:
        timing_requested = bool(word_timestamps)
        words = bool(word_timestamps)
    if timing_requested and response_format not in TIMING_FORMATS:
        raise PlatformError(
            400,
            "Timestamps require response_format 'verbose_json', 'srt', or 'vtt'",
            "timestamp_requires_format",
            "response_format",
        )
    return words


def _clock(seconds: float, *, separator: str) -> str:
    """Render seconds as ``HH:MM:SS{sep}mmm`` (comma for SRT, dot for VTT)."""
    total_ms = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"


def _cues(segments: Iterable[Mapping[str, Any]]) -> list[tuple[float, float, str]]:
    """Ordered, non-negative cue tuples (start, end, text); blank text dropped."""
    ordered = sorted(
        segments,
        key=lambda segment: float(segment.get("start", 0.0) or 0.0),
    )
    cues: list[tuple[float, float, str]] = []
    for segment in ordered:
        start = float(segment.get("start", 0.0) or 0.0)
        end = float(segment.get("end", start) or start)
        if end < start:
            end = start
        text = (segment.get("text") or "").strip()
        if not text:
            continue
        cues.append((start, end, text))
    return cues


def format_srt(segments: Iterable[Mapping[str, Any]]) -> str:
    """SubRip subtitles: 1-based index, ``HH:MM:SS,mmm -->`` arrow, blank-line gaps."""
    blocks: list[str] = []
    for index, (start, end, text) in enumerate(_cues(segments), start=1):
        arrow = f"{_clock(start, separator=',')} --> {_clock(end, separator=',')}"
        blocks.append(f"{index}\n{arrow}\n{text}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def format_vtt(segments: Iterable[Mapping[str, Any]]) -> str:
    """WebVTT: ``WEBVTT`` header then ``HH:MM:SS.mmm -->`` cues (no index line)."""
    lines = ["WEBVTT", ""]
    for start, end, text in _cues(segments):
        arrow = f"{_clock(start, separator='.')} --> {_clock(end, separator='.')}"
        lines.append(f"{arrow}\n{text}\n")
    return "\n".join(lines).rstrip() + "\n"
