<#
  dsh-focus-mode · 宿主降级（performance 档案专用）
  对 DSH 本体做「让位」：CPU 优先级、EcoQoS（能效核调度）、内存优先级，可选回收工作集。
  不冻结、不结束任何进程；状态写入 host-boost.json，restore-host.ps1 按指纹精确恢复。
  本文件须以 UTF-8 with BOM 保存。
#>
[CmdletBinding()]
param(
  [int]$ParentPid = 0,
  [ValidateSet('idle', 'below', 'normal')][string]$Priority = 'idle',
  [switch]$Eco,
  [switch]$KeepEco,
  [int]$MemPriority = 1,
  [switch]$Trim,
  [string]$StateFile,
  [switch]$Quiet, [switch]$EmitJson, [string]$JsonOut
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if (-not ('HB' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HB {
  const uint M_FULL = 0x0F00, M_SUSP = 0x1800;
  const uint PRIO_IDLE = 0x40, PRIO_BELOW = 0x4000;
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetProcessInformation(IntPtr h, int c, IntPtr b, int s);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessInformation(IntPtr h, int c, IntPtr b, int s);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetPriorityClass(IntPtr h, uint c);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetPriorityClass(IntPtr h);
  [DllImport("psapi.dll", SetLastError=true)] static extern bool EmptyWorkingSet(IntPtr h);
  static IntPtr Open(int pid) { IntPtr h = OpenProcess(M_FULL, false, pid); if (h == IntPtr.Zero) h = OpenProcess(M_SUSP, false, pid); return h; }
  static bool SetMem(IntPtr h, int v) { IntPtr b = Marshal.AllocHGlobal(4); try { Marshal.WriteInt32(b, v); return SetProcessInformation(h, 0, b, 4); } finally { Marshal.FreeHGlobal(b); } }
  static int GetMem(IntPtr h) { IntPtr b = Marshal.AllocHGlobal(4); try { Marshal.WriteInt32(b, 0); if (GetProcessInformation(h, 0, b, 4)) return Marshal.ReadInt32(b); return -1; } finally { Marshal.FreeHGlobal(b); } }
  static bool SetEco(IntPtr h, bool on) { IntPtr b = Marshal.AllocHGlobal(12); try { Marshal.WriteInt32(b, 1); Marshal.WriteInt32(b, 4, 1); Marshal.WriteInt32(b, 8, on ? 1 : 0); return SetProcessInformation(h, 4, b, 12); } finally { Marshal.FreeHGlobal(b); } }
  static int GetEco(IntPtr h) { IntPtr b = Marshal.AllocHGlobal(12); try { Marshal.WriteInt32(b, 1); Marshal.WriteInt32(b, 4, 0); Marshal.WriteInt32(b, 8, 0); if (GetProcessInformation(h, 4, b, 12)) return (Marshal.ReadInt32(b, 8) & 1); return -1; } finally { Marshal.FreeHGlobal(b); } }
  public static string Query(int pid) {
    IntPtr h = Open(pid); if (h == IntPtr.Zero) return "E" + Marshal.GetLastWin32Error();
    try { return ((int)GetPriorityClass(h)) + "|" + GetMem(h) + "|" + GetEco(h); } finally { CloseHandle(h); }
  }
  // 返回 "OK|origPrio|origMem|origEco|applied" 或 "E<win32err>"
  public static string Apply(int pid, int prio, int mem, bool eco, bool trim) {
    IntPtr h = Open(pid); if (h == IntPtr.Zero) return "E" + Marshal.GetLastWin32Error();
    try {
      int op = (int)GetPriorityClass(h); int om = GetMem(h); int oe = GetEco(h);
      string err = "";
      if (prio > 0 && !SetPriorityClass(h, (uint)prio)) err += "prio:E" + Marshal.GetLastWin32Error() + " ";
      if (mem >= 0 && !SetMem(h, mem)) err += "mem:E" + Marshal.GetLastWin32Error() + " ";
      if (eco && !SetEco(h, true)) err += "eco:E" + Marshal.GetLastWin32Error() + " ";
      if (trim && !EmptyWorkingSet(h)) err += "trim:E" + Marshal.GetLastWin32Error() + " ";
      return "OK|" + op + "|" + om + "|" + oe + "|" + (err.Length == 0 ? "all" : err.Trim());
    } finally { CloseHandle(h); }
  }
}
'@
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $StateFile) { $StateFile = Join-Path (Join-Path $Root 'state') 'host-boost.json' }
$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir ('host-boost-' + (Get-Date -Format 'yyyyMMdd') + '.log')
function Log([string]$m, [string]$c = 'Gray') {
  if (-not $Quiet) { Write-Host $m -ForegroundColor $c }
  try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'HH:mm:ss') + '  ' + $m) -Encoding UTF8 } catch { }
}

