<#
  shannon-anchor · 游戏看护启停（DshGameGuard 计划任务）
  专注模式 performance 档案开启时启动，关闭时停止。
  看护本身（.\dsh_game_guard.ps1）负责检测游戏、挂起/恢复 DSH。
  本文件须以 UTF-8 with BOM 保存。
#>
[CmdletBinding()]
param(
  [ValidateSet('start','stop','status')][string]$Action = 'status',
  [string]$TaskName = 'DshGameGuard',
  [switch]$Quiet, [switch]$EmitJson, [string]$JsonOut
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Out-Result($ok, $state, $msg) {
  $payload = [pscustomobject]@{
    ok = $ok; action = $Action; task = $TaskName; state = $state; message = $msg
    ts = (Get-Date).ToUniversalTime().ToString('o')
  }
  if ($EmitJson) {
    $json = $payload | ConvertTo-Json -Depth 4 -Compress
    if ($JsonOut) { [IO.File]::WriteAllText($JsonOut, $json, (New-Object Text.UTF8Encoding($false))) }
    else { Write-Output $json }
  } elseif (-not $Quiet) {
    Write-Output $msg
  }
  if ($ok) { exit 0 } else { exit 1 }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Out-Result $false 'missing' "计划任务 $TaskName 不存在。" }

switch ($Action) {
  'status' {
    Out-Result $true ([string]$task.State) "计划任务 $TaskName 状态：$($task.State)"
  }
  'start' {
    if ($task.State -eq 'Running') { Out-Result $true 'Running' "计划任务 $TaskName 已在运行。" }
    try {
      Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      Start-Sleep -Milliseconds 600
      $t2 = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Out-Result $true ([string]$t2.State) "计划任务 $TaskName 已启动（状态 $($t2.State)）。"
    } catch {
      Out-Result $false 'error' "启动失败：$($_.Exception.Message)"
    }
  }
  'stop' {
    if ($task.State -ne 'Running') { Out-Result $true ([string]$task.State) "计划任务 $TaskName 未在运行。" }
    try {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      Start-Sleep -Milliseconds 600
      $t2 = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Out-Result $true ([string]$t2.State) "计划任务 $TaskName 已停止（状态 $($t2.State)）。"
    } catch {
      Out-Result $false 'error' "停止失败：$($_.Exception.Message)"
    }
  }
}
