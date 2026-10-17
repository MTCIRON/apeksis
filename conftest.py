# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Repo-wide pytest bootstrap.

Priority-2 (docs/technical-debt.md): on some Windows profiles the default
pytest session root (``%TEMP%\\pytest-of-<user>``) exists but cannot be
enumerated or written under the current ACL, so ``tmp_path`` errors during
fixture *setup* with ``PermissionError: [WinError 5]`` even though the test
bodies are correct. Confirmed environment-only: the two affected
``tests/test_audio.py`` cases pass unchanged the moment ``tmp_path`` is
redirected to a writable base (``--basetemp`` yields 137 passed / 0 errors).

We probe ``%TEMP%`` lazily because touching that directory is exactly what
fails (and, under a locked ACL, can even block). So instead of probing we
always point the run at a repo-local base under the workspace, which is
reliably writable and equally hermetic on Linux CI. An explicit
``--basetemp`` from the operator is always respected.
"""

from __future__ import annotations

import os
from pathlib import Path


def pytest_configure(config) -> None:
    # Respect an explicit ``--basetemp`` the operator already supplied.
    if getattr(config.option, "basetemp", None):
        return
    run_dir = Path(config.rootpath, ".test-tmp", f"run-{os.getpid()}")
    run_dir.mkdir(parents=True, exist_ok=True)
    config.option.basetemp = str(run_dir)
