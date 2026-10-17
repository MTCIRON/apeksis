# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan
"""Insert the project's SPDX header into source files. Idempotent and safe.

Run from the repository root:

    python scripts/add_spdx_headers.py --check   # report only, exit 1 if work is pending
    python scripts/add_spdx_headers.py           # write the missing headers

Rules:
* Only files under the roots below with the listed suffixes are touched.
* A file that already contains ``SPDX-License-Identifier`` is never modified, so running this
  twice is a no-op.
* A Python shebang line, a PEP 263 ``coding:`` line and a TypeScript ``/// <reference`` directive
  stay the first lines; the header is inserted directly after them.
* The file's existing newline style (LF or CRLF) and its BOM (if any) are preserved.
* Generated/vendored/reference trees (``node_modules``, ``dist``, ``example-projects``,
  ``.venv*``, ``models``, ``certs``, ``smoke-output``, ``docs``) are never
  touched.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

COPYRIGHT = "2026 Mustafa Tayyar Çalışkan"
SPDX_LICENSE = "AGPL-3.0-or-later"

ROOTS = ["src", "scripts", "tests", "infra", "integrations", "webui/src", "webui/tests"]
EXTRA_FILES = ["conftest.py"]
EXTENSIONS = {".py", ".ts", ".tsx", ".css", ".sh"}

EXCLUDED_DIRS = {
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    "example-projects",
    "models",
    "certs",
    "smoke-output",
    "docs",
    ".venv",
    ".venv-export",
    ".pytest-tmp",
    ".test-tmp",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}


def header_lines(suffix: str) -> list[str]:
    if suffix == ".css":
        return [
            "/*",
            f" * SPDX-License-Identifier: {SPDX_LICENSE}",
            f" * SPDX-FileCopyrightText: {COPYRIGHT}",
            " */",
        ]
    marker = "#" if suffix in {".py", ".sh"} else "//"
    return [
        f"{marker} SPDX-License-Identifier: {SPDX_LICENSE}",
        f"{marker} SPDX-FileCopyrightText: {COPYRIGHT}",
    ]


def insert_index(lines: list[str], suffix: str) -> int:
    """Return the index at which the header must be inserted (after shebang/coding/directives)."""
    index = 0
    if lines and lines[0].startswith("#!"):
        index = 1
    if suffix == ".py" and index < len(lines):
        first = lines[index].lstrip()
        if first.startswith("#") and "coding:" in first:
            index += 1
    is_ts = suffix in {".ts", ".tsx"}
    if is_ts and index < len(lines) and lines[index].startswith("/// <reference"):
        index += 1
    return index


def discover(root: Path) -> list[Path]:
    found: list[Path] = []
    for base in ROOTS:
        target = root / base
        if not target.exists():
            continue
        for path in sorted(target.rglob("*")):
            if not path.is_file() or path.suffix not in EXTENSIONS:
                continue
            if any(part in EXCLUDED_DIRS for part in path.relative_to(root).parts):
                continue
            found.append(path)
    for name in EXTRA_FILES:
        path = root / name
        if path.is_file():
            found.append(path)
    return found


def process(path: Path) -> str:
    """Return 'ok' (has header), 'added', or 'skipped'."""
    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    if "SPDX-License-Identifier" in text:
        return "ok"
    newline = "\r\n" if "\r\n" in text else "\n"
    had_trailing_newline = text.endswith(("\n", "\r"))
    lines = text.split(newline)
    index = insert_index(lines, path.suffix)
    head = lines[:index]
    tail = lines[index:]
    header = header_lines(path.suffix)
    merged = head + header + [""] + tail
    out = newline.join(merged)
    if had_trailing_newline and not out.endswith(newline):
        out += newline
    data = out.encode("utf-8")
    if bom:
        data = b"\xef\xbb\xbf" + data
    path.write_bytes(data)
    return "added"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="report pending files without writing")
    parser.add_argument("--root", default=".", help="repository root (default: current directory)")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    pending: list[Path] = []
    ok = 0
    added: list[Path] = []

    for path in discover(root):
        if args.check:
            text = path.read_text(encoding="utf-8", errors="replace")
            if "SPDX-License-Identifier" in text:
                ok += 1
            else:
                pending.append(path)
        else:
            result = process(path)
            if result == "added":
                added.append(path)
            else:
                ok += 1

    if args.check:
        print(f"with header: {ok}")
        print(f"missing header: {len(pending)}")
        for path in pending:
            print(f"  - {path.relative_to(root)}")
        return 1 if pending else 0

    print(f"already had header: {ok}")
    print(f"header added: {len(added)}")
    for path in added:
        print(f"  + {path.relative_to(root)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
