# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Exercise a live Voxi deployment; never downloads models or invents transcripts."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import time
import wave
from pathlib import Path

import httpx
from openai import OpenAI

from voxi.secrets import read_secret


def wait_ready(
    base_url: str, api_key: str, deadline_seconds: float, verify: bool | str = True
) -> None:
    deadline = time.monotonic() + deadline_seconds
    last_error = "not contacted"
    with httpx.Client(timeout=10, trust_env=False, verify=verify) as http:
        while time.monotonic() < deadline:
            try:
                response = http.get(
                    f"{base_url.removesuffix('/v1')}/readyz",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if response.status_code == 200:
                    return
                last_error = f"HTTP {response.status_code}: {response.text[:300]}"
            except httpx.HTTPError as exc:
                last_error = str(exc)
            time.sleep(2)
    raise RuntimeError(f"Readiness deadline exceeded: {last_error}")


def validate_audio(path: Path, expected_format: str) -> dict[str, object]:
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_name,sample_rate,channels",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    metadata = json.loads(probe.stdout)
    if float(metadata["format"]["duration"]) <= 0:
        raise RuntimeError(f"Empty audio duration: {path}")
    streams = metadata.get("streams", [])
    if len(streams) != 1 or streams[0].get("channels") != 1:
        raise RuntimeError(f"Expected one mono audio stream: {metadata}")
    if expected_format == "mp3" and streams[0]["codec_name"] != "mp3":
        raise RuntimeError(f"Expected MP3 codec: {metadata}")
    if expected_format == "wav":
        with wave.open(str(path), "rb") as audio:
            if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
                raise RuntimeError("Expected mono signed 16-bit WAV")
            if audio.getframerate() != 24000 or audio.getnframes() == 0:
                raise RuntimeError("Expected nonempty 24 kHz WAV")
    # Decode the entire file, not just its headers. ffmpeg must fail on corrupt input.
    subprocess.run(
        ["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-f", "null", "-"],
        check=True,
        capture_output=True,
    )
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8080/v1")
    parser.add_argument("--output-dir", type=Path, default=Path("smoke-output"))
    parser.add_argument("--ready-timeout", type=float, default=600)
    parser.add_argument("--request-timeout", type=float, default=180)
    parser.add_argument("--model", default="ema-lightning")
    parser.add_argument("--voice", default="ema-tr")
    parser.add_argument(
        "--stt-model",
        default="whisper-1",
        help="Transcription model id; use whisper-large-v3-turbo to exercise the opt-in worker",
    )
    parser.add_argument(
        "--ca-bundle",
        type=Path,
        default=None,
        help="PEM of the TLS proxy, for a self-signed deployment (for example certs/voxi.crt)",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Skip TLS verification; only for a self-signed proxy on this machine",
    )
    parser.add_argument(
        "--text", default="Merhaba, bu yerel Türkçe konuşma hizmetinin ses denemesidir."
    )
    args = parser.parse_args()
    api_key = read_secret("VOXI_API_KEY", "app.key")
    if not api_key:
        parser.error(
            "Set VOXI_API_KEY (or make the generated app.key readable) to your deployment's "
            "audio API key"
        )
    if not args.base_url.endswith("/v1"):
        parser.error("--base-url must end in /v1")
    if args.insecure and args.ca_bundle:
        parser.error("Pass either --ca-bundle or --insecure, not both")
    if args.ca_bundle and not args.ca_bundle.is_file():
        parser.error(f"--ca-bundle not found: {args.ca_bundle}")
    # `verify` is True, a CA bundle path, or False; the same value is used for the
    # readiness probe and the SDK transport so both trust the same certificate.
    verify: bool | str = True
    if args.insecure:
        verify = False
    elif args.ca_bundle:
        verify = str(args.ca_bundle)
    if not all(shutil.which(binary) for binary in ("ffmpeg", "ffprobe")):
        parser.error("Install ffmpeg and ffprobe on the machine running this script")
    wait_ready(args.base_url, api_key, args.ready_timeout, verify)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with (
        httpx.Client(trust_env=False, verify=verify, timeout=args.request_timeout) as transport,
        OpenAI(
            base_url=args.base_url,
            api_key=api_key,
            timeout=args.request_timeout,
            max_retries=0,
            http_client=transport,
        ) as client,
    ):
        model_ids = {model.id for model in client.models.list().data}
        if not {args.model, args.stt_model} <= model_ids:
            raise RuntimeError(f"Required models absent: {sorted(model_ids)}")
        report: dict[str, object] = {
            "models": sorted(model_ids),
            "tts_model": args.model,
            "stt_model": args.stt_model,
            "audio": {},
        }
        audio_report: dict[str, object] = {}
        for response_format in ("wav", "mp3"):
            started = time.monotonic()
            path = args.output_dir / f"response.{response_format}"
            # SDK streaming here means HTTP file delivery, NOT realtime model generation.
            with client.audio.speech.with_streaming_response.create(
                model=args.model,
                voice=args.voice,
                input=args.text,
                response_format=response_format,
                extra_body={"sample_rate": 24000},
            ) as response:
                response.stream_to_file(path)
            request_seconds = round(time.monotonic() - started, 3)
            audio_report[response_format] = validate_audio(path, response_format)
            audio_report[response_format]["request_seconds"] = request_seconds
        report["audio"] = audio_report
        started = time.monotonic()
        with (args.output_dir / "response.wav").open("rb") as recording:
            transcript = client.audio.transcriptions.create(
                file=recording,
                model=args.stt_model,
                language="tr",
                response_format="json",
            )
        if not transcript.text.strip():
            raise RuntimeError("Generated Turkish sample transcribed to empty text")
        # Content is observed, never compared with a hard-coded expected transcript.
        report["transcript"] = transcript.text
        report["transcription_request_seconds"] = round(time.monotonic() - started, 3)
        (args.output_dir / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
