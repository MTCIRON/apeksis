# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import asyncio
import json
import threading

import httpx
import pytest

from voxi.contracts import TurnInput
from voxi.errors import PlatformError
from voxi.n8n import TurnBroker
from voxi.runtime import InferenceGate


async def test_late_previous_turn_never_returns_playable_action():
    entered = asyncio.Event()
    release = asyncio.Event()

    async def handler(request):
        payload = json.loads(request.content)
        if payload["sequence"] == 1:
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await (
                    release.wait()
                )  # Misbehaving upstream survives cancel; generation still guards it.
        return httpx.Response(
            200,
            json={
                "schema_version": "1.0",
                "action": "speak",
                "text": f"Yanıt {payload['sequence']}",
                "idempotency_key": f"{payload['call_id']}:{payload['turn_id']}",
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        broker = TurnBroker(client, "http://n8n/webhook/turn", "k" * 32)
        session = broker.create("alice")
        first = asyncio.create_task(broker.deliver(session, TurnInput(transcript="Eski"), "r1"))
        await entered.wait()
        second = await broker.deliver(session, TurnInput(transcript="Yeni"), "r2")
        assert second["generation_id"] == 2
        assert second["action"]["text"] == "Yanıt 2"
        release.set()
        with pytest.raises(PlatformError) as exc:
            await first
        assert exc.value.code == "stale_generation"


async def test_calls_and_tenant_state_isolated_and_hangup_invalidates():
    async def handler(request):
        payload = json.loads(request.content)
        assert payload["caller"]["number"] == "redacted"
        return httpx.Response(
            200,
            json={
                "schema_version": "1.0",
                "action": "listen",
                "idempotency_key": f"{payload['call_id']}:{payload['turn_id']}",
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        broker = TurnBroker(client, "http://n8n/webhook/turn", "k" * 32)
        alice, bob = broker.create("alice"), broker.create("bob")
        with pytest.raises(PlatformError) as exc:
            broker.get(alice.id, "bob")
        assert exc.value.status == 404
        actions = await asyncio.gather(
            *(broker.deliver(s, TurnInput(transcript="Merhaba"), "r") for s in (alice, bob))
        )
        assert actions[0]["action"]["idempotency_key"] != actions[1]["action"]["idempotency_key"]
        broker.terminate(alice)
        assert broker.get(bob.id, "bob") is bob
        with pytest.raises(PlatformError):
            broker.get(alice.id, "alice")


@pytest.mark.parametrize(
    "bad_action",
    [
        {"action": "transfer", "transfer_target": "+902125551234"},
        {"action": "speak", "text": " "},
        {"action": "speak", "text": "Hello", "language": "en"},
        {"action": "speak", "text": "Merhaba", "idempotency_key": "wrong"},
        {"action": "speak", "text": "Merhaba", "voice": "invented"},
        {"action": "listen", "transfer_target": "101"},
    ],
)
async def test_invalid_actions_use_controlled_fallback(bad_action):
    async def handler(request):
        payload = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "schema_version": "1.0",
                "idempotency_key": f"{payload['call_id']}:{payload['turn_id']}",
                **bad_action,
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        broker = TurnBroker(
            client,
            "http://n8n/webhook/turn",
            "k" * 32,
            targets=frozenset({"101"}),
            fallback_text="Hizmet kullanılamıyor.",
        )
        action = await broker.deliver(broker.create("alice"), TurnInput(transcript="Merhaba"), "r")
        assert action["action"]["action"] == "fallback"
        assert action["action"]["text"] == "Hizmet kullanılamıyor."


async def test_outage_timeout_and_oversized_response_bounded():
    async def slow(request):
        await asyncio.sleep(10)

    async def oversized(request):
        return httpx.Response(200, content=b"x" * 65537)

    async def outage(request):
        return httpx.Response(503)

    for handler in (slow, oversized, outage):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            broker = TurnBroker(client, "http://n8n/webhook/turn", "k" * 32, timeout=0.01)
            async with asyncio.timeout(1):
                result = await broker.deliver(
                    broker.create("alice"), TurnInput(transcript="Merhaba"), "r"
                )
            assert result["action"]["action"] == "fallback"


async def test_cancelled_inference_retains_slot_until_thread_exits():
    gate = InferenceGate(1)
    entered = threading.Event()
    release = threading.Event()

    def work():
        entered.set()
        release.wait(5)
        return 42

    pending = asyncio.create_task(gate.run(work))
    await asyncio.to_thread(entered.wait, 2)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    with pytest.raises(PlatformError) as exc:
        await gate.run(lambda: 2)
    assert exc.value.status == 429
    release.set()
    await asyncio.gather(*gate.jobs)
    await asyncio.sleep(0)
    assert await gate.run(lambda: 7) == 7
