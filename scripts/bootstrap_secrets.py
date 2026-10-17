# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Generate the local secrets and TLS material a fresh clone needs.

Runs as a one-shot Compose service before the gateway, the workers and the TLS
proxy. Every step is idempotent and precedence-preserving:

* an explicit environment variable always wins, so nothing is generated for a
  secret the operator already provided in ``.env``;
* an existing file is never overwritten, so re-running ``docker compose up -d``
  cannot rotate the worker key out from under a running stack;
* TLS material is generated only when NEITHER ``voxi.crt`` nor ``voxi.key``
  exists, and never when ``REQUIRE_PROVIDED_CERTS=1`` (fail closed, for LAN and
  production deployments).

Secret values are never printed — only the path that now exists. Files are
root-owned and readable only by the runtime group (UID/GID 10001); the local
WebUI key is 0600 root-only because only the root proxy process reads it.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path

SECRETS_DIR = Path(os.environ.get("VOXI_SECRETS_DIR") or "/run/voxi-secrets")
CERT_DIR = Path(os.environ.get("VOXI_CERT_DIR") or "/certs")
GENERATED_MARKER = ".generated-by-voxi"
WEBUI_SCOPES = ("audio:read", "audio:write", "realtime:connect")
MIN_SECRET = 32
RUNTIME_GID = 10001
LOOPBACK = {"127.0.0.1", "::1", "localhost", "[::1]"}


def log(message: str) -> None:
    print(f"[secrets] {message}", flush=True)


