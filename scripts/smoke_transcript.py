# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""F5 · Live smoke for the WebSocket ticket flow and the transcript pipeline.

Two goals:

  1. Exercise the F5 security primitive (`POST /v1/auth/socket` → short-lived
     single-use ticket → WS handshake with `?ticket=`) over the real nginx TLS
     proxy. The ticket is opaque and burns on first use, so unlike the legacy
     `?token=` path it can never leak a long-lived credential.

  2. Feed a real audio file through `/v1/audio/transcriptions` with
     `response_format=verbose_json` + `word_timestamps=true`, and validate the
     response shape against the TranscriptDocument adapter's expectations
     (segments[].start/end in seconds, optional words[] with word/start/end).

Every check mirrors the contract already documented in
`src/voxi/gateway.py`, `src/voxi/auth.py::SocketTicketStore`, and
`webui/src/lib/transcript.ts::fromVerboseJson`. Nothing here invents endpoints.

    python scripts/smoke_transcript.py --base-url https://localhost:8443 \
        --audio smoke-output/acceptance/sample.wav --insecure
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import wave
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import websockets


class CheckError(RuntimeError):
    """One assertion failed; the reason is reported verbatim."""


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise CheckError(message)


def _http_base(base_url: str) -> str:
    parsed = urlsplit(base_url)
    if not parsed.netloc:
        raise CheckError(f"--base-url must be absolute: {base_url!r}")
    scheme = "https" if parsed.scheme in {"https", "wss"} else "http"
    return f"{scheme}://{parsed.netloc}"


def _ws_base(base_url: str) -> str:
    parsed = urlsplit(base_url)
    scheme = "wss" if parsed.scheme in {"https", "wss"} else "ws"
    return f"{scheme}://{parsed.netloc}"


def _headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


# ------------------------------------------------------------------ checks


def mint_ticket(client: httpx.Client, base: str, key: str, scope: str) -> tuple[str, int]:
    response = client.post(f"{base}/v1/auth/socket", json={"scope": scope}, headers=_headers(key))
    expect(
        response.status_code == 201,
        f"mint {scope} -> {response.status_code}: {response.text[:200]}",
    )
    body = response.json()
    expect(isinstance(body.get("ticket"), str), f"ticket missing: {body}")
    expect(len(body["ticket"]) >= 16, f"ticket too short: {body}")
    expect(
        isinstance(body.get("expires_in"), int) and body["expires_in"] >= 1, "expires_in invalid"
    )
    return body["ticket"], body["expires_in"]


def ws_open_with_ticket(ws_base: str, ticket: str, insecure: bool) -> dict:
    """Dial /v1/tts/stream?ticket=... and return the first JSON event."""
    url = f"{ws_base}/v1/tts/stream?ticket={ticket}"
    ssl_ctx: ssl.SSLContext | None = None
    if ws_base.startswith("wss") and insecure:
        ssl_ctx = ssl._create_unverified_context()
    import asyncio

    async def _go() -> dict:
        kwargs = {"open_timeout": 10}
        if ssl_ctx is not None:
            kwargs["ssl"] = ssl_ctx
        async with websockets.connect(url, **kwargs) as socket:
            await socket.send(
                json.dumps(
                    {
                        "type": "speak",
                        "model": "ema-lightning",
                        "input": "F5 smoke",
                        "voice": "ema-tr",
                        "sample_rate": 16000,
                        "chunk_ms": 20,
                        "generation_id": 1,
                    }
                )
            )
            # Peek the first event only; the full audio regression is covered
            # by smoke_stream.py. Receiving any JSON payload (meta / error)
            # proves the ticket was accepted.
            raw = await asyncio.wait_for(socket.recv(), timeout=10)
            if isinstance(raw, bytes | bytearray):
                return {"type": "binary-first", "size": len(raw)}
            return json.loads(raw)

    return asyncio.run(_go())


