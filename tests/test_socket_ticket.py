# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""F5 · Short-lived, single-use WebSocket handshake ticket.

Two layers are covered here:

* SocketTicketStore unit tests exercise the state machine directly (mint,
  consume, replay, expiry, scope mismatch, capacity) so a regression in the
  primitive fails loudly rather than surfacing as an opaque 401 in a socket.
* Gateway HTTP/WS tests check that the endpoint mints correctly, that
  authorize_socket prefers the ticket when one is supplied, that `?token=`
  still works for existing clients, and that the ticket cannot be reused or
  swapped across scopes.

Time is monkeypatched through `time.monotonic` inside the store; we never
sleep in the suite. See src/voxi/auth.py::SocketTicketStore.
"""

import hashlib
import json
import time

import httpx
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from voxi.auth import Principal, SocketTicketStore, _Ticket
from voxi.errors import PlatformError
from voxi.gateway import Settings, create_app

KEY = "k" * 32
WORKER_KEY = "w" * 32


def _app(handler=None, **overrides):
    options: dict = {"api_key": KEY, "worker_key": WORKER_KEY}
    options.update(overrides)
    if handler is None:

        async def handler(request):  # pragma: no cover - unused by these tests
            raise AssertionError("no worker call expected")

    return create_app(
        Settings(**options), client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )


# ------------------------------------------------------------------ store


def test_ticket_mint_and_consume_round_trip():
    store = SocketTicketStore(ttl_seconds=30.0, capacity=4)
    principal = Principal("app", frozenset({"audio:write"}))
    ticket, expires_in = store.mint(principal, "audio:write")
    assert expires_in == 30
    assert len(store) == 1
    assert store.consume(ticket, "audio:write") is principal
    # Single-use: the second consume must fail exactly like a bogus value.
    with pytest.raises(PlatformError) as replay:
        store.consume(ticket, "audio:write")
    assert replay.value.status == 401
    assert replay.value.code == "invalid_ticket"


def test_ticket_scope_mismatch_burns_the_ticket():
    store = SocketTicketStore(ttl_seconds=30.0, capacity=4)
    principal = Principal("app", frozenset({"audio:write", "realtime:connect"}))
    ticket, _ = store.mint(principal, "audio:write")
    with pytest.raises(PlatformError) as swap:
        store.consume(ticket, "realtime:connect")
    assert swap.value.status == 403
    assert swap.value.code == "ticket_scope_mismatch"
    # Ticket was popped; nothing to leak even if the attacker retries.
    assert len(store) == 0


def test_ticket_mint_rejects_scope_principal_does_not_have():
    store = SocketTicketStore(ttl_seconds=30.0, capacity=4)
    principal = Principal("app", frozenset({"audio:read"}))
    with pytest.raises(PlatformError) as exc:
        store.mint(principal, "audio:write")
    assert exc.value.status == 403


def test_ticket_expiry_reaps_and_rejects():
    store = SocketTicketStore(ttl_seconds=0.05, capacity=4)
    principal = Principal("app", frozenset({"audio:write"}))
    ticket, _ = store.mint(principal, "audio:write")
    # Rewind the entry's expiry directly: same effect as wall-clock elapse
    # without making the suite sleep.
    store._entries[ticket].expires_at = time.monotonic() - 1
    with pytest.raises(PlatformError) as expired:
        store.consume(ticket, "audio:write")
    assert expired.value.status == 401
    assert expired.value.code == "invalid_ticket"


def test_ticket_capacity_refuses_instead_of_evicting():
    store = SocketTicketStore(ttl_seconds=30.0, capacity=2)
    principal = Principal("app", frozenset({"audio:write"}))
    first, _ = store.mint(principal, "audio:write")
    second, _ = store.mint(principal, "audio:write")
    with pytest.raises(PlatformError) as overflow:
        store.mint(principal, "audio:write")
    assert overflow.value.status == 429
    assert overflow.value.code == "ticket_capacity_exceeded"
    # Existing tickets remain valid; capacity is a refusal, not an eviction.
    assert store.consume(first, "audio:write") is principal
    assert store.consume(second, "audio:write") is principal


def test_ticket_unknown_value_looks_like_expired():
    store = SocketTicketStore(ttl_seconds=30.0, capacity=2)
    with pytest.raises(PlatformError) as exc:
        store.consume("never-existed-never-will", "audio:write")
    assert exc.value.status == 401
    assert exc.value.code == "invalid_ticket"


def test_ticket_scope_mismatch_then_replay_is_401():
    """Documented state machine:

      fresh ticket + wrong scope   -> 403 ticket_scope_mismatch (and burned)
      that same ticket again       -> 401 invalid_ticket (indistinguishable
                                      from a value that never existed)

    The 403 only ever fires on the very first, still-valid use. Once burned,
    every subsequent attempt — right scope or wrong — is the same 401, so an
    observer cannot tell 'replay' from 'expired' from 'never minted'.
    """
    store = SocketTicketStore(ttl_seconds=30.0, capacity=4)
    principal = Principal("app", frozenset({"audio:write", "realtime:connect"}))
    ticket, _ = store.mint(principal, "audio:write")
    with pytest.raises(PlatformError) as mismatch:
        store.consume(ticket, "realtime:connect")
    assert mismatch.value.status == 403
    assert mismatch.value.code == "ticket_scope_mismatch"
    # Any retry now, correct scope included, is the generic invalid response.
    for scope in ("audio:write", "realtime:connect"):
        with pytest.raises(PlatformError) as after:
            store.consume(ticket, scope)
        assert after.value.status == 401
        assert after.value.code == "invalid_ticket"


@pytest.mark.parametrize("code", ["scope", "replay", "unknown"])
def test_ticket_errors_never_leak_the_ticket_value(code):
    """The opaque value is a bearer-like secret; no error message may echo it.

    A leak would let an attacker confirm that a guessed ticket exists (or
    existed) purely from the error text, defeating the single-use guarantee.
    """
    store = SocketTicketStore(ttl_seconds=30.0, capacity=4)
    principal = Principal("app", frozenset({"audio:write", "realtime:connect"}))
    secret = "SEKR-TKT-" + "x" * 24
    store._entries[secret] = _Ticket(principal, "audio:write", time.monotonic() + 30)
    if code == "scope":
        bad_scope = "realtime:connect"
        probe = secret
    elif code == "replay":
        store.consume(secret, "audio:write")
        bad_scope = "audio:write"
        probe = secret
    else:
        bad_scope = "audio:write"
        probe = "totally-unknown-value"
    with pytest.raises(PlatformError) as exc:
        store.consume(probe, bad_scope)
    assert probe not in exc.value.message
    assert probe not in str(exc.value)
    assert exc.value.param is None


def test_ticket_rejects_bad_configuration():
    with pytest.raises(ValueError):
        SocketTicketStore(ttl_seconds=0, capacity=1)
    with pytest.raises(ValueError):
        SocketTicketStore(ttl_seconds=1, capacity=0)


# ------------------------------------------------------------------ gateway HTTP


def test_socket_ticket_endpoint_requires_bearer():
    app = _app()
    with TestClient(app) as client:
        refused = client.post("/v1/auth/socket", json={"scope": "audio:write"})
        assert refused.status_code == 401
        assert refused.json()["error"]["code"] == "invalid_api_key"


def test_socket_ticket_endpoint_returns_opaque_value():
    app = _app()
    with TestClient(app) as client:
        created = client.post(
            "/v1/auth/socket",
            json={"scope": "audio:write"},
            headers={"Authorization": f"Bearer {KEY}"},
        )
        assert created.status_code == 201
        body = created.json()
        assert isinstance(body["ticket"], str) and len(body["ticket"]) >= 16
        assert body["expires_in"] >= 1
        # Ticket must not be the API key or its hash; opaque to the client.
        assert body["ticket"] != KEY
        assert body["ticket"] != hashlib.sha256(KEY.encode()).hexdigest()


def test_socket_ticket_endpoint_rejects_unknown_scope():
    app = _app()
    with TestClient(app) as client:
        bad = client.post(
            "/v1/auth/socket",
            json={"scope": "nonsense:scope"},
            headers={"Authorization": f"Bearer {KEY}"},
        )
        assert bad.status_code in {400, 422}


def test_socket_ticket_endpoint_rejects_extra_fields():
    app = _app()
    with TestClient(app) as client:
        bad = client.post(
            "/v1/auth/socket",
            json={"scope": "audio:write", "role": "admin"},
            headers={"Authorization": f"Bearer {KEY}"},
        )
        assert bad.status_code in {400, 422}


def test_socket_ticket_endpoint_respects_principal_scopes():
    read_key = "r" * 32
    records = json.dumps(
        [
            {
                "id": "watcher",
                "sha256": hashlib.sha256(read_key.encode()).hexdigest(),
                "scopes": ["audio:read"],
            }
        ]
    )
    app = create_app(
        Settings(api_keys_json=records, worker_key=WORKER_KEY),
        client=httpx.AsyncClient(transport=httpx.MockTransport(_unused)),
    )
    with TestClient(app) as client:
        denied = client.post(
            "/v1/auth/socket",
            json={"scope": "audio:write"},
            headers={"Authorization": f"Bearer {read_key}"},
        )
        assert denied.status_code == 403


async def _unused(request):  # pragma: no cover - placeholder for MockTransport
    raise AssertionError("no worker call expected")


# ------------------------------------------------------------------ gateway WS


def test_ws_connect_accepts_valid_ticket():
    async def handler(request):
        assert request.url.path == "/internal/speech/stream"
        return httpx.Response(200, content=b"\x00\x00" * 400)

    app = _app(handler, ws_idle_timeout=5)
    with TestClient(app) as client:
        mint = client.post(
            "/v1/auth/socket",
            json={"scope": "audio:write"},
            headers={"Authorization": f"Bearer {KEY}"},
        )
        ticket = mint.json()["ticket"]
        with client.websocket_connect(f"/v1/tts/stream?ticket={ticket}") as websocket:
            websocket.send_json(
                {
                    "type": "speak",
                    "model": "ema-lightning",
                    "input": "Merhaba",
                    "voice": "ema-tr",
                    "sample_rate": 16000,
                    "chunk_ms": 20,
                    "generation_id": 1,
                }
            )
            # The socket opened: at minimum a meta frame or an error frame
            # should arrive; either way the handshake was accepted.
            first = websocket.receive()
            assert first.get("type") != "websocket.close" or first.get("code") != 1008


def test_ws_connect_replays_same_ticket():
    async def handler(request):
        return httpx.Response(200, content=b"\x00\x00" * 400)

    app = _app(handler, ws_idle_timeout=5)
    with TestClient(app) as client:
        mint = client.post(
            "/v1/auth/socket",
            json={"scope": "audio:write"},
            headers={"Authorization": f"Bearer {KEY}"},
        )
        ticket = mint.json()["ticket"]
        # First use succeeds; second use must be rejected as invalid.
        with client.websocket_connect(f"/v1/tts/stream?ticket={ticket}") as websocket:
            websocket.send_json(
                {
                    "type": "speak",
                    "model": "ema-lightning",
                    "input": "Merhaba",
                    "voice": "ema-tr",
                    "sample_rate": 16000,
                    "chunk_ms": 20,
                    "generation_id": 1,
                }
            )
            websocket.receive()  # drain a frame or reject signal
        with pytest.raises(WebSocketDisconnect) as replay:
            with client.websocket_connect(f"/v1/tts/stream?ticket={ticket}"):
                pass
        assert replay.value.code == 1008


def test_ws_ticket_scope_mismatch_cannot_open_other_route():
    async def handler(request):  # pragma: no cover - unused on rejection
        raise AssertionError("worker must not be called on rejected handshake")

    app = _app(handler, ws_idle_timeout=5)
    with TestClient(app) as client:
        # Real-time scope: the application key holds realtime:connect too, so
        # a ticket minted for that scope cannot open the audio:write route.
        mint = client.post(
            "/v1/auth/socket",
            json={"scope": "realtime:connect"},
            headers={"Authorization": f"Bearer {KEY}"},
        )
        ticket = mint.json()["ticket"]
        with pytest.raises(WebSocketDisconnect) as mismatch:
            with client.websocket_connect(f"/v1/tts/stream?ticket={ticket}"):
                pass
        assert mismatch.value.code == 1008


def test_ws_connect_still_accepts_legacy_token_query():
    """Backwards-compatibility contract: existing integrations keep working."""

    async def handler(request):
        return httpx.Response(200, content=b"\x00\x00" * 400)

    app = _app(handler, ws_idle_timeout=5)
    with TestClient(app) as client:
        with client.websocket_connect(f"/v1/tts/stream?token={KEY}") as websocket:
            websocket.send_json(
                {
                    "type": "speak",
                    "model": "ema-lightning",
                    "input": "Merhaba",
                    "voice": "ema-tr",
                    "sample_rate": 16000,
                    "chunk_ms": 20,
                    "generation_id": 1,
                }
            )
            first = websocket.receive()
            assert first.get("type") != "websocket.close" or first.get("code") != 1008


def test_settings_validate_ticket_window():
    """TTL > 300 s or non-positive capacity is a config error, not silent."""
    with pytest.raises(ValueError):
        Settings(api_key=KEY, worker_key=WORKER_KEY, ws_ticket_ttl=400).validate()
    with pytest.raises(ValueError):
        Settings(api_key=KEY, worker_key=WORKER_KEY, ws_ticket_capacity=0).validate()


def test_http_and_ws_error_bodies_never_contain_the_ticket():
    """End-to-end non-leak: the minted value must not appear in any later
    error response (HTTP JSON body or WebSocket close reason), even when the
    client replays or misuses its own ticket.
    """

    async def handler(request):
        return httpx.Response(200, content=b"\x00\x00" * 400)

    app = _app(handler, ws_idle_timeout=5)
    with TestClient(app) as client:
        mint = client.post(
            "/v1/auth/socket",
            json={"scope": "audio:write"},
            headers={"Authorization": f"Bearer {KEY}"},
        )
        ticket = mint.json()["ticket"]
        assert len(ticket) >= 16
        # Burn the ticket on a valid handshake.
        with client.websocket_connect(f"/v1/tts/stream?ticket={ticket}") as websocket:
            websocket.send_json(
                {
                    "type": "speak",
                    "model": "ema-lightning",
                    "input": "Merhaba",
                    "voice": "ema-tr",
                    "sample_rate": 16000,
                    "chunk_ms": 20,
                    "generation_id": 1,
                }
            )
            websocket.receive()
        # Replayed handshake must fail with a reason that omits the value.
        with pytest.raises(WebSocketDisconnect) as replay:
            with client.websocket_connect(f"/v1/tts/stream?ticket={ticket}"):
                pass
        assert replay.value.code == 1008
        assert ticket not in (replay.value.reason or "")
        # Wrong-scope handshake: same guarantee.
        mint2 = client.post(
            "/v1/auth/socket",
            json={"scope": "realtime:connect"},
            headers={"Authorization": f"Bearer {KEY}"},
        )
        ticket2 = mint2.json()["ticket"]
        with pytest.raises(WebSocketDisconnect) as swap:
            with client.websocket_connect(f"/v1/tts/stream?ticket={ticket2}"):
                pass
        assert swap.value.code == 1008
        assert ticket2 not in (swap.value.reason or "")
