<#
.SYNOPSIS
  Turnkey first-run bootstrap for the Voxi TLS proxy stack (idempotent).

.DESCRIPTION
  Prepares .env and local TLS material, then (optionally) builds the WebUI and
  brings the gateway + proxy up over HTTPS. Designed to be run repeatedly: it
  never overwrites a secret that already looks set, so re-running only fills the
  gaps. Secrets are written to .env with owner-only permissions and are NEVER
  printed to the console or a log unless you explicitly pass -ShowKey.

  Identity model (see docs/deployment.md and integrations/nginx/README.md):
    * The proxy injects a SEPARATE, revocable local key (VOXI_WEBUI_KEY) for
      same-origin /v1 calls — never the master VOXI_API_KEY. That key is
      registered in VOXI_API_KEYS_JSON as id "webui-local" (SHA-256 stored, raw
      secret kept only in .env). Revoke = -RotateKey (or delete that record).
    * Injection is only sound on loopback. The nginx entrypoint hard-refuses to
      start injection against a non-loopback bind, so -ExposeLan also turns
      injection OFF: each LAN client then supplies its own key over TLS.

.PARAMETER ShowKey
  Print the current local WebUI key once, on demand, and exit without changing
  anything. This is the only path that surfaces the secret.

.PARAMETER RotateKey
  Generate a fresh local WebUI key and replace the "webui-local" record, even if
  one already exists (revokes the previous key).

.PARAMETER ExposeLan
  Configure for LAN access: bind the proxy to -LanIP (auto-detected if omitted),
  set VOXI_PROXY_INJECT=false, and include that IP in the certificate SANs. The
  proxy's loopback guards are disabled in this mode; every client needs a key.

.PARAMETER LanIP
  LAN address to bind/cert when -ExposeLan is set. Auto-detected if omitted.

.PARAMETER KeysOnly
  Only reconcile .env + certificates; skip the WebUI build and docker compose.

.PARAMETER ForceCert
  Regenerate the self-signed TLS certificate even if certs/voxi.crt already
  exists. Use this after -ExposeLan when the LAN address changed, so the
  certificate SAN covers the address clients will dial.

.PARAMETER SkipBuild
  Reconcile and bring the stack up, but do not rebuild the frontend (voxi-proxy) image.

.PARAMETER NoBrowser
  Print the clickable UI link but do not auto-open it in the default browser.

.EXAMPLE
  pwsh infra/bootstrap.ps1                 # first run: keys + cert + build + up
  pwsh infra/bootstrap.ps1 -NoBrowser      # bring up, show link, don't open browser
  pwsh infra/bootstrap.ps1 -KeysOnly       # just (re)concile .env + cert
  pwsh infra/bootstrap.ps1 -ShowKey        # reveal the local WebUI key once
  pwsh infra/bootstrap.ps1 -RotateKey      # revoke + issue a new local key
  pwsh infra/bootstrap.ps1 -ExposeLan -LanIP 192.168.1.50
