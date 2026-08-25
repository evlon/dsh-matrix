# Batch create Synapse test users (UIA two-phase + rc_registration 429 retry)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-test-users.ps1
#        [-Users @("zhaolei","niukunliang")]
param([string[]]$Users = @("liuliye","suhuhu","dusanfeng","zhaolei","niukunliang","yuanhaijiao","shilei","ai-liuliye"))
$ErrorActionPreference = "Stop"
$uri = "https://im-ipm.ict.cmcc/_matrix/client/v3/register?kind=user"
$password = "Synapse@2026!Demo"

# NOTE: Invoke-WebRequest on Windows PowerShell 5.1 returns an EMPTY body stream for
# non-2xx responses (IE parser consumes it), so use curl.exe to read UIA session / errors.
# The body is written to a temp file and sent via "-d @file" to avoid the PowerShell
# 5.1 -> native command argument-quoting bugs (JSON quotes get mangled otherwise).
function Invoke-CurlJson {
  param([string]$Body)
  $tmp = Join-Path $env:TEMP ("reg-" + [guid]::NewGuid().ToString("N") + ".json")
  [System.IO.File]::WriteAllText($tmp, $Body, (New-Object System.Text.UTF8Encoding($false)))
  try {
    return & curl.exe -sk --connect-timeout 8 -X POST -H "Content-Type: application/json" --data-binary "@$tmp" $uri
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}

function Get-RegSession {
  for ($try = 1; $try -le 8; $try++) {
    $resp = Invoke-CurlJson -Body '{}'
    if (-not $resp) { return $null }
    $json = $resp | ConvertFrom-Json
    if ($json.session) { return $json.session }
    if ($json.errcode -eq "M_LIMIT_EXCEEDED") { Start-Sleep -Seconds 7; continue }
    return $null
  }
  return $null
}

foreach ($u in $Users) {
  $sess = Get-RegSession
  if (-not $sess) { Write-Host "FAIL $u : no reg session"; continue }

  $body = @{ username = $u; password = $password; auth = @{ type = "m.login.dummy"; session = $sess } } |
    ConvertTo-Json -Depth 3

  $done = $false
  foreach ($try in 1..8) {
    $resp = Invoke-CurlJson -Body $body
    if (-not $resp) { Write-Host "FAIL $u : empty response"; $done = $true; break }
    $json = $resp | ConvertFrom-Json
    if ($json.user_id) { Write-Host "OK  $u -> $($json.user_id)"; $done = $true; break }
    if ($json.errcode -eq "M_LIMIT_EXCEEDED") { Start-Sleep -Seconds 7; continue }
    if ($resp -match "already") { Write-Host "SKIP $u (exists)" } else { Write-Host "FAIL $u : $resp" }
    $done = $true
    break
  }
  if (-not $done) { Write-Host "FAIL $u : retries exhausted" }
}