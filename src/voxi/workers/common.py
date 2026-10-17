# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Shared worker observability and fail-closed runtime settings."""

from __future__ import annotations

import os
import time

from fastapi import FastAPI, Request
from fastapi.responses import Response
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

from voxi.secrets import read_secret


def positive_env(name: str, default: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def require_worker_key() -> None:
    if len(read_secret("VOXI_WORKER_API_KEY", "worker.key")) < 32:
        raise RuntimeError("VOXI_WORKER_API_KEY must contain at least 32 characters")


def install_observability(app: FastAPI) -> None:
    registry = CollectorRegistry()
    requests = Counter(
        "voxi_worker_requests_total", "Worker HTTP requests", ["path", "status"], registry=registry
    )
    latency = Histogram(
        "voxi_worker_request_seconds", "Worker request latency", ["path"], registry=registry
    )
    active = Gauge("voxi_worker_inference_active", "Occupied inference slots", registry=registry)

    @app.middleware("http")
    async def observe(request: Request, call_next):
        # Fixed route label; never user text, filename or API keys.
        path = (
            request.url.path
            if request.url.path
            in {
                "/healthz",
                "/readyz",
                "/metrics",
                "/internal/models",
                "/internal/speech",
                "/internal/speech/stream",
                "/internal/transcriptions",
            }
            else "unmatched"
        )
        start = time.monotonic()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            requests.labels(path, str(status)).inc()
            latency.labels(path).observe(time.monotonic() - start)

    @app.get("/metrics", include_in_schema=False)
    async def metrics():
        gate = getattr(app.state, "gate", None)
        active.set(gate.active if gate else 0)
        return Response(generate_latest(registry), headers={"Content-Type": CONTENT_TYPE_LATEST})
