<#
  dsh-focus-mode · 重任务探测（performance 档案自动降级用）
  只读：查 GPU 利用率 + 非宿主大进程，输出一行 JSON。不改任何进程。
  判据：GPU ≥ 70% 或 非 DSH 进程工作集 ≥ 2 GB → heavy。
  本文件须以 UTF-8 with BOM 保存。
#>
[CmdletBinding()]
param(
  [int]$GpuThreshold = 70,
  [int]$MemThresholdMB = 2048,
  [switch]$Quiet
)
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# GPU 利用率：nvidia-smi 只在 pwsh 里能用（Node 的 child_process 调它报 EPERM，见手册 #313）
$gpu = -1
try {
  $out = & nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>$null
  if ($out) {
    $first = @($out)[0]
    $n = 0
    if ([int]::TryParse(([string]$first).Trim(), [ref]$n)) { $gpu = $n }
  }
} catch { }

# 非宿主大进程：排除 DSH 自身、系统件、终端壳层
$exclude = 'DeepSeek Harness|dsh|node|pwsh|powershell|conhost|OpenConsole|WindowsTerminal|cmd|explorer|dwm|svchost|System|Registry|Memory Compression|Idle|csrss|wininit|winlogon|services|lsass|fontdrvhost|audiodg|WmiPrvSE|taskhostw|sihost|RuntimeBroker|SearchHost|StartMenuExperienceHost|TextInputHost|ShellExperienceHost|ApplicationFrameHost|WidgetBoard|WidgetService|MsMpEng|NisSrv|SecurityHealthService|nvcontainer|NVDisplay.Container'
$heavyProcs = @()
try {
  $heavyProcs = @(Get-Process | Where-Object {
      $_.ProcessName -notmatch $exclude -and $_.WorkingSet64 -ge ($MemThresholdMB * 1MB)
    } | ForEach-Object {
      [pscustomobject]@{
        name = [string]$_.ProcessName
        pid = [int]$_.Id
        memMB = [int][math]::Round($_.WorkingSet64 / 1MB, 0)
      }
    } | Sort-Object memMB -Descending | Select-Object -First 8)
} catch { }

# ComfyUI 跑图时 python 内存通常 > 500MB，但可能不到 2GB 阈值；
# 单独给 python 一个更低的门槛，避免跑图时检测不到。
try {
  $pyHeavy = @(Get-Process -Name python,pythonw -ErrorAction SilentlyContinue | Where-Object {
      $_.WorkingSet64 -ge (500 * 1MB)
    } | ForEach-Object {
      [pscustomobject]@{
        name = [string]$_.ProcessName
        pid = [int]$_.Id
        memMB = [int][math]::Round($_.WorkingSet64 / 1MB, 0)
      }
    })
  if ($pyHeavy.Count -gt 0) {
    $heavyProcs = @(@($heavyProcs) + $pyHeavy | Sort-Object pid -Unique)
  }
} catch { }

$gpuHeavy = ($gpu -ge $GpuThreshold)
$memHeavy = ($heavyProcs.Count -gt 0)
$heavy = $gpuHeavy -or $memHeavy
$reason = if ($gpuHeavy -and $memHeavy) { 'gpu+memory' } elseif ($gpuHeavy) { 'gpu' } elseif ($memHeavy) { 'memory' } else { 'none' }

# DSH 是否在前台：前台时恢复优先级（但仍留在能效核），后台时降级让位。
$dshForeground = $false
try {
  if (-not ('FG2' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class FG2 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public static int Get() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return 0;
    uint pid; GetWindowThreadProcessId(h, out pid);
    return (int)pid;
  }
}
'@ -ErrorAction SilentlyContinue
  }
  $fgPid = [FG2]::Get()
  if ($fgPid -gt 0) {
    $fgProc = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
    if ($fgProc -and $fgProc.ProcessName -eq 'DeepSeek Harness') { $dshForeground = $true }
  }
} catch { }

$payload = [pscustomobject]@{
  heavy = [bool]$heavy
  reason = [string]$reason
  gpuPct = [int]$gpu
  gpuThreshold = [int]$GpuThreshold
  memThresholdMB = [int]$MemThresholdMB
  heavyProcs = @($heavyProcs)
  dshForeground = [bool]$dshForeground
  ts = (Get-Date).ToUniversalTime().ToString('o')
}
$json = $payload | ConvertTo-Json -Depth 4 -Compress
if (-not $Quiet) { Write-Output $json }
exit 0
