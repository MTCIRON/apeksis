# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import asyncio
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from starlette.types import ASGIApp, Receive, Scope, Send

from voxi.errors import PlatformError, error_response


class InferenceGate:
    """No waiting queue; cancelled HTTP jobs retain slots until threads actually finish."""

    def __init__(self, capacity: int):
        if capacity < 1:
            raise ValueError("capacity must be positive")
        self.capacity = capacity
        self.active = 0
        self.jobs: set[asyncio.Task] = set()

    def acquire(self) -> None:
        """Take one slot; the caller owns the release, so streams fail fast with a real 429."""
        if self.active >= self.capacity:
            raise PlatformError(429, "Inference capacity exhausted", "capacity_exceeded")
        self.active += 1

    def release(self) -> None:
        self.active = max(0, self.active - 1)

    async def run(self, func: Callable, *args: Any, **kwargs: Any) -> Any:
        self.acquire()
        job = asyncio.create_task(asyncio.to_thread(func, *args, **kwargs))
        self.jobs.add(job)

        def finished(task: asyncio.Task):
            self.release()
            self.jobs.discard(task)
            if not task.cancelled():
                task.exception()  # Retrieve exceptions if HTTP waiter already cancelled.

        job.add_done_callback(finished)
        return await asyncio.shield(job)


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        messages = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            size += len(message.get("body", b""))
            if size > self.max_bytes:
                await error_response(413, "Request body too large", "body_too_large")(
                    scope, receive, send
                )
                return
            messages.append(message)
            if not message.get("more_body", False):
                break
        index = 0

        async def replay():
            nonlocal index
            if index < len(messages):
                result = messages[index]
                index += 1
                return result
            return await receive()

        await self.app(scope, replay, send)


def install_body_limit(app: FastAPI, max_bytes: int) -> None:
    app.add_middleware(BodyLimitMiddleware, max_bytes=max_bytes)
