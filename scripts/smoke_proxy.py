# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Verify the Voxi proxy identity guards end-to-end through real HTTP.

Closes the "loopback keyless" hole: a foreign Host or a cross-site request must be
rejected BEFORE any bearer is injected or the upstream is reached, so another page
in the same browser cannot ride the operator's injected identity (DNS rebinding).

Run against the loopback stack (keyless):

    python scripts/smoke_proxy.py --url https://127.0.0.1:8443 --mode loopback --insecure

Run against a LAN bring-up (per-client key required, guards off):

    python scripts/smoke_proxy.py --url https://<lan-ip>:8443 \
        --mode lan --key <VOXI_API_KEY> --insecure

Use --no-upstream when only the proxy is running (no gateway): the /v1 lines then
expect 502 (forwarded) instead of a gateway status, while every guard assertion still
applies because the reject happens before the upstream hop.
"""

from __future__ import annotations

import argparse
import http.client
import json
import ssl
import sys
from urllib.parse import urlsplit


class GuardCheckError(RuntimeError):
    """One proxy guard assertion failed."""


def _connect(
    url: str, insecure: bool
) -> tuple[http.client.HTTPSConnection | http.client.HTTPConnection, str, int, str]:
    parts = urlsplit(url if "://" in url else "https://" + url)
    host = parts.hostname or "127.0.0.1"
    port = parts.port or (443 if parts.scheme == "https" else 80)
    path_prefix = parts.path.rstrip("/")
    if parts.scheme == "https":
        # TEST-ONLY: this harness probes a self-signed LAN cert and disables
        # verification only when the operator explicitly passes --insecure. It is
        # never a production path; the proxy itself always requires TLS.
        ctx = ssl._create_unverified_context() if insecure else ssl.create_default_context()
        conn = http.client.HTTPSConnection(host, port, context=ctx, timeout=15)
    else:
        conn = http.client.HTTPConnection(host, port, timeout=15)
    return conn, host, port, path_prefix


def _status(conn, method: str, path: str, headers: dict[str, str]) -> tuple[int, dict[str, str]]:
    conn.request(method, path, headers=headers)
    response = conn.getresponse()
    body = response.read()
    resp_headers = {k.lower(): v for k, v in response.getheaders()}
    return response.status, resp_headers | {"__body__": body.decode("utf-8", "replace")}


def check_loopback(conn, host: str, prefix: str, upstream: bool) -> list[str]:
    notes: list[str] = []
    base_headers = {"Host": host}

    # 1) DNS rebinding: a foreign Host must be rejected outright.
    code, _ = _status(conn, "GET", f"{prefix}/v1/models", {"Host": "evil.example"})
    if code != 421:
        raise GuardCheckError(f"foreign Host expected 421, got {code}")
    notes.append("Host=evil.example -> 421 (DNS-rebinding cut)")

    # 2) Cross-site via Origin.
    code, _ = _status(conn, "GET", f"{prefix}/v1/models", {**base_headers, "Origin": "https://evil.example"})
    if code != 403:
        raise GuardCheckError(f"cross-site Origin expected 403, got {code}")
    notes.append("Origin=https://evil.example -> 403 (cross-site refused, no injection)")

    # 3) Cross-site via Sec-Fetch-Site.
    code, _ = _status(
        conn, "GET", f"{prefix}/v1/models", {**base_headers, "Sec-Fetch-Site": "cross-site"}
    )
    if code != 403:
        raise GuardCheckError(f"Sec-Fetch-Site=cross-site expected 403, got {code}")
    notes.append("Sec-Fetch-Site=cross-site -> 403")

    # 4) No CORS is ever advertised (same-origin is the only supported mode).
    code, headers = _status(conn, "GET", f"{prefix}/ui/runtime.json", base_headers)
    if code != 200:
        raise GuardCheckError(f"runtime.json expected 200, got {code}")
    if any(k.startswith("access-control") for k in headers):
        raise GuardCheckError("proxy advertised a CORS/Access-Control header in loopback mode")
    runtime = json.loads(headers["__body__"])
    if runtime.get("mode") != "loopback" or runtime.get("needKey") is not False:
        raise GuardCheckError(f"runtime.json not loopback/keyless: {runtime}")
    notes.append("runtime.json -> 200 loopback/keyless; no CORS header")

    # 5) Same-origin request is forwarded to the gateway with the injected bearer.
    code, _ = _status(conn, "GET", f"{prefix}/v1/models", base_headers)
    if upstream:
        if code != 200:
            raise GuardCheckError(
                f"same-origin /v1/models with injected identity expected 200, got {code}"
            )
        notes.append("same-origin /v1/models -> 200 (proxy injected the local key)")
    elif code not in (200, 502, 504):
        raise GuardCheckError(f"same-origin /v1/models expected forward (200/502), got {code}")
    else:
        notes.append(f"same-origin /v1/models -> {code} (guard passed through; no upstream)")
    return notes


def check_lan(conn, host: str, prefix: str, key: str | None, upstream: bool) -> list[str]:
    notes: list[str] = []

    # Guards are OFF in LAN mode: a foreign Host / Origin must NOT be 421/403.
    code, _ = _status(conn, "GET", f"{prefix}/v1/models", {"Host": "evil.example"})
    if code in (421, 403):
        raise GuardCheckError(f"LAN mode must not apply loopback guards, got {code}")
    notes.append(f"Host=evil.example -> {code} (loopback guards off in LAN mode)")

    # Keyless must NOT be honored: without a bearer the gateway rejects (401) or
    # there is simply no upstream (502) — never an injected success.
    code, _ = _status(conn, "GET", f"{prefix}/v1/models", {"Host": host})
    if upstream:
        if code != 401:
            raise GuardCheckError(f"LAN keyless /v1/models expected 401, got {code}")
        notes.append("keyless /v1/models -> 401 (no injection in LAN mode)")
    else:
        notes.append(f"keyless /v1/models -> {code} (forwarded, no injection)")

    # With a real client key it must succeed.
    if key:
        code, _ = _status(
            conn,
            "GET",
            f"{prefix}/v1/models",
            {"Host": host, "Authorization": f"Bearer {key}"},
        )
        if code != 200:
            raise GuardCheckError(f"LAN /v1/models with client key expected 200, got {code}")
        notes.append("client-key /v1/models -> 200")

    # Status file must report lan/needKey.
    code, headers = _status(conn, "GET", f"{prefix}/ui/runtime.json", {"Host": host})
    if code != 200:
        raise GuardCheckError(f"runtime.json expected 200, got {code}")
    runtime = json.loads(headers["__body__"])
    if runtime.get("mode") != "lan" or runtime.get("needKey") is not True:
        raise GuardCheckError(f"runtime.json not lan/needKey: {runtime}")
    notes.append("runtime.json -> lan/needKey")
    return notes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://127.0.0.1:8443", help="proxy base URL")
    parser.add_argument("--mode", choices=["loopback", "lan"], default="loopback")
    parser.add_argument("--key", default=None, help="client API key (LAN 200 check)")
    parser.add_argument(
        "--insecure", action="store_true", help="skip TLS verification (self-signed)"
    )
    parser.add_argument(
        "--no-upstream", action="store_true", help="proxy only (no gateway): tolerate 502 on /v1"
    )
    args = parser.parse_args()
    upstream = not args.no_upstream

    conn, host, _port, prefix = _connect(args.url, args.insecure)
    try:
        if args.mode == "loopback":
            notes = check_loopback(conn, host, prefix, upstream)
        else:
            notes = check_lan(conn, host, prefix, args.key, upstream)
    except (GuardCheckError, OSError, http.client.HTTPException) as exc:
        print(f"FAIL — {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()

    print(f"PASS — proxy guards ({args.mode}):")
    for note in notes:
        print(f"  {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
