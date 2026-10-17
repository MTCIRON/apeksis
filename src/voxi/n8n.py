# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError

from voxi.contracts import TurnAction, TurnInput
from voxi.errors import PlatformError
from voxi.media import PlayoutBuffer


@dataclass
class Session:
    id: str
    call_id: str
    owner: str
    sequence: int = 0
    generation: int = 0
    touched: float = field(default_factory=time.monotonic)
    task: asyncio.Task | None = None
    playout: PlayoutBuffer = field(default_factory=PlayoutBuffer)


class TurnBroker:
    """Transport-only session isolation. n8n remains sole owner of decisions and memory."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        url: str,
        key: str,
        targets: frozenset[str] = frozenset(),
        timeout: float = 10,
        fallback_text: str = "Üzgünüm, hizmet şu anda kullanılamıyor.",
        capacity: int = 100,
        ttl: float = 600,
    ):
        if url:
            parsed = urlsplit(url)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError(
                    "n8n URL must be fixed HTTP(S), without credentials/query/fragment"
                )
            if len(key) < 32:
                raise ValueError("VOXI_N8N_API_KEY must contain at least 32 characters")
        if timeout <= 0 or capacity < 1 or ttl <= 0:
            raise ValueError("n8n timeout, capacity and TTL must be positive")
        self.client = client
        self.url = url
        self.key = key
        self.targets = targets
        self.timeout = timeout
        self.fallback_text = fallback_text
        self.capacity = capacity
        self.ttl = ttl
        self.sessions: dict[str, Session] = {}

    def reap(self):
        now = time.monotonic()
        for session in list(self.sessions.values()):
            if now - session.touched > self.ttl:
                self.terminate(session)

    def create(self, owner: str) -> Session:
        if not self.url:
            raise PlatformError(503, "n8n turn delivery is not configured", "n8n_unconfigured")
        self.reap()
        if len(self.sessions) >= self.capacity:
            raise PlatformError(429, "Session capacity exhausted", "capacity_exceeded")
        session = Session(uuid.uuid4().hex, uuid.uuid4().hex, owner)
        self.sessions[session.id] = session
        return session

    def get(self, session_id: str, owner: str) -> Session:
        self.reap()
        session = self.sessions.get(session_id)
        if session is None or session.owner != owner:
            raise PlatformError(404, "Session not found", "session_not_found")
        session.touched = time.monotonic()
        return session

    def terminate(self, session: Session):
        session.generation += 1
        if session.task:
            session.task.cancel()
        self.sessions.pop(session.id, None)
        session.playout.close()

    def close(self):
        for session in list(self.sessions.values()):
            self.terminate(session)

    def validate(self, action: TurnAction, expected: str):
        if action.idempotency_key != expected:
            raise ValueError("n8n idempotency key mismatch")
        if action.action in {"speak", "fallback"}:
            if not action.text or not action.text.strip():
                raise ValueError("spoken actions require text")
            if action.language not in {"tr", "tr-TR"}:
                raise ValueError("only Turkish speech supported")
            if action.voice not in {None, "ema-tr", "antalia-tr"}:
                raise ValueError("unknown voice")
        if action.action == "transfer":
            if action.transfer_target not in self.targets:
                raise ValueError("transfer target not allowlisted")
        elif action.transfer_target is not None:
            raise ValueError("transfer_target only valid for transfer")

    async def deliver(self, session: Session, turn: TurnInput, correlation_id: str) -> dict:
        session.sequence += 1
        session.generation += 1
        generation = session.generation
        session.playout.new_generation(generation)
        session.touched = time.monotonic()
        if session.task:
            session.task.cancel()
        turn_id = uuid.uuid4().hex
        expected = f"{session.call_id}:{turn_id}"
        payload = {
            "schema_version": "1.0",
            "event_type": "utterance.final",
            "call_id": session.call_id,
            "session_id": session.id,
            "turn_id": turn_id,
            "sequence": session.sequence,
            "generation_id": generation,
            "correlation_id": correlation_id,
            "timestamp": datetime.now(UTC).isoformat(),
            "language": turn.language,
            "transcript": turn.transcript,
            "caller": {"number": "redacted"},
            "context": turn.context,
        }

        async def invoke():
            try:
                # One bounded attempt. No redirects or proxy-env routing of speech data.
                async with asyncio.timeout(self.timeout):
                    async with self.client.stream(
                        "POST",
                        self.url,
                        json=payload,
                        headers={
                            "Authorization": f"Bearer {self.key}",
                            "Idempotency-Key": expected,
                            "X-Request-ID": correlation_id,
                        },
                        timeout=self.timeout,
                    ) as response:
                        response.raise_for_status()
                        data = bytearray()
                        async for chunk in response.aiter_bytes():
                            if len(data) + len(chunk) > 65536:
                                raise ValueError("n8n response too large")
                            data.extend(chunk)
                    action = TurnAction.model_validate_json(data)
                    self.validate(action, expected)
                    return action
            except (httpx.HTTPError, TimeoutError, ValidationError, ValueError):
                return TurnAction(
                    schema_version="1.0",
                    action="fallback",
                    text=self.fallback_text,
                    idempotency_key=expected,
                )

        task = asyncio.create_task(invoke())
        session.task = task
        try:
            action = await task
        except asyncio.CancelledError:
            if generation != session.generation or session.id not in self.sessions:
                raise PlatformError(
                    409, "Turn superseded or session ended", "stale_generation"
                ) from None
            task.cancel()
            raise
        finally:
            if session.task is task:
                session.task = None
        if generation != session.generation or session.id not in self.sessions:
            raise PlatformError(409, "Turn superseded or session ended", "stale_generation")
        return {
            "generation_id": generation,
            "turn_id": turn_id,
            "action": action.model_dump(exclude_none=True),
        }
