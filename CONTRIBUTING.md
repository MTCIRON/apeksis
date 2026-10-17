# Contributing

Thanks for considering a contribution. This project is licensed
**AGPL-3.0-or-later** (see [`LICENSE`](LICENSE)); by contributing you agree that your
contribution is licensed under the same terms.

## Before you start

- **Do not commit secrets.** `.env`, `certs/`, generated keys and `models/` are gitignored and
  must stay that way. Generated keys live root-owned in the `voxi-secrets` volume, never in
  `.env` or logs.
- **Do not commit model weights or large binaries.** Models are installed on the host by pinned
  `provision-*` services; the repo holds only their provenance (see
  [`docs/licensing.md`](docs/licensing.md) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)).
- **Do not commit the local reference material** (`example-projects/`, `_scratch_reference/`) or
  internal process notes (`docs/internal/`). They are gitignored on purpose.

## Development setup

```sh
uv sync --locked --extra dev          # base + dev extras only; no model downloads
uv run ruff check src scripts tests infra
uv run mypy src
uv run pytest
uv run python scripts/export_openapi.py
```

The test suite injects deterministic inference boundaries; it does not prove model quality.
`scripts/smoke.py` exercises deployed real file inference against a running stack.

For frontend work, always (re)install with the lockfile: `npm --prefix webui ci` before
`npm run build`. A clean `npm ci` build reproduces the shipped image's bundle **byte for byte**
(measured: host and in-image builds produced the identical 476,524-byte `index-*.js`,
SHA-256 `7C3F8BD1…`); a drifted host `node_modules` silently produces a different artifact.

Validate every Compose combination you touch (each must exit 0; CI runs the same set):

```sh
docker compose config --quiet
docker compose -f compose.yaml -f infra/compose.proxy.yaml config --quiet
docker compose -f compose.yaml -f infra/compose.offline.yaml config --quiet
docker compose -f compose.yaml -f infra/compose.nvidia.yaml --profile antalia --profile stt-turbo config --quiet
docker compose -f compose.yaml -f infra/compose.turnstub.yaml config --quiet
```

## Evidence rules

- Never fabricate timings, durations, transcripts or benchmark numbers. If a value is measured,
  say on what hardware; if it is not measured, say it is not measured. See
  [`docs/verification.md`](docs/verification.md).
- Gateway behaviour changes must be verified against a **running** stack, not only by tests.
- If you cannot verify something, write the honest limit in the docs instead of softening the
  claim.

## Source headers

Every source file starts with the project's SPDX header (one licence identifier, no dual tagging):

```python
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan
```

The comment form follows the language: `#` for Python and shell, `//` for TS/TSX, `/* … */` for CSS.
The script `scripts/add_spdx_headers.py` adds the header to every file that lacks one — it is
idempotent, skips shebang/`coding:`/`/// <reference>` lines correctly, and ignores `docs/`,
`example-projects/`, `node_modules/` and build output:

```bash
python scripts/add_spdx_headers.py --check   # report files that still miss a header
python scripts/add_spdx_headers.py           # insert the missing headers
```

## Commit sign-off (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org) instead
of a CLA. Every commit must be signed off with `git commit -s`, which appends a line like:

```text
Signed-off-by: Your Name <you@example.com>
```

The name and email must be your real identity and must match the commit author. By signing off you
certify the following:

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Reporting security issues

Do not open a public issue for a vulnerability. Until a dedicated address is published, report it
privately to the maintainer listed in [`README.md`](README.md).
