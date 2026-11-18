<#
  dsh-focus-mode · 宿主恢复（performance 档案专用）
  读 host-boost.json，按 pid + 进程名 + 启动时间戳指纹校验，恢复 DSH 本体的
  优先级 / 内存优先级 / EcoQoS。只恢复本插件降级过的进程，绝不乱改别人的 QoS。
  本文件须以 UTF-8 with BOM 保存。
#>
[CmdletBinding()]
param(
  [string]$StateFile,
  [switch]$Status, [switch]$DryRun, [switch]$Force, [switch]$Quiet, [switch]$KeepJournal, [switch]$Yes
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if (-not ('HB2' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HB2 {
  const uint M_FULL = 0x0F00, M_SUSP = 0x1800;
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetProcessInformation(IntPtr h, int c, IntPtr b, int s);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetPriorityClass(IntPtr h, uint c);
  static IntPtr Open(int pid) { IntPtr h = OpenProcess(M_FULL, false, pid); if (h == IntPtr.Zero) h = OpenProcess(M_SUSP, false, pid); return h; }
  static bool SetMem(IntPtr h, int v) { IntPtr b = Marshal.AllocHGlobal(4); try { Marshal.WriteInt32(b, v); return SetProcessInformation(h, 0, b, 4); } finally { Marshal.FreeHGlobal(b); } }
  static bool SetEco(IntPtr h, bool on) { IntPtr b = Marshal.AllocHGlobal(12); try { Marshal.WriteInt32(b, 1); Marshal.WriteInt32(b, 4, 1); Marshal.WriteInt32(b, 8, on ? 1 : 0); return SetProcessInformation(h, 4, b, 12); } finally { Marshal.FreeHGlobal(b); } }
  public static string Restore(int pid, int prio, int mem, int eco) {
    IntPtr h = Open(pid); if (h == IntPtr.Zero) return "E" + Marshal.GetLastWin32Error();
    try {
      string err = "";
      if (prio > 0 && !SetPriorityClass(h, (uint)prio)) err += "prio:E" + Marshal.GetLastWin32Error() + " ";
      if (mem > 0 && !SetMem(h, mem)) err += "mem:E" + Marshal.GetLastWin32Error() + " ";
      if (eco >= 0 && !SetEco(h, eco == 1)) err += "eco:E" + Marshal.GetLastWin32Error() + " ";
      return err.Length == 0 ? "OK" : err.Trim();
    } finally { CloseHandle(h); }
  }
}
'@
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $StateFile) { $StateFile = Join-Path (Join-Path $Root 'state') 'host-boost.json' }
$HistDir = Join-Path $Root 'history'
if (-not (Test-Path $HistDir)) { New-Item -ItemType Directory $HistDir -Force | Out-Null }
$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir ('host-restore-' + (Get-Date -Format 'yyyyMMdd') + '.log')
function Log([string]$m, [string]$c = 'Gray') {
  if (-not $Quiet) { Write-Host $m -ForegroundColor $c }
  try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'HH:mm:ss') + '  ' + $m) -Encoding UTF8 } catch { }
}

if (-not (Test-Path $StateFile)) { Log ('没有待恢复的宿主降级记录（' + $StateFile + ' 不存在）') 'Yellow'; exit 0 }
try { $doc = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { Log ('状态文件损坏，未做任何改动：' + $_.Exception.Message) 'Red'; exit 1 }
$entries = @($doc.entries)
if ($entries.Count -eq 0) { Log '状态文件为空，无可恢复项。' 'Yellow'; exit 0 }

# 指纹校验：pid 活着且名字/启动时间对得上才恢复；PID 被复用时跳过（除非 -Force）
$plan = @()
foreach ($e in $entries) {
  $live = Get-Process -Id ([int]$e.pid) -ErrorAction SilentlyContinue
  $state = 'OK'; $target = $live
  if (-not $live) {
    $cand = @()
    try { $cand = @(Get-Process -Name $e.name -ErrorAction SilentlyContinue | Where-Object { $_.StartTime.ToUniversalTime().Ticks -eq [long]$e.startUtcTicks }) } catch { }
    if ($cand.Count -eq 1) { $target = $cand[0]; $state = 'Relocated' } else { $state = 'NotRunning'; $target = $null }
  }
  elseif ([string]$live.ProcessName -ne [string]$e.name) { if ($Force) { $state = 'Forced' } else { $state = 'PidReused'; $target = $null } }
  elseif ([long]$e.startUtcTicks -gt 0) {
    $same = $false
    try { $same = ($live.StartTime.ToUniversalTime().Ticks -eq [long]$e.startUtcTicks) } catch { $same = $true }
    if (-not $same) { if ($Force) { $state = 'Forced' } else { $state = 'PidReused'; $target = $null } }
  }
  $plan += [pscustomobject]@{ E = $e; T = $target; S = $state }
}

if ($Status) {
  Log ('宿主降级记录 ' + $doc.startedUtc + '  [优先级=' + $doc.priority + ' EcoQoS=' + $doc.eco + ' 内存优先级=' + $doc.memPriority + ']  共 ' + $plan.Count + ' 条') 'Cyan'
  foreach ($i in $plan) {
    Log ('{0,-11} {1,-22} pid {2,-7} 原优先级 {3}' -f $i.S, $i.E.name, $i.E.pid, $i.E.origPrio)
  }
  exit 0
}
if ($DryRun) { foreach ($i in $plan) { Log ('将要恢复 {0} pid {1}（{2}）' -f $i.E.name, $i.E.pid, $i.S) }; exit 0 }
if (-not $Yes) {
  $a = Read-Host ('将恢复 ' + $plan.Count + ' 条宿主降级记录，确认？输入 Y 继续')
  if ($a -notmatch '^[Yy]') { Log '已取消。'; exit 0 }
}

$ok = 0; $skip = 0; $fail = 0
$keep = New-Object System.Collections.Generic.List[object]
foreach ($i in $plan) {
  $e = $i.E
  if ($i.S -eq 'NotRunning' -or $i.S -eq 'PidReused' -or -not $i.T) {
    Log ('   跳过 {0}（{1}）' -f $e.name, $i.S) 'DarkGray'
    $skip++
    if ($i.S -eq 'PidReused') { $keep.Add($e) }
    continue
  }
  $r = [HB2]::Restore([int]$i.T.Id, [int]$e.origPrio, [int]$e.origMem, [int]$e.origEco)
  if ($r -eq 'OK') { Log ('   已恢复 {0,-22} pid {1}' -f $e.name, $i.T.Id) 'Green'; $ok++ }
  else { Log ('   失败 {0} pid {1} -> {2}' -f $e.name, $i.T.Id, $r) 'Red'; $fail++; $keep.Add($e) }
}

if (-not $KeepJournal) {
  if ($keep.Count -gt 0) {
    $doc.entries = [object[]]($keep.ToArray())
    [IO.File]::WriteAllText($StateFile, ($doc | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    Log ('仍有 ' + $keep.Count + ' 条未确认，已保留在状态文件中（可再次运行本脚本继续恢复）') 'Yellow'
  } else {
    $arch = Join-Path $HistDir ('host-restored-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
    Copy-Item $StateFile $arch -Force
    Remove-Item $StateFile -Force
    Log ('宿主降级记录已归档：' + $arch) 'Cyan'
  }
}
Log ('完成：恢复 ' + $ok + ' / 跳过 ' + $skip + ' / 失败 ' + $fail) 'Cyan'
if ($fail -gt 0) { exit 1 }
exit 0
