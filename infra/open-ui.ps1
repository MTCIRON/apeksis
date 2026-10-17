<#
.SYNOPSIS
  Print (and open) the clickable Voxi WebUI URL for the running Docker stack.

.DESCRIPTION
  Derives the console address from .env (VOXI_PROXY_BIND_IP / VOXI_PROXY_PORT) so
  it works whether you started via bootstrap.ps1 or a plain `docker compose up`.
  Loopback/0.0.0.0 binds resolve to `localhost`; a LAN bind keeps its real IP so
  another device's clickable link still points at this host. Emits an OSC 8
  hyperlink (clickable in Windows Terminal) and opens the default browser.

.PARAMETER NoBrowser
  Show the clickable link only; do not auto-open the browser.

.EXAMPLE
  pwsh infra/open-ui.ps1
  pwsh infra/open-ui.ps1 -NoBrowser
#>
[CmdletBinding()]
param(
  [switch] $NoBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$envPath = Join-Path $root ".env"

function Read-Env($name, $default) {
  if (-not (Test-Path $envPath)) { return $default }
  foreach ($line in Get-Content -LiteralPath $envPath) {
    $t = $line.Trim()
    if ($t -eq "" -or $t.StartsWith("#")) { continue }
    $i = $t.IndexOf("=")
    if ($i -lt 1) { continue }
    if ($t.Substring(0, $i).Trim() -eq $name) {
      return ($t.Substring($i + 1).Trim().Trim('"').Trim("'"))
    }
  }
  return $default
}

$bind = Read-Env "VOXI_PROXY_BIND_IP" "127.0.0.1"
$port = Read-Env "VOXI_PROXY_PORT" "8443"
if ([string]::IsNullOrWhiteSpace($port)) { $port = "8443" }

# Loopback / all-interfaces bind => reach it as localhost from this machine.
# A concrete LAN IP => keep it so other devices' links resolve correctly.
$hostLabel = switch ($bind) {
  { $_ -in @("", "127.0.0.1", "::1", "0.0.0.0", "localhost", "[::1]") } { "localhost" }
  default { $bind }
}
$url = "https://${hostLabel}:${port}/ui/"

$esc = [char]27
$bel = [char]7
$link = "$esc]8;;$url$bel$url$esc]8;;$bel"
Write-Host "Voxi WebUI  : $link" -ForegroundColor Green

if (-not $NoBrowser) {
  try { Start-Process $url } catch { Write-Host "Otomatik açılamadı, bağlantıya tıklayın: $url" -ForegroundColor Yellow }
}
