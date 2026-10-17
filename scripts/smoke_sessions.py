# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Live smoke for /v1/sessions + /v1/sessions/{id}/turns.

Proves the F4 contract against a real gateway (via the same TLS proxy the
browser uses). Complements `scripts/smoke_stream.py` (WebSocket paths) and
`scripts/smoke_ui.py` (asset correctness). Nothing here invents endpoints;
every check mirrors the shape already documented in `src/voxi/gateway.py`
and `src/voxi/n8n.py`.

Passes require the gateway to have a reachable turn responder configured
either as a real n8n webhook or as `infra/compose.turnstub.yaml` for
sandbox verification.

    python scripts/smoke_sessions.py --base-url https://localhost:8443 --insecure
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx


class CheckError(RuntimeError):
    """One assertion failed; the reason is reported verbatim, never invented."""


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise CheckError(message)


def _headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def run(http_base: str, key: str, insecure: bool, timeout: float) -> dict:
    verify = not insecure
    out: dict[str, object] = {}
    with httpx.Client(timeout=timeout, verify=verify, trust_env=False) as client:
        # 1. Unauthenticated requests must be refused before any side effect.
        refusal = client.post(f"{http_base}/v1/sessions")
        expect(
            refusal.status_code in {401, 403},
            f"unauth /v1/sessions returned {refusal.status_code}: {refusal.text[:200]}",
        )
        out["unauth_refusal"] = refusal.status_code

        # 2. Real create returns {session_id, call_id} with 201.
        created = client.post(f"{http_base}/v1/sessions", headers=_headers(key))
        body: dict = {}
        if created.status_code == 503 and "n8n_unconfigured" in created.text:
            raise CheckError(
                "gateway has no VOXI_N8N_WEBHOOK_URL configured; bring up "
                "infra/compose.turnstub.yaml (or point at a real n8n) first"
            )
        expect(
            created.status_code == 201,
            f"POST /v1/sessions -> {created.status_code}: {created.text[:200]}",
        )
        body = created.json()
        expect(
            isinstance(body.get("session_id"), str) and isinstance(body.get("call_id"), str),
            f"session response missing identifiers: {body}",
        )
        session_id = body["session_id"]
        out["session_created"] = {
            "session_id_prefix": session_id[:8],
            "call_id_prefix": body["call_id"][:8],
        }

        try:
            # 3. Valid turn produces a schema-clean TurnAction.
            valid = client.post(
                f"{http_base}/v1/sessions/{session_id}/turns",
                headers=_headers(key),
                content=json.dumps({"transcript": "Merhaba voksi, F4 smoke denemesi."}).encode(
                    "utf-8"
                ),
            )
            expect(
                valid.status_code == 200,
                f"POST turns (valid) -> {valid.status_code}: {valid.text[:200]}",
            )
            delivered = valid.json()
            expect(
                {"generation_id", "turn_id", "action"} <= delivered.keys(),
                f"turn response shape unexpected: {list(delivered.keys())}",
            )
            action = delivered["action"]
            expect(
                action.get("schema_version") == "1.0"
                and action.get("action") in {"speak", "transfer", "hangup", "listen", "fallback"},
                f"TurnAction failed validation: {action}",
            )
            expect(
                isinstance(action.get("idempotency_key"), str) and action["idempotency_key"],
                "idempotency_key missing",
            )
            out["turn_ok"] = {
                "generation_id": delivered["generation_id"],
                "action": action["action"],
                "has_text": bool(action.get("text")),
            }

            # 4. Blank transcript -> pydantic 422 (extra=forbid + min_length + nonblank).
            blank = client.post(
                f"{http_base}/v1/sessions/{session_id}/turns",
                headers=_headers(key),
                content=json.dumps({"transcript": "   "}).encode("utf-8"),
            )
            expect(
                blank.status_code in {400, 422},
                f"blank transcript accepted: {blank.status_code} {blank.text[:200]}",
            )
            out["blank_rejected"] = blank.status_code

            # 5. Unknown extra field -> 422 (TurnInput extra=forbid).
            extra = client.post(
                f"{http_base}/v1/sessions/{session_id}/turns",
                headers=_headers(key),
                content=json.dumps({"transcript": "deneme", "surprise": 1}).encode("utf-8"),
            )
            expect(
                extra.status_code in {400, 422},
                f"extra=forbid not enforced: {extra.status_code} {extra.text[:200]}",
            )
            out["extra_forbid_rejected"] = extra.status_code

            # 6. Unauthorized turn on a real session is refused.
            unauth = client.post(
                f"{http_base}/v1/sessions/{session_id}/turns",
                content=json.dumps({"transcript": "deneme"}).encode("utf-8"),
            )
            expect(
                unauth.status_code in {401, 403},
                f"unauth turn returned {unauth.status_code}",
            )
            out["turn_unauth_refusal"] = unauth.status_code
        finally:
            # 7. Terminate always.
            deleted = client.delete(f"{http_base}/v1/sessions/{session_id}", headers=_headers(key))
            expect(
                deleted.status_code == 204,
                f"DELETE session -> {deleted.status_code}: {deleted.text[:200]}",
            )
            out["terminated"] = 204

        # 8. Follow-up turn on a terminated session must be a clean 404.
        ghost = client.post(
            f"{http_base}/v1/sessions/{session_id}/turns",
            headers=_headers(key),
            content=json.dumps({"transcript": "hayalet"}).encode("utf-8"),
        )
        expect(
            ghost.status_code == 404,
            f"terminated session reused: {ghost.status_code} {ghost.text[:200]}",
        )
        out["post_terminate_rejected"] = ghost.status_code

    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://localhost:8443")
    parser.add_argument("--insecure", action="store_true")
    parser.add_argument("--api-key", default=os.getenv("VOXI_API_KEY", ""))
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--output-dir", type=Path, default=Path("smoke-output/sessions"))
    args = parser.parse_args()

    if len(args.api_key) < 32:
        print("Set VOXI_API_KEY or pass --api-key (at least 32 characters).", file=sys.stderr)
        return 2
    parsed = urlsplit(args.base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        print("--base-url must be an absolute http(s) URL", file=sys.stderr)
        return 2
    http_base = f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")

    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    report: dict[str, object] = {"base_url": args.base_url, "started_at": started, "passed": False}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    try:
        report["checks"] = run(http_base, args.api_key, args.insecure, args.timeout)
        report["passed"] = True
        report["error"] = None
    except (CheckError, httpx.HTTPError) as exc:
        report["error"] = str(exc)

    report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    path = args.output_dir / "sessions-report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if report["passed"]:
        for name, value in report["checks"].items():
            print(f"{name}: {json.dumps(value, ensure_ascii=False)[:180]}")
        print(f"PASS — Sessions smoke evidence written to {path}")
        return 0
    print(f"FAIL — {report['error']}\nDetails: {path}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