def ws_open_with_rejected_ticket(ws_base: str, ticket: str, insecure: bool) -> int:
    url = f"{ws_base}/v1/tts/stream?ticket={ticket}"
    ssl_ctx: ssl.SSLContext | None = None
    if ws_base.startswith("wss") and insecure:
        ssl_ctx = ssl._create_unverified_context()
    import asyncio

    async def _go() -> int:
        kwargs = {"open_timeout": 10}
        if ssl_ctx is not None:
            kwargs["ssl"] = ssl_ctx
        try:
            async with websockets.connect(url, **kwargs) as socket:
                # Server closed pre-accept: surface the close code.
                try:
                    await asyncio.wait_for(socket.recv(), timeout=5)
                except websockets.exceptions.ConnectionClosed as closed:
                    return int(closed.code or 1006)
                raise CheckError("rejected ticket unexpectedly opened")
        except websockets.exceptions.InvalidStatus as rejected:
            return int(rejected.response.status_code)
        except websockets.exceptions.ConnectionClosed as closed:
            return int(closed.code or 1006)

    return asyncio.run(_go())


def transcribe_verbose(client: httpx.Client, base: str, key: str, audio_path: Path) -> dict:
    with audio_path.open("rb") as handle:
        response = client.post(
            f"{base}/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {key}"},
            files={"file": (audio_path.name, handle, "application/octet-stream")},
            data={
                "model": "whisper-1",
                "response_format": "verbose_json",
                "word_timestamps": "true",
                "timestamp_granularities[]": ["word", "segment"],
            },
            timeout=120,
        )
    expect(
        response.status_code == 200,
        f"transcriptions -> {response.status_code}: {response.text[:200]}",
    )
    return response.json()


def validate_verbose_shape(payload: dict, expected_duration_seconds: float | None) -> dict:
    """Mirror what `webui/src/lib/transcript.ts::fromVerboseJson` accepts.
    A failure here means the browser editor would silently lose data."""
    expect(isinstance(payload, dict), "verbose_json root must be an object")
    text = payload.get("text")
    expect(isinstance(text, str), "text missing")
    segments = payload.get("segments")
    expect(isinstance(segments, list), "segments must be a list")
    first_start = None
    last_end = None
    word_count = 0
    for index, segment in enumerate(segments):
        expect(isinstance(segment, dict), f"segments[{index}] not an object")
        start = segment.get("start")
        end = segment.get("end")
        expect(
            isinstance(start, int | float) and isinstance(end, int | float),
            f"segments[{index}] start/end not numeric",
        )
        expect(start >= 0 and end >= start, f"segments[{index}] inverted range")
        words = segment.get("words")
        if words is not None:
            expect(isinstance(words, list), f"segments[{index}].words not a list")
            for word_index, word in enumerate(words):
                expect(isinstance(word, dict), f"segments[{index}].words[{word_index}] not object")
                expect(isinstance(word.get("word"), str), "missing word.text")
                expect(isinstance(word.get("start"), int | float), "missing word.start")
                expect(isinstance(word.get("end"), int | float), "missing word.end")
                expect(word["end"] >= word["start"], "inverted word timing")
                word_count += 1
        if first_start is None:
            first_start = start
        last_end = end
    if expected_duration_seconds is not None and last_end is not None:
        # The editor clamps word times to file duration; a segment drifting
        # more than 10 % past the end means upstream alignment is broken.
        expect(
            last_end <= expected_duration_seconds * 1.1,
            f"last segment end {last_end} exceeds duration {expected_duration_seconds} by >10%",
        )
    return {
        "segments": len(segments),
        "words": word_count,
        "first_start": first_start,
        "last_end": last_end,
        "text_chars": len(text or ""),
    }


def probe_nginx_does_not_log_ticket(ws_base: str, insecure: bool) -> dict:
    """The F5 mitigation: even if the ticket value ends up in the request
    line, nginx's `voxi_safe` log_format prints $uri (no query). We cannot
    read the log from here, but we can send a probe token and require the
    proxy to accept the request line without echoing the query back."""
    url = f"{ws_base.replace('ws', 'http')}/healthz?ticket=PROBETICKET"
    verify = not insecure
    with httpx.Client(timeout=5, verify=verify, trust_env=False) as client:
        response = client.get(url)
    # /healthz may 404 or 200 depending on wiring; we only care that the
    # response body does NOT reflect the query string (e.g. debug echoes).
    expect("PROBETICKET" not in response.text, "response body echoed the ticket probe")
    return {"status": response.status_code, "echoed": False}


