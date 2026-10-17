# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Secret resolution: environment first, then a root-only file.

A fresh clone has no ``.env`` (it is gitignored), so every secret has two sources:

1. an explicit environment variable — always wins, so an operator's ``.env`` is
   never overridden by generated material;
2. a file inside the secrets directory (default ``/run/voxi-secrets``), written
   0600 by the one-shot ``secrets`` service on first start.

``<NAME>_FILE`` overrides the file path for one secret. Nothing here logs a
value, and a value is only ever read when a caller asks for it by name.
"""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_SECRETS_DIR = "/run/voxi-secrets"


def secrets_dir() -> Path:
    """Directory the ``secrets`` service writes into (override: ``VOXI_SECRETS_DIR``)."""
    return Path(os.environ.get("VOXI_SECRETS_DIR") or DEFAULT_SECRETS_DIR)


def read_secret(name: str, file_name: str) -> str:
    """Return the secret for ``name``, preferring the environment over the file.

    Returns an empty string when neither source is present; callers already
    fail closed on a short or empty secret, so an absent value is never a
    usable credential.
    """
    value = os.environ.get(name, "").strip()
    if value:
        return value
    override = os.environ.get(f"{name}_FILE", "").strip()
    path = Path(override) if override else secrets_dir() / file_name
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""
