#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

# Turnkey install for Linux/macOS: brings up the whole stack — pinned models,
# generated secrets and the TLS/UI edge included, no .env needed.
#
# This is a thin wrapper over the canonical command; everything it runs is
# visible below. Arguments are forwarded BEFORE `up`, so top-level Compose
# flags work, e.g.
#   scripts/up.sh                     # default install, waits until healthy
#   scripts/up.sh --profile antalia   # also start the opt-in Antalia worker
#
# Windows users: `pwsh infra/bootstrap.ps1` is the equivalent host-side path
# (plus key management); the compose command itself works everywhere.

set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker not found on PATH. Install Docker first:" >&2
    echo "  https://docs.docker.com/engine/install/  (Linux)" >&2
    echo "  https://docs.docker.com/desktop/         (macOS/Windows, WSL2 backend)" >&2
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "error: 'docker compose' (Compose v2 plugin) not available." >&2
    echo "The proxy overlay needs Compose v2.24 or newer (it uses the !reset tag)." >&2
    exit 1
fi

# The proxy (TLS + /ui) is defined only in the overlay file, so BOTH -f flags
# are required; a bare `docker compose up -d` would start the API without the
# TLS/UI edge, and this wrapper exists to make that mistake impossible.
docker compose \
    -f compose.yaml \
    -f infra/compose.proxy.yaml \
    "$@" \
    up -d --wait --wait-timeout 900

echo
echo "Console:  https://127.0.0.1:8443/ui/"
echo "The loopback certificate is self-signed; the browser asks once to trust it."
echo "API health:  curl -k https://127.0.0.1:8443/readyz"
