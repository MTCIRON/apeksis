# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Minimal HTTP turn responder used ONLY for F4 verification.

This is a stand-in for the operator's real n8n webhook. It exists so that
`/v1/sessions` + `/v1/sessions/{id}/turns` can be exercised end-to-end when
no external n8n deployment is available in the sandbox. It is not part of
the shipped product and is never referenced from the browser.

Contract, verified against src/voxi/n8n.py:

    POST <webhook url>
    Headers:
        Authorization: Bearer <VOXI_N8N_API_KEY>
        Idempotency-Key: <call_id>:<turn_id>
        X-Request-ID: <correlation id>
    Body (JSON, schema_version "1.0"):
        { event_type, call_id, session_id, turn_id, sequence,
          generation_id, correlation_id, timestamp, language,
          transcript, caller, context }

    Response: a single TurnAction JSON object. The gateway validates it
    against pydantic `TurnAction(extra="forbid")`, so this fixture emits
    only allowed fields. `idempotency_key` must echo the request header
    or the broker raises `ValueError("n8n idempotency key mismatch")`.

Behaviour:
    * Rejects missing / wrong bearer with 401.
    * Rejects missing Idempotency-Key with 400.
    * Body JSON is echoed into a `speak` action with a short Turkish reply
      so the browser can prove the round-trip.
    * No transcript or key is written to stdout beyond the truncated prefix
      that we deliberately include in the response text.

Run:
    python infra/turn-stub.py --port 9099 --key <shared bearer>
"""

from __future__ import annotations

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    key: str = ""

    def _reply(self, code: int, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or auth[7:] != self.key:
            self._reply(401, {"error": "unauthorized"})
            return
        idem = self.headers.get("Idempotency-Key", "")
        if not idem:
            self._reply(400, {"error": "missing Idempotency-Key"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 65536:
            self._reply(400, {"error": "invalid body size"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except ValueError:
            self._reply(400, {"error": "invalid json"})
            return
        transcript = str(payload.get("transcript", ""))[:4000]
        language = str(payload.get("language", "tr-TR"))
        text = f"Anlaşıldı: {transcript[:80]}" if transcript else "Boş istek"
        self._reply(
            200,
            {
                "schema_version": "1.0",
                "action": "speak",
                "text": text,
                "language": language,
                "idempotency_key": idem,
            },
        )

    # Silence default stderr logging of the raw request line (it includes
    # nothing sensitive but adds noise; the gateway already correlates).
    def log_message(self, fmt: str, *args) -> None:  # type: ignore[override]
        return


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9099)
    parser.add_argument(
        "--key",
        default=os.getenv("VOXI_N8N_API_KEY", ""),
        help="Shared bearer; must match the gateway's VOXI_N8N_API_KEY.",
    )
    args = parser.parse_args()
    if len(args.key) < 32:
        raise SystemExit("Refusing to start: --key shorter than 32 characters")
    Handler.key = args.key
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"turn-stub listening on 0.0.0.0:{args.port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
