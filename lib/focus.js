// shannon-anchor — focus half (migrated from dsh-focus-mode, 2026-11-01 P2).
//
// One tool: focus_mode (status / scan / on / off). Freeze and restore are done
// by the vendored GameBoost engine, so an active session costs no model tokens
// and needs no resident process. A detached watcher restores the journal if
// this DSH process exits while focus mode is on.

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 迁入 shannon-anchor（2026-11-01 P2）：不再是独立插件，改为 installFocus(ctx, {...})。
// 路径由调用方传入 —— 引擎在 <shannon-anchor>/engine，状态外置到 runtime/focus。
// 模块级变量在 installFocus 里赋值一次；其余函数照旧引用这些名字，避免动 800 行。
let ROOT = "";
let ENGINE = "";
let PAUSE = "";
let RESUME = "";
let WATCH = "";
let DAEMON = "";
let STATE = "";
let HOST_BOOST = "";
let HOST_RESTORE = "";
let HOST_STATE = "";
let GAME_GUARD = "";
let ENGINE_CONFIG = "";
let DETECT_HEAVY = "";
let LOGS = "";
let RUN = "";
let MARKER = "";

const PS_BASE = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
const DEFAULTS = {
  defaultMode: "task",
  timeoutMs: 180000,
  // 默认关闭。专注模式会冻结别的进程，什么时候开始这件事得由使用者决定——
  // 装上就自动冻结，等于替他做了一个他没同意的决定。要自动开就自己设成 true。
  autoStart: false,
  autoStartDelayMs: 12000,
  // 常驻看护：多久扫一遍把新出现的后台冻上；某个程序被切到前台解冻后，多久内不再冻它。
  scanIntervalSec: 15,
  graceSec: 30,
  // 重任务自动检测：每 autoDetectIntervalSec 秒看一次 GPU/大进程，连续两次命中才降级，
  // 连续两次空闲才恢复。默认关：自动冻结别人正在用的东西，风险要使用者自己接。
  autoDetect: false,
  autoDetectIntervalSec: 60,
  // 档案自动切换：重任务时自动切到 performance（白名单冻结 + 降级 DSH 本体），
  // 空闲时切回 task。默认关，理由同上：它会在你没看着的时候改冻结规则。
  autoProfileSwitch: false
};
const MODES = new Set(["task", "deep", "performance"]);

function resolveConfig(raw) {
  let value = raw;
  try {
    if (typeof value === "function") value = value();
    else if (value && typeof value.get === "function") value = value.get();
  } catch {
    value = raw;
  }
  const cfg = { ...DEFAULTS, ...(value && typeof value === "object" ? value : {}) };
  if (!MODES.has(cfg.defaultMode)) cfg.defaultMode = DEFAULTS.defaultMode;
  const n = Number(cfg.timeoutMs);
  cfg.timeoutMs = Number.isFinite(n) ? Math.min(600000, Math.max(10000, n)) : DEFAULTS.timeoutMs;
  cfg.autoStart = cfg.autoStart === true;
  const d = Number(cfg.autoStartDelayMs);
  cfg.autoStartDelayMs = Number.isFinite(d) ? Math.min(300000, Math.max(0, d)) : DEFAULTS.autoStartDelayMs;
  const si = Number(cfg.scanIntervalSec);
  cfg.scanIntervalSec = Number.isFinite(si) ? Math.min(300, Math.max(5, si)) : DEFAULTS.scanIntervalSec;
  const gs = Number(cfg.graceSec);
  cfg.graceSec = Number.isFinite(gs) ? Math.min(600, Math.max(5, gs)) : DEFAULTS.graceSec;
  cfg.autoProfileSwitch = cfg.autoProfileSwitch !== false;
  return cfg;
}

let psResolved = null;

// 优先 PowerShell 7（pwsh）：冷启动略快，脚本里 try/UTF-8 等写法更正常。
// pwsh 不是 Windows 自带件，必须留 5.1 回退，否则用户换机或卸载后专注模式整个失灵。
function resolvePs() {
  if (psResolved) return psResolved;
  const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const v1 = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const cands = [];
  // 本机实测 pwsh 装在 %LOCALAPPDATA%\Programs\7.6.9\，版本号在目录名里，不能写死 Programs\7
  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "Programs"));
  if (process.env.PROGRAMFILES) roots.push(process.env.PROGRAMFILES, path.join(process.env.PROGRAMFILES, "PowerShell"));
  if (process.env["ProgramFiles(x86)"]) roots.push(path.join(process.env["ProgramFiles(x86)"], "PowerShell"));
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue }
    for (const n of names.sort()) {
      if (!/^(7|7\..*|pwsh)$/i.test(n)) continue;
      cands.push(path.join(root, n, "pwsh.exe"));
    }
  }
  for (const d of cands) {
    if (fs.existsSync(d)) { psResolved = { exe: d, kind: "pwsh7" }; return psResolved; }
  }
  for (const name of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(name, "pwsh.exe");
    try { if (fs.statSync(p).isFile()) { psResolved = { exe: p, kind: "pwsh7" }; return psResolved; } } catch { /* ignore */ }
  }
  if (fs.existsSync(v1)) { psResolved = { exe: v1, kind: "powershell5.1" }; return psResolved; }
  psResolved = { exe: "powershell.exe", kind: "powershell5.1" };
  return psResolved;
}

function psExe() { return resolvePs().exe; }

function psLabel() {
  const r = resolvePs();
  return `${r.kind} · ${r.exe}`;
}

function runScript(script, args, timeout) {
  return new Promise((resolve) => {
    execFile(psExe(), [...PS_BASE, script, ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout,
      maxBuffer: 4 * 1024 * 1024
    }, (err, stdout, stderr) => {
      const timedOut = Boolean(err && (err.killed || err.signal));
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({
        code,
        timedOut,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: err ? String(err.message || err) : ""
      });
    });
  });
}

let integrityCache = null;

async function currentIntegrity() {
  if (integrityCache) return integrityCache;
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
  integrityCache = await new Promise((resolve) => {
    execFile(exe, ["/groups"], { encoding: "utf8", windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) { resolve({ level: "unknown", label: "未知" }); return; }
      const text = String(stdout || "");
      if (/S-1-16-4096\b/.test(text)) resolve({ level: "low", label: "Low (4096)" });
      else if (/S-1-16-8192\b/.test(text)) resolve({ level: "medium", label: "Medium (8192)" });
      else if (/S-1-16-12288\b/.test(text)) resolve({ level: "high", label: "High (12288)" });
      else if (/S-1-16-16384\b/.test(text)) resolve({ level: "system", label: "System (16384)" });
      else resolve({ level: "unknown", label: "未知" });
    });
  });
  return integrityCache;
}