#>
[CmdletBinding()]
param(
  [switch] $ShowKey,
  [switch] $RotateKey,
  [switch] $ExposeLan,
  [string] $LanIP,
  [switch] $KeysOnly,
  [switch] $ForceCert,
  [switch] $SkipBuild,
  [switch] $NoBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$envPath = Join-Path $root ".env"
$examplePath = Join-Path $root ".env.example"
$certDir = Join-Path $root "certs"
$webuiKeyScopes = @("audio:read", "audio:write", "realtime:connect")

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Info($m) { Write-Host "    $m" }

function New-Secret {
  $bytes = New-Object 'byte[]' 48
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  # base64url, 64 chars, no padding — matches `secrets.token_urlsafe(48)`.
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Get-Sha256Hex([string]$s) {
  $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
  return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
}

# A secret counts as "already provided" only if it is non-empty, not a
# placeholder, and long enough to be a real key. Placeholders like the shipped
# `change-me` (or a too-short leftover) are treated as absent and regenerated.
function Test-HasSecret([string]$v) {
  if ([string]::IsNullOrWhiteSpace($v)) { return $false }
  if ($v -match "(?i)change[-_ ]?me") { return $false }
  if ($v.Trim().Length -lt 32) { return $false }
  return $true
}

function Read-EnvValue([string]$name) {
  if (-not (Test-Path $envPath)) { return $null }
  foreach ($line in @(Get-Content -LiteralPath $envPath)) {
    if ($line -match "^\s*$([regex]::Escape($name))\s*=(.*)$") {
      $v = $matches[1].Trim()
      if ($v.Length -ge 2 -and (($v[0] -eq "'" -and $v[-1] -eq "'") -or ($v[0] -eq '"' -and $v[-1] -eq '"'))) {
        $v = $v.Substring(1, $v.Length - 2)
      }
      return $v
    }
  }
  return $null
}

function Set-EnvValue([string]$name, [string]$value, [switch]$Quote) {
  $literal = if ($Quote) { "$name=`"$($value.Replace('"','\"'))`"" } `
             elseif ($name -eq "VOXI_API_KEYS_JSON") { "$name='$value'" } `
             else { "$name=$value" }
  if (-not (Test-Path $envPath)) { Set-Content -LiteralPath $envPath -Value $literal; return }
  $lines = @(Get-Content -LiteralPath $envPath)
  $rx = "^\s*$([regex]::Escape($name))\s*="
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $rx) { $lines[$i] = $literal; $found = $true; break }
  }
  if (-not $found) { $lines += $literal }
  Set-Content -LiteralPath $envPath -Value $lines
}

# Merge/replace one id in the VOXI_API_KEYS_JSON array without disturbing other
# records (e.g. an stt-client key the operator added by hand). Always emits a
# JSON array so the gateway Keyring parses it.
function Update-KeysJson([string]$existing, [string]$id, [string]$sha) {
  $records = @()
  if (-not [string]::IsNullOrWhiteSpace($existing)) {
    try { $records = @($existing | ConvertFrom-Json) } catch { $records = @() }
  }
  $records = @($records | Where-Object { $_.id -ne $id })
  $records += [pscustomobject]@{ id = $id; sha256 = $sha; scopes = $webuiKeyScopes }
  # -InputObject (not the pipeline) keeps a single-element array as a JSON array;
  # -Depth must exceed 2 or `scopes` is flattened to a space-joined string.
  return (ConvertTo-Json -InputObject @($records) -Compress -Depth 6)
}

function Set-OwnerOnly([string]$path) {
  if ($IsWindows) {
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    # Break inheritance, grant ONLY the current user full control.
    icacls $path /inheritance:r /grant:r "${user}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed on $path (exit $LASTEXITCODE)" }
  } else {
    chmod 600 $path
  }
}

function Get-LanIP {
  $candidates = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch "^127\." -and $_.IPAddress -notmatch "^169\." -and $_.PrefixOrigin -ne "WellKnown" })
  if ($candidates.Count -eq 0) { return $null }
  return $candidates[0].IPAddress
}

function Ensure-Cert([string[]]$sans) {
  New-Item -ItemType Directory -Force $certDir | Out-Null
  $crt = Join-Path $certDir "voxi.crt"
  $key = Join-Path $certDir "voxi.key"
  if ($ForceCert) {
    Remove-Item $crt, $key -Force -ErrorAction SilentlyContinue
    Info "-ForceCert: regenerating TLS material."
  }
  if ((Test-Path $crt) -and (Test-Path $key)) { Info "TLS cert present: $crt"; return }
  $san = "subjectAltName=" + ($sans -join ",")
  Step "Generating self-signed TLS certificate (SAN: $san)"
  $openssl = Get-Command openssl -ErrorAction SilentlyContinue
  if ($openssl) {
    & openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes `
      -keyout $key -out $crt -subj "/CN=voxi-gateway" -addext $san
    if ($LASTEXITCODE -ne 0) { throw "openssl cert generation failed" }
  } else {
    $crtAbs = (Resolve-Path $certDir).Path
    & docker run --rm -v "${crtAbs}:/out" alpine/openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes `
      -keyout /out/voxi.key -out /out/voxi.crt -subj "/CN=voxi-gateway" -addext $san
    if ($LASTEXITCODE -ne 0) { throw "docker openssl cert generation failed (no local openssl)" }
  }
  Set-OwnerOnly $key
  Info "Wrote $crt and $key (owner-only)."
}

# --- 1. Ensure .env exists (seed from .env.example, never overwrite secrets) ---
if (-not (Test-Path $envPath)) {
  if (-not (Test-Path $examplePath)) { throw "Neither .env nor .env.example found in $root." }
  Copy-Item -LiteralPath $examplePath -Destination $envPath
  Info "Created .env from .env.example"
}
Set-OwnerOnly $envPath

# --- 2. Reconcile secrets idempotently --------------------------------------
$apiKey = Read-EnvValue "VOXI_API_KEY"
if (-not (Test-HasSecret $apiKey)) {
  Step "Generating master API key (VOXI_API_KEY)"
  $apiKey = New-Secret
  Set-EnvValue "VOXI_API_KEY" $apiKey
  Info "Created a new master key (not printed; use -ShowKey pattern if needed)."
} else { Info "Master key already set — left untouched." }

$workerKey = Read-EnvValue "VOXI_WORKER_API_KEY"
if (-not (Test-HasSecret $workerKey)) {
  Step "Generating worker key (VOXI_WORKER_API_KEY)"
  Set-EnvValue "VOXI_WORKER_API_KEY" (New-Secret)
} else { Info "Worker key already set — left untouched." }

$webuiKey = Read-EnvValue "VOXI_WEBUI_KEY"
if ($RotateKey -or -not (Test-HasSecret $webuiKey)) {
  Step $(if ($RotateKey) { "Rotating local WebUI key (revokes the previous one)" } else { "Generating local WebUI key (VOXI_WEBUI_KEY)" })
  $webuiKey = New-Secret
  Set-EnvValue "VOXI_WEBUI_KEY" $webuiKey
} else { Info "Local WebUI key already set — left untouched." }

$sha = Get-Sha256Hex $webuiKey
$existingJson = Read-EnvValue "VOXI_API_KEYS_JSON"
Set-EnvValue "VOXI_API_KEYS_JSON" (Update-KeysJson $existingJson "webui-local" $sha) -Quote:$false
Info "Registered 'webui-local' in VOXI_API_KEYS_JSON (SHA-256 only)."

# --- 3. Proxy identity mode -------------------------------------------------
if ($ExposeLan) {
  if (-not $LanIP) {
    $LanIP = Get-LanIP
    if (-not $LanIP) { throw "-ExposeLan needs a LAN address; pass -LanIP <ip>." }
  }
  Set-EnvValue "VOXI_PROXY_INJECT" "false"
  Set-EnvValue "VOXI_PROXY_BIND_IP" $LanIP
  $sans = @("DNS:localhost", "IP:127.0.0.1", "IP::$LanIP")
  Info "LAN mode: injection OFF, bind $LanIP. Each client must send its own key over TLS."
  Info "If certs/voxi.crt predates this address, re-run with -ForceCert so the SAN covers $LanIP."
} else {
  Set-EnvValue "VOXI_PROXY_INJECT" "true"
  Set-EnvValue "VOXI_PROXY_BIND_IP" "127.0.0.1"
  $sans = @("DNS:localhost", "IP:127.0.0.1", "IP:::1")
  Info "Loopback mode: keyless local identity ON (same-host only)."
}
$proxyPort = Read-EnvValue "VOXI_PROXY_PORT"
if ([string]::IsNullOrWhiteSpace($proxyPort)) { $proxyPort = "8443" }

# --- 4. TLS material (mandatory; entrypoint refuses without it) ------------
Ensure-Cert $sans

# --- 5. -ShowKey: reveal the local key once, then stop ---------------------
if ($ShowKey) {
  Write-Host "`nLocal WebUI key (VOXI_WEBUI_KEY):" -ForegroundColor Yellow
  Write-Host $webuiKey
  Write-Host "Keep this private. -RotateKey revokes it. It is not the master key." -ForegroundColor DarkGray
  return
}

if ($KeysOnly) { Step "Keys/cert reconciled (-KeysOnly: skipping build + compose)"; return }

# --- 6. Build frontend image + bring the stack up ---------------------------
$compose = @("-f", "compose.yaml", "-f", "infra/compose.proxy.yaml")

if (-not $SkipBuild) {
  Step "Building the WebUI frontend image (SPA compiled inside Docker)"
  & docker compose $compose build webui
  if ($LASTEXITCODE -ne 0) { throw "docker compose build webui failed" }
}

Step "Starting gateway + WebUI + TLS proxy (waits for health)"
& docker compose $compose up -d --wait --wait-timeout 600 gateway webui proxy
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

$hostLabel = if ($ExposeLan) { $LanIP } else { "localhost" }
$url = "https://${hostLabel}:${proxyPort}/ui/"
Step "Ready"

# Clickable link (Windows Terminal OSC 8) + auto-open. Fall back to the plain
# URI line (still Ctrl+clickable) if the browser cannot be launched.
$esc = [char]27
$bel = [char]7
$link = "$esc]8;;$url$bel$url$esc]8;;$bel"
Write-Host "    Tıkla ve aç : $link" -ForegroundColor Green

if (-not $NoBrowser) {
  Info "Tarayıcıda açıyorum… (self-signed sertifika uyarısında 'Yine de devam et' deyin.)"
  try { Start-Process $url } catch { Write-Host "    Otomatik açamadım, bağlantıya tıklayın: $url" -ForegroundColor Yellow }
}
