# Security policy

## Supported surface

No tagged releases exist yet. Report findings against **the current state of this
repository** (the `main` tree and the stack it builds: `compose.yaml` +
`infra/compose.proxy.yaml`) and the Docker images those files build. Older states are not
supported; if a finding reproduces only against an old build, mention it anyway.

## How to report

**Do not open a public issue for a security problem.** Use GitHub's private
**Security Advisories** channel (the repository's *Security → Report a vulnerability* flow).
There is no report-by-email and no bug bounty; the maintainer responds on a best-effort
basis and no response-time limit is promised. If the repository has not yet been published,
hold your report until it is — there is no private intake channel before that.

Please include:

- the **affected component**: a gateway route (`/v1/*`, the WebSocket routes), a worker
  (`tts-ema`, `stt-whisper`, opt-in Antalia/turbo), the `proxy` TLS edge, the WebUI bundle,
  secret generation (`scripts/bootstrap_secrets.py`) or model provisioning
  (`scripts/provision_models.py`);
- the Compose overlay files and profiles you ran, Docker version, and (for WebUI findings)
  the browser/platform;
- minimal reproduction steps and **redacted** logs — never paste API keys, `secrets` volume
  contents, `VOXI_API_KEY` values or private key material;
- your assessment of impact. Conclusions you can't justify can be left open; the measurement
  will determine them.

## What counts as in scope

- Authentication/authorization bypass on any served route, cross-worker or cross-tenant data
  leakage, unsafe WebSocket framing that reaches another client's session.
- Anything that breaks the integrity chain of model provisioning: a way to run, substitute or
  download model files **without** passing the pinned commit revision and SHA-256 verification
  in `src/voxi/providers/inventory.py` / `scripts/provision_models.py`.
- Token/secret exposure (`HF_TOKEN`, generated API keys, TLS keys) into images, logs,
  containers' filesystems or the WebUI bundle.
- Script injection, path traversal or prototype pollution reachable through the WebUI or the
  file ingestion paths; SSRF introduced by any endpoint that fetches user-influenced URLs.
- The `proxy` edge serving the WebUI or gateway to network clients in a way that ignores the
  documented generation-time guards.

## Explicitly out of scope

- Model quality (how good the speech or transcription sounds/reads) — that is not a defect,
  it is the honest limit recorded in `docs/verification.md`.
- Findings that require a malicious operator on the same host — a self-hosted root account
  can always read the local volumes; there is no hardening claim against the machine's owner.
- Absence of features (multi-tenancy, rate-limit dashboards, SIEM integration) is a roadmap
  question, not a vulnerability.
- Reports about the upstream model repositories (EMA Lightning, Faster-Whisper, Antalia) or
  third-party npm/PyPI packages that do not involve how this project integrates them — route
  those to the respective projects, but tell us if our integration is the amplifier.

## Supply-chain posture you can rely on (and challenge)

Models are installed only through the pinned `provision-*` one-shot Compose services, each
file verified by SHA-256 against an immutable commit revision; models are never downloaded at
runtime and no model ID is ever substituted. Generated TLS keys and API keys live in the
`secrets` volume, never in the repository or in images. `CI` builds and tests never download
models. If you find a path where any of that can be silently defeated, that is exactly the
kind of report this policy wants — before publishing a measured workaround publicly, please
coordinate through the advisory channel.
