# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""F5 · Bounded transient-failure retry policy for STT final recognition.

Closes the F4 Priority-5 debt item. The retry loop used to live inline inside
the realtime-transcription WS handler; extracting it as `recognize_with_retry`
lets us drive every branch directly without opening a socket:

  * success on the first try
  * success after a 429 or 503 backoff
  * retry ceiling reached → the last transient error is re-raised
  * non-retryable status (400 / 413 / 422 / 504) short-circuits immediately
  * cancellation from the caller propagates without swallowing
  * sleep schedule matches `base_delay * (attempt + 1)`

Also asserts that the retry helper keeps the strict ordering that lets a
final transcript arrive AFTER a cancelled partial, which is the reason the
policy exists in the first place (see src/voxi/gateway.py::recognize_with_retry).
"""

import asyncio

import pytest

from voxi.errors import PlatformError
from voxi.gateway import (
    RETRY_BASE_DELAY,
    RETRY_MAX_ATTEMPTS,
    RETRY_STATUSES,
    recognize_with_retry,
)


class FakeClock:
    """Async sleep stub recording every backoff step."""

    def __init__(self) -> None:
        self.delays: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.delays.append(seconds)


def err(status: int, code: str = "capacity_exceeded") -> PlatformError:
    return PlatformError(status, "transient", code)


async def test_success_first_try_does_not_sleep():
    clock = FakeClock()
    calls = 0

    async def call():
        nonlocal calls
        calls += 1
        return "merhaba"

    assert await recognize_with_retry(call, sleep=clock) == "merhaba"
    assert calls == 1
    assert clock.delays == []


async def test_retries_transient_then_succeeds():
    clock = FakeClock()
    seen: list[int] = []

    async def call():
        seen.append(len(seen))
        if len(seen) < 3:
            raise err(429)
        return "tamam"

    result = await recognize_with_retry(call, sleep=clock)
    assert result == "tamam"
    assert len(seen) == 3
    # Backoff is base * (attempt+1): 1× base, 2× base.
    assert clock.delays == [RETRY_BASE_DELAY * 1, RETRY_BASE_DELAY * 2]


async def test_ceiling_reached_reraises_last_transient():
    clock = FakeClock()

    async def call():
        raise err(503, "worker_unavailable")

    with pytest.raises(PlatformError) as exc:
        await recognize_with_retry(call, sleep=clock)
    assert exc.value.status == 503
    assert exc.value.code == "worker_unavailable"
    # Exactly attempts-1 backoffs: attempt 0..3 fires 4 calls, sleeps 3 times.
    assert len(clock.delays) == RETRY_MAX_ATTEMPTS - 1
    assert clock.delays == [
        RETRY_BASE_DELAY * 1,
        RETRY_BASE_DELAY * 2,
        RETRY_BASE_DELAY * 3,
    ]


@pytest.mark.parametrize("status", [400, 413, 422, 504])
async def test_non_retryable_status_short_circuits(status: int):
    clock = FakeClock()
    calls = 0

    async def call():
        nonlocal calls
        calls += 1
        raise err(status, "user_error")

    with pytest.raises(PlatformError) as exc:
        await recognize_with_retry(call, sleep=clock)
    assert exc.value.status == status
    assert calls == 1
    assert clock.delays == []


async def test_cancellation_propagates_without_swallowing():
    """A cancelled socket must tear down the retry loop; asyncio.CancelledError
    is NOT a PlatformError so the policy never catches it. Regression guard
    against a future refactor that broadens the except clause."""

    async def call():
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await recognize_with_retry(call, sleep=FakeClock())


async def test_retry_status_set_matches_policy_documentation():
    # 429 (capacity) and 503 (worker unavailable / failure) are the only
    # retryable statuses; a new transient code requires updating this test
    # on purpose, not by accident.
    assert RETRY_STATUSES == frozenset({429, 503})


async def test_final_priority_after_cancel_partial():
    """Simulate the STT-07 race: an earlier partial is cancelled, its
    worker slot is still draining, and the final request hits a 429 for
    exactly one attempt before the slot frees. The retry policy must
    preserve the final transcript (that is the whole reason it exists)."""

    clock = FakeClock()
    pending_partial = True

    async def call():
        nonlocal pending_partial
        if pending_partial:
            pending_partial = False
            raise err(429)
        return "bu canlı web soket akış denemesi"

    assert "canlı" in await recognize_with_retry(call, sleep=clock)
    assert clock.delays == [RETRY_BASE_DELAY * 1]


async def test_attempts_below_one_rejected():
    async def call():  # pragma: no cover - never reached
        return "unused"

    with pytest.raises(ValueError):
        await recognize_with_retry(call, attempts=0)
