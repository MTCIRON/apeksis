# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Live WebSocket streaming smoke for a deployed Voxi gateway.

`scripts/smoke.py` proves the file APIs. It cannot prove that the serving stack
accepts WebSocket upgrades: contract tests use Starlette's TestClient, which
bypasses the ASGI server entirely. This client speaks raw WebSocket through the
pinned `websockets` dependency, so a gateway without a WebSocket-capable server
implementation fails here loudly instead of passing silently.

Latency numbers are observed wall-clock values for operator review. They are not
benchmarks, SLO proofs or model-quality measurements.

    python scripts/smoke_stream.py --base-url ws://127.0.0.1:8080 --audio sample.wav
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import wave
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import websockets

HEADER_BYTES = 4


class CheckError(RuntimeError):
    """One smoke assertion failed; the reason is reported, never invented."""


def targets(base_url: str) -> tuple[str, str]:
    """Return the (websocket, http) base URLs for one gateway."""
    parsed = urlsplit(base_url)
    if not parsed.netloc:
        raise CheckError(f"--base-url must be absolute: {base_url!r}")
    secure = parsed.scheme in {"wss", "https"}
    if parsed.scheme not in {"ws", "wss", "http", "https"}:
        raise CheckError(f"Unsupported scheme: {parsed.scheme!r}")
    root = f"{parsed.netloc}{parsed.path}".rstrip("/")
    return ("wss://" if secure else "ws://") + root, ("https://" if secure else "http://") + root


def connect_kwargs(args, key: str | None = None) -> dict:
    """websockets.connect kwargs; --insecure skips verification for a self-signed proxy."""
    kwargs: dict = {"open_timeout": args.timeout}
    if key:
        kwargs["additional_headers"] = {"Authorization": f"Bearer {key}"}
    if getattr(args, "secure", False) and args.insecure:
        import ssl

        kwargs["ssl"] = ssl._create_unverified_context()
    return kwargs


class Socket:
    """One test socket that keeps audio and events in arrival order."""

    def __init__(self, websocket) -> None:
        self.ws = websocket
        self.events: list[dict] = []
        self.pcm = bytearray()
        self.frames: list[tuple[int, int]] = []
        self.first_audio_ms: float | None = None
        self._sent_at: float | None = None

    def mark_sent(self) -> None:
        self._sent_at = time.monotonic()

    async def send(self, payload: dict | bytes | str) -> None:
        if isinstance(payload, dict):
            await self.ws.send(json.dumps(payload))
        else:
            await self.ws.send(payload)

    def _record(self, frame) -> dict | None:
        """Accumulate one received frame; return the parsed event only for JSON frames."""
        if isinstance(frame, bytes | bytearray):
            if len(frame) < HEADER_BYTES:
                raise CheckError(f"binary frame shorter than its {HEADER_BYTES}-byte header")
            generation, sequence = (
                int.from_bytes(frame[0:2], "big"),
                int.from_bytes(frame[2:4], "big"),
            )
            self.frames.append((generation, sequence))
            self.pcm.extend(frame[HEADER_BYTES:])
            if self.first_audio_ms is None and self._sent_at is not None:
                self.first_audio_ms = (time.monotonic() - self._sent_at) * 1000
            return None
        event = json.loads(frame)
        self.events.append(event)
        return event

    async def _recv(self, deadline: float):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise CheckError("timed out reading from the socket")
        async with asyncio.timeout(remaining):
            return await self.ws.recv()

    async def until(self, kinds: set[str], limit_s: float) -> dict:
        """Read frames until a terminal event arrives; audio is accumulated throughout."""
        deadline = time.monotonic() + limit_s
        while True:
            event = self._record(await self._recv(deadline))
            if event is not None and event.get("type") in kinds:
                return event

    async def until_audio(self, count: int, terminal: set[str], limit_s: float) -> dict | None:
        """Read until `count` audio frames arrive, or stop early on a terminal event.

        This is what lets the cancel probe interrupt a stream mid-flight: waiting on
        a terminal event alone would drain the whole generation before cancelling.
        """
        deadline = time.monotonic() + limit_s
        while len(self.frames) < count:
            event = self._record(await self._recv(deadline))
            if event is not None and event.get("type") in terminal:
                return event
        return None

    def last(self, kind: str) -> dict:
        for event in reversed(self.events):
            if event.get("type") == kind:
                return event
        raise CheckError(f"no {kind!r} event; saw {[e.get('type') for e in self.events]}")

    def count(self, kind: str) -> int:
        return sum(1 for event in self.events if event.get("type") == kind)


