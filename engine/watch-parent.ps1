# dsh-focus-mode - restore the journal after the DSH process that created it exits.
# Spawned detached by the host plugin after a successful freeze. ASCII only:
# Windows PowerShell 5.1 misreads UTF-8 without a BOM.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [long]$ParentStartMs = 0,
  [Parameter(Mandatory=$true)][string]$StateFile,
  [Parameter(Mandatory=$true)][string]$ResumeScript
)
$ErrorActionPreference = 'SilentlyContinue'
$engine = Split-Path -Parent (Split-Path -Parent $StateFile)
$logDir = Join-Path $engine 'logs'
$log = Join-Path $logDir 'watch.log'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
function Note([string]$m) {
  try { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m) -Encoding UTF8 } catch { }
}
if (-not (Test-Path -LiteralPath $StateFile)) { exit 0 }
Note ('watch start pid=' + $ParentPid)
while ($true) {
  if (-not (Test-Path -LiteralPath $StateFile)) { Note 'journal gone; stop'; exit 0 }
  $p = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if (-not $p) { Note 'parent exited'; break }
  if ($ParentStartMs -gt 0) {
    $ms = -1
    try { $ms = ([DateTimeOffset]($p.StartTime.ToUniversalTime())).ToUnixTimeMilliseconds() } catch { }
    if ($ms -gt 0 -and [math]::Abs($ms - $ParentStartMs) -gt 3000) { Note 'pid reused; stop'; exit 0 }
  }
  Start-Sleep -Seconds 3
}
if (-not (Test-Path -LiteralPath $StateFile)) { exit 0 }
Note 'restoring journal'
& $ResumeScript -Yes -Quiet -StateFile $StateFile
Note ('resume exit=' + $LASTEXITCODE)
exit $LASTEXITCODE