def fail(message: str) -> None:
    print(f"[secrets] REFUSING TO START: {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def is_true(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def has_secret(name: str) -> bool:
    """Mirror bootstrap.ps1: empty, placeholder or short values count as absent."""
    value = os.environ.get(name, "").strip()
    if len(value) < MIN_SECRET:
        return False
    return "change-me" not in value.lower().replace("_", "-").replace(" ", "-")


def new_secret() -> str:
    # Same shape as bootstrap.ps1 / secrets.token_urlsafe(48): 64 url-safe chars.
    return secrets.token_urlsafe(48)


def _running_as_root() -> bool:
    return hasattr(os, "geteuid") and os.geteuid() == 0


def _own(path: Path, mode: int, *, gid: int) -> None:
    if _running_as_root():
        os.chown(path, 0, gid)
    os.chmod(path, mode)


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    _own(path, 0o750, gid=RUNTIME_GID)


def write_private(path: Path, text: str, *, group_readable: bool) -> None:
    """Write a secret file root-owned with no world access.

    ``group_readable`` is True for the secrets the UID 10001 runtime reads
    (worker key, master key, keyring): 0640 root:voxi. It is False for the local
    WebUI key, which only the root proxy process reads: 0600 root:root.

    The file is created with mode 0600 *before* any bytes are written, so it is
    never briefly world-readable between creation and the final chmod.
    """
    mode = 0o640 if group_readable else 0o600
    gid = RUNTIME_GID if group_readable else 0
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    _own(path, mode, gid=gid)


def reconcile_secret(file_name: str, env_name: str, *, group_readable: bool) -> str:
    """Return the secret the READER will use, generating a file only when needed.

    The returned value follows the same precedence as ``voxi.secrets.read_secret``
    (environment, then file, then generated) so a caller that derives something from
    the value — the keyring's SHA-256 of the local WebUI key — cannot desync from
    what the proxy actually injects.
    """
    path = SECRETS_DIR / file_name
    existing = path.read_text(encoding="utf-8").strip() if path.is_file() else ""
    if has_secret(env_name):
        log(
            f"{file_name}: {env_name} is set in the environment and wins at read time"
            + (" (existing file left untouched)" if existing else ", nothing generated")
        )
        return os.environ[env_name].strip()
    if existing:
        log(f"{file_name}: present, left untouched")
        return existing
    value = new_secret()
    write_private(path, value + "\n", group_readable=group_readable)
    log(f"{file_name}: generated (value not printed)")
    return value


def reconcile_keys_json(webui_key: str) -> None:
    """Register the local WebUI key by SHA-256 so the proxy's injection is scoped.

    The file is derived, not a key: if it already authorises the key the proxy will
    actually inject it is left byte-for-byte alone (so re-running ``up -d`` changes
    nothing), and if the local WebUI key was later pinned in the environment it is
    refreshed. A stale record would otherwise make every injected ``/v1`` call a
    silent 401. No key is ever rotated by this.
    """
    path = SECRETS_DIR / "api-keys.json"
    expected = hashlib.sha256(webui_key.encode()).hexdigest()
    if has_secret("VOXI_API_KEYS_JSON"):
        log("api-keys.json: VOXI_API_KEYS_JSON is set in the environment, nothing generated")
        return
    records: list[dict[str, object]] = []
    if path.is_file() and path.read_text(encoding="utf-8").strip():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            loaded = None
        if not isinstance(loaded, list):
            log("api-keys.json: unreadable; regenerating the 'webui-local' record")
        else:
            records = [row for row in loaded if isinstance(row, dict)]
            current = next(
                (row.get("sha256") for row in records if row.get("id") == "webui-local"), None
            )
            if current == expected:
                log("api-keys.json: present and matches the local WebUI key, left untouched")
                return
            log(
                "api-keys.json: the local WebUI key changed; refreshing the generated "
                "'webui-local' record (other records are kept)"
            )
    records = [row for row in records if row.get("id") != "webui-local"]
    records.append({"id": "webui-local", "sha256": expected, "scopes": list(WEBUI_SCOPES)})
    write_private(path, json.dumps(records, separators=(",", ":")) + "\n", group_readable=True)
    log("api-keys.json: registered 'webui-local' (SHA-256 only)")


def san_list() -> list[str]:
    """localhost + loopback, plus the LAN bind address and any VOXI_TLS_SAN entries."""
    sans = ["DNS:localhost", "IP:127.0.0.1", "IP:::1"]
    bind = os.environ.get("VOXI_PROXY_BIND_IP", "").strip()
    if bind and bind not in LOOPBACK:
        sans.append(f"IP:{bind}")
    for extra in (os.environ.get("VOXI_TLS_SAN") or "").split(","):
        extra = extra.strip()
        if not extra:
            continue
        if ":" in extra:
            sans.append(extra)  # already a typed SAN entry, e.g. IP:192.168.1.5
        elif extra.count(".") == 3 and all(part.isdigit() for part in extra.split(".")):
            sans.append(f"IP:{extra}")  # bare IPv4 address
        else:
            sans.append(f"DNS:{extra}")
    unique: list[str] = []
    for san in sans:
        if san not in unique:
            unique.append(san)
    return unique


def ensure_cert() -> None:
    crt, key = CERT_DIR / "voxi.crt", CERT_DIR / "voxi.key"
    marker = CERT_DIR / GENERATED_MARKER
    have_crt, have_key = crt.is_file(), key.is_file()
    if is_true(os.environ.get("REQUIRE_PROVIDED_CERTS")):
        if not (have_crt and have_key):
            fail(
                "REQUIRE_PROVIDED_CERTS=1 but certs/voxi.crt and certs/voxi.key are not both "
                "present. Provide your own certificate (see integrations/nginx/README.md)."
            )
        if marker.exists():
            fail(
                "REQUIRE_PROVIDED_CERTS=1 but the certificate in certs/ was auto-generated by "
                "Voxi. Provide your own and delete certs/.generated-by-voxi."
            )
        log("TLS: provided certificate accepted (strict mode, nothing generated)")
        return
    if have_crt and have_key:
        log("TLS: present, left untouched")
        return
    if have_crt or have_key:
        fail(
            "TLS material is incomplete: both certs/voxi.crt and certs/voxi.key are required. "
            "Refusing to overwrite an existing file — remove both and re-run, or provide a pair."
        )
    sans = san_list()
    # Create the directory if needed, but never chown an existing one: on Linux
    # ./certs is a host bind mount, and the proxy (root) can read the pair regardless.
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "825",
                "-nodes", "-keyout", str(key), "-out", str(crt), "-subj", "/CN=voxi-gateway",
                "-addext", "subjectAltName=" + ",".join(sans),
            ],
            check=True,
        )
    except FileNotFoundError:
        fail("openssl is not installed in this image; cannot generate a certificate.")
    except subprocess.CalledProcessError:
        fail("openssl failed to generate the certificate.")
    _own(crt, 0o644, gid=0)
    _own(key, 0o600, gid=0)
    marker.write_text(
        "Auto-generated by Voxi (scripts/bootstrap_secrets.py).\n"
        "Fine for loopback. For LAN or production, provide your own certificate and\n"
        "delete this file, then run with REQUIRE_PROVIDED_CERTS=1.\n",
        encoding="utf-8",
    )
    log(f"TLS: generated a self-signed certificate (SAN: {', '.join(sans)})")
    log(
        "TLS: loopback only. For LAN or production, provide your own cert and set "
        "REQUIRE_PROVIDED_CERTS=1."
    )


def main() -> int:
    ensure_dir(SECRETS_DIR)
    reconcile_secret("worker.key", "VOXI_WORKER_API_KEY", group_readable=True)
    reconcile_secret("app.key", "VOXI_API_KEY", group_readable=True)
    webui_key = reconcile_secret("webui.key", "VOXI_WEBUI_KEY", group_readable=False)
    reconcile_keys_json(webui_key)
    ensure_cert()
    log("done: secrets are in place; no secret value was printed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