def event_types(socket: Socket) -> list[str]:
    return [event.get("type", "") for event in socket.events]


def write_wav(path: Path, pcm: bytes, sample_rate: int) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm)


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise CheckError(message)


async def check_tts(ws_base: str, key: str, args) -> dict:
    """TTS-05: meta first, framed audio, truthful totals, reusable connection."""
    generation = 7
    pcm_ms = 0
    async with websockets.connect(f"{ws_base}/v1/tts/stream", **connect_kwargs(args, key)) as raw:
        socket = Socket(raw)
        request = {
            "type": "speak",
            "model": args.model,
            "voice": args.voice,
            "input": args.text,
            "sample_rate": args.sample_rate,
            "chunk_ms": args.chunk_ms,
            "generation_id": generation,
        }
        socket.mark_sent()
        await socket.send(request)
        done = await socket.until({"done", "cancelled", "error"}, args.timeout)
        expect(done["type"] == "done", f"speak failed: {done}")
        meta = socket.last("meta")
        expect(event_types(socket)[0] == "meta", f"first frame was not meta: {event_types(socket)}")
        expect(
            meta.get("encoding") == "pcm_s16le" and meta.get("channels") == 1,
            f"unexpected meta framing: {meta}",
        )
        rate = int(meta.get("sample_rate", 0))
        expect(rate == args.sample_rate, f"meta sample_rate {rate} != requested {args.sample_rate}")
        expect(socket.frames, "done arrived with no audio frame")
        expect(
            all(pair[0] == generation for pair in socket.frames),
            f"audio carried a foreign generation: {sorted({p[0] for p in socket.frames})}",
        )
        expect(
            [pair[1] for pair in socket.frames] == list(range(len(socket.frames))),
            "chunk sequence numbers were not contiguous from zero",
        )
        expect(done.get("chunks") == len(socket.frames), f"chunk count mismatch: {done}")
        pcm_ms = len(socket.pcm) * 1000 // (rate * 2)
        expect(
            abs(int(done.get("duration_ms", -1)) - pcm_ms) <= args.chunk_ms,
            f"done duration {done.get('duration_ms')} ms vs observed {pcm_ms} ms",
        )
        output = args.output_dir / "stream-response.wav"
        write_wav(output, bytes(socket.pcm), rate)

        # The same socket must serve a second request after a completed one.
        socket.mark_sent()
        await socket.send({**request, "input": args.text[:12] or args.text, "generation_id": 8})
        again = await socket.until({"done", "cancelled", "error"}, args.timeout)
        expect(again["type"] == "done", f"connection was not reusable: {again}")

    return {
        "observed_frames": len(socket.frames),
        "observed_pcm_ms": pcm_ms,
        "first_audio_ms": (
            round(socket.first_audio_ms, 1) if socket.first_audio_ms is not None else None
        ),
        "declared_duration_ms": done.get("duration_ms"),
        "wav": str(output),
        "reused_connection": True,
    }


async def check_tts_cancel(ws_base: str, key: str, args) -> dict:
    """Cancellation must stop delivery at a chunk boundary and say so."""
    stop_after = 3
    async with websockets.connect(f"{ws_base}/v1/tts/stream", **connect_kwargs(args, key)) as raw:
        socket = Socket(raw)
        socket.mark_sent()
        await socket.send(
            {
                "type": "speak",
                "model": args.model,
                "voice": args.voice,
                "input": args.long_text,
                "sample_rate": args.sample_rate,
                "chunk_ms": args.chunk_ms,
                "generation_id": 11,
            }
        )
        early = await socket.until_audio(stop_after, {"done", "cancelled", "error"}, args.timeout)
        if early is not None:
            raise CheckError(
                f"stream ended before {stop_after} frames arrived; cannot exercise cancel: {early}"
            )
        cancel_at = time.monotonic()
        await socket.send({"type": "cancel", "generation_id": 11})
        ended = await socket.until({"cancelled", "done", "error"}, args.timeout)
        expect(
            ended["type"] == "cancelled",
            f"cancel did not produce a cancelled event: {ended}",
        )
        audio_after = len(socket.frames)
        await socket.ws.close()
    return {
        "frames_before_cancel": stop_after,
        "frames_at_cancel": audio_after,
        "reported_chunks": ended.get("chunks"),
        "cancel_to_reply_ms": round((time.monotonic() - cancel_at) * 1000, 1),
        "chunk_ms": args.chunk_ms,
    }


