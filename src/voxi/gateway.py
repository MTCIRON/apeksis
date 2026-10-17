# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import asyncio
import json
import logging
import os
import time
import uuid
from collections import deque
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Literal, cast
from urllib.parse import urlsplit

import httpx
from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse, Response
from fastapi.security import HTTPBearer
from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest
from pydantic import ValidationError

from voxi import __version__
from voxi.auth import Keyring, Principal, SocketTicketStore
from voxi.contracts import (
    RealtimeTranscriptionControl,
    RealtimeTranscriptionStart,
    SocketTicketMintRequest,
    SpeechRequest,
    StreamInboundEvent,
    StreamOutboundEvent,
    TranscriptionOutboundEvent,
    TranscriptionRequest,
    TranscriptionResult,
    TtsStreamControl,
    TtsStreamOutboundEvent,
    TtsStreamRequest,
    TurnInput,
)
from voxi.errors import PlatformError, install_error_handlers
from voxi.media import (
    InboundAudioBuffer,
    SpeechEndpointer,
    Utterance,
    VadEvent,
    pack_audio_frame,
    pcm_to_wav,
)
from voxi.n8n import TurnBroker
from voxi.runtime import install_body_limit
from voxi.secrets import read_secret
from voxi.transcripts import format_srt, format_vtt, resolve_timestamp_granularities

logger = logging.getLogger("voxi.gateway")

# Public transcription response formats (F-SRV). Default json/text behaviour is
# unchanged; verbose_json/srt/vtt are additive and opt-in.
TRANSCRIPTION_FORMATS = {"json", "text", "verbose_json", "srt", "vtt"}

# F5 · Transient worker-slot retry policy. A cancelled partial can leave its
# inference still draining inside the single-slot STT worker; the final request
# would otherwise 429 and lose the utterance. Bounded retries with linear
# backoff keep the transcript intact without letting a hung worker stall the
# socket forever. Retried statuses are the transient ones; 400/413/422 and
# 504 (server-side timeout) are user-visible errors and are raised directly.
RETRY_STATUSES: frozenset[int] = frozenset({429, 503})
RETRY_MAX_ATTEMPTS = 4
RETRY_BASE_DELAY = 0.35  # seconds; backoff is BASE * (attempt + 1)


async def recognize_with_retry(
    call,
    *,
    attempts: int = RETRY_MAX_ATTEMPTS,
    base_delay: float = RETRY_BASE_DELAY,
    sleep=asyncio.sleep,
) -> str:
    """Run `call()` under the transient-failure policy.

    Kept module-level and side-effect-free so unit tests can drive every
    branch: success, retry-until-success, retry-then-exhaust, non-retryable
    status short-circuit, and cancellation propagation.
    """
    if attempts < 1:
        raise ValueError("attempts must be >= 1")
    last: PlatformError | None = None
    for attempt in range(attempts):
        try:
            return await call()
        except PlatformError as exc:
            last = exc
            if exc.status in RETRY_STATUSES and attempt < attempts - 1:
                await sleep(base_delay * (attempt + 1))
                continue
            raise
    # Defensive: the loop always either returns or raises. If a future edit
    # shortens the exit path, keep the last error in scope rather than 500.
    raise last or PlatformError(503, "Speech worker failed", "worker_failure")


def socket_token(websocket: WebSocket) -> str:
    """Realtime clients may not set headers; query token is an explicit fallback."""
    header = websocket.headers.get("authorization", "")
    if header.startswith("Bearer "):
        return header[7:].strip()
    for name in ("token", "api_key"):
        if name in websocket.query_params:
            return websocket.query_params[name].strip()
    return ""


class CloseStream(Exception):
    """Ordered socket teardown with a specific WebSocket close code."""

    def __init__(self, code: int = 1000, reason: str = "Session closed"):
        self.code = code
        self.reason = reason
        super().__init__(reason)


async def flush_stream(queue: asyncio.Queue | None, sender: asyncio.Task, timeout: float = 2.0):
    """Drain queued frames before teardown so the final event is never swallowed."""
    if queue is not None:
        try:
            queue.put_nowait(None)
        except asyncio.QueueFull:
            sender.cancel()
            return
    try:
        await asyncio.wait_for(sender, timeout=timeout)
    except asyncio.CancelledError:
        sender.cancel()
        raise
    except Exception:
        sender.cancel()


