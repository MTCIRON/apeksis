<#
.SYNOPSIS
  Repeatable WebUI (and optional backend) redeploy for the Voxi proxy stack.

.DESCRIPTION
  Encodes the two operational traps discovered while building the UI:
    1. Any change under src/ makes the running containers serve stale baked code
       (the Dockerfile COPYs src in the shared base stage) -> rebuild the images.
    2. A rebuilt webui/dist is not picked up by the proxy's read-only bind mount
       on Docker Desktop (Windows) -> recreate the proxy so it re-mounts fresh dist.
  After redeploy it runs scripts/smoke_ui.py to prove the correct (not fallback)
  assets are actually being served.

.EXAMPLE
  pwsh infra/redeploy.ps1                 # rebuild UI, recreate proxy, verify assets
  pwsh infra/redeploy.ps1 -Backend        # also rebuild gateway/tts/stt images (src changed)
  pwsh infra/redeploy.ps1 -SkipBuild      # only recreate + verify (dist already built)
  pwsh infra/redeploy.ps1 -TurnStub       # include infra/compose.turnstub.yaml so
                                          # /v1/sessions + /v1/sessions/{id}/turns can
                                          # be exercised without a real n8n deployment.
#>
param(
  [string] $Url = "https://localhost:8443",
  [switch] $Backend,
  [switch] $SkipBuild,
  [switch] $TurnStub
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$compose = @("-f", "compose.yaml", "-f", "infra/compose.proxy.yaml")
if ($TurnStub) { $compose += @("-f", "infra/compose.turnstub.yaml") }

function Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Assert-LastExit($label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}

if (-not $SkipBuild) {
  Step "Building WebUI (tsc + vite)"
  npm --prefix webui run build
  Assert-LastExit "npm run build"
}

if ($Backend) {
  Step "Rebuilding backend images (gateway, tts-ema, stt-whisper)"
  docker compose $compose build gateway tts-ema stt-whisper
  Assert-LastExit "docker compose build"
}

Step "Recreating proxy (re-establishes bind mount on the fresh dist)"
$services = if ($Backend) { @("gateway", "tts-ema", "stt-whisper", "proxy") } else { @("proxy") }
if ($TurnStub) { $services += "turn-stub" }
docker compose $compose up -d --force-recreate --wait --wait-timeout 600 @services
Assert-LastExit "docker compose up"

Step "Verifying served assets are fresh and correctly typed"
python scripts/smoke_ui.py --url $Url --insecure
Assert-LastExit "smoke_ui"

Step "Done"