def read_pcm16(path: Path, allowed_rates: set[int]) -> tuple[bytes, int]:
    with wave.open(str(path), "rb") as source:
        expect(source.getnchannels() == 1, "transcript audio must be mono")
        expect(source.getsampwidth() == 2, "transcript audio must be 16-bit PCM")
        expect(source.getcomptype() == "NONE", "transcript audio must be uncompressed")
        rate = source.getframerate()
        expect(
            rate in allowed_rates,
            f"{path} is {rate} Hz; stream it at {'/'.join(map(str, sorted(allowed_rates)))} Hz "
            "(e.g. ffmpeg -i in.wav -ar 16000 -ac 1 -c:a pcm_s16le out.wav)",
        )
        return source.readframes(source.getnframes()), rate


async def check_stt(ws_base: str, key: str, args) -> dict:
    """STT-07: handshake, windowed speech, monotonic revisions, real final transcript."""
    pcm, rate = (None, args.sample_rate)
    if args.audio:
        pcm, rate = read_pcm16(args.audio, {8000, 16000})
    window = int(rate * 0.02) * 2
    async with websockets.connect(
        f"{ws_base}/v1/realtime/transcriptions", **connect_kwargs(args, key)
    ) as raw:
        socket = Socket(raw)
        await socket.send(
            {
                "type": "session.start",
                "model": args.stt_model,
                "language": args.language,
                "sample_rate": rate,
                "partial_interval_ms": args.partial_interval_ms,
            }
        )
        started = await socket.until({"session.started", "error"}, args.timeout)
        expect(started["type"] == "session.started", f"handshake failed: {started}")
        expect(started.get("mode") == "windowed", f"unexpected mode: {started.get('mode')}")
        vad = started.get("vad") or {}
        expect("end_ms" in vad and "min_speech_ms" in vad, f"handshake omitted vad: {started}")

        if pcm is None:
            await socket.send(b"\x00\x00" * window * 15)  # 300 ms of digital silence
            await socket.send({"type": "session.stop"})
            ended = await socket.until({"session.ended", "error"}, args.timeout)
            expect(ended["type"] == "session.ended", f"session.stop was ignored: {ended}")
            return {
                "input": "none (silence probe)",
                "session_started": True,
                "speech_events": event_types(socket),
                "note": "no --audio given; only handshake and clean shutdown were proven",
            }

        for offset in range(0, len(pcm), window):
            await socket.send(pcm[offset : offset + window])
            if args.pace:
                await asyncio.sleep(window / (rate * 2))
        endpoint_at = time.monotonic()
        await socket.send({"type": "flush"})
        final = await socket.until({"transcript.final", "error"}, args.timeout)
        expect(final["type"] == "transcript.final", f"flush produced no final: {final}")
        partials = [event for event in socket.events if event.get("type") == "transcript.partial"]
        revisions = [event.get("revision", 0) for event in partials]
        expect(
            all(b > a for a, b in zip(revisions, revisions[1:], strict=False))
            and (not revisions or revisions[-1] < final.get("revision", 0)),
            f"revisions were not monotonic: {revisions} then {final.get('revision')}",
        )
        # The gateway emits speech.ended before transcript.final within the same
        # flush() drain, so it was already recorded while waiting for the final.
        # Re-issuing until({"speech.ended"}) would block for the next event and
        # time out; assert presence in the captured stream instead.
        expect(
            any(event.get("type") == "speech.ended" for event in socket.events),
            "missing speech.ended before final",
        )
        await socket.send({"type": "session.stop"})
        closed = await socket.until({"session.ended", "error"}, args.timeout)
        expect(closed["type"] == "session.ended", f"session.ended missing: {closed}")

    return {
        "input": str(args.audio),
        "input_ms": len(pcm) * 1000 // (rate * 2),
        "pacing": "realtime" if args.pace else "as fast as the socket allows",
        "partial_events": len(partials),
        "final_revision": final.get("revision"),
        "transcript": final.get("text"),
        "truncated": final.get("truncated", False),
        "flush_to_final_ms": round((time.monotonic() - endpoint_at) * 1000, 1),
        "vad": vad,
    }


