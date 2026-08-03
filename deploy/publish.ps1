# Publish script: deploy API to Aliyun server (run on this PC)
# Usage: .\deploy\publish.ps1 -ServerIp 47.x.x.x [-Token your-sync-token]
#   Token defaults to SYNC_TOKEN in pipeline/.env
# Prereq: server reachable via ssh root@ServerIp (password or key)
param(
  [Parameter(Mandatory=$true)][string]$ServerIp,
  [string]$Token = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$app = Join-Path $root "ai-news-miniprogram"
$stage = Join-Path $env:TEMP "ai-news-publish"

# --- resolve token ---
if (-not $Token) {
  $envFile = Join-Path $app "pipeline\.env"
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Select-String '^SYNC_TOKEN=' | Select-Object -First 1
    if ($line) { $Token = ($line.Line -replace '^SYNC_TOKEN=', '').Trim() }
  }
}
if (-not $Token) {
  Write-Host "ERROR: no token. Pass -Token xxx or add SYNC_TOKEN=xxx to pipeline/.env" -ForegroundColor Red
  exit 1
}

# --- stage files (exclude heavy/unneeded dirs) ---
Write-Host "[publish] staging files ..."
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
robocopy $app $stage /E /XD node_modules data miniprogram .github /NFL /NDL /NJH /NJS /NC /NS | Out-Null

# --- upload ---
Write-Host "[publish] uploading to root@$ServerIp ..."
ssh root@$ServerIp "mkdir -p /opt/ai-news/data"
scp -r "$stage\*" root@${ServerIp}:/opt/ai-news/
scp (Join-Path $app "data\articles.db") root@${ServerIp}:/opt/ai-news/data/

# --- install & start service ---
Write-Host "[publish] running install-server.sh ..."
ssh root@$ServerIp "SYNC_TOKEN=$Token bash /opt/ai-news/deploy/install-server.sh"

# --- verify with sync push ---
Write-Host "[publish] verifying sync push ..."
$env:SYNC_URL = "http://${ServerIp}:3000"
$env:SYNC_TOKEN = $Token
Set-Location (Join-Path $app "pipeline")
& "C:\Program Files\nodejs\node.exe" sync-push.mjs

Write-Host ""
Write-Host "[publish] done. Next:"
Write-Host "  1. Aliyun console: security group allow TCP 3000"
Write-Host "  2. miniprogram config.js dev.apiBase = http://${ServerIp}:3000"
