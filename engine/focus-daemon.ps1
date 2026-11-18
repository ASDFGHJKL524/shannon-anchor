<#
  focus-daemon.ps1 — 专注模式常驻看护

  三种状态，自动切换：
    日常   每 ScanIntervalSec 秒增量冻结后台（新冒出来的照样收拾）
    游戏   检测到全屏游戏：Dock / DSH 只回收内存不挂起，Steam 保持运行
    退出   退出游戏后自动回到日常

  另外每 ForegroundPollMs 毫秒看一次前台窗口：
    - 被冻的程序成为前台 → 立刻恢复，并记宽限期，避免刚切走又被冻上

  注意：本文件须以 UTF-8 with BOM 保存（PowerShell 5.1 兼容）。
#>
[CmdletBinding()]
param(
  [string]$EngineDir = '',
  [string]$Profile = 'task',
  [int]$ScanIntervalSec = 15,
  [int]$ForegroundPollMs = 800,
  [int]$GraceSec = 30,
  [int]$GameScanWindowSec = 180,
  [int]$ParentPid = 0,
  [string]$StopFile = '',
  [string]$TrimTargets = 'DeepSeek Harness,Dock_64',
  [string]$GameKeep = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if (-not $EngineDir) { $EngineDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$PauseScript  = Join-Path $EngineDir 'pause-non-system-processes.ps1'
$ResumeScript = Join-Path $EngineDir 'resume-non-system-processes.ps1'
$StateFile    = Join-Path (Join-Path $EngineDir 'state') 'current.json'
$LogDir       = Join-Path $EngineDir 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir 'daemon.log'

function Log([string]$m) {
  try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'HH:mm:ss') + '  ' + $m) -Encoding UTF8 } catch { }
}