@dataclass
class Settings:
    api_key: str = ""
    api_keys_json: str = ""
    worker_key: str = ""
    tts_url: str = "http://tts-ema:8081"
    stt_url: str = "http://stt-whisper:8082"
    stt_turbo_url: str = ""
    antalia_url: str = ""
    allow_alloy: bool = False
    timeout: float = 120
    max_upload: int = 26214400
    concurrency: int = 4
    rate_limit: int = 60
    n8n_url: str = ""
    n8n_key: str = ""
    n8n_timeout: float = 10
    transfer_targets: frozenset[str] = frozenset()
    fallback_text: str = "Üzgünüm, hizmet şu anda kullanılamıyor."
    stream_sample_rate: int = 16000
    tts_chunk_ms: int = 100
    ws_idle_timeout: float = 60
    stt_timeout: float = 30
    vad_start_ms: int = 100
    vad_end_ms: int = 700
    vad_min_speech_ms: int = 200
    vad_open_rms: float = 350.0
    vad_close_rms: float = 200.0
    # F5 security: short-lived, single-use ticket for WebSocket handshakes so
    # browsers can stop putting the long-lived bearer in the URL. TTL and
    # capacity are enforced by SocketTicketStore; expiry is monotonically
    # measured from time.monotonic().
    ws_ticket_ttl: float = 30.0
    ws_ticket_capacity: int = 1000

    @classmethod
    def from_env(cls):
        return cls(
            api_key=read_secret("VOXI_API_KEY", "app.key"),
            api_keys_json=read_secret("VOXI_API_KEYS_JSON", "api-keys.json"),
            worker_key=read_secret("VOXI_WORKER_API_KEY", "worker.key"),
            tts_url=os.getenv("TTS_URL", "http://tts-ema:8081"),
            stt_url=os.getenv("STT_URL", "http://stt-whisper:8082"),
            stt_turbo_url=os.getenv("STT_TURBO_URL", ""),
            antalia_url=os.getenv("ANTALIA_URL", ""),
            allow_alloy=os.getenv("VOXI_ALLOW_ALLOY", "false").lower() == "true",
            timeout=float(os.getenv("VOXI_REQUEST_TIMEOUT", "120")),
            max_upload=int(os.getenv("VOXI_MAX_UPLOAD_BYTES", "26214400")),
            concurrency=int(os.getenv("VOXI_MAX_CONCURRENCY", "4")),
            rate_limit=int(os.getenv("VOXI_RATE_LIMIT_PER_MINUTE", "60")),
            n8n_url=os.getenv("VOXI_N8N_WEBHOOK_URL", ""),
            n8n_key=os.getenv("VOXI_N8N_API_KEY", ""),
            n8n_timeout=float(os.getenv("VOXI_N8N_TIMEOUT", "10")),
            transfer_targets=frozenset(
                filter(None, os.getenv("VOXI_TRANSFER_TARGETS", "").split(","))
            ),
            fallback_text=os.getenv("VOXI_FALLBACK_TEXT", cls.fallback_text),
            stream_sample_rate=int(os.getenv("VOXI_STREAM_SAMPLE_RATE", "16000")),
            tts_chunk_ms=int(os.getenv("VOXI_TTS_CHUNK_MS", "100")),
            ws_idle_timeout=float(os.getenv("VOXI_WS_IDLE_TIMEOUT", "60")),
            stt_timeout=float(os.getenv("VOXI_STREAM_STT_TIMEOUT", "30")),
            vad_start_ms=int(os.getenv("VOXI_VAD_START_MS", "100")),
            vad_end_ms=int(os.getenv("VOXI_VAD_END_MS", "700")),
            vad_min_speech_ms=int(os.getenv("VOXI_VAD_MIN_SPEECH_MS", "200")),
            vad_open_rms=float(os.getenv("VOXI_VAD_OPEN_RMS", "350")),
            vad_close_rms=float(os.getenv("VOXI_VAD_CLOSE_RMS", "200")),
            ws_ticket_ttl=float(os.getenv("VOXI_WS_TICKET_TTL", "30")),
            ws_ticket_capacity=int(os.getenv("VOXI_WS_TICKET_CAPACITY", "1000")),
        )

    def validate(self):
        if len(self.worker_key) < 32:
            raise ValueError("VOXI_WORKER_API_KEY must contain at least 32 characters")
        if min(self.timeout, self.max_upload, self.concurrency, self.rate_limit) <= 0:
            raise ValueError("Timeout and limits must be positive")
        if self.stream_sample_rate not in {8000, 16000}:
            raise ValueError("VOXI_STREAM_SAMPLE_RATE must be 8000 or 16000")
        if min(self.tts_chunk_ms, self.ws_idle_timeout, self.stt_timeout) <= 0:
            raise ValueError("Stream chunk size and stream timeouts must be positive")
        if min(self.vad_start_ms, self.vad_end_ms, self.vad_min_speech_ms) <= 0:
            raise ValueError("VAD timing must be positive")
        if self.vad_close_rms > self.vad_open_rms:
            raise ValueError("VOXI_VAD_CLOSE_RMS must not exceed VOXI_VAD_OPEN_RMS")
        if self.ws_ticket_ttl <= 0 or self.ws_ticket_ttl > 300:
            raise ValueError("VOXI_WS_TICKET_TTL must be in (0, 300] seconds")
        if self.ws_ticket_capacity <= 0:
            raise ValueError("VOXI_WS_TICKET_CAPACITY must be positive")
        for url in (self.tts_url, self.stt_url, self.antalia_url):
            if not url:
                continue
            parsed = urlsplit(url)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("Worker URLs must be fixed HTTP(S) addresses")