function readJson(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function readState() {
  if (!fs.existsSync(STATE)) return { exists: false, entries: [] };
  try {
    const doc = readJson(STATE);
    return { exists: true, doc, entries: Array.isArray(doc?.entries) ? doc.entries : [] };
  } catch (e) {
    return { exists: true, broken: true, entries: [], error: String(e?.message || e) };
  }
}

function readMarker() {
  try {
    return fs.existsSync(MARKER) ? readJson(MARKER) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 宿主降级（performance 档案）
// 读 engine/config.json 的 hostBoost 段：每次调用现读，改档位不需要重启 DSH。
const HOST_BOOST_FALLBACK = { enabled: true, priority: "idle", eco: true, memPriority: 1, trim: false };

function readHostBoostConfig() {
  try {
    const doc = readJson(ENGINE_CONFIG);
    const raw = doc?.hostBoost;
    if (!raw || typeof raw !== "object") return { ...HOST_BOOST_FALLBACK };
    const mp = Number(raw.memPriority);
    return {
      enabled: raw.enabled !== false,
      priority: raw.priority === "below" ? "below" : "idle",
      eco: raw.eco !== false,
      memPriority: Number.isFinite(mp) ? Math.max(0, Math.min(5, mp)) : 1,
      trim: raw.trim === true
    };
  } catch {
    return { ...HOST_BOOST_FALLBACK };
  }
}

function readHostState() {
  try {
    if (!fs.existsSync(HOST_STATE)) return { exists: false, entries: [] };
    const doc = readJson(HOST_STATE);
    return { exists: true, doc, entries: Array.isArray(doc?.entries) ? doc.entries : [] };
  } catch {
    return { exists: false, entries: [] };
  }
}

function hostBoostSummary() {
  const st = readHostState();
  if (!st.exists || !st.entries.length) return null;
  const doc = st.doc || {};
  return {
    active: true,
    count: st.entries.length,
    priority: doc.priority || "idle",
    eco: doc.eco !== false,
    memPriority: Number(doc.memPriority) || 1,
    trim: doc.trim === true,
    since: doc.startedUtc || null,
    mb: st.entries.reduce((n, e) => n + (Number(e.wsMB) || 0), 0)
  };
}

async function boostHost(cfg, opts = {}) {
  const hb = readHostBoostConfig();
  if (!hb.enabled) return { ok: false, skipped: true, text: "宿主降级未启用（engine/config.json 的 hostBoost.enabled=false）。" };
  if (!fs.existsSync(HOST_BOOST)) return { ok: false, skipped: true, text: `宿主降级脚本缺失：${HOST_BOOST}` };
  const priority = opts.priority || hb.priority;
  const args = ["-Priority", priority, "-MemPriority", String(hb.memPriority), "-ParentPid", String(process.pid)];
  if (hb.eco) args.push("-Eco");
  if (opts.keepEco) args.push("-KeepEco");
  if (hb.trim) args.push("-Trim");
  const res = await runScript(HOST_BOOST, args, cfg.timeoutMs);
  const st = hostBoostSummary();
  if (res.code !== 0 || !st) {
    return {
      ok: false,
      text: [
        `宿主降级失败（退出码 ${res.code}${res.timedOut ? "，超时" : ""}）。`,
        res.stderr ? res.stderr.trim().slice(-800) : "",
        res.error && !res.stderr ? res.error : ""
      ].filter(Boolean).join("\n")
    };
  }
  return {
    ok: true,
    text: `DSH 本体已降级：${st.count} 个进程，优先级 ${st.priority}，EcoQoS ${st.eco ? "开" : "关"}，内存优先级 ${st.memPriority}${st.trim ? "，已回收工作集" : ""}。`
  };
}

async function restoreHost(cfg) {
  if (!fs.existsSync(HOST_RESTORE)) return { ok: false, skipped: true, text: "" };
  const st = readHostState();
  if (!st.exists || !st.entries.length) return { ok: true, skipped: true, text: "" };
  const res = await runScript(HOST_RESTORE, ["-Yes", "-Quiet"], cfg.timeoutMs);
  if (res.code !== 0) {
    return {
      ok: false,
      text: [
        `宿主恢复失败（退出码 ${res.code}${res.timedOut ? "，超时" : ""}）。`,
        res.stderr ? res.stderr.trim().slice(-800) : ""
      ].filter(Boolean).join("\n")
    };
  }
  return { ok: true, text: `DSH 本体已恢复（${st.entries.length} 个进程）。` };
}

// ---------------------------------------------------------------- 游戏看护（DshGameGuard 计划任务）
// performance 档案开启时启动，关闭时停止。看护本身负责检测游戏、挂起/恢复 DSH。
// 计划任务保留登录触发器，但看护脚本启动时会检查专注模式 marker：没开就自己退出。
async function gameGuardAction(cfg, action) {
  if (!fs.existsSync(GAME_GUARD)) return { ok: false, skipped: true, text: "" };
  // status 不传 -Quiet：脚本靠 stdout 回状态文本，静默模式下会拿到空串。
  const args = ["-Action", action];
  if (action !== "status") args.push("-Quiet");
  const res = await runScript(GAME_GUARD, args, cfg.timeoutMs);
  if (res.code !== 0) {
    return {
      ok: false,
      text: `游戏看护${action === "start" ? "启动" : action === "stop" ? "停止" : "查询"}失败（退出码 ${res.code}）。${res.stderr ? res.stderr.trim().slice(-400) : ""}`
    };
  }
  return { ok: true, text: String(res.stdout || "").trim() };
}

// ---------------------------------------------------------------- 重任务自动检测
// 每 autoDetectIntervalSec 秒跑一次 detect-heavy.ps1（只读：GPU 利用率 + 非宿主大进程）。
// 连续两次命中才降级、连续两次空闲才恢复，避免跑图/游戏加载间隙来回抖。
let heavyTimer = null;
let heavyStreak = 0;
let idleStreak = 0;
let heavyBusy = false;
let heavyLast = null;
let lastAutoState = "";
// 退出看护的启动函数由 installFocus 注入：startHeavyWatch 是模块级函数，
// 拿不到 installFocus 里的闭包，自动切换档案时要靠它把看护重新拉起来。
let WATCHER_FN = () => {};

function heavyWatchStatus() {
  if (!heavyTimer) return null;
  return {
    running: true,
    intervalSec: heavyLast?.intervalSec || 60,
    streak: heavyStreak,
    idleStreak,
    last: heavyLast
  };
}

function startHeavyWatch(cfg) {
  if (heavyTimer) return true;
  if (!fs.existsSync(DETECT_HEAVY)) return false;
  const intervalMs = Math.max(15, Number(cfg.autoDetectIntervalSec) || 60) * 1000;
  heavyStreak = 0;
  idleStreak = 0;
  heavyLast = null;
  heavyTimer = setInterval(async () => {
    if (heavyBusy) return;
    heavyBusy = true;
    try {
      const res = await runScript(DETECT_HEAVY, [], 20000);
      if (res.code !== 0) return;
      let payload = null;
      try { payload = JSON.parse(String(res.stdout || "").trim()); } catch { return; }
      if (!payload || typeof payload.heavy !== "boolean") return;
      heavyLast = { heavy: payload.heavy, reason: payload.reason, gpuPct: payload.gpuPct, dshForeground: Boolean(payload.dshForeground), at: new Date().toISOString(), intervalSec: Math.round(intervalMs / 1000) };
      if (payload.heavy) { heavyStreak += 1; idleStreak = 0; }
      else { idleStreak += 1; heavyStreak = 0; }
      const boosted = readHostState().exists;
      const fg = Boolean(payload.dshForeground);
      if (fg && boosted) {
        // 前台：恢复优先级，但保留 EcoQoS —— DSH 仍留在能效核，性能核留给重任务。
        const r = await boostHost(cfg, { priority: "normal", keepEco: true });
        if (r.ok && lastAutoState !== "foreground") {
          lastAutoState = "foreground";
          appendAutostartLog("auto foreground: priority normal, eco kept");
        }
      } else if (heavyStreak >= 2 && !boosted) {
        // 重任务：先把冻结规则切到 performance（白名单模式，不会冻游戏本体），
        // 再降级宿主。切换走 off→on，会短暂解冻再重冻，后台窗口闪一下是正常代价。
        if (cfg.autoProfileSwitch && !fg && readMarker() !== "performance") {
          stopHeavyWatch();
          await offText(cfg, () => {});
          await onText(cfg, { confirm: true, apply: true, mode: "performance" }, WATCHER_FN);
          lastAutoState = "boosted";
          appendAutostartLog(`auto switch: performance (${payload.reason} gpu=${payload.gpuPct}%)`);
          return;
        }
        const r = await boostHost(cfg);
        if (r.ok && lastAutoState !== "boosted") {
          lastAutoState = "boosted";
          appendAutostartLog(`auto boost: ${payload.reason} gpu=${payload.gpuPct}%`);
        }
      } else if (idleStreak >= 2 && boosted && !fg) {
        // 空闲：如果当前是 performance，切回 task（恢复全冻后台、不降级宿主）。
        if (cfg.autoProfileSwitch && readMarker() === "performance") {
          stopHeavyWatch();
          await offText(cfg, () => {});
          await onText(cfg, { confirm: true, apply: true, mode: "task" }, WATCHER_FN);
          startHeavyWatch(cfg);
          lastAutoState = "idle";
          appendAutostartLog(`auto switch: task (idle gpu=${payload.gpuPct}%)`);
          return;
        }
        const r = await restoreHost(cfg);
        if (r.ok && lastAutoState !== "idle") {
          lastAutoState = "idle";
          appendAutostartLog(`auto restore: idle gpu=${payload.gpuPct}%`);
        }
      }
    } catch { /* 检测失败不碰宿主 */ } finally {
      heavyBusy = false;
    }
  }, intervalMs);
  heavyTimer.unref?.();
  return true;
}

function stopHeavyWatch() {
  if (heavyTimer) { clearInterval(heavyTimer); heavyTimer = null; }
  heavyStreak = 0;
  idleStreak = 0;
  heavyBusy = false;
  lastAutoState = "";
}

function writeMarker(mode) {
  try {
    fs.mkdirSync(RUN, { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify({ mode, at: new Date().toISOString(), parentPid: process.pid }, null, 2), "utf8");
  } catch { /* marker is advisory */ }
}

function clearMarker() {
  try { fs.rmSync(MARKER, { force: true }); } catch { /* nothing to clean */ }
}

// 前端提示条与自动启动共用的只读快照：只看磁盘状态，不跑扫描、不碰进程。
// 进程是否还活着。EPERM 表示存在但没权限（正常，说明还活着），ESRCH 才是真没了。
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === "EPERM");
  }
}

function snapshot() {
  const st = readState();
  const marker = readMarker();
  const t = st.exists && !st.broken ? tally(st.entries) : { susp: [], idle: [], mb: 0 };
  const total = t.susp.length + t.idle.length;
  const mode = marker?.mode && MODES.has(marker.mode) ? marker.mode : "";
  // 开着但暂时没东西可冻也是「进行中」：常驻看护还在盯着，之后出现的后台照冻。
  const active = Boolean(marker) && (total > 0 || daemonRunning());
  return {
    active,
    mode: mode || null,
    since: marker?.at || null,
    suspended: t.susp.length,
    idle: t.idle.length,
    mb: t.mb,
    broken: Boolean(st.broken),
    hostBoost: hostBoostSummary()
  };
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  try {
    res.writeHead(code, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(text);
  } catch { /* 客户端已断开 */ }
}

function appendAutostartLog(line) {
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.appendFileSync(path.join(LOGS, "autostart.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch { /* 日志写不进不影响主流程 */ }
}

// 常驻看护进程：开着的时候每 scanIntervalSec 秒增量冻结，并盯着前台窗口做解冻。
// 它退出的唯一出口是「恢复全部」，所以 off、DSH 退出、被 kill 三条路都不会留下冻着的进程
// （被 kill 时由 offText / watch-parent 兜底恢复）。
let activeDaemon = null;

function startDaemon(cfg, mode) {
  if (activeDaemon && activeDaemon.exitCode === null) return true;
  if (!fs.existsSync(DAEMON)) return false;
  try {
    const child = spawn(psExe(), [
      ...PS_BASE, DAEMON,
      "-Profile", mode || cfg.defaultMode,
      "-ScanIntervalSec", String(cfg.scanIntervalSec),
      "-GraceSec", String(cfg.graceSec),
      "-ParentPid", String(process.pid)
    ], {
      windowsHide: true,
      stdio: "ignore"
    });
    child.once("exit", () => { if (activeDaemon === child) activeDaemon = null; });
    activeDaemon = child;
    return true;
  } catch {
    activeDaemon = null;
    return false;
  }
}

function stopDaemon() {
  if (!activeDaemon) return;
  try { activeDaemon.kill(); } catch { /* 已经退了 */ }
  activeDaemon = null;
}

function daemonRunning() {
  return Boolean(activeDaemon && activeDaemon.exitCode === null);
}

function fmtMB(mb) {
  const n = Number(mb) || 0;
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`;
}

function fmtTime(iso) {
  const d = new Date(iso || "");
  return Number.isNaN(d.getTime()) ? "未知时间" : d.toLocaleString("zh-CN", { hour12: false });
}

function tally(entries) {
  const susp = [];
  const idle = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    if (e.mode === "Suspend" && Number(e.suspendCount) > 0) susp.push(e);
    else if (e.mode === "Idle") idle.push(e);
  }
  const groups = new Map();
  let mb = 0;
  for (const e of susp) {
    const key = String(e.name || "?");
    const g = groups.get(key) || { name: key, n: 0, mb: 0 };
    g.n += 1;
    g.mb += Number(e.wsMB) || 0;
    groups.set(key, g);
  }
  const top = [...groups.values()].sort((a, b) => b.mb - a.mb);
  for (const g of top) mb += g.mb;
  const idleNames = [...new Set(idle.map((e) => String(e.name || "?")))];
  return { susp, idle, top, mb, idleNames };
}

function latestLog(prefix) {
  try {
    const names = fs.readdirSync(LOGS).filter((n) => n.startsWith(prefix) && n.endsWith(".log")).sort();
    return names.length ? path.join(LOGS, names[names.length - 1]) : "";
  } catch {
    return "";
  }
}

function logTail(prefix, lines = 12) {
  const file = latestLog(prefix);
  if (!file) return "";
  try {
    const all = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
    return `最近日志（${path.basename(file)}）：\n${all.slice(-lines).join("\n")}`;
  } catch {
    return "";
  }
}

async function statusText(cfg, il) {
  if (!fs.existsSync(PAUSE)) return `引擎文件缺失：${ENGINE}`;
  const st = readState();
  const ilLine = `运行完整性：${il?.label || "未知"}${il?.level === "low" ? "（无法挂起普通应用，需从开始菜单重启 DSH）" : ""}；脚本引擎：${psLabel()}`;
  const hb = hostBoostSummary();
  const hostLine = hb
    ? `DSH 本体：已降级 ${hb.count} 个进程（优先级 ${hb.priority}，EcoQoS ${hb.eco ? "开" : "关"}，内存优先级 ${hb.memPriority}${hb.trim ? "，已回收工作集" : ""}）。`
    : "DSH 本体：未降级。";
  const hw = heavyWatchStatus();
  const watchLine = hw
    ? `重任务自动检测：运行中（每 ${hw.intervalSec} 秒；连续 ${hw.streak} 次命中 / ${hw.idleStreak} 次空闲${hw.last ? `；上次 GPU ${hw.last.gpuPct}%` : ""}）。`
    : "重任务自动检测：未运行。";
  const guard = await gameGuardAction(cfg, "status");
  const guardLine = guard?.ok
    ? `游戏看护：${guard.text}`
    : "游戏看护：未启用（performance 档案开启时自动启动）。";
  if (!st.exists) {
    // 开着但还没冻过任何东西：常驻看护在跑就是「进行中」。
    const marker0 = readMarker();
    if (marker0 && daemonRunning()) {
      const m0 = marker0.mode && MODES.has(marker0.mode) ? marker0.mode : "";
      return [
        `专注模式：已开启${m0 ? `（档案 ${m0}）` : ""}，启动于 ${fmtTime(marker0.at)}。`,
        "当前没有冻结任何进程——常驻看护在持续盯着，新出现的后台会被冻上。",
        hostLine,
        watchLine,
        guardLine,
        ilLine,
        "恢复：执行 off。"
      ].join("\n");
    }
    return [
      "专注模式：未开启。",
      `默认档案：${cfg.defaultMode}；可用 task / deep / performance。`,
      hostLine,
      watchLine,
      guardLine,
      ilLine,
      "scan 预览会冻结哪些进程；on 开启；off 恢复。performance 档案会额外把 DSH 本体降级（优先级/EcoQoS/内存优先级），并启动游戏看护（游戏时挂起 DSH）。"
    ].join("\n");
  }
  if (st.broken) {
    return [
      "专注模式：会话文件存在但无法解析。",
      st.error || "",
      `文件：${STATE}`,
      hostLine,
      watchLine,
      guardLine,
      ilLine,
      "可以执行 off 尝试恢复；若仍失败，手动运行 engine/resume-non-system-processes.ps1 -Yes。"
    ].filter(Boolean).join("\n");
  }
  const t = tally(st.entries);
  if (!t.susp.length && !t.idle.length) {
    if (readMarker() && daemonRunning()) {
      const m1 = readMarker()?.mode && MODES.has(readMarker().mode) ? readMarker().mode : "";
      return [
        `专注模式：已开启${m1 ? `（档案 ${m1}）` : ""}。`,
        "当前没有冻结任何进程——常驻看护在持续盯着，新出现的后台会被冻上。",
        hostLine,
        watchLine,
        guardLine,
        ilLine,
        "恢复：执行 off。"
      ].join("\n");
    }
    return [
      "专注模式：未开启（会话文件里没有冻结中的进程）。",
      `文件：${STATE}`,
      hostLine,
      watchLine,
      guardLine,
      ilLine,
      "执行 off 可清理这份残留会话文件。"
    ].join("\n");
  }
  const marker = readMarker();
  const mode = marker?.mode && MODES.has(marker.mode) ? marker.mode : "";
  const lines = [
    `专注模式：已开启${mode ? `（档案 ${mode}）` : ""}，启动于 ${fmtTime(st.doc?.startedUtc)}。`,
    `冻结 ${t.susp.length} 个进程，冻结前工作集合计约 ${fmtMB(t.mb)}。`,
    hostLine,
    watchLine,
    guardLine,
    ilLine
  ];
  for (const g of t.top.slice(0, 10)) lines.push(`- ${g.name} · ${g.n} 个 · ${fmtMB(g.mb)}`);
  if (t.top.length > 10) lines.push(`- …另有 ${t.top.length - 10} 个进程名`);
  if (t.idle.length) {
    const names = t.idleNames.slice(0, 8).join("、");
    lines.push(`只降 QoS（未冻结）：${t.idle.length} 个${names ? `（${names}${t.idleNames.length > 8 ? " 等" : ""}）` : ""}`);
  }
  lines.push("恢复：执行 off；DSH 退出时看护进程也会自动恢复。");
  return lines.join("\n");
}

async function runScan(cfg, mode) {
  fs.mkdirSync(RUN, { recursive: true });
  const out = path.join(RUN, `scan-${mode}.json`);
  try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
  const res = await runScript(PAUSE, ["-Profile", mode, "-EmitJson", "-JsonOut", out, "-Quiet"], cfg.timeoutMs);
  let payload = null;
  try {
    if (fs.existsSync(out)) payload = readJson(out);
  } catch { /* handled by the caller */ }
  return { res, payload };
}

function planRows(payload, action) {
  const rows = Array.isArray(payload?.processes) ? payload.processes : [];
  return rows
    .filter((r) => r && r.action === action && Number(r.targetCount) > 0)
    .sort((x, y) => (Number(y.wsMB) || 0) - (Number(x.wsMB) || 0));
}

function riskOf(rows) {
  const crit = rows.filter((r) => Number(r.critical) > 0);
  const session0 = rows.filter((r) => Array.isArray(r.sessions) && r.sessions.map(Number).includes(0));
  return { crit, session0, blocked: crit.length > 0 || session0.length > 0 };
}

function flagsOf(r) {
  const flags = [];
  if (Number(r.critical) > 0) flags.push("系统关键!");
  if (Number(r.hasWindow) > 0) flags.push("有窗口，会假死");
  if (r.foreground === true) flags.push("当前前台");
  if (Array.isArray(r.sessions) && r.sessions.map(Number).includes(0)) flags.push("会话0!");
  return flags.length ? `（${flags.join("；")}）` : "";
}

function visibilityWarning(payload) {
  const bits = [];
  if (payload && payload.lowVisibility === true) {
    bits.push(`枚举只看到 ${payload.totalProcs ?? "?"} 个进程（本机实际 200+）——这是权限不足，不是没有可冻结的进程`);
  }
  const unread = Number(payload?.unreadablePathProcs) || 0;
  const win = Number(payload?.windowsImageProcs) || 0;
  if (unread > 0) bits.push(`${unread} 个进程读不到映像路径，按硬门一律不冻`);
  if (win > 0) bits.push(`${win} 个进程映像位于 Windows 目录，永不冻结`);
  return bits.length ? "｜" + bits.join("；") + "。" : "";
}

function scanTextHead(mode, payload, il) {
  return `运行完整性：${il?.label || payload?.integrity || "未知"}${
    (il?.level === "low" || String(payload?.integrity) === "low") ? "（开启会被拒绝，需从开始菜单重启 DSH 到 Medium）" : ""
  }；脚本引擎：${psLabel()}${visibilityWarning(payload)}`;
}

async function scanText(cfg, mode, il) {
  const { res, payload } = await runScan(cfg, mode);
  if (!payload) {
    return [
      `扫描失败（退出码 ${res.code}${res.timedOut ? "，超时" : ""}）。`,
      res.stderr ? res.stderr.trim().slice(-1500) : "",
      res.error && !res.stderr ? res.error : "",
      logTail("pause")
    ].filter(Boolean).join("\n");
  }

  const rows = Array.isArray(payload.processes) ? payload.processes : [];
  const susp = planRows(payload, "suspend");
  const idle = planRows(payload, "idle");
  const skip = planRows(payload, "skip");
  const risk = riskOf(susp);
  const protectedRows = rows.filter((r) => r && r.state === "protected");
  const lines = [
    `专注模式预览（档案 ${mode}）`,
    `候选 ${payload.candidateProcs ?? "?"} 个进程 / 冻结前工作集合计约 ${fmtMB(payload.candidateMB)}；规则 ${payload.ruleCount ?? "?"} 条；管理员权限：${payload.admin ? "是" : "否（提权进程会被跳过）"}。`,
    scanTextHead(mode, payload, il),
    `系统关键候选：${risk.crit.length} 个${risk.blocked ? "（on 会拒绝执行）" : ""}；受保护/排除进程名：${protectedRows.length} 个。`,
    "本次只扫描，不改动任何进程。"
  ];
  if (susp.length) {
    lines.push("", `将冻结（前 ${Math.min(12, susp.length)} 个，共 ${susp.length} 个进程名）：`);
    for (const r of susp.slice(0, 12)) {
      lines.push(`- ${r.name} · ${r.n} 个 · ${fmtMB(r.wsMB)} · ${r.rule || "默认规则"}${flagsOf(r)}`);
    }
  } else {
    lines.push("", "按当前规则没有会冻结的进程。");
  }
  if (idle.length) {
    const names = idle.slice(0, 10).map((r) => r.name).join("、");
    lines.push("", `只降 QoS（不冻结）：${names}${idle.length > 10 ? " 等" : ""}`);
  }
  const bigSkip = skip.filter((r) => (Number(r.wsMB) || 0) >= 100).slice(0, 6);
  if (bigSkip.length) {
    lines.push("", `按规则跳过（≥100 MB）：${bigSkip.map((r) => `${r.name} ${fmtMB(r.wsMB)}`).join("、")}`);
  }
  lines.push("", "开启用 on：先返回预演，确认后带 apply:true 才真正冻结。");
  return lines.join("\n");
}

async function onText(cfg, args, ensureWatcher) {
  if (args?.confirm !== true) {
    return "开启专注模式会挂起后台进程的窗口（可恢复，但看起来像假死）。用户明确要求时，带 confirm: true 再调用。";
  }
  const mode = args?.mode ? String(args.mode) : cfg.defaultMode;
  if (!MODES.has(mode)) return `不认识的档案 "${mode}"；只支持 task / deep / performance。`;

  const il = await currentIntegrity();
  if (il.level === "low") {
    return "当前 DSH 运行在 Low 完整性（IL=4096），打不开普通 Medium 应用的进程，引擎会全部 E5 跳过。请从开始菜单或桌面图标手动重启 DSH 到 Medium 后再开启。";
  }

  const { res: scanRes, payload } = await runScan(cfg, mode);
  if (!payload) {
    return [
      `预审失败（退出码 ${scanRes.code}${scanRes.timedOut ? "，超时" : ""}）。`,
      scanRes.stderr ? scanRes.stderr.trim().slice(-1500) : "",
      logTail("pause")
    ].filter(Boolean).join("\n");
  }

  if (payload.lowVisibility === true) {
    return [
      `预审拒绝：引擎只枚举到 ${payload.totalProcs ?? "?"} 个进程（本机实际 200+），当前完整性=${payload.integrity ?? "未知"}。`,
      "这个权限看不见也打不开别的进程，零候选是权限不足的结果，不是真的没有可冻结的进程。",
      "不会执行任何冻结。请确认 DSH 以 Medium 完整性运行（开始菜单或桌面图标重启 DSH），再开专注模式。"
    ].join("\n");
  }

  const suspPlan = planRows(payload, "suspend");
  const idlePlan = planRows(payload, "idle");
  const risk = riskOf(suspPlan);
  const plan = [];
  plan.push(`专注模式预演（档案 ${mode}）`);
  plan.push(`候选 ${payload.candidateProcs ?? "?"} 个进程 / 冻结前工作集合计约 ${fmtMB(payload.candidateMB)}；管理员权限：${payload.admin ? "是" : "否（提权进程会被跳过）"}。`);
  plan.push(`引擎自检：${scanTextHead(mode, payload, il)}`);
  if (suspPlan.length) {
    plan.push(`将冻结（${suspPlan.length} 个进程名）：`);
    for (const r of suspPlan.slice(0, 12)) {
      plan.push(`- ${r.name} · ${r.n} 个 · ${fmtMB(r.wsMB)} · ${r.rule || "默认规则"}${flagsOf(r)}`);
    }
    if (suspPlan.length > 12) plan.push(`- …另有 ${suspPlan.length - 12} 个进程名`);
  } else {
    plan.push("没有会冻结的进程。");
  }
  if (idlePlan.length) {
    const names = idlePlan.slice(0, 10).map((r) => r.name).join("、");
    plan.push(`只降 QoS：${names}${idlePlan.length > 10 ? " 等" : ""}`);
  }
  if (mode === "performance") {
    const hb = readHostBoostConfig();
    plan.push(
      hb.enabled
        ? `DSH 本体：将降级为 ${hb.priority === "below" ? "BelowNormal" : "Idle"} 优先级，EcoQoS ${hb.eco ? "开" : "关"}，内存优先级 ${hb.memPriority}${hb.trim ? "，并回收工作集" : ""}。`
        : "DSH 本体：hostBoost 未启用，不降级。"
    );
  }
  if (risk.blocked) {
    plan.push("", `预审拒绝：发现 ${risk.crit.length} 个系统关键候选、${risk.session0.length} 个会话 0 候选；不会执行。`);
    return plan.join("\n");
  }
  if (args.apply !== true) {
    plan.push("", "未执行任何冻结。确认无误后再次调用 on，带 confirm:true + apply:true。");
    return plan.join("\n");
  }
  // 没有可冻的也进入开启状态：常驻看护会持续盯着，之后新出现的后台照样冻。
  // 只在「系统关键/会话 0 候选」时才拒绝，那种情况已经在上面拦掉了。
  if (!suspPlan.length) {
    writeMarker(mode);
    const watched0 = ensureWatcher();
    const daemon0 = startDaemon(cfg, mode);
    if (mode === "performance") startHeavyWatch(cfg);
    const host0 = mode === "performance" ? await boostHost(cfg) : null;
    const guard0 = mode === "performance" ? await gameGuardAction(cfg, "start") : null;
    return [
      `专注模式已开启（档案 ${mode}），当前没有可冻结的进程。`,
      daemon0
        ? `常驻看护已启动：每 ${cfg.scanIntervalSec} 秒扫一次，新出现的后台会被冻上，切到前台自动解冻。`
        : "注意：常驻看护没启动，之后新开的程序不会被冻。",
      watched0 ? "DSH 退出时看护进程会自动恢复。" : "注意：退出看护未启动，DSH 异常退出后需要手动 off。",
      host0 ? host0.text : "",
      guard0 ? guard0.text : ""
    ].filter(Boolean).join("\n");
  }

  const before = readState();
  const wasActive = before.exists && !before.broken && tally(before.entries).susp.length > 0;
  const res = await runScript(PAUSE, ["-Profile", mode, "-Yes", "-Quiet"], cfg.timeoutMs);
  if (res.code !== 0) {
    return [
      `开启失败（退出码 ${res.code}${res.timedOut ? "，超时" : ""}）。`,
      res.stderr ? res.stderr.trim().slice(-1500) : "",
      res.error && !res.stderr ? res.error : "",
      logTail("pause")
    ].filter(Boolean).join("\n");
  }

  const st = readState();
  if (!st.exists) {
    if (wasActive) return "开启命令已执行，但会话文件不见了；请用 status 检查，或运行 off 清理。";
    return "没有可冻结的进程：候选都被规则判为跳过或受保护。专注模式未开启。";
  }
  if (st.broken) return `会话文件无法解析：${st.error || STATE}`;

  const t = tally(st.entries);
  if (!t.susp.length && !t.idle.length) {
    if (!st.entries.length) {
      try { fs.rmSync(STATE, { force: true }); } catch { /* best-effort */ }
    }
    return "没有挂起任何进程：候选都被规则跳过，或全部被系统拒绝。专注模式未开启。";
  }

  writeMarker(mode);
  const watched = ensureWatcher();
  const daemonOk = startDaemon(cfg, mode);
  if (mode === "performance") startHeavyWatch(cfg);
  const host = mode === "performance" ? await boostHost(cfg) : null;
  const guard = mode === "performance" ? await gameGuardAction(cfg, "start") : null;
  const lines = [
    wasActive ? `专注模式已追加冻结（档案 ${mode}）。` : `专注模式已开启（档案 ${mode}）。`,
    `冻结 ${t.susp.length} 个进程，冻结前工作集合计约 ${fmtMB(t.mb)}。`
  ];
  for (const g of t.top.slice(0, 10)) lines.push(`- ${g.name} · ${g.n} 个 · ${fmtMB(g.mb)}`);
  if (t.top.length > 10) lines.push(`- …另有 ${t.top.length - 10} 个进程名`);
  if (t.idle.length) lines.push(`只降 QoS：${t.idle.length} 个`);
  if (host) lines.push(host.text);
  if (guard) lines.push(guard.text);
  lines.push("被冻结的窗口会暂时无响应。恢复用 off。");
  if (daemonOk) lines.push(`常驻看护已启动：每 ${cfg.scanIntervalSec} 秒把新出现的后台冻上，切到前台会自动解冻。`);
  else lines.push("注意：常驻看护没启动，只冻了这一次，之后新开的程序不会被冻。");
  if (watched) lines.push("DSH 退出时看护进程会自动恢复。");
  else lines.push("注意：退出看护未启动，DSH 异常退出后需要手动 off。");
  return lines.join("\n");
}

async function offText(cfg, dropWatcher) {
  const hadMarker = Boolean(readMarker());
  stopDaemon();
  stopHeavyWatch();
  const guard = await gameGuardAction(cfg, "stop");
  let before = readState();
  const hostBefore = readHostState();
  if (!before.exists) {
    clearMarker();
    const host0 = hostBefore.exists ? await restoreHost(cfg) : null;
    return [
      hadMarker
        ? "专注模式已关闭（本轮没有冻结任何进程）。"
        : "专注模式未开启：没有待恢复的会话。",
      host0 ? host0.text : "",
      guard ? guard.text : ""
    ].filter(Boolean).join("\n");
  }
  if (before.broken) {
    return [
      `会话文件无法解析，未做改动：${before.error || STATE}`,
      "请手动检查，或运行 engine/resume-non-system-processes.ps1 -Yes。",
      guard ? guard.text : ""
    ].filter(Boolean).join("\n");
  }
  if (!before.entries.length) {
    try { fs.rmSync(STATE, { force: true }); } catch { /* best-effort */ }
    clearMarker();
    dropWatcher();
    const host0 = hostBefore.exists ? await restoreHost(cfg) : null;
    return ["专注模式未开启：会话文件为空，已清理。", host0 ? host0.text : "", guard ? guard.text : ""].filter(Boolean).join("\n");
  }

  // 2026-11-14：进程可能在被冻结后自己退出（临时工具、被系统清理）。
  // 这些条目恢复必然失败（E5 = 拒绝访问），而下面只要有一条失败就不清 marker，
  // 结果是专注模式永远关不掉。恢复前先把确定不存在的 PID 剔除。
  const alive = before.entries.filter((en) => pidAlive(Number(en.pid)));
  if (alive.length !== before.entries.length) {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE, "utf8"));
      raw.entries = alive;
      fs.writeFileSync(STATE, JSON.stringify(raw, null, 2), "utf8");
      appendAutostartLog(`off: 剔除 ${before.entries.length - alive.length} 条已退出进程的记录`);
      before = readState();
    } catch { /* 写不回去就按原样走 */ }
  }

  const n0 = before.entries.length;
  const t0 = tally(before.entries);
  // 先恢复 DSH 本体，再恢复其他应用：resume 本身要在 DSH 里跑，先把自己放出来更快。
  const host = hostBefore.exists ? await restoreHost(cfg) : null;
  const res = await runScript(RESUME, ["-Yes", "-Quiet"], cfg.timeoutMs);
  if (res.code !== 0) {
    return [
      `恢复失败（退出码 ${res.code}${res.timedOut ? "，超时" : ""}），可能只恢复了一部分。`,
      res.stderr ? res.stderr.trim().slice(-1500) : "",
      logTail("resume"),
      guard ? guard.text : ""
    ].filter(Boolean).join("\n");
  }

  const after = readState();
  const n1 = after.exists && !after.broken ? after.entries.length : 0;
  const done = Math.max(0, n0 - n1);
  if (!after.exists) {
    clearMarker();
    dropWatcher();
    return [
      `已恢复并归档：本次处理 ${done} 条记录（冻结 ${t0.susp.length} 个 / 软限制 ${t0.idle.length} 个）。`,
      host ? host.text : "",
      guard ? guard.text : ""
    ].filter(Boolean).join("\n");
  }

  const t1 = tally(after.entries);
  if (t1.susp.length || t1.idle.length) {
    return [
      `已处理 ${done} 条；仍有 ${t1.susp.length + t1.idle.length} 条未确认（进程已退出、PID 被复用或访问被拒），记录保留在 ${STATE}。`,
      "可以再执行一次 off 继续恢复。",
      host ? host.text : "",
      guard ? guard.text : ""
    ].filter(Boolean).join("\n");
  }
  clearMarker();
  dropWatcher();
  return [
    `已恢复 ${done} 条记录；会话文件残留空记录，再执行一次 off 可清理。`,
    host ? host.text : "",
    guard ? guard.text : ""
  ].filter(Boolean).join("\n");
}

export function installFocus(ctx, { root, cfg: rawConfig, logger } = {}) {
  ROOT = root;
  ENGINE = path.join(ROOT, "engine");
  PAUSE = path.join(ENGINE, "pause-non-system-processes.ps1");
  RESUME = path.join(ENGINE, "resume-non-system-processes.ps1");
  WATCH = path.join(ENGINE, "watch-parent.ps1");
  DAEMON = path.join(ENGINE, "focus-daemon.ps1");
  STATE = path.join(ENGINE, "state", "current.json");
  HOST_BOOST = path.join(ENGINE, "boost-host.ps1");
  HOST_RESTORE = path.join(ENGINE, "restore-host.ps1");
  HOST_STATE = path.join(ENGINE, "state", "host-boost.json");
  GAME_GUARD = path.join(ENGINE, "game-guard.ps1");
  ENGINE_CONFIG = path.join(ENGINE, "config.json");
  DETECT_HEAVY = path.join(ENGINE, "detect-heavy.ps1");
  LOGS = path.join(ENGINE, "logs");
  RUN = path.join(ENGINE, "run");
  MARKER = path.join(RUN, "active.json");
  const cfg = resolveConfig(rawConfig);
  let watcher = null;
  let chain = Promise.resolve();

  const queued = (fn) => {
    const run = chain.then(() => fn());
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const ensureWatcher = () => {
    if (watcher && watcher.exitCode === null) return true;
    if (!fs.existsSync(WATCH)) return false;
    const parentStartMs = Math.round(Date.now() - process.uptime() * 1000);
    try {
      const child = spawn(psExe(), [
        ...PS_BASE, WATCH,
        "-ParentPid", String(process.pid),
        "-ParentStartMs", String(parentStartMs),
        "-StateFile", STATE,
        "-ResumeScript", RESUME
      ], {
        detached: true,
        windowsHide: true,
        stdio: "ignore"
      });
      child.unref();
      child.once("exit", () => { if (watcher === child) watcher = null; });
      watcher = child;
      return true;
    } catch {
      watcher = null;
      return false;
    }
  };

  const dropWatcher = () => { watcher = null; };
  WATCHER_FN = ensureWatcher;

  ctx.tools.register({
    name: "focus_mode",
    description: "专注模式：冻结后台应用以腾出 CPU/内存，关闭时按指纹精确恢复，不结束任何进程。status 查看状态；scan 预览会冻结谁和风险；on 先返回预演（系统关键/可见窗口/当前前台），确认后带 confirm:true + apply:true 才真正冻结；off 恢复全部。task 只冻结 Adobe 后台/厂商控制台白名单，deep 才冻结浏览器/编辑器/Office/Adobe/虚拟机，performance 在 deep 基础上再把 DSH 本体降级（Idle 优先级 + EcoQoS 能效核 + 低内存优先级），把 CPU/内存最大程度让给游戏或跑图。系统关键、会话 0 永远不冻。需要 DSH 以 Medium 完整性启动；Low 下会拒绝。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "scan", "on", "off"], description: "要执行的操作。" },
        mode: { type: "string", enum: ["task", "deep", "performance"], description: "档案：task 只冻结 Adobe 后台/厂商控制台白名单；deep 才冻结浏览器/编辑器/Office/Adobe/虚拟机；performance 在 deep 基础上额外降级 DSH 本体（优先级/EcoQoS/内存优先级），适合打游戏或跑图。默认取插件配置。" },
        confirm: { type: "boolean", description: "on 必须显式传 true；其余操作忽略。" },
        apply: { type: "boolean", description: "on 第一次不要传：只返回预演。看过预演、确认要冻结后，再带 apply:true 调用。" }
      },
      required: ["action"]
    },
    output: {
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: true
      },
      render: (args, value) => [{ type: "text", text: value.text || "（无输出）" }]
    },
    execute: (args) => queued(async () => {
      try {
        if (process.platform !== "win32") return { text: "专注模式只支持 Windows。" };
        if (!fs.existsSync(PAUSE) || !fs.existsSync(RESUME)) return { text: `引擎脚本缺失：${ENGINE}` };
        const action = String(args?.action || "status").trim().toLowerCase();
        if (action === "status") {
          const il = await currentIntegrity();
          return { text: await statusText(cfg, il) };
        }
        if (action === "scan") {
          const mode = args?.mode ? String(args.mode) : cfg.defaultMode;
          if (!MODES.has(mode)) return { text: `不认识的档案 "${mode}"；只支持 task / deep / performance。` };
          const il = await currentIntegrity();
          return { text: await scanText(cfg, mode, il) };
        }
        if (action === "on") return { text: await onText(cfg, args, ensureWatcher) };
        if (action === "off") return { text: await offText(cfg, dropWatcher) };
        return { text: `不认识的 action "${action}"；只支持 status / scan / on / off。` };
      } catch (e) {
        return { text: `专注模式出错：${e?.message || e}` };
      }
    })
  });

  // 浏览器提示条的数据源：只读快照。webServer 不是必备服务，拿不到就静默缺席，
  // 绝不因为少了它让整块插件（含 focus_mode 工具）停在 pending。
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["webServer"], (owner) => {
        const server = owner?.get?.("webServer") ?? owner?.webServer;
        if (!server || typeof server.register !== "function") return;
        ctx.effect(() => server.register({
          kind: "exact",
          path: "/plugins/shannon-anchor/focus/state",
          handler: (_req, res) => {
            try {
              sendJson(res, 200, { ...snapshot(), ts: Date.now() });
            } catch (e) {
              sendJson(res, 500, { error: String(e?.message || e) });
            }
          }
        }), "shannon-anchor: focus state route");
        // 提示条点一下就走这里：开着的关掉，关着的开起来。
        // 走的是和手动 on/off 完全相同的路径（预审、系统关键候选拒绝、低完整性拒绝都在）。
        ctx.effect(() => server.register({
          kind: "exact",
          path: "/plugins/shannon-anchor/focus/toggle",
          handler: (_req, res) => {
            void queued(async () => {
              try {
                const before = snapshot();
                const text = before.active
                  ? await offText(cfg, dropWatcher)
                  : await onText(cfg, { confirm: true, apply: true, mode: cfg.defaultMode }, ensureWatcher);
                sendJson(res, 200, { ...snapshot(), text, ts: Date.now() });
              } catch (e) {
                sendJson(res, 500, { error: String(e?.message || e) });
              }
            });
          }
        }), "shannon-anchor: focus toggle route");
      });
    } catch { /* 服务不可用：提示条缺席，工具照常 */ }
  }

  // 随 DSH 启动自动开启：延迟等宿主自己落定，再走和手动 on 完全相同的预审+执行路径
  // （系统关键/会话 0 候选照样拒绝，低完整性照样不动）。失败只记日志，不碰宿主。
  if (cfg.autoStart) {
    const runAutostart = () => queued(async () => {
      try {
        // 2026-10-31 实测：DSH 被强杀时 daemon 的 finally 来不及跑，冻结会残留——
        // 进程冻着、没人恢复、状态却还报「已开启」。所以每次启动先清残留。
        try {
          const st = readState();
          if (st.exists && !st.broken) {
            const stale = (st.entries || []).filter(
              (e) => String(e.mode) === "Suspend" && Number(e.suspendCount) > 0,
            );
            if (stale.length) {
              appendAutostartLog(`recover stale: ${stale.length} frozen`);
              await offText(cfg, false);
            }
          }
        } catch (e) {
          appendAutostartLog(`recover stale failed: ${e?.message || e}`);
        }
        // 上次 DSH 被强杀时，宿主降级也可能残留：先恢复，再走正常流程。
        try {
          const hs = readHostState();
          if (hs.exists && hs.entries.length) {
            appendAutostartLog(`recover stale host boost: ${hs.entries.length}`);
            await restoreHost(cfg);
          }
        } catch (e) {
          appendAutostartLog(`recover stale host boost failed: ${e?.message || e}`);
        }
        // 专注模式没开时，停掉可能残留的游戏看护（旧实例或上次没停干净的）。
        const snap = snapshot();
        if (!snap.active) {
          try {
            const g = await gameGuardAction(cfg, "stop");
            if (g && !g.skipped) appendAutostartLog(`game guard stop: ${g.text}`);
          } catch (e) {
            appendAutostartLog(`game guard stop failed: ${e?.message || e}`);
          }
        }
        if (snap.active) { appendAutostartLog("skip: already active"); return; }
        const il = await currentIntegrity();
        if (il.level === "low") { appendAutostartLog("skip: integrity=low"); return; }
        // performance 会降级 DSH 本体，自动启动时降级自己会让 DSH 一直很卡——
        // 自动启动只跑 task，performance 留给手动 on。
        const autoMode = cfg.defaultMode === "performance" ? "task" : cfg.defaultMode;
        const text = await onText(cfg, { confirm: true, apply: true, mode: autoMode }, ensureWatcher);
        const first = String(text || "").split("\n").find(Boolean) || "(empty)";
        appendAutostartLog(`done: ${first}`);
      } catch (e) {
        appendAutostartLog(`error: ${e?.message || e}`);
      }
    });
    try {
      ctx.effect(() => {
        const timer = setTimeout(runAutostart, cfg.autoStartDelayMs);
        timer.unref?.();
        return () => clearTimeout(timer);
      }, "shannon-anchor: focus autostart");
    } catch {
      const timer = setTimeout(runAutostart, cfg.autoStartDelayMs);
      timer.unref?.();
    }
  }

  // 重任务自动检测：DSH 启动后延迟 30 秒开始，每 autoDetectIntervalSec 秒看一次。
  // 检测到重任务（GPU ≥ 70% 或非宿主大进程 ≥ 2 GB）连续两次 → 降级 DSH；
  // 连续两次空闲 → 恢复。off 会停掉它，下次 on performance 或重启 DSH 再起。
  if (cfg.autoDetect) {
    try {
      ctx.effect(() => {
        const timer = setTimeout(() => {
          if (startHeavyWatch(cfg)) appendAutostartLog("heavy watch: started");
        }, 30000);
        timer.unref?.();
        return () => { clearTimeout(timer); stopHeavyWatch(); };
      }, "shannon-anchor: focus heavy watch");
    } catch {
      const timer = setTimeout(() => { startHeavyWatch(cfg); }, 30000);
      timer.unref?.();
    }
  }
}