async def check_auth(ws_base: str, args) -> dict:
    """A socket without credentials must be refused, not silently accepted.

    Over a real ASGI server a close issued before ``accept()`` is delivered as
    an HTTP rejection of the upgrade (websockets raises ``InvalidStatus``), not
    as a WebSocket close frame. Starlette's TestClient hides this distinction,
    so the wire truth is asserted here rather than a fabricated close code.
    """
    refused: dict[str, object] = {}
    for route in ("/v1/tts/stream", "/v1/realtime/transcriptions"):
        try:
            async with websockets.connect(f"{ws_base}{route}", **connect_kwargs(args)) as anon:
                await anon.recv()
            raise CheckError(f"{route} accepted an anonymous socket")
        except websockets.exceptions.InvalidStatus as rejected:
            status = rejected.response.status_code
            expect(status in {401, 403}, f"{route} refused the upgrade with HTTP {status}")
            refused[route] = f"http-{status}"
        except websockets.exceptions.ConnectionClosedError as closed:
            expect(closed.code == 1008, f"{route} closed with {closed.code}, expected 1008")
            refused[route] = closed.code or 1006
    expect(bool(refused), "auth probe produced no evidence")
    return refused


async def run(args, ws_base: str, http_base: str, key: str) -> dict:
    checks: dict = {}
    async with httpx.AsyncClient(
        timeout=args.timeout, trust_env=False, verify=not args.insecure
    ) as client:
        ready = await client.get(f"{http_base}/readyz")
        expect(ready.status_code == 200, f"/readyz returned {ready.status_code}: {ready.text}")
        checks["readyz"] = ready.json()
        if args.audio is None:
            suggested = Path("smoke-output/response.wav")
            if suggested.exists():
                args.audio = suggested
                print(f"using {suggested} for the transcription probe")
    checks["unauthenticated_refusal"] = await check_auth(ws_base, args)
    checks["tts_stream"] = await check_tts(ws_base, key, args)
    checks["tts_stream_cancel"] = await check_tts_cancel(ws_base, key, args)
    checks["realtime_transcriptions"] = await check_stt(ws_base, key, args)
    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="ws://127.0.0.1:8080")
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="skip TLS verification for a self-signed proxy (wss/https)",
    )
    parser.add_argument("--api-key", default=os.getenv("VOXI_API_KEY", ""))
    parser.add_argument("--output-dir", type=Path, default=Path("smoke-output/stream"))
    parser.add_argument("--text", default="Merhaba, bu bir canlı akış denemesidir.")
    parser.add_argument(
        "--long-text",
        default="Bugün hava oldukça güzel ve size uzun bir deneme metni okuyorum. " * 4,
    )
    parser.add_argument("--audio", type=Path, default=None)
    parser.add_argument("--model", default="ema-lightning")
    parser.add_argument("--voice", default="ema-tr")
    parser.add_argument("--stt-model", default="whisper-1")
    parser.add_argument("--language", default="tr")
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--chunk-ms", type=int, default=100)
    parser.add_argument("--partial-interval-ms", type=int, default=1200)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument(
        "--pace",
        action="store_true",
        help="send audio windows in real time instead of as fast as the socket allows",
    )
    args = parser.parse_args()

    if len(args.api_key) < 32:
        print("Set VOXI_API_KEY or pass --api-key (at least 32 characters).", file=sys.stderr)
        return 2
    args.output_dir.mkdir(parents=True, exist_ok=True)
    ws_base, http_base = targets(args.base_url)
    args.secure = ws_base.startswith("wss")
    report = {
        "base_url": args.base_url,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "websockets_version": getattr(websockets, "__version__", "unknown"),
        "passed": False,
        "checks": {},
    }
    try:
        report["checks"] = asyncio.run(run(args, ws_base, http_base, args.api_key))
        report["passed"] = True
        report["error"] = None
    except (CheckError, OSError, websockets.exceptions.WebSocketException) as exc:
        report["error"] = str(exc)
        if os.getenv("VOXI_SMOKE_DEBUG"):
            import traceback

            report["traceback"] = traceback.format_exc()
    report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    report_path = args.output_dir / "stream-report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    for name, result in report["checks"].items():
        print(f"{name}: {json.dumps(result, ensure_ascii=False)[:200]}")
    if report["passed"]:
        print(f"PASS — streaming evidence written to {args.output_dir}")
        print("Observed values are single-sample wall-clock numbers, not latency benchmarks.")
        return 0
    print(f"FAIL — {report['error']}\nDetails: {report_path}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
