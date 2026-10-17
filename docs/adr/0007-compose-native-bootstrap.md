# ADR 0007: Compose-native first-run secrets and TLS

Status: Accepted (2026-10-16)

## Context
ADR 0006 delivered turnkey local identity, but only through `infra/bootstrap.ps1` — a
PowerShell script. That leaves two gaps for the stated install goal ("a user installs on
their own server with `git clone` then `docker compose up -d`"):

1. **Platform.** `bootstrap.ps1` is Windows-only, so a Linux server has no turnkey path.
2. **Two commands, two code paths.** A POSIX `install.sh` would mean maintaining a second
   implementation that drifts from the PowerShell one.

Both `.env` (worker/master/local keys) and `certs/` (TLS) are gitignored, and the proxy
entrypoint refuses to start without TLS material, so a literal fresh clone could not come up
at all. The alternative was shipping a committed `.env` and self-signed certificate, which
puts real secrets in the repository — rejected.

The chosen direction is to move the same logic **into Compose**, where it runs on every
platform, and to keep the security model intact rather than trading it for convenience.

## Decision
A one-shot `secrets` service runs before the gateway, the workers and the proxy
(`depends_on: service_completed_successfully`) and generates, **once**, the local material a
fresh clone needs. It is `scripts/bootstrap_secrets.py`, run from the gateway image.

The following properties are contractual, not incidental:

1. **User material always wins.** An explicit environment value (`VOXI_WORKER_API_KEY`,
   `VOXI_API_KEY`, `VOXI_API_KEYS_JSON`, `VOXI_WEBUI_KEY`) or an existing `certs/voxi.crt` +
   `certs/voxi.key` pair means nothing is generated and nothing is overwritten.
2. **Fail-closed is preserved, not removed.** `REQUIRE_PROVIDED_CERTS=1` restores "no cert,
   no start": the generator refuses to create a certificate, a missing pair fails the stack,
   and a certificate this project generated is refused because it carries
   `certs/.generated-by-voxi`. The default (generate a loopback certificate) is for
   single-machine use; LAN and production set the flag.
3. **Generation is idempotent.** A key is written only when no file and no environment value
   exists. Re-running `up -d` cannot rotate the worker key out from under a running stack.
4. **No secret value leaves the file.** Values are never printed, never logged, and — when
   generated — never placed in a container's environment. Files are root-owned with no world
   access: `0600 root:root` where the only reader is the root proxy process (`webui.key`,
   `certs/voxi.key`), and `0640 root:voxi` where the reader is the UID 10001 runtime
   (`worker.key`, `app.key`, `api-keys.json`). `0600` root-owned is impossible for a
   non-root reader; `0640` to the single runtime group is the honest equivalent, and this
   deviation is documented rather than hidden.
5. **The default bind stays loopback.** A generated certificate does not make publishing to
   the world safe, so `VOXI_PROXY_BIND_IP` still defaults to `127.0.0.1` and the entrypoint
   still refuses injection on a non-loopback bind.
6. **SANs are explicit.** A generated certificate covers `localhost`, `127.0.0.1`, `::1`, the
   LAN bind address when it is not loopback, and any `VOXI_TLS_SAN` entries.
7. **Ordering is declarative.** `secrets` is a `depends_on` target of every consumer, which
   also keeps `docker compose up -d --wait` returning 0 (Compose treats an exited one-shot
   with no dependent as a `--wait` failure).
8. **The generator has no network.** `network_mode: none`, all capabilities dropped except
   `CHOWN`, read-only root filesystem.

## Consequences
`git clone <repo> && cd <repo> && docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d`
is a complete install on any platform, with no `.env` and no host bootstrap script. The `proxy`
service is defined only in the overlay, so that command is the canonical install and a bare
`docker compose up -d` starts the API without the TLS/UI edge, not a half-working console.
`bootstrap.ps1` remains as an equivalent Windows host-side path (and for `-ShowKey` /
`-RotateKey`), not as the only one. The gateway and workers gain a secret-source seam
(`environment → <NAME>_FILE → VOXI_SECRETS_DIR/<file>`, `src/voxi/secrets.py`) and read a new
`voxi-secrets` volume; the proxy entrypoint reads `webui.key` from it when `VOXI_WEBUI_KEY` is
empty.

Residual risk is unchanged from ADR 0006: a generated certificate encrypts the transport but
proves no server identity, and a Docker administrator can read the secrets volume. Neither is
a regression against the previous state, where the same secrets lived in `.env`.