$prioValue = if ($Priority -eq 'normal') { 0x20 } elseif ($Priority -eq 'below') { 0x4000 } else { 0x40 }
$prioLabel = if ($Priority -eq 'normal') { 'Normal' } elseif ($Priority -eq 'below') { 'BelowNormal' } else { 'Idle' }
# -KeepEco：只改优先级，保留现有 EcoQoS（前台恢复时用，让 DSH 仍留在能效核）
$ecoOn = $Eco -and -not $KeepEco

# 枚举 DSH 本体：所有 DeepSeek Harness.exe 进程，排除自己（脚本是 pwsh，不会命中，但留一道门）
$targets = @()
try {
  $targets = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID })
} catch { }
if ($targets.Count -eq 0) {
  Log '没有找到 DeepSeek Harness 进程，未做任何改动。' 'Yellow'
  if ($EmitJson) {
    $payload = [pscustomobject]@{ ok = $false; reason = 'no-target'; applied = @(); generatedUtc = (Get-Date).ToUniversalTime().ToString('o') }
    if ($JsonOut) { [IO.File]::WriteAllText($JsonOut, ($payload | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding($false))) }
  }
  exit 0
}

$entries = @()
$applied = @()
foreach ($p in $targets) {
  $startTicks = 0
  try { $startTicks = $p.StartTime.ToUniversalTime().Ticks } catch { }
  $r = [HB]::Apply($p.Id, $prioValue, $MemPriority, [bool]$ecoOn, [bool]$Trim)
  if ($r -like 'OK|*') {
    $f = $r -split '\|'
    $entries += [pscustomobject]@{
      pid = [int]$p.Id
      name = [string]$p.ProcessName
      startUtcTicks = [long]$startTicks
      origPrio = [int]$f[1]
      origMem = [int]$f[2]
      origEco = [int]$f[3]
      applied = [string]$f[4]
      wsMB = [math]::Round($p.WorkingSet64 / 1MB, 0)
    }
    $applied += [pscustomobject]@{ pid = [int]$p.Id; name = [string]$p.ProcessName; result = [string]$f[4]; wsMB = [math]::Round($p.WorkingSet64 / 1MB, 0) }
    Log ('已降级 {0} pid {1}：优先级 {2}，内存优先级 {3}，EcoQoS {4}{5}' -f $p.ProcessName, $p.Id, $prioLabel, $MemPriority, $(if ($ecoOn) { '开' } elseif ($KeepEco) { '保留' } else { '关' }), $(if ($Trim) { '，已回收工作集' } else { '' })) 'Green'
  } else {
    Log ('降级失败 {0} pid {1} -> {2}' -f $p.ProcessName, $p.Id, $r) 'Red'
    $applied += [pscustomobject]@{ pid = [int]$p.Id; name = [string]$p.ProcessName; result = [string]$r; wsMB = [math]::Round($p.WorkingSet64 / 1MB, 0) }
  }
}

if ($entries.Count -gt 0) {
  $doc = [pscustomobject]@{
    startedUtc = (Get-Date).ToUniversalTime().ToString('o')
    priority = $prioLabel
    eco = [bool]($ecoOn -or $KeepEco)
    memPriority = $MemPriority
    trim = [bool]$Trim
    parentPid = $ParentPid
    entries = $entries
  }
  $stateDir = Split-Path -Parent $StateFile
  if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory $stateDir -Force | Out-Null }
  [IO.File]::WriteAllText($StateFile, ($doc | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  Log ('状态已写入：' + $StateFile) 'Cyan'
}

if ($EmitJson) {
  $payload = [pscustomobject]@{
    ok = ($entries.Count -gt 0)
    priority = $prioLabel
    eco = [bool]$ecoOn
    memPriority = $MemPriority
    trim = [bool]$Trim
    applied = $applied
    generatedUtc = (Get-Date).ToUniversalTime().ToString('o')
  }
  if ($JsonOut) { [IO.File]::WriteAllText($JsonOut, ($payload | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding($false))) }
  else { $payload | ConvertTo-Json -Depth 5 -Compress }
}

if ($entries.Count -eq 0) { exit 1 }
exit 0
