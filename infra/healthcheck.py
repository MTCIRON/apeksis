# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Dependency-free Docker readiness probe. No audio inference or key disclosure."""

import sys
import urllib.request


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: healthcheck.py URL")
    with urllib.request.urlopen(sys.argv[1], timeout=8) as response:
        if response.status != 200:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
