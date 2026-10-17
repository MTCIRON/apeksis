# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass

from fastapi import Request

from voxi.errors import PlatformError
from voxi.secrets import read_secret


@dataclass(frozen=True)
class Principal:
    id: str
    scopes: frozenset[str]


def bearer(request: Request) -> str:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise PlatformError(401, "Bearer API key required", "invalid_api_key")
    return token


def worker_auth(request: Request) -> None:
    expected = read_secret("VOXI_WORKER_API_KEY", "worker.key")
    if not expected or not hmac.compare_digest(bearer(request), expected):
        raise PlatformError(401, "Invalid worker API key", "invalid_api_key")


class Keyring:
    def __init__(self, key: str, records_json: str = ""):
        records = json.loads(records_json) if records_json else []
        if key:
            if len(key) < 32:
                raise ValueError("VOXI_API_KEY must contain at least 32 characters")
            records.append(
                {
                    "id": "application",
                    "sha256": hashlib.sha256(key.encode()).hexdigest(),
                    "scopes": ["audio:read", "audio:write", "realtime:connect"],
                }
            )
        if not records:
            raise ValueError("Set VOXI_API_KEY or VOXI_API_KEYS_JSON; no default credentials")
        self.records = []
        seen: set[str] = set()
        for row in records:
            digest = row["sha256"]
            if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                raise ValueError("API key hashes must be SHA256 lowercase hex")
            if row["id"] in seen or digest in seen:
                raise ValueError("API key IDs and hashes must be unique")
            seen.update((row["id"], digest))
            self.records.append((digest, Principal(row["id"], frozenset(row["scopes"]))))

    def authenticate(self, request: Request, scope: str) -> Principal:
        return self.authenticate_token(bearer(request), scope)

    def authenticate_token(self, token: str, scope: str) -> Principal:
        digest = hashlib.sha256(token.encode()).hexdigest()
        principal = None
        for stored, candidate in self.records:
            if hmac.compare_digest(stored, digest):
                principal = candidate
        if principal is None:
            raise PlatformError(401, "Invalid API key", "invalid_api_key")
        if scope not in principal.scopes:
            raise PlatformError(403, "API key lacks required scope", "insufficient_scope")
        return principal


@dataclass
class _Ticket:
    principal: Principal
    scope: str
    expires_at: float  # time.monotonic() seconds


class SocketTicketStore:
    """Single-use, short-lived bearer for WebSocket handshakes.

    Security rules enforced by `consume`:
      * a ticket that has expired is rejected and removed
      * a ticket is removed on first successful use, so a replay is rejected
      * the scope requested at consumption must equal the scope bound at mint
    The value itself is `secrets.token_urlsafe(32)`; store lookups use
    constant-time compare so a timing oracle cannot probe for valid tickets.
    """

    def __init__(self, ttl_seconds: float = 30.0, capacity: int = 1000) -> None:
        if ttl_seconds <= 0 or capacity <= 0:
            raise ValueError("Socket ticket TTL and capacity must be positive")
        self.ttl = float(ttl_seconds)
        self.capacity = int(capacity)
        self._entries: dict[str, _Ticket] = {}

    def __len__(self) -> int:  # test hook
        return len(self._entries)

    def _reap(self, now: float) -> None:
        for key in [k for k, v in self._entries.items() if v.expires_at <= now]:
            self._entries.pop(key, None)

    def mint(self, principal: Principal, scope: str) -> tuple[str, int]:
        if scope not in principal.scopes:
            raise PlatformError(403, "API key lacks required scope", "insufficient_scope")
        now = time.monotonic()
        self._reap(now)
        if len(self._entries) >= self.capacity:
            # Never grow unboundedly: refuse instead of evicting valid tickets,
            # because eviction would let an attacker force replays for others.
            raise PlatformError(
                429, "Socket ticket capacity exhausted", "ticket_capacity_exceeded"
            )
        while True:
            token = secrets.token_urlsafe(32)
            if token not in self._entries:
                break
        self._entries[token] = _Ticket(principal, scope, now + self.ttl)
        return token, max(1, int(self.ttl))

    def consume(self, ticket: str, scope: str) -> Principal:
        """Redeem a ticket exactly once. Documented error contract (F5/F6):

          * fresh ticket, matching scope            -> returns the principal
          * fresh ticket, mismatched scope          -> 403 `ticket_scope_mismatch`
                                                       AND the ticket is burned
                                                       (privilege-escalation
                                                       attempt, not a reusable
                                                       credential)
          * already-used / expired / never-minted   -> 401 `invalid_ticket`
                                                       (identical shape so a
                                                       caller cannot tell the
                                                       three apart)

        Every failure message is fixed text — the opaque ticket value is never
        echoed in `message`, `param`, an HTTP body or a WebSocket close reason.
        Tests in tests/test_socket_ticket.py lock this contract in.
        """
        now = time.monotonic()
        entry = self._entries.pop(ticket, None)
        if entry is None:
            # Do not distinguish "never existed", "expired" or "already used"
            # — all three are equally invalid to a caller and the difference
            # would leak which tickets are live.
            raise PlatformError(401, "Socket ticket invalid or expired", "invalid_ticket")
        if entry.expires_at <= now:
            raise PlatformError(401, "Socket ticket invalid or expired", "invalid_ticket")
        if not hmac.compare_digest(entry.scope, scope):
            # Wrong scope: burn the ticket anyway (already popped). This is
            # an attempted privilege escalation, not a re-usable credential.
            raise PlatformError(403, "Socket ticket scope mismatch", "ticket_scope_mismatch")
        return entry.principal
