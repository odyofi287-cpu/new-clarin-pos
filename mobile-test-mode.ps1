param(
  [int]$Port = 4000
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $projectRoot 'server'

if (-not (Test-Path $serverDir)) {
  Write-Error "Server folder not found: $serverDir"
}

# Prefer the currently connected interface (usually Wi-Fi).
$activeProfile = Get-NetConnectionProfile -ErrorAction SilentlyContinue |
  Where-Object { $_.IPv4Connectivity -ne 'Disconnected' } |
  Select-Object -First 1

$ipCandidate = $null
if ($activeProfile) {
  $ipCandidate = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.InterfaceAlias -eq $activeProfile.InterfaceAlias -and
      $_.AddressState -eq 'Preferred' -and
      $_.SkipAsSource -eq $false -and
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254*'
    } |
    Select-Object -First 1
}

if (-not $ipCandidate) {
  # Fallback: choose non-virtual Wi-Fi/Ethernet interface.
  $ipCandidate = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.AddressState -eq 'Preferred' -and
      $_.SkipAsSource -eq $false -and
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254*' -and
      $_.InterfaceAlias -notmatch 'vEthernet|WSL|Hyper-V|Virtual|Loopback' -and
      ($_.InterfaceAlias -match 'Wi-?Fi|Ethernet')
    } |
    Select-Object -First 1
}

if (-not $ipCandidate) {
  $ipCandidate = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |
    Select-Object -First 1
}

if (-not $ipCandidate) {
  Write-Error 'No suitable LAN IPv4 address found.'
}

$lanIp = $ipCandidate.IPAddress

# Stop any process already listening on the selected port.
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $existingProcId = $existing[0].OwningProcess
  try {
    Stop-Process -Id $existingProcId -Force -ErrorAction Stop
    Start-Sleep -Seconds 1
    Write-Host "Stopped process on port $Port (PID $existingProcId)."
  } catch {
    Write-Warning "Could not stop existing process on port $Port (PID $existingProcId): $($_.Exception.Message)"
  }
}

Push-Location $serverDir
$env:PORT = "$Port"

Write-Host "Starting backend on port $Port..."
$serverProcess = Start-Process -FilePath 'node' -ArgumentList 'index.js' -PassThru

# Wait for port to be ready.
$ready = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Milliseconds 300
  $isListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($isListening) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  Pop-Location
  Write-Error "Server did not start on port $Port in time."
}

# Verify health endpoint.
$healthUrl = "http://localhost:$Port/api/health"
$healthStatus = 'unknown'
try {
  $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
  if ($health.status -eq 'ok') {
    $healthStatus = 'ok'
  } else {
    $healthStatus = 'unexpected'
  }
} catch {
  $healthStatus = 'failed'
}

$mobileUrl = "http://${lanIp}:$Port"

Write-Host ''
Write-Host '=== Mobile Test Mode ==='
Write-Host "Server PID: $($serverProcess.Id)"
Write-Host "LAN URL:   $mobileUrl"
Write-Host "Health:    $healthStatus"
Write-Host ''
Write-Host 'Open this URL on your phone (same Wi-Fi):'
Write-Host $mobileUrl
Write-Host ''
Write-Host 'To stop later:'
Write-Host "Stop-Process -Id $($serverProcess.Id)"

Pop-Location
