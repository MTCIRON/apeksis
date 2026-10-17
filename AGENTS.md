# AGENTS.md — guidance for AI coding agents working in this repository

Apeksis is a self-hosted Turkish speech platform: an OpenAI-compatible FastAPI gateway with
isolated model workers (EMA Lightning + Antalia-2 Mini TTS, Faster-Whisper STT), a React studio
(`webui/`), and a Docker Compose CPU deployment. Do not confuse it with a telephony product —
SIP/RTP/phone transfer is explicitly out of scope ([ADR 0002](docs/adr/0002-sip-stack.md)).

## Non-negotiable rules

- **Never fabricate measurements.** No invented timings, durations, transcripts, benchmark
  numbers or capacity figures. If a value was not measured on real hardware, say so or omit it.
  Evidence records live in [docs/verification.md](docs/verification.md).
- **Gateway behaviour changes must be verified against a running stack**, not only by unit
  tests: rebuild the affected image, `up -d --force-recreate` it, and re-check the served
  surface. Rebuilding an image does **not** recreate its container; recreating `webui` or
  `gateway` breaks `proxy` (stale upstream IP) — fix with `docker compose restart proxy`.
- **No secrets in the repo.** `.env`, `certs/`, `certs.saved/`, `models/`, `example-projects/`,
  `docs/internal/`, `_scratch_reference/` and `webui/.env` are gitignored on purpose. Generated
  keys live in the `secrets` volume, never in files the repo tracks.
- **Tests never download models and CI has none.** `pytest` injects deterministic inference
  boundaries (`HF_HUB_OFFLINE=1`). Do not add a test that reaches the network or needs weights.
- **Never substitute model IDs at runtime** to trigger silent downloads. Models install via the
  pinned `provision-*` one-shot services ([src/voxi/providers/inventory.py](src/voxi/providers/inventory.py)),
  each file verified by SHA-256 against its immutable commit revision.

## Commands

```sh
# Install (fresh clone, any platform) — the canonical turnkey command:
docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d --wait --wait-timeout 900
#   Both -f flags are required: proxy/webui live only in the overlay.

# Python checks (uv):
uv sync --locked --extra dev
uv run ruff check .
uv run mypy src
uv run pytest

# Frontend checks:
npm --prefix webui ci
npm --prefix webui test          # vitest run
npm --prefix webui run build     # tsc --noEmit && vite build

# Live smoke against a running stack (real inference, no fabricated data):
python scripts/smoke.py --base-url https://127.0.0.1:8443/v1 --ca-bundle certs/voxi.crt

# Validate Compose files (CI runs the same five):
docker compose config --quiet
docker compose -f compose.yaml -f infra/compose.proxy.yaml config --quiet
docker compose -f compose.yaml -f infra/compose.offline.yaml config --quiet
docker compose -f compose.yaml -f infra/compose.nvidia.yaml --profile antalia --profile stt-turbo config --quiet
docker compose -f compose.yaml -f infra/compose.turnstub.yaml config --quiet
```

## Conventions

- Licensing: **AGPL-3.0-or-later**, copyright Mustafa Tayyar Çalışkan (2026). Every source file
  starts with the SPDX header (see [CONTRIBUTING.md](CONTRIBUTING.md)); run
  `python scripts/add_spdx_headers.py` (or `--check`) after creating files.
- Visible product naming is **Apeksis**; the technical `voxi` identifiers (`voxi-*` images,
  volumes, `VOXI_*` env vars, `voxi.apiKey`) are deliberately not renamed. There are only two
  accepted spellings for user-facing words: `apeksis.*` browser keys and `voxi` technical names.
- Contracts: exported OpenAPI/WebSocket schemas live in `packages/contracts/`; after changing an
  API route, run `python scripts/export_openapi.py` and commit the updated contracts.
- Docs are load-bearing: when you change behavior, update [docs/deployment.md](docs/deployment.md)
  / [docs/troubleshooting.md](docs/troubleshooting.md) / [CHANGELOG.md](CHANGELOG.md) in the same
  change, and record the honest limits.

## Layout

| Path | What |
|---|---|
| `src/voxi/` | Gateway API, workers, providers, secrets seam (Python 3.12, `uv`, mypy strict-ish) |
| `webui/` | React + TS studio (one app, `/ui/` base); its own tests in `webui/tests/` |
| `scripts/` | `provision_models.py` (pinned downloads), `bootstrap_secrets.py`, smoke tools |
| `infra/` | Compose overlays, nginx template/entrypoint, Windows bootstrap, healthcheck |
| `integrations/` | n8n workflows, OpenWebUI/Hermes guides, nginx README |
| `packages/contracts/` | Exported OpenAPI 3.1 + WebSocket frame + n8n action schemas |
| `docs/` | Public design/deployment records; `docs/adr/` decisions; internal process notes stay in gitignored `docs/internal/` |

## Agent quick pointers

- LAN / trusted-LAN keyless access: `integrations/nginx/README.md` (§3 Trusted-LAN
  injection) — the refusal invariants and the explicit opt-in envs; identity reasoning in
  [docs/adr/0006-turnkey-local-identity.md](docs/adr/0006-turnkey-local-identity.md).
- Operating this stack inside another Compose deployment (central model tree, external
  network join, fixed container names, published-LAN bind):
  `infra/compose.lan-stack.example.yaml` + `docs/deployment.md` §"Merging into an
  existing Compose stack" and §"Updating an existing deployment".
- Symptom→action table (421/403, proxy refusals, permissions, port and Docker DNS
  naming): [docs/troubleshooting.md](docs/troubleshooting.md).
- Honest-evidence records for every verified gate:
  [docs/verification.md](docs/verification.md).