# ------------------------------------------------------------------ driver


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url", default=os.getenv("VOXI_SMOKE_BASE_URL", "http://127.0.0.1:8080")
    )
    parser.add_argument("--api-key", default=os.getenv("VOXI_API_KEY", ""))
    parser.add_argument("--audio", type=Path, default=None, help="wav/ogg/mp3 to feed STT")
    parser.add_argument("--insecure", action="store_true", help="skip TLS verification")
    parser.add_argument("--out", type=Path, default=Path("smoke-output/transcript"))
    args = parser.parse_args()

    key = args.api_key
    if len(key) < 32:
        print("Set VOXI_API_KEY or pass --api-key (>=32 chars).", file=sys.stderr)
        return 2
    if args.audio is None or not args.audio.exists():
        print("--audio file required (a real .wav for verbose_json check)", file=sys.stderr)
        return 2

    base_http = _http_base(args.base_url)
    base_ws = _ws_base(args.base_url)
    args.out.mkdir(parents=True, exist_ok=True)

    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    results: dict[str, object] = {"passed": False, "checks": {}, "started_at": started}
    verify = not args.insecure

    try:
        with httpx.Client(timeout=30, verify=verify, trust_env=False) as client:
            # 1. Unauthorized mint is refused.
            refusal = client.post(f"{base_http}/v1/auth/socket", json={"scope": "audio:write"})
            expect(
                refusal.status_code in {401, 403},
                f"unauth mint -> {refusal.status_code}: {refusal.text[:200]}",
            )
            results["checks"]["unauth_mint_refused"] = refusal.status_code

            # 2. Valid bearer mints a ticket.
            ticket, expires_in = mint_ticket(client, base_http, key, "audio:write")
            results["checks"]["ticket_mint"] = {"expires_in": expires_in, "prefix": ticket[:6]}

            # 3. WS accepts a valid ticket (no long-lived bearer on the URL).
            first_event = ws_open_with_ticket(base_ws, ticket, args.insecure)
            results["checks"]["ws_with_ticket_opens"] = first_event.get("type", "unknown")

            # 4. Immediate replay of the SAME ticket is refused.
            replay_code = ws_open_with_rejected_ticket(base_ws, ticket, args.insecure)
            expect(
                replay_code in {1008, 401, 403},
                f"replayed ticket accepted (code {replay_code})",
            )
            results["checks"]["ticket_replay_rejected"] = replay_code

            # 5. A ticket minted for realtime:connect cannot open audio:write.
            rt_ticket, _ = mint_ticket(client, base_http, key, "realtime:connect")
            cross_code = ws_open_with_rejected_ticket(base_ws, rt_ticket, args.insecure)
            expect(
                cross_code in {1008, 401, 403},
                f"cross-scope ticket accepted (code {cross_code})",
            )
            results["checks"]["cross_scope_rejected"] = cross_code

            # 6. Real nginx does not echo the ticket into a response body.
            results["checks"]["nginx_no_echo"] = probe_nginx_does_not_log_ticket(
                base_ws, args.insecure
            )

            # 7. Real audio → verbose_json with word timings.
            with wave.open(str(args.audio), "rb") as reader:
                expected_duration = reader.getnframes() / float(reader.getframerate())
            payload = transcribe_verbose(client, base_http, key, args.audio)
            shape = validate_verbose_shape(payload, expected_duration)
            results["checks"]["verbose_shape"] = shape

        results["passed"] = True
        return_code = 0
    except CheckError as failure:
        results["error"] = str(failure)
        return_code = 1

    (args.out / "transcript-report.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    if return_code == 0:
        print("[F5 smoke] PASS — see", args.out / "transcript-report.json")
    else:
        print("[F5 smoke] FAIL:", results.get("error"), file=sys.stderr)
    return return_code


if __name__ == "__main__":
    sys.exit(main())
