# ADR 0006: Turnkey local identity through the TLS proxy
Status: Accepted

## Context
The WebUI console and single-command Docker bring-up must be usable without the
operator generating and pasting an API key, while the gateway still requires a
bearer on every `/v1` call (ADR 0001, threat model). Publishing the gateway
directly to a host port collides with the Windows reserved 8080 range and, worse,
would expose an unauthenticated audio API. The nginx TLS proxy
(`infra/compose.proxy.yaml`) is already the only published service, so it is the
natural place to add a local identity — but "inject a key and stay on loopback"
has a concrete hole: any other page open in the same browser can dial
`http://127.0.0.1:8443` and, via DNS rebinding, read the response and ride the
operator's injected identity. Loopback alone does not stop that.

## Decision
1. **Server-side injection, never in the browser.** The proxy adds the bearer for
   same-origin `/v1` calls; the WebUI holds no key in the normal local flow. The
   key that is injected is a **separate, revocable** local key (`VOXI_WEBUI_KEY`),
   registered in `VOXI_API_KEYS_JSON` as `webui-local` by SHA-256 — it is never the
   master `VOXI_API_KEY`, so leaking or revoking it does not compromise other
   clients.
2. **Keyless is sound, not merely loopback-bound.** In inject mode the proxy fails
   closed before any injection or upstream hop on: a foreign `Host` (→ 421, cuts
   DNS rebinding), and a cross-site request via `Origin` or `Sec-Fetch-Site:
   cross-site` (→ 403). No CORS is ever advertised — same-origin is the only
   supported WebUI origin.
3. **Startup guard lives in the entrypoint, not only in the script.** While
   injection is on, a non-loopback `VOXI_PROXY_BIND_IP` makes the container refuse
   to start, so a hand-edit of `.env` cannot bypass the invariant. TLS is mandatory
   in every mode (no cert → no start), so a LAN bearer never travels in cleartext.
4. **LAN exposure is an explicit, different mode.** `bootstrap.ps1 -ExposeLan`
   turns injection **off**, unbinds the loopback guards, and requires each client to
   supply its own key over TLS. The proxy serves an operator-facing
   `/ui/runtime.json` (no secret, not part of the `/v1` contract) so the Settings
   screen can state honestly whether this install auto-identifies or needs a key.
5. **Secrets at rest.** `bootstrap.ps1` is idempotent (never overwrites a real
   secret; treats empty/`change-me` as absent), writes keys only to `.env` with
   owner-only permissions (`icacls` / `600`), and never prints them except on the
   explicit `-ShowKey` request. The rendered nginx config may embed the injected
   bearer, so it is written `0600`; `log_format voxi_safe` records `$uri` only and
   `error_log` is pinned to `warn`, so the key never reaches an access or error log.

## Accepted residual risk
On a **shared machine**, another local user or a local process can still reach the
loopback port and consume the injected identity keyless: loopback trust is
same-host trust, not same-user trust. This is accepted for the single-user,
single-host turnkey case. **On any shared or multi-tenant host, disable local
auto-identity** (`VOXI_PROXY_INJECT=false`, i.e. `-ExposeLan` semantics or per-client
keys) so no credential is injected for anonymous loopback callers.

## Consequences
The topology is unchanged (gateway + tts-ema + stt-whisper + proxy stay isolated per
ADR 0001); turnkey is delivered by one compose override + `bootstrap.ps1` + the proxy
entrypoint, not by merging containers. The proxy now owns identity policy, so its
template/entrypoint are security-critical code reviewed alongside the gateway.