def create_app(settings: Settings | None = None, client: httpx.AsyncClient | None = None):
    settings = settings or Settings.from_env()
    registry = CollectorRegistry()
    requests = Counter("voxi_http_requests_total", "HTTP requests", ["status"], registry=registry)
    latency = Histogram("voxi_http_duration_seconds", "HTTP duration", registry=registry)
    active: dict[str, int] = {}
    recent: dict[str, deque] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        settings.validate()
        if not logger.handlers:
            logger.addHandler(logging.StreamHandler())
        logger.setLevel(logging.INFO)
        logger.propagate = False
        app.state.keys = Keyring(settings.api_key, settings.api_keys_json)
        app.state.tickets = SocketTicketStore(
            ttl_seconds=settings.ws_ticket_ttl,
            capacity=settings.ws_ticket_capacity,
        )
        app.state.client = client or httpx.AsyncClient(
            timeout=settings.timeout,
            follow_redirects=False,
            trust_env=False,
            limits=httpx.Limits(max_connections=settings.concurrency * 3),
        )
        app.state.broker = TurnBroker(
            app.state.client,
            settings.n8n_url,
            settings.n8n_key,
            settings.transfer_targets,
            settings.n8n_timeout,
            settings.fallback_text,
        )
        try:
            yield
        finally:
            app.state.broker.close()
            if client is None:
                await app.state.client.aclose()

    app = FastAPI(title="Voxi Local Voice Gateway", version=__version__, lifespan=lifespan)
    # Keyring enforces scopes/errors; this dependency declares the bearer contract.
    api_bearer = HTTPBearer(auto_error=False, scheme_name="VoxiApiKey", bearerFormat="API key")
    protected = [Depends(api_bearer)]
    install_error_handlers(app)
    install_body_limit(app, settings.max_upload + 65536)

    @app.middleware("http")
    async def request_metrics(request: Request, call_next):
        request.state.request_id = uuid.uuid4().hex
        started = time.monotonic()
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        requests.labels(str(response.status_code)).inc()
        latency.observe(time.monotonic() - started)
        logger.info(
            json.dumps(
                {
                    "request_id": request.state.request_id,
                    "method": request.method,
                    "status": response.status_code,
                    "duration_seconds": round(time.monotonic() - started, 6),
                }
            )
        )
        return response

    def authorize(request: Request, scope: str) -> Principal:
        principal = app.state.keys.authenticate(request, scope)
        queue = recent.setdefault(principal.id, deque())
        now = time.monotonic()
        while queue and queue[0] <= now - 60:
            queue.popleft()
        if len(queue) >= settings.rate_limit:
            raise PlatformError(429, "API key rate limit exceeded", "rate_limit_exceeded")
        queue.append(now)
        return principal

    @asynccontextmanager
    async def slot(principal: Principal):
        if active.get(principal.id, 0) >= settings.concurrency:
            raise PlatformError(429, "Client concurrency limit exceeded", "capacity_exceeded")
        active[principal.id] = active.get(principal.id, 0) + 1
        try:
            yield
        finally:
            active[principal.id] -= 1

    async def worker(method: str, base: str, path: str, **kwargs) -> httpx.Response:
        try:
            response = await app.state.client.request(
                method,
                base.rstrip("/") + path,
                headers={"Authorization": f"Bearer {settings.worker_key}"},
                **kwargs,
            )
        except httpx.TimeoutException:
            raise PlatformError(504, "Speech worker timed out", "worker_timeout") from None
        except httpx.HTTPError:
            raise PlatformError(503, "Speech worker unavailable", "worker_unavailable") from None
        if response.status_code >= 400:
            try:
                detail = response.json()["error"]
                status = (
                    response.status_code if response.status_code in {400, 413, 422, 429} else 503
                )
                raise PlatformError(status, detail["message"], detail["code"], detail.get("param"))
            except (ValueError, KeyError, TypeError):
                raise PlatformError(503, "Speech worker failed", "worker_failure") from None
        if response.is_redirect:
            raise PlatformError(503, "Worker redirect forbidden", "worker_redirect")
        return response

    def resolve_tts(model: str, voice: str | None) -> tuple[str, str, str]:
        """Map public model/voice onto an installed engine, worker URL and physical voice."""
        engine = "ema-lightning" if model == "tts-1" else model
        if engine == "ema-lightning":
            return engine, settings.tts_url, "ema-tr"
        if engine == "antalia-mini" and settings.antalia_url:
            return engine, settings.antalia_url, "antalia-tr"
        raise PlatformError(400, "Unknown or disabled TTS model", "model_not_found", "model")

    def resolve_stt(model: str) -> str:
        """Map a public STT model onto the worker URL that serves it.

        `whisper-1` is the OpenAI alias and always resolves to the default
        worker. The explicit quality model resolves to its own worker only when
        that opt-in profile is enabled. The worker's own `/internal/models` list
        stays the final authority, so a disabled profile still fails as
        `model_not_found` instead of being routed to a worker that cannot serve
        it. No model is ever advertised that is not actually installed.
        """
        if model == "whisper-large-v3-turbo" and settings.stt_turbo_url:
            return settings.stt_turbo_url
        return settings.stt_url

    async def worker_error(response: httpx.Response) -> PlatformError:
        try:
            detail = (await response.json())["error"]
            status = response.status_code if response.status_code in {400, 413, 422, 429} else 503
            return PlatformError(status, detail["message"], detail["code"], detail.get("param"))
        except (ValueError, KeyError, TypeError):
            return PlatformError(503, "Speech worker failed", "worker_failure")

    async def speech_pcm_stream(body: SpeechRequest) -> AsyncGenerator[bytes, None]:
        """Pull PCM16 from the TTS worker stream endpoint as the engine produces it."""
        _, url, physical_voice = resolve_tts(body.model, body.voice)
        request = body.model_copy(update={"voice": physical_voice, "response_format": "pcm"})
        try:
            async with app.state.client.stream(
                "POST",
                url.rstrip("/") + "/internal/speech/stream",
                headers={"Authorization": f"Bearer {settings.worker_key}"},
                json=request.model_dump(),
                timeout=settings.timeout,
            ) as response:
                if response.status_code != 200:
                    await response.aread()
                    raise await worker_error(response)
                async for chunk in response.aiter_bytes():
                    if chunk:
                        yield chunk
        except httpx.TimeoutException:
            raise PlatformError(504, "Speech worker timed out", "worker_timeout") from None
        except httpx.HTTPError:
            raise PlatformError(503, "Speech worker unavailable", "worker_unavailable") from None

    async def transcribe_pcm(
        pcm: bytes, *, sample_rate: int, language: str | None, prompt: str | None = None
    ) -> str:
        """Windowed transcription of a bounded utterance; WAV container keeps the worker honest."""
        fields = {"language": language} if language else {}
        if prompt:
            fields["prompt"] = prompt
        try:
            response = await app.state.client.post(
                settings.stt_url.rstrip("/") + "/internal/transcriptions",
                headers={"Authorization": f"Bearer {settings.worker_key}"},
                data=fields,
                files={"file": ("utterance.wav", pcm_to_wav(pcm, sample_rate), "audio/wav")},
                timeout=settings.stt_timeout,
            )
        except httpx.TimeoutException:
            raise PlatformError(504, "Speech worker timed out", "worker_timeout") from None
        except httpx.HTTPError:
            raise PlatformError(503, "Speech worker unavailable", "worker_unavailable") from None
        if response.status_code >= 400:
            raise await worker_error(response)
        return TranscriptionResult.model_validate(response.json()).text

    def touch(principal: Principal) -> None:
        queue = recent.setdefault(principal.id, deque())
        now = time.monotonic()
        while queue and queue[0] <= now - 60:
            queue.popleft()
        queue.append(now)

    async def authorize_socket(websocket: WebSocket, scope: str) -> Principal | None:
        """Authenticate a realtime socket; returns None when the handshake must fail.

        Order of preference (F5):
          1. `?ticket=<value>` minted via POST /v1/auth/socket. Single-use,
             short-TTL, bound to the requested scope; safe to appear in the
             URL because the value is opaque and burned on first use.
          2. `Authorization: Bearer <key>` header (non-browser clients).
          3. `?token=` / `?api_key=` query fallback (legacy; still honoured
             so already-deployed integrations keep working).
        """
        ticket = websocket.query_params.get("ticket", "").strip()
        if ticket:
            try:
                principal = app.state.tickets.consume(ticket, scope)
            except PlatformError as exc:
                await websocket.close(code=1008, reason=exc.message)
                return None
            # Skip the bearer rate-limit queue on the ticket path: the mint
            # already charged one request, and a single-use ticket cannot be
            # replayed to farm additional sockets.
            touch(principal)
            return principal
        token = socket_token(websocket)
        if not token:
            await websocket.close(code=1008, reason="Missing authentication token")
            return None
        try:
            principal = app.state.keys.authenticate_token(token, scope)
        except PlatformError as exc:
            await websocket.close(code=1008, reason=exc.message)
            return None
        queue = recent.setdefault(principal.id, deque())
        now = time.monotonic()
        while queue and queue[0] <= now - 60:
            queue.popleft()
        if len(queue) >= settings.rate_limit:
            await websocket.close(code=1008, reason="API key rate limit exceeded")
            return None
        touch(principal)
        return principal

    def acquire(principal: Principal) -> bool:
        if active.get(principal.id, 0) >= settings.concurrency:
            return False
        active[principal.id] = active.get(principal.id, 0) + 1
        return True

    def release(principal: Principal) -> None:
        active[principal.id] = max(0, active.get(principal.id, 1) - 1)

    def new_endpointer(sample_rate: int, **overrides) -> SpeechEndpointer:
        options: dict = {
            "start_ms": settings.vad_start_ms,
            "end_ms": settings.vad_end_ms,
            "min_speech_ms": settings.vad_min_speech_ms,
            "open_rms": settings.vad_open_rms,
            "close_rms": settings.vad_close_rms,
        }
        options.update({key: value for key, value in overrides.items() if value is not None})
        return SpeechEndpointer(sample_rate, **options)

    @app.get("/healthz")
    async def health():
        return {"status": "ok"}

    @app.get("/readyz")
    async def ready():
        urls = {"tts": settings.tts_url, "stt": settings.stt_url}
        if settings.antalia_url:
            urls["antalia"] = settings.antalia_url

        async def check(name: str, url: str):
            try:
                result = await app.state.client.get(url.rstrip("/") + "/readyz", timeout=3)
                return name, result.status_code == 200
            except httpx.HTTPError:
                return name, False

        states = dict(await asyncio.gather(*(check(name, url) for name, url in urls.items())))
        return JSONResponse(
            {"status": "ready" if all(states.values()) else "not_ready", "workers": states},
            status_code=200 if all(states.values()) else 503,
        )

    @app.get("/metrics", include_in_schema=False)
    async def metrics():
        return Response(generate_latest(registry), media_type="text/plain; version=0.0.4")

    @app.post("/v1/auth/socket", status_code=201, dependencies=protected)
    async def mint_socket_ticket(
        body: SocketTicketMintRequest, request: Request
    ) -> dict:
        """F5: single-use, short-lived WebSocket handshake ticket.

        The caller authenticates with the normal Bearer header and declares the
        scope of the socket they intend to open. The gateway issues an opaque
        ticket bound to that principal + scope; the browser then dials the WS
        route with `?ticket=<value>` instead of leaking its long-lived key in
        the URL. Ticket lifetime is `VOXI_WS_TICKET_TTL` (default 30 s) and
        every value is consumed on first successful handshake; replays of the
        same ticket are rejected, expired tickets are reaped, and any probe
        error collapses to a single 401 to avoid a liveness oracle.
        """
        principal = authorize(request, body.scope)
        ticket, expires_in = app.state.tickets.mint(principal, body.scope)
        return {"ticket": ticket, "expires_in": expires_in}

    @app.get("/v1/endpoints")
    async def endpoints():
        """Every route this gateway serves and the scope a key needs for it.

        Public routes carry an empty `scopes` list. This is the honest answer to
        "which key do I give an external client?": it lists the agent (n8n)
        session routes and the Voxi streaming sockets too, not only the
        OpenAI-compatible subset.
        """
        catalog = [
            ("GET", "/healthz", "gateway", (), "Temel servis sagligi"),
            ("GET", "/readyz", "gateway", (), "Worker hazirlik durumu"),
            ("GET", "/metrics", "gateway", (), "Prometheus metrikleri"),
            ("GET", "/v1/endpoints", "gateway", (), "Uc katalogu (bu liste)"),
            ("GET", "/v1/models", "gateway", ("audio:read",), "Kurulu TTS/STT modelleri"),
            ("POST", "/v1/audio/speech", "tts", ("audio:write",), "Metinden sese (OpenAI uyumlu)"),
            (
                "POST",
                "/v1/audio/transcriptions",
                "stt",
                ("audio:write",),
                "Sesten metne (OpenAI uyumlu)",
            ),
            (
                "POST",
                "/v1/auth/socket",
                "gateway",
                ("audio:write", "realtime:connect"),
                "Tek kullanimlik WS bileti (istenen kapsam icin)",
            ),
            ("POST", "/v1/sessions", "n8n", ("realtime:connect",), "Ajan oturumu ac"),
            (
                "POST",
                "/v1/sessions/{session_id}/turns",
                "n8n",
                ("realtime:connect",),
                "Turu ajana ilet",
            ),
            (
                "DELETE",
                "/v1/sessions/{session_id}",
                "n8n",
                ("realtime:connect",),
                "Oturumu kapat",
            ),
            (
                "WS",
                "/v1/sessions/{session_id}/stream",
                "n8n",
                ("realtime:connect",),
                "Ajan medya akisi",
            ),
            ("WS", "/v1/tts/stream", "tts", ("audio:write",), "Akisli sentez"),
            (
                "WS",
                "/v1/realtime/transcriptions",
                "stt",
                ("audio:write",),
                "Pencereli canli transkripsiyon",
            ),
        ]
        return {
            "endpoints": [
                {
                    "method": method,
                    "path": path,
                    "service": service,
                    "scopes": list(scopes),
                    "purpose": purpose,
                }
                for method, path, service, scopes, purpose in catalog
            ]
        }

    @app.get("/v1/models", dependencies=protected)
    async def models(request: Request):
        authorize(request, "audio:read")
        # De-duplicate by id: two STT workers both advertise the `whisper-1` alias
        # (each serves it), and the first listed worker is the one `whisper-1`
        # actually routes to, so the alias must appear exactly once.
        catalog: dict[str, dict] = {}
        urls = [settings.tts_url, settings.stt_url]
        if settings.antalia_url:
            urls.append(settings.antalia_url)
        if settings.stt_turbo_url:
            urls.append(settings.stt_turbo_url)
        for url in urls:
            response = await worker("GET", url, "/internal/models")
            for row in response.json()["data"]:
                catalog.setdefault(row["id"], row)
        return {"object": "list", "data": list(catalog.values())}

    @app.post("/v1/audio/speech", dependencies=protected)
    async def speech(request: Request, body: SpeechRequest):
        principal = authorize(request, "audio:write")
        engine, url, physical_voice = resolve_tts(body.model, body.voice)
        alias = body.voice == "alloy" and settings.allow_alloy and engine == "ema-lightning"
        if body.voice != physical_voice and not alias:
            raise PlatformError(
                400, f"Supported physical voice: {physical_voice}", "unsupported_voice", "voice"
            )
        resolved = body.model_copy(update={"model": engine, "voice": physical_voice})
        async with slot(principal):
            response = await worker("POST", url, "/internal/speech", json=resolved.model_dump())
        headers = {
            "Content-Disposition": f'inline; filename="speech.{body.response_format}"',
            "X-Engine": engine,
            "X-Sample-Rate": str(body.sample_rate),
            "X-Audio-Encoding": "mp3" if body.response_format == "mp3" else "pcm_s16le",
        }
        for name in ("X-Normalization-Owner", "X-Normalizer-Version"):
            if name in response.headers:
                headers[name] = response.headers[name]
        if alias:
            headers["Warning"] = '299 Voxi "alloy maps to the single ema-tr physical voice"'
        return Response(
            response.content,
            media_type={"wav": "audio/wav", "pcm": "audio/pcm", "mp3": "audio/mpeg"}[
                body.response_format
            ],
            headers=headers,
        )

    @app.post("/v1/audio/transcriptions", dependencies=protected)
    async def transcription(
        request: Request,
        file: Annotated[UploadFile, File()],
        model: Annotated[str, Form()] = "whisper-1",
        language: Annotated[str | None, Form()] = None,
        prompt: Annotated[str | None, Form()] = None,
        response_format: Annotated[str, Form()] = "json",
        temperature: Annotated[float, Form()] = 0,
        word_timestamps: Annotated[bool, Form()] = False,
        timestamp_granularities: Annotated[
            list[str] | None, Form(alias="timestamp_granularities[]")
        ] = None,
    ):
        principal = authorize(request, "audio:write")
        stt_url = resolve_stt(model)
        if model != "whisper-1":
            installed = await worker("GET", stt_url, "/internal/models")
            installed_ids = sorted(row["id"] for row in installed.json()["data"])
            if model not in installed_ids:
                raise PlatformError(
                    400,
                    f"Unknown or disabled STT model; installed: {', '.join(installed_ids)}",
                    "model_not_found",
                    "model",
                )
        if response_format not in TRANSCRIPTION_FORMATS:
            raise PlatformError(
                400,
                "Supported transcription formats: json, text, verbose_json, srt, vtt",
                "unsupported_format",
                "response_format",
            )
        allowed = {
            "file",
            "model",
            "language",
            "prompt",
            "response_format",
            "temperature",
            "word_timestamps",
            "timestamp_granularities[]",
        }
        form = await request.form()
        if set(form) - allowed:
            raise PlatformError(400, "Unsupported multipart fields", "unsupported_parameter")
        try:
            options = TranscriptionRequest(
                language=language, prompt=prompt, temperature=temperature
            )
        except ValidationError:
            raise PlatformError(
                400, "Invalid transcription parameters", "invalid_parameter"
            ) from None
        want_words = resolve_timestamp_granularities(
            response_format=response_format,
            word_timestamps=word_timestamps,
            timestamp_granularities=timestamp_granularities,
        )
        # Per-word timings are only produced for verbose_json; srt/vtt use segment cues.
        want_words = want_words and response_format == "verbose_json"
        data = await file.read(settings.max_upload + 1)
        await file.close()
        if len(data) > settings.max_upload:
            raise PlatformError(413, "Audio upload too large", "file_too_large", "file")
        if not data:
            raise PlatformError(400, "Empty audio upload", "empty_audio", "file")
        fields = {
            key: str(value)
            for key, value in options.model_dump(exclude_none=True).items()
            if key != "word_timestamps"
        }
        if want_words:
            fields["word_timestamps"] = "true"
        async with slot(principal):
            result = await worker(
                "POST",
                stt_url,
                "/internal/transcriptions",
                data=fields,
                files={"file": ("audio", data, file.content_type or "application/octet-stream")},
            )
        transcript = TranscriptionResult.model_validate(result.json())
        if response_format == "text":
            return Response(transcript.text, media_type="text/plain; charset=utf-8")
        if response_format == "verbose_json":
            segments = [dict(segment) for segment in transcript.segments]
            if not want_words:
                for segment in segments:
                    segment.pop("words", None)
            return {
                "text": transcript.text,
                "language": transcript.language,
                "duration": transcript.duration,
                "segments": segments,
            }
        if response_format in {"srt", "vtt"}:
            body = (
                format_srt(transcript.segments)
                if response_format == "srt"
                else format_vtt(transcript.segments)
            )
            media = (
                "text/vtt; charset=utf-8"
                if response_format == "vtt"
                else "text/plain; charset=utf-8"
            )
            return Response(
                body,
                media_type=media,
                headers={"Content-Disposition": f'inline; filename="transcript.{response_format}"'},
            )
        return {"text": transcript.text}

    @app.post("/v1/sessions", status_code=201, dependencies=protected)
    async def create_session(request: Request):
        principal = authorize(request, "realtime:connect")
        session = app.state.broker.create(principal.id)
        return {"session_id": session.id, "call_id": session.call_id}

    @app.post("/v1/sessions/{session_id}/turns", dependencies=protected)
    async def deliver_turn(session_id: str, body: TurnInput, request: Request):
        principal = authorize(request, "realtime:connect")
        session = app.state.broker.get(session_id, principal.id)
        async with slot(principal):
            return await app.state.broker.deliver(session, body, request.state.request_id)

    @app.delete("/v1/sessions/{session_id}", status_code=204, dependencies=protected)
    async def delete_session(session_id: str, request: Request):
        principal = authorize(request, "realtime:connect")
        session = app.state.broker.get(session_id, principal.id)
        app.state.broker.terminate(session)
        return Response(status_code=204)

    @app.websocket("/v1/sessions/{session_id}/stream")
    async def session_stream(websocket: WebSocket, session_id: str):
        principal = await authorize_socket(websocket, "realtime:connect")
        if principal is None:
            return
        try:
            session = app.state.broker.get(session_id, principal.id)
        except PlatformError as exc:
            await websocket.close(code=1008, reason=exc.message)
            return
        if not acquire(principal):
            await websocket.close(code=1013, reason="Client concurrency limit exceeded")
            return

        rate = settings.stream_sample_rate
        requested_rate = websocket.query_params.get("sample_rate")
        if requested_rate is not None:
            if requested_rate not in {"8000", "16000"}:
                await websocket.close(code=1008, reason="sample_rate must be 8000 or 16000")
                release(principal)
                return
            rate = int(requested_rate)

        await websocket.accept()
        playout = session.playout
        endpointer = new_endpointer(rate)
        inbound_audio = InboundAudioBuffer(max_bytes=rate * 20)  # 10 s unconsumed
        chunk_bytes = max(2, int(rate * settings.tts_chunk_ms / 1000) * 2)
        tts_task: asyncio.Task | None = None
        turn_task: asyncio.Task | None = None

        def emit(**event) -> bool:
            model = StreamOutboundEvent.model_validate(event)
            return playout.push_event(model.model_dump(exclude_none=True))

        async def speak(text: str, voice: str | None, generation_id: int) -> None:
            """Stream one generation's audio; stale chunks never reach the caller."""
            if not text.strip():
                emit(type="error", code="empty_speech", message="Spoken action requires text")
                emit(type="state", state="listening")
                return
            engine = "antalia-mini" if (voice or "").startswith("antalia") else "ema-lightning"
            body = SpeechRequest(
                model=engine,
                voice=voice or "ema-tr",
                input=text,
                response_format="pcm",
                sample_rate=cast(Literal[8000, 16000, 24000, 48000], rate),
            )
            sequence = 0
            pending = bytearray()
            streamer = speech_pcm_stream(body)
            try:
                async for pcm in streamer:
                    pending.extend(pcm)
                    while len(pending) >= chunk_bytes:
                        frame = bytes(pending[:chunk_bytes])
                        del pending[:chunk_bytes]
                        if not playout.push_chunk(generation_id, sequence, frame):
                            return
                        sequence += 1
                if pending and not playout.push_chunk(generation_id, sequence, bytes(pending)):
                    return
                if playout.current_generation == generation_id:
                    emit(type="state", state="listening")
            except asyncio.CancelledError:
                return
            except PlatformError as exc:
                emit(type="error", code=exc.code, message=exc.message)
                if playout.current_generation == generation_id:
                    emit(type="state", state="listening")
            except Exception:
                logger.exception("Session stream synthesis failed")
                emit(type="error", code="stream_error", message="Speech streaming failed")
            finally:
                await streamer.aclose()

        def interrupt() -> None:
            """Cancel queued and in-flight audio for the current generation."""
            nonlocal tts_task
            old_generation = session.generation
            if tts_task and not tts_task.done():
                tts_task.cancel()
            session.generation = playout.barge_in()
            emit(type="clear", generation_id=old_generation)

        async def send_loop() -> None:
            try:
                while True:
                    item = await playout.get_next()
                    if item is None:
                        if playout.closed:
                            break
                        continue
                    if isinstance(item, dict):
                        await websocket.send_json(item)
                    else:
                        await websocket.send_bytes(item)
            except (WebSocketDisconnect, asyncio.CancelledError):
                return
            except Exception:
                logger.exception("Session stream sender failed")

        async def run_turn(transcript: str, language: str, context: dict) -> None:
            """Hand one finalized utterance to n8n; n8n alone decides the next action."""
            nonlocal tts_task
            if not transcript.strip():
                emit(type="error", code="empty_turn", message="No transcript available")
                return
            emit(type="state", state="thinking")
            turn = TurnInput(transcript=transcript, language=language, context=context)
            try:
                result = await app.state.broker.deliver(session, turn, f"ws_{session.id}")
            except PlatformError as exc:
                if exc.code == "stale_generation":
                    return
                emit(type="error", code=exc.code, message=exc.message)
                emit(type="state", state="listening")
                return
            action = result.get("action", {})
            emit(type="action", action=action)
            name = action.get("action")
            if name in {"speak", "fallback"}:
                emit(type="state", state="speaking")
                if tts_task and not tts_task.done():
                    tts_task.cancel()
                tts_task = asyncio.create_task(
                    speak(action.get("text") or "", action.get("voice"), result["generation_id"])
                )
            elif name == "transfer":
                emit(type="state", state="transferring")
            elif name == "hangup":
                emit(type="state", state="hangup")
                raise CloseStream(1000, "n8n hangup")
            else:
                emit(type="state", state="listening")

        async def handle_utterance(utterance: Utterance) -> None:
            emit(
                type="speech_ended",
                utterance_id=utterance.utterance_id,
                duration_ms=utterance.duration_ms,
                truncated=utterance.truncated,
            )
            try:
                transcript = await transcribe_pcm(utterance.pcm, sample_rate=rate, language="tr")
            except PlatformError as exc:
                emit(type="error", code=exc.code, message=exc.message)
                emit(type="state", state="listening")
                return
            if not transcript.strip():
                emit(type="state", state="listening")
                return
            emit(
                type="transcript",
                utterance_id=utterance.utterance_id,
                text=transcript,
                duration_ms=utterance.duration_ms,
            )
            await run_turn(transcript, "tr-TR", {})

        def on_vad_event(event: VadEvent) -> None:
            nonlocal turn_task
            if event.name == "speech_started":
                emit(type="speech_started", utterance_id=event.utterance_id)
                if tts_task and not tts_task.done():
                    interrupt()
                    emit(type="state", state="listening")
            elif event.name == "speech_too_long":
                emit(type="error", code="utterance_too_long", message="Utterance exceeded bound")
            elif event.utterance is None:
                emit(type="speech_ended", rejected_ms=event.rejected_ms)
            else:
                if turn_task and not turn_task.done():
                    turn_task.cancel()
                turn_task = asyncio.create_task(handle_utterance(event.utterance))

        async def receive_loop() -> None:
            nonlocal tts_task, turn_task
            emit(type="state", state="connected", generation_id=playout.current_generation)
            while True:
                async with asyncio.timeout(settings.ws_idle_timeout):
                    message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    return
                payload = message.get("bytes") or b""
                if payload:
                    inbound_audio.append(payload)
                    for vad_event in endpointer.feed(payload):
                        on_vad_event(vad_event)
                    continue
                text = message.get("text") or ""
                if not text:
                    continue
                try:
                    event = StreamInboundEvent.model_validate_json(text)
                except ValidationError:
                    emit(
                        type="error",
                        code="invalid_event",
                        message="Unsupported control event",
                    )
                    continue
                if event.type == "ping":
                    emit(type="pong", generation_id=playout.current_generation)
                elif event.type == "barge_in":
                    interrupt()
                    emit(type="state", state="listening")
                elif event.type == "hangup":
                    if tts_task and not tts_task.done():
                        tts_task.cancel()
                    raise CloseStream(1000, "Client hangup")
                elif event.type == "turn":
                    transcript = event.transcript
                    if transcript is None:
                        buffered = inbound_audio.read_all()
                        inbound_audio.clear()
                        endpointer.reset()
                        if not buffered:
                            emit(
                                type="error",
                                code="empty_turn",
                                message="No transcript available",
                            )
                            continue
                        try:
                            transcript = await transcribe_pcm(
                                buffered, sample_rate=rate, language="tr"
                            )
                        except PlatformError as exc:
                            emit(type="error", code=exc.code, message=exc.message)
                            continue
                    await run_turn(transcript, event.language, event.context)

        sender_task = asyncio.create_task(send_loop())
        code, reason = 1000, "Session closed"
        try:
            await receive_loop()
        except CloseStream as close:
            code, reason = close.code, close.reason
        except WebSocketDisconnect:
            pass
        except TimeoutError:
            code, reason = 1000, "Idle timeout"
        except Exception:
            logger.exception("Session stream receiver failed")
            code, reason = 1011, "Internal stream failure"
        finally:
            if tts_task and not tts_task.done():
                tts_task.cancel()
            if turn_task and not turn_task.done():
                turn_task.cancel()
            playout.close()
            await flush_stream(None, sender_task)
            app.state.broker.terminate(session)
            release(principal)
            try:
                await websocket.close(code=code, reason=reason)
            except RuntimeError:
                pass

    @app.websocket("/v1/tts/stream")
    async def tts_stream(websocket: WebSocket):
        """Platform-specific streaming synthesis (TTS-05) with chunk-boundary cancellation."""
        principal = await authorize_socket(websocket, "audio:write")
        if principal is None:
            return
        if not acquire(principal):
            await websocket.close(code=1013, reason="Client concurrency limit exceeded")
            return
        await websocket.accept()

        outbox: asyncio.Queue[bytes | dict | None] = asyncio.Queue(maxsize=64)
        cancel = asyncio.Event()
        job: asyncio.Task | None = None

        async def push(event: dict | bytes) -> None:
            await outbox.put(event)

        async def send_event(**event) -> None:
            model = TtsStreamOutboundEvent.model_validate(event)
            await push(model.model_dump(exclude_none=True))

        async def sender() -> None:
            try:
                while True:
                    item = await outbox.get()
                    if item is None:
                        return
                    if isinstance(item, dict):
                        await websocket.send_json(item)
                    else:
                        await websocket.send_bytes(item)
            except (WebSocketDisconnect, asyncio.CancelledError):
                return
            except Exception:
                logger.exception("TTS stream sender failed")

        async def stream_one(config: TtsStreamRequest) -> None:
            generation_id = config.generation_id
            try:
                engine, _, physical_voice = resolve_tts(config.model, config.voice)
            except PlatformError as exc:
                await send_event(
                    type="error",
                    code=exc.code,
                    message=exc.message,
                    generation_id=generation_id,
                )
                return
            alias = config.voice == "alloy" and settings.allow_alloy and engine == "ema-lightning"
            if config.voice != physical_voice and not alias:
                await send_event(
                    type="error",
                    code="unsupported_voice",
                    message=f"Supported physical voice: {physical_voice}",
                    generation_id=generation_id,
                )
                return
            await send_event(
                type="meta",
                generation_id=generation_id,
                sample_rate=config.sample_rate,
                channels=1,
                encoding="pcm_s16le",
                chunk_ms=config.chunk_ms,
            )
            body = SpeechRequest(
                model=config.model,
                voice=config.voice,
                input=config.input,
                response_format="pcm",
                sample_rate=config.sample_rate,
                speed=config.speed,
                seed=config.seed,
            )
            chunk_bytes = max(2, int(config.sample_rate * config.chunk_ms / 1000) * 2)
            streamer = speech_pcm_stream(body)
            pending = bytearray()
            sequence = 0
            pcm_bytes = 0
            cancelled = False
            failed = False
            try:
                async for chunk in streamer:
                    if cancel.is_set():
                        cancelled = True
                        break
                    pending.extend(chunk)
                    pcm_bytes += len(chunk)
                    while len(pending) >= chunk_bytes:
                        frame = bytes(pending[:chunk_bytes])
                        del pending[:chunk_bytes]
                        # Bounded outbox: a stalled client slows generation, never buffers forever.
                        await push(pack_audio_frame(generation_id, sequence, frame))
                        sequence += 1
                        if cancel.is_set():
                            break
                    if cancel.is_set():
                        cancelled = True
                        break
                if not cancelled and pending:
                    await push(pack_audio_frame(generation_id, sequence, bytes(pending)))
                    sequence += 1
            except asyncio.CancelledError:
                return
            except PlatformError as exc:
                failed = True
                await send_event(
                    type="error",
                    code=exc.code,
                    message=exc.message,
                    generation_id=generation_id,
                )
            except Exception:
                failed = True
                logger.exception("TTS stream synthesis failed")
                await send_event(
                    type="error",
                    code="stream_error",
                    message="Speech streaming failed",
                    generation_id=generation_id,
                )
            finally:
                await streamer.aclose()
            if failed:
                return
            if cancelled:
                await send_event(type="cancelled", generation_id=generation_id, chunks=sequence)
            else:
                await send_event(
                    type="done",
                    generation_id=generation_id,
                    chunks=sequence,
                    duration_ms=int(pcm_bytes * 500 / config.sample_rate),
                )

        sender_task = asyncio.create_task(sender())
        try:
            while True:
                async with asyncio.timeout(settings.ws_idle_timeout):
                    message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                text = message.get("text")
                if not text:
                    await send_event(
                        type="error", code="invalid_frame", message="Expected a JSON control frame"
                    )
                    continue
                try:
                    payload = json.loads(text)
                except ValueError:
                    await send_event(
                        type="error", code="invalid_json", message="Control frame is not JSON"
                    )
                    continue
                if job is not None and not job.done():
                    try:
                        control = TtsStreamControl.model_validate(payload)
                    except ValidationError:
                        await send_event(
                            type="error",
                            code="invalid_event",
                            message="Expected cancel or ping during an active stream",
                        )
                        continue
                    if control.type == "cancel":
                        cancel.set()
                    else:
                        await send_event(type="pong")
                    continue
                try:
                    config = TtsStreamRequest.model_validate(payload)
                except ValidationError as exc:
                    await send_event(
                        type="error",
                        code="invalid_request",
                        message="Invalid speak request: " + str(exc.errors()[0]["msg"]),
                    )
                    continue
                cancel.clear()
                job = asyncio.create_task(stream_one(config))
        except TimeoutError:
            logger.info("TTS stream idle timeout; closing socket")
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except Exception:
            logger.exception("TTS stream receiver failed")
        finally:
            if job is not None and not job.done():
                job.cancel()
            await flush_stream(outbox, sender_task)
            release(principal)
            try:
                await websocket.close(code=1000, reason="Stream closed")
            except RuntimeError:
                pass

    @app.websocket("/v1/realtime/transcriptions")
    async def realtime_transcriptions(websocket: WebSocket):
        """Windowed near-real-time transcription (STT-07); not OpenAI Realtime compatibility."""
        principal = await authorize_socket(websocket, "audio:write")
        if principal is None:
            return
        if not acquire(principal):
            await websocket.close(code=1013, reason="Client concurrency limit exceeded")
            return
        await websocket.accept()

        outbox: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=128)

        async def send_event(**event) -> None:
            model = TranscriptionOutboundEvent.model_validate(event)
            await outbox.put(model.model_dump(exclude_none=True))

        async def sender() -> None:
            try:
                while True:
                    event = await outbox.get()
                    if event is None:
                        return
                    await websocket.send_json(event)
            except (WebSocketDisconnect, asyncio.CancelledError):
                return
            except Exception:
                logger.exception("Realtime transcription sender failed")

        sender_task = asyncio.create_task(sender())
        code, reason = 1000, "Session ended"
        partial_task: asyncio.Task | None = None
        revisions: dict[str, int] = {}
        try:
            async with asyncio.timeout(settings.ws_idle_timeout):
                first = await websocket.receive()
            if first["type"] == "websocket.disconnect":
                return
            try:
                start = RealtimeTranscriptionStart.model_validate_json(first.get("text") or "")
            except (ValidationError, ValueError):
                await send_event(
                    type="error",
                    code="invalid_request",
                    message="First frame must be a valid session.start event",
                )
                raise CloseStream(1008, "Invalid handshake") from None
            else:
                try:
                    endpointer = new_endpointer(
                        start.sample_rate,
                        start_ms=start.start_ms,
                        end_ms=start.end_ms,
                        min_speech_ms=start.min_speech_ms,
                        max_utterance_ms=start.max_utterance_ms,
                    )
                except ValueError:
                    await send_event(
                        type="error",
                        code="invalid_request",
                        message="VAD timing exceeds the utterance bound",
                    )
                    raise CloseStream(1008, "Invalid VAD timing") from None
                rate = start.sample_rate
                audio_budget = int(rate * 2 * 600)  # 10 minutes per socket
                fed_bytes = 0
                last_partial_ms = 0
                # The STT worker reserves a single inference slot; a partial still in
                # flight when an utterance ends would otherwise 429 the final request,
                # so serialize every recognize() call for this session.
                recognize_lock = asyncio.Lock()
                await send_event(
                    type="session.started",
                    session_id=uuid.uuid4().hex,
                    sample_rate=rate,
                    mode="windowed",
                    vad={
                        "start_ms": start.start_ms,
                        "end_ms": start.end_ms,
                        "min_speech_ms": start.min_speech_ms,
                        "max_utterance_ms": start.max_utterance_ms,
                        "partial_interval_ms": start.partial_interval_ms,
                    },
                )

                async def recognize(pcm: bytes) -> str:
                    async with recognize_lock:
                        # A cancelled partial can leave its inference still draining in
                        # the single-slot worker, so the final request may briefly see a
                        # 429/503. Retry with backoff rather than failing the transcript.
                        return await recognize_with_retry(
                            lambda: transcribe_pcm(
                                pcm,
                                sample_rate=rate,
                                language=start.language,
                                prompt=start.prompt,
                            )
                        )

                async def emit_final(utterance: Utterance) -> None:
                    try:
                        text = await recognize(utterance.pcm)
                    except PlatformError as exc:
                        await send_event(type="error", code=exc.code, message=exc.message)
                        return
                    revision = revisions.get(utterance.utterance_id, 0) + 1
                    revisions[utterance.utterance_id] = revision
                    await send_event(
                        type="transcript.final",
                        utterance_id=utterance.utterance_id,
                        text=text,
                        revision=revision,
                        mode="windowed",
                        duration_ms=utterance.duration_ms,
                        started_ms=utterance.started_ms,
                        ended_ms=utterance.ended_ms,
                        truncated=utterance.truncated,
                    )

                async def emit_partial(utterance_id: str, pcm: bytes) -> None:
                    try:
                        text = await recognize(pcm)
                    except PlatformError:
                        return
                    if endpointer.active_utterance_id != utterance_id:
                        return
                    revision = revisions.get(utterance_id, 0) + 1
                    revisions[utterance_id] = revision
                    await send_event(
                        type="transcript.partial",
                        utterance_id=utterance_id,
                        text=text,
                        revision=revision,
                        mode="windowed",
                    )

                async def drain_events(events: list[VadEvent]) -> None:
                    nonlocal partial_task
                    for event in events:
                        if event.name == "speech_started":
                            await send_event(
                                type="speech.started",
                                utterance_id=event.utterance_id,
                                started_ms=event.started_ms,
                            )
                        elif event.name == "speech_too_long":
                            await send_event(
                                type="error",
                                code="utterance_too_long",
                                message="Utterance exceeded the configured bound",
                            )
                        elif event.name == "speech_ended":
                            if event.utterance is None:
                                await send_event(
                                    type="speech.ended",
                                    utterance_id=event.utterance_id,
                                    ended_ms=event.position_ms,
                                    started_ms=event.started_ms,
                                    rejected_ms=event.rejected_ms,
                                )
                                continue
                            if partial_task is not None and not partial_task.done():
                                partial_task.cancel()
                            await send_event(
                                type="speech.ended",
                                utterance_id=event.utterance_id,
                                ended_ms=event.position_ms,
                                started_ms=event.started_ms,
                                duration_ms=event.utterance.duration_ms,
                            )
                            await emit_final(event.utterance)

                while True:
                    async with asyncio.timeout(settings.ws_idle_timeout):
                        message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    payload = message.get("bytes") or b""
                    if payload:
                        fed_bytes += len(payload)
                        if fed_bytes > audio_budget:
                            await send_event(
                                type="error",
                                code="session_audio_limit_exceeded",
                                message="Socket exceeded its transcription audio budget",
                            )
                            raise CloseStream(1013, "Session audio budget exceeded")
                        await drain_events(endpointer.feed(payload))
                        if endpointer.in_speech and (
                            endpointer.position_ms - last_partial_ms >= start.partial_interval_ms
                        ):
                            snapshot = endpointer.active_pcm()
                            utterance_id = endpointer.active_utterance_id
                            if (
                                snapshot
                                and utterance_id
                                and (partial_task is None or partial_task.done())
                            ):
                                last_partial_ms = endpointer.position_ms
                                partial_task = asyncio.create_task(
                                    emit_partial(utterance_id, snapshot)
                                )
                        continue
                    text = message.get("text") or ""
                    if not text:
                        continue
                    try:
                        control = RealtimeTranscriptionControl.model_validate_json(text)
                    except ValidationError:
                        await send_event(
                            type="error",
                            code="invalid_event",
                            message="Expected flush, ping or session.stop",
                        )
                        continue
                    if control.type == "ping":
                        await send_event(type="pong")
                    elif control.type == "flush":
                        await drain_events(endpointer.flush())
                    else:
                        await drain_events(endpointer.flush())
                        await send_event(type="session.ended")
                        return
        except CloseStream as close:
            code, reason = close.code, close.reason
        except TimeoutError:
            code, reason = 1000, "Idle timeout"
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except Exception:
            logger.exception("Realtime transcription session failed")
            code, reason = 1011, "Internal transcription failure"
        finally:
            if partial_task is not None and not partial_task.done():
                partial_task.cancel()
            await flush_stream(outbox, sender_task)
            release(principal)
            try:
                await websocket.close(code=code, reason=reason)
            except RuntimeError:
                pass

    return app


app = create_app()