if (-not ('FOCUSFG' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class FOCUSFG {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  public static int ForegroundPid() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return 0;
    int pid = 0;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }
  // 前台窗口是否铺满整个主屏：独占全屏和覆盖全屏的游戏都算。
  public static bool ForegroundFullscreen() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return false;
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    int w = GetSystemMetrics(0), ht = GetSystemMetrics(1);
    if (w <= 0 || ht <= 0) return false;
    return r.Left <= 0 && r.Top <= 0 && r.Right >= w && r.Bottom >= ht;
  }

  // ---- 托盘程序唤醒（2026-10-31 加） ----
  // Steam 这类驻托管的程序被挂起后，点托盘图标它自己没法响应，窗口永远不出现，
  // 靠「前台窗口」检测不到。所以改监听鼠标：按下时正好落在任务栏/托盘区，就解冻托盘程序。
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  // 返回 "" / "tray" / "dock"：
  //   tray = 任务栏/托盘图标（只解冻驻托盘的程序）
  //   dock = Dock 类启动器（解冻所有有窗口的程序，因为不知道点的是哪个）
  public static string LauncherKind() {
    if ((GetAsyncKeyState(0x01) & 0x8000) == 0) return "";   // 左键没按着
    POINT p;
    if (!GetCursorPos(out p)) return "";
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return "";
    var sb = new StringBuilder(256);
    GetClassNameW(h, sb, 256);
    string c = sb.ToString();
    if (c == "Shell_TrayWnd" || c == "TrayNotifyWnd" ||
        c == "NotifyIconOverflowWindow" || c == "Shell_SecondaryTrayWnd" ||
        c == "TaskListThumbnailWnd") return "tray";
    int pid;
    GetWindowThreadProcessId(h, out pid);
    try {
      string pn = System.Diagnostics.Process.GetProcessById(pid).ProcessName.ToLowerInvariant();
      if (pn.Contains("dock")) return "dock";
    } catch { }
    return "";
  }

  // 这个进程有没有窗口（不论可见与否）
  public static bool HasWindow(int pid) {
    bool found = false;
    EnumWindows((h, l) => {
      int wp;
      GetWindowThreadProcessId(h, out wp);
      if (wp == pid) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // 有窗口、但一个可见的都没有 —— 这才是「驻托盘」的程序（Steam、微信）。
  // 用它过滤，点任务栏时就不会把有正常窗口的程序一起解冻。
  public static bool HasOnlyHiddenWindows(int pid) {
    bool any = false, visible = false;
    EnumWindows((h, l) => {
      int wp;
      GetWindowThreadProcessId(h, out wp);
      if (wp == pid) {
        any = true;
        if (IsWindowVisible(h)) visible = true;
      }
      return true;
    }, IntPtr.Zero);
    return any && !visible;
  }

  // 台前调度（MyDockFinder StageManager）是否打开：窗口类名含 StageManager。
  // 打开时把有窗口的冻结程序放出来，否则点缩略图时进程还冻着，窗口激活不了。
  public static bool StageManagerOpen() {
    bool found = false;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetClassNameW(h, sb, 256);
      if (sb.ToString().IndexOf("StageManager", StringComparison.OrdinalIgnoreCase) >= 0) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
}

if (-not ('FOCUSWS' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FOCUSWS {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("psapi.dll", SetLastError=true)] static extern bool EmptyWorkingSet(IntPtr h);
  static IntPtr Open(int pid) {
    IntPtr h = OpenProcess(0x0500, false, pid);                 // QUERY_INFORMATION | SET_QUOTA
    if (h == IntPtr.Zero) h = OpenProcess(0x1000, false, pid);  // 退一步只要 QUERY_LIMITED
    return h;
  }
  // 只回收工作集，不挂起、不改优先级。进程照常跑，缺页时自己换回来。
  public static int TrimPid(int pid) {
    IntPtr h = Open(pid);
    if (h == IntPtr.Zero) return -1;
    try { return EmptyWorkingSet(h) ? 1 : 0; } finally { CloseHandle(h); }
  }
}
'@
}

function Read-Frozen {
  if (-not (Test-Path $StateFile)) { return @() }
  try {
    $doc = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    return @($doc.entries | Where-Object { $_.mode -eq 'Suspend' -and [int]$_.suspendCount -gt 0 })
  } catch { return @() }
}

function Get-ProcName([int]$procId) {
  try { return [string](Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { return '' }
}

# ---- 游戏归属识别（2026-10-31 加） ----
# 判据：游戏进程的安装路径 或 它加载的 SDK 模块，属于哪个平台。
# 装了 Steam 的游戏一定在 steamapps\common 下、且加载 steam_api64.dll；
# 终末地这种独立客户端两者都不沾，识别为空 → 不解冻任何平台。
$PLATFORM_PROCS = @{
  'steam'     = @('steam','steamwebhelper','GameOverlayUI')
  'epic'      = @('EpicGamesLauncher','EpicWebHelper')
  'battlenet' = @('Battle.net','Agent')
  'ubisoft'   = @('UbisoftConnect','upc','UplayService')
  'ea'        = @('EADesktop','EALocalHostSvc','EABackgroundService')
  'riot'      = @('RiotClientServices')
  'wegame'    = @('WeGame')
}

function Get-GamePlatform([int]$procId) {
  $path = ''
  $mods = @()
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    try { $path = [string]$p.Path } catch { }
    try { $mods = @($p.Modules | ForEach-Object { $_.ModuleName }) } catch { }
  } catch { return '' }

  # 1) 安装路径
  if ($path) {
    if ($path -match '(?i)steamapps|\\Steam\\') { return 'steam' }
    if ($path -match '(?i)Epic Games|EpicGames')  { return 'epic' }
    if ($path -match '(?i)Battle\.net')           { return 'battlenet' }
    if ($path -match '(?i)Ubisoft')               { return 'ubisoft' }
    if ($path -match '(?i)Origin|EA Games')       { return 'ea' }
    if ($path -match '(?i)Riot Games')            { return 'riot' }
    if ($path -match '(?i)WeGame')                { return 'wegame' }
  }
  # 2) 加载的 SDK（比路径更准；读不到模块就跳过）
  if ($mods.Count -gt 0) {
    $joined = ($mods -join ',').ToLower()
    if ($joined -match 'steam_api')             { return 'steam' }
    if ($joined -match 'eossdk')                { return 'epic' }
    if ($joined -match 'battle\.net|battlenet') { return 'battlenet' }
    if ($joined -match 'uplay|ubisoftconnect')  { return 'ubisoft' }
  }
  return ''
}

$trimNames = @($TrimTargets -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$gameKeep  = @($GameKeep   -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$grace = @{}
function Touch-Grace([string]$name) {
  if ($name) { $grace[$name] = (Get-Date).AddSeconds($GraceSec) }
}
function Active-Grace {
  $now = Get-Date
  foreach ($k in @($grace.Keys)) { if ($grace[$k] -le $now) { $grace.Remove($k) } }
  return @($grace.Keys)
}

Log ('start profile=' + $Profile + ' scan=' + $ScanIntervalSec + 's fg=' + $ForegroundPollMs + 'ms grace=' + $GraceSec + 's trim=[' + ($trimNames -join ',') + '] parent=' + $ParentPid)

$startedAt = Get-Date
$nextScan = (Get-Date).AddSeconds($ScanIntervalSec)
$gameMode = $false
$gameEnteredAt = $null   # 进入游戏模式的时间；游戏扫描窗口从这里算
$gameIntentUntil = $null # 游戏启动意图：前台是启动器/平台时，给启动链 5 分钟宽限，期间不冻新进程
$lastIntentFg = $null    # 上次触发意图的前台进程名，避免同一前台无限续期
$platformKeep = @()   # 当前游戏依赖的平台进程（识别出来才解冻）
$lastTrayClick = [datetime]::MinValue   # 托盘点击去抖
$stageWasOpen = $false                  # 台前调度上一轮是否打开
$stageThawed = @()                      # 台前调度打开时放出来的进程名
$lastStageCheck = [datetime]::MinValue  # 台前调度检测节流
try {
  while ($true) {
    if ($StopFile -and (Test-Path $StopFile)) { Log 'stop file seen'; break }
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { Log 'parent gone'; break }

    # ---- 前台：被冻的立刻恢复；顺手判定是不是进了游戏 ----
    $fgPid = 0
    try { $fgPid = [FOCUSFG]::ForegroundPid() } catch { }
    if ($fgPid -gt 0) {
      $fgName = Get-ProcName $fgPid
      if ($fgName) {
        $hit = @(Read-Frozen | Where-Object { [string]$_.name -eq $fgName })
        if ($hit.Count -gt 0) {
          Log ('revive ' + $fgName + ' (foreground)')
          & $ResumeScript -Only $fgName -Yes -Quiet | Out-Null
        }
        Touch-Grace $fgName

        # 游戏启动意图：前台切到启动器/平台（Steam、REDlauncher、GOG 等）时，
        # 给启动链 5 分钟宽限，期间不冻新进程——否则 Steam→平台→游戏本体
        # 这条链上每个新进程都会被扫描冻上，游戏永远起不来。
        # 只在「前台变化」时触发一次，避免 Steam 一直前台时无限续期。
        if ($fgName -match '^(steam|steamwebhelper|REDlauncher|GOG Galaxy|GalaxyClient|EpicGamesLauncher|EpicWebHelper|Battle\.net|UbisoftConnect|upc|EADesktop|EALocalHostSvc|RiotClientServices|WeGame|wegame|gameoverlayui64)$') {
          if ($lastIntentFg -ne $fgName) {
            $gameIntentUntil = (Get-Date).AddMinutes(5)
            $lastIntentFg = $fgName
            Log ('启动器前台 (' + $fgName + ') -> 游戏启动意图 5 分钟')
          }
        } else {
          $lastIntentFg = $null
        }

        # 全屏窗口、又不是桌面/DSH 自己 → 认为在玩游戏
        # 2026-10-31 加排除：截图工具、任务管理器、视频播放器全屏也会铺满屏幕，
        # 不排掉会误触发游戏模式（实测 SnippingTool 被当成游戏）。
        $fs = $false
        try { $fs = [FOCUSFG]::ForegroundFullscreen() } catch { }
        $isGame = $fs -and ($fgName -notmatch '^(explorer|DeepSeek Harness|dwm|SearchHost|SnippingTool|ScreenClippingHost|Taskmgr|Magnify|OBS64|obs64|vlc|mpv|PotPlayerMini64|mpc-hc64|QQMusic|cloudmusic|Photoshop|Illustrator|Premiere Pro|After Effects|InDesign|Spotify|LockApp|LogonUI|ShellExperienceHost|StartMenuExperienceHost|TextInputHost)$')
        if ($isGame -ne $gameMode) {
          $gameMode = $isGame
          if ($gameMode) { $gameEnteredAt = Get-Date; $gameIntentUntil = $null } else { $gameEnteredAt = $null }
          $platformKeep = @()
          if ($gameMode) {
            # 认出游戏属于哪个平台，才解冻那个平台；独立客户端什么都不解冻
            $plat = Get-GamePlatform $fgPid
            if ($plat) {
              Log ('game mode -> True (' + $fgName + ') 平台=' + $plat)
              if ($PLATFORM_PROCS.ContainsKey($plat)) {
                $platformKeep = @($PLATFORM_PROCS[$plat])
                & $ResumeScript -Only $platformKeep -Yes -Quiet | Out-Null
                foreach ($k in $platformKeep) { Touch-Grace $k }
                Log ('  放出来: ' + ($platformKeep -join ','))
              }
            } else {
              Log ('game mode -> True (' + $fgName + ') 独立客户端，不解冻任何平台')
            }
          } else {
            Log ('game mode -> False (' + $fgName + ')')
          }
        }
      }
    }

    # ---- 启动器唤醒：点到任务栏/托盘/Dock，就把冻着的程序放出来 ----
    # Steam 这种驻托盘的程序被挂起后，点图标它自己没法响应、窗口不出现，
    # 靠「前台窗口」永远检测不到。所以监听鼠标落点，点到启动器就主动解冻。
    #   tray → 只解冻驻托盘的程序（有窗口但全隐藏）
    #   dock → 解冻所有有窗口的程序（Dock 点哪个都可能是目标）
    $kind = ''
    try { $kind = [FOCUSFG]::LauncherKind() } catch { }
    if ($kind -and ((Get-Date) - $lastTrayClick).TotalSeconds -gt 2) {
      $lastTrayClick = Get-Date
      $thaw = @()
      foreach ($e in @(Read-Frozen)) {
        try {
          $hit = if ($kind -eq 'dock') { [FOCUSFG]::HasWindow([int]$e.pid) } else { [FOCUSFG]::HasOnlyHiddenWindows([int]$e.pid) }
          if ($hit) { $thaw += [string]$e.name }
        } catch { }
      }
      $thaw = @($thaw | Select-Object -Unique)
      if ($thaw.Count -gt 0) {
        Log ('launcher click (' + $kind + ') -> thaw [' + ($thaw -join ',') + ']')
        & $ResumeScript -Only $thaw -Yes -Quiet | Out-Null
        foreach ($n in $thaw) { Touch-Grace $n }
        # 点开的是启动器 → 进入 5 分钟启动意图，期间不冻任何进程
        if (@($thaw | Where-Object { $_ -match '^(steam|steamwebhelper|REDlauncher|GOG Galaxy|GalaxyClient|EpicGamesLauncher|EpicWebHelper|Battle\.net|UbisoftConnect|upc|EADesktop|EALocalHostSvc|RiotClientServices|WeGame|wegame|gameoverlayui64)$' }).Count -gt 0) {
          $gameIntentUntil = (Get-Date).AddMinutes(5)
          Log ('启动器被点开 -> 游戏启动意图 5 分钟（期间不冻）')
        }
      }
    }

    # ---- 台前调度：打开时把有窗口的冻结程序放出来 ----
    # 台前调度显示所有窗口缩略图，点被冻窗口时进程还挂着，窗口激活不了。
    # 打开台前调度就主动解冻，关闭后扫描会重新冻回去。
    if (((Get-Date) - $lastStageCheck).TotalSeconds -ge 2) {
      $lastStageCheck = Get-Date
      $stageOpen = $false
      try { $stageOpen = [FOCUSFG]::StageManagerOpen() } catch { }
      if ($stageOpen -and -not $stageWasOpen) {
        $thaw = @()
        foreach ($e in @(Read-Frozen)) {
          try { if ([FOCUSFG]::HasWindow([int]$e.pid)) { $thaw += [string]$e.name } } catch { }
        }
        $thaw = @($thaw | Select-Object -Unique)
        if ($thaw.Count -gt 0) {
          Log ('stage manager open -> thaw [' + ($thaw -join ',') + ']')
          & $ResumeScript -Only $thaw -Yes -Quiet | Out-Null
          foreach ($n in $thaw) { Touch-Grace $n }
          $stageThawed = @($thaw)
        }
      }
      if ($stageWasOpen -and -not $stageOpen) {
        # 台前调度关闭：清掉刚解冻的宽限期，立即恢复冻结，不等 30 秒周期扫描
        foreach ($n in @($stageThawed)) { $grace.Remove($n) }
        $stageThawed = @()
        $nextScan = Get-Date
      }
      $stageWasOpen = $stageOpen
    }

    # ---- 游戏模式：Dock / DSH 只回收内存，不挂起 ----
    if ($gameMode) {
      foreach ($n in $trimNames) {
        foreach ($p in @(Get-Process -Name $n -ErrorAction SilentlyContinue)) {
          try { [void][FOCUSWS]::TrimPid($p.Id) } catch { }
        }
      }
    }

    # ---- 频率自适应：刚开启时勤快，跑满一分钟后放缓（游戏时更慢，省 CPU）----
    $age = ((Get-Date) - $startedAt).TotalSeconds
    $pollNow = $ForegroundPollMs
    $scanNow = $ScanIntervalSec
    if ($age -gt 60) {
      if ($gameMode) { $pollNow = 5000; $scanNow = 60 }
      else { $scanNow = 30 }
    }

    # ---- 周期冻结 ----
    if ((Get-Date) -ge $nextScan) {
      # 游戏扫描窗口：进游戏后只扫前 GameScanWindowSec 秒，之后停扫（打游戏时不会有新进程要冻）。
      $intentActive = $gameIntentUntil -and ((Get-Date) -lt $gameIntentUntil)
      $skipGameScan = $gameMode -and $gameEnteredAt -and (((Get-Date) - $gameEnteredAt).TotalSeconds -gt $GameScanWindowSec)
      if ($intentActive) {
        Log ('游戏启动意图中（至 ' + $gameIntentUntil.ToString('HH:mm:ss') + '），跳过周期扫描')
        $nextScan = (Get-Date).AddSeconds($scanNow)
      } elseif ($skipGameScan) {
        Log ('游戏已过 ' + $GameScanWindowSec + 's，跳过周期扫描（trim 和前台轮询照旧）')
        $nextScan = (Get-Date).AddSeconds($scanNow)
      } else {
        $excl = @(Active-Grace)
        if ($gameMode) { $excl = @(@($excl) + @($platformKeep) + @($trimNames) | Select-Object -Unique) }
        Log ('scan exclude=[' + ($excl -join ',') + ']' + $(if ($gameMode) { ' [game]' } else { '' }) + ' 间隔=' + $scanNow + 's')
        & $PauseScript -Profile $Profile -Yes -Quiet -Exclude $excl | Out-Null
        $nextScan = (Get-Date).AddSeconds($scanNow)
      }
    }

    Start-Sleep -Milliseconds $pollNow
  }
} finally {
  Log 'stop: restore all'
  try { & $ResumeScript -Yes -Quiet | Out-Null } catch { Log ('restore failed: ' + $_.Exception.Message) }
  if ($StopFile -and (Test-Path $StopFile)) { try { Remove-Item $StopFile -Force } catch { } }
  Log 'exit'
}
