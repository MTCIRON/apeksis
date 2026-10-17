# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Verify the WebUI served behind the proxy is the *fresh* SPA, not a stale bind mount.

On Docker Desktop (Windows) a re-built `webui/dist` is not picked up by a running
container's read-only bind mount, so `location /ui/ { try_files ... }` happily
serves the SPA `index.html` in place of the content-hashed JS/CSS assets. The page
then loads with a blank body and no console error. This smoke test catches exactly
that: it resolves the assets the served index.html actually references and asserts
each is delivered with its real MIME type, not the HTML shell.

    python scripts/smoke_ui.py --url https://localhost:8443 --insecure
"""

from __future__ import annotations

import argparse
import re
import sys
from urllib.parse import urljoin

import httpx

ASSET_RE = re.compile(r'(?:src|href)="(/ui/(?:assets|vite)/[^"]+\.(js|css))"')
HTML_HINTS = ("<!doctype html", "<html")


class UiCheckError(RuntimeError):
    """One WebUI assertion failed."""


def looks_like_html(body: bytes) -> bool:
    head = body[:64].decode("utf-8", "replace").lstrip().lower()
    return any(head.startswith(hint) for hint in HTML_HINTS)


def check(base: str, client: httpx.Client) -> dict:
    root = base if base.endswith("/") else base + "/"
    index_url = urljoin(root, "ui/")
    index = client.get(index_url)
    if index.status_code != 200:
        raise UiCheckError(f"{index_url} returned {index.status_code}, expected 200")
    if not index.text.lstrip().lower().startswith("<!doctype html"):
        raise UiCheckError(f"{index_url} is not an HTML document")

    assets = ASSET_RE.findall(index.text)
    if not assets:
        raise UiCheckError("index.html references no hashed assets; build looks empty")

    delivered: dict[str, str] = {}
    for path, kind in assets:
        asset_url = urljoin(root, path)
        response = client.get(asset_url)
        if response.status_code != 200:
            raise UiCheckError(f"asset {asset_url} returned {response.status_code}")
        content_type = response.headers.get("content-type", "").lower()
        if looks_like_html(response.content):
            raise UiCheckError(
                f"asset {asset_url} served the SPA shell (stale bind mount?); "
                f"recreate the proxy: {content_type!r}"
            )
        expected = "css" if kind == "css" else ("javascript", "ecmascript")
        if not any(token in content_type for token in expected):
            raise UiCheckError(f"asset {asset_url} content-type {content_type!r} is not {kind}")
        if len(response.content) == 0:
            raise UiCheckError(f"asset {asset_url} is empty")
        delivered[path] = content_type

    # SPA deep-link fallback must return the HTML shell, not a 404.
    deep = client.get(urljoin(root, "ui/derin/rota"))
    if deep.status_code != 200 or not deep.text.lstrip().lower().startswith("<!doctype html"):
        raise UiCheckError("SPA fallback for /ui/<deep/route> did not return index.html")

    return {
        "index": index_url,
        "assets": delivered,
        "spa_fallback": "ui/derin/rota -> 200 text/html",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://localhost:8443", help="proxy base URL")
    parser.add_argument(
        "--insecure", action="store_true", help="skip TLS verification (self-signed cert)"
    )
    parser.add_argument("--timeout", type=float, default=15.0)
    args = parser.parse_args()

    try:
        with httpx.Client(
            verify=not args.insecure, timeout=args.timeout, trust_env=False
        ) as client:
            result = check(args.url, client)
    except (UiCheckError, httpx.HTTPError) as exc:
        print(f"FAIL — {exc}", file=sys.stderr)
        return 1

    print("PASS — WebUI assets are fresh and correctly typed:")
    for path, content_type in result["assets"].items():
        print(f"  {path} -> {content_type}")
    print(f"  {result['spa_fallback']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
