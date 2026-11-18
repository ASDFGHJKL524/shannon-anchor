# 恢复被冻结、但 DSH（Medium 完整性）无权限恢复的进程。
#
# 用法：右键「以管理员身份运行」，或在管理员 PowerShell 里：
#   pwsh -File "~/.dsh\shannon-anchor\engine\resume-admin.ps1"
#
# 默认只处理 About（winToolBox 的 PDF 工具，管理员权限启动，2026-11-14 被冻住后
# DSH 侧 OpenProcess 一直 E5）。要处理别的进程，改下面的 -Names。

param([string[]]$Names = @('About'))

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ProcResume {
  [DllImport("ntdll.dll")] public static extern uint NtResumeProcess(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
}
"@

$PROCESS_SUSPEND_RESUME = 0x0800
$found = 0
$fixed = 0

foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
  if ($Names -notcontains $p.ProcessName) { continue }
  $found++
  try {
    $susp = @($p.Threads | Where-Object { $_.ThreadState -eq 'Wait' -and $_.WaitReason -eq 'Suspended' }).Count
    if ($susp -eq 0) {
      Write-Host ("skip  {0} pid={1} (未挂起)" -f $p.ProcessName, $p.Id)
      continue
    }
    $h = [ProcResume]::OpenProcess($PROCESS_SUSPEND_RESUME, $false, $p.Id)
    if ($h -eq [IntPtr]::Zero) {
      $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Write-Host ("FAIL  {0} pid={1} OpenProcess err={2}" -f $p.ProcessName, $p.Id, $err)
      continue
    }
    $r = [ProcResume]::NtResumeProcess($h)
    [ProcResume]::CloseHandle($h) | Out-Null
    if ($r -eq 0) { $fixed++ }
    Write-Host ("resume {0} pid={1} -> {2}" -f $p.ProcessName, $p.Id, $r)
  } catch {
    Write-Host ("ERR   {0} pid={1}: {2}" -f $p.ProcessName, $p.Id, $_.Exception.Message)
  }
}

if ($found -eq 0) { Write-Host "没有找到目标进程（可能已经退出）。" }
Write-Host ""
Write-Host ("完成：找到 {0} 个，恢复 {1} 个。" -f $found, $fixed)
Write-Host "按任意键关闭…"
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
