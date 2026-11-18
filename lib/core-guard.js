// core-guard — 核心区写入白名单（dry-run 阶段）。
//
// 主线第二段“收通道”的第一步：先只记录、不拦截。跑一段时间后看
// 日志里有多少“非白名单写入”，再决定 enforce 规则。
//
// 白名单按工具名判定：
//   - memory_*       本插件自己的写入工具
//   - 护栏/备份脚本   命令行命中 allowCommands 里的正则（默认空，自己配）
// 其余工具只要参数里出现核心区路径，就记一条 dry-run 记录。
//
// 边界：这是软闸门。它只看得见经过 tools/pre-execute 的调用；
// 宿主之外的进程写文件，它一无所知（那是 FIM 的活）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { judgeCommand51 } from "./experience-router.js";

export const DEFAULTS = {
  enabled: true,
  // dry-run：只记不拦。enforce 阶段再改。
  mode: "dry-run",
  // 核心区路径（绝对路径或相对 manualRoot）。
  paths: [],
  // 允许写的工具名（正则字符串）。
  allowTools: ["^memory_"],
  // 允许写的命令行特征（正则字符串）。
  // 空默认：护栏/备份脚本的命名因机器而异，由使用者在 conf/user.json 里自己配。
  allowCommands: [],
  logDir: "guard"
};

function resolveCfg(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  cfg.enabled = cfg.enabled !== false;
  cfg.mode = cfg.mode === "enforce" ? "enforce" : "dry-run";
  cfg.paths = Array.isArray(cfg.paths) ? cfg.paths.filter((p) => typeof p === "string" && p.trim()) : [];
  cfg.allowTools = Array.isArray(cfg.allowTools) ? cfg.allowTools : DEFAULTS.allowTools;
  cfg.allowCommands = Array.isArray(cfg.allowCommands) ? cfg.allowCommands : DEFAULTS.allowCommands;
  return cfg;
}

function compile(list) {
  const out = [];
  for (const p of list) {
    try { out.push(new RegExp(p, "i")); } catch { /* 坏正则跳过，不拖垮 */ }
  }
  return out;
}

function argsText(args) {
  try {
    if (typeof args === "string") return args;
    return JSON.stringify(args ?? {});
  } catch {
    return String(args ?? "");
  }
}

// 只取「会被写入的目标」，不取内容。
//
// 典型误伤：编辑一份普通文档，只因为正文里**提到**了
// 核心区路径，就被判成"写核心区"拦下。argsText 是整个参数的 JSON，内容里
// 出现路径字符串太正常了（文档、代码、日志摘要都会带）。
//
// 判定只该看「这次操作会落到哪个路径」：
//   - pwsh / bash：命令本身就是要执行的东西，整条看（它真会写）
//   - 文件类工具：只取出目标路径字段，不看我往里面写什么
//   - 其余：退回整份 args（宁可多拦，不可漏拦）
const PATH_FIELDS = ["file_path", "path", "target", "dest", "destination"];

function targetText(args) {
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object") return String(args ?? "");
  if (typeof args.command === "string") return args.command;
  for (const f of PATH_FIELDS) {
    const v = args[f];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v)) {
      const parts = v.filter((x) => typeof x === "string" && x.trim());
      if (parts.length) return parts.join("\n");
    }
  }
  return argsText(args);
}

function norm(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "").toLowerCase();
}

// `~` 展开：配置里写 ~/.dsh/... 比写死盘符可移植，但 path.isAbsolute("~/x")
// 是 false —— 不展开就会被当成相对路径拼到 root 后面，核心区静默失效。
// 目标文本也要展开，否则工具参数里写 ~ 的调用会漏拦。
function expandTilde(s) {
  const home = os.homedir();
  return String(s || "").replace(/(^|[\s'"`=(])~(?=[\\/])/g, (m, pre) => pre + home);
}

// 乱码容错（2026-11-01）：兜底，不是主路径。
//
// 曾经以为 core-guard 漏拦，理由是日志里的路径是一串 GBK 乱码。实际查明
// 那是 PowerShell 5.1 的 Get-Content 用 GBK 解码 UTF-8 造成的显示问题，文件里
// 一直是正确中文，实际判定没有漏。这条容错留作防御：工具参数若真以 GBK 乱码
// 形态到达，路径 includes 会匹配不上，core-guard 就会静默放行。成本很低，留着。
let gbkDecoder = null;
try { gbkDecoder = new TextDecoder("gbk"); } catch { /* 没有 ICU 就算了 */ }

function mojiVariant(p) {
  if (!gbkDecoder) return null;
  try {
    const m = gbkDecoder.decode(Buffer.from(String(p), "utf8"));
    return m === p ? null : m;
  } catch {
    return null;
  }
}

// 从参数文本里找出落在核心区的路径。
export function coreHits(text, corePaths) {
  const t = norm(expandTilde(text));
  const hits = [];
  const seen = new Set();
  for (const c of corePaths) {
    const ce = expandTilde(c);
    const candidates = [norm(ce)];
    const m = mojiVariant(ce);
    if (m) candidates.push(norm(m));
    for (const n of candidates) {
      if (n && t.includes(n) && !seen.has(c)) {
        hits.push(c);
        seen.add(c);
      }
    }
  }
  return hits;
}

// 只读工具：它们碰核心区是正常的（查日志、读条目），不该进白名单判定。
// 2026-11-01 实测：Get-ChildItem / Get-Content 读 guard 日志被记成
// “非白名单写入”，dry-run 日志里全是误报，观察期就白看了。
const READ_ONLY_TOOLS = /^(read|grep|glob|list|ls|cat|head|tail|stat|find|search|memory_(list|recall|search|metrics|forget|review|curate))$/i;

// 只读命令：命令行里只出现这些动词时，视为读。
// 注意：一条命令里只要出现任一写动词，就按写处理（宁可多判一次写）。
const WRITE_VERBS = /\b(set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|rename-item|clear-content|set-itemproperty|new-itemproperty|remove-itemproperty|icacls|takeown|attrib|del|erase|rmdir|mkdir|rm|mv|cp|touch|tee|sed\s+-i|truncate|chmod|chown|unlink|shutil\.rmtree|os\.remove|fs\.writefile|fs\.unlink|fs\.rm|writefile|appendfile)\b/i;

// 读动词：命令行里出现这些，且没有写动词，才算读。
// 为什么需要它：空命令或纯参数（如 memory_write 的 file_path）没有动词，
// 不能默认当读——那等于给所有未知调用开后门。
const READ_VERBS = /\b(get-content|get-childitem|get-item|get-itemproperty|select-string|test-path|resolve-path|measure-object|compare-object|import-csv|import-cli|cat|head|tail|less|more|grep|rg|find|ls|dir|stat|type|wc|jq|python\s+-c\s+["']?print)\b/i;

export function isReadOnlyCall(toolName, text) {
  const name = String(toolName || "");
  if (READ_ONLY_TOOLS.test(name)) return true;
  const t = String(text || "");
  if (!t.trim()) return false;
  // 有写动词 → 一定是写（哪怕同时有读动词）。
  if (WRITE_VERBS.test(t)) return false;
  // 没有写动词，还要有读动词才算读；纯参数不算。
  return READ_VERBS.test(t);
}

export function createCoreGuard({ root, cfg: rawCfg, logger }) {
  const cfg = resolveCfg(rawCfg);
  const baseRoot = expandTilde(root);
  const corePaths = cfg.paths.map((p) => {
    const e = expandTilde(p);
    return path.isAbsolute(e) ? e : path.join(baseRoot, e);
  });
  const allowTools = compile(cfg.allowTools);
  const allowCommands = compile(cfg.allowCommands);
  const logFile = path.join(baseRoot, cfg.logDir, "core-writes.jsonl");

  function log(rec) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", "utf8");
    } catch { /* 日志失败不影响主流程 */ }
  }

  // 返回 { allowed, hits, reason }；allowed=false 时 enforce 阶段会 deny。
  function judge(toolName, args) {
    // 编码闸门：跟核心区无关，是独立的一类。5.1 的 powershell 收到中文参数会
    // 变成 ?，交给 icacls 这类原生程序直接报 Invalid parameter（2026-11-01 实测）。
    // 这条不看 mode —— dry-run 也拦，因为它拦的是"必然失败的命令"，不是策略。
    if (String(toolName || "") === "pwsh") {
      const v = judgeCommand51(args?.command ?? args?.script);
      if (v) return { allowed: false, hits: [], reason: "powershell-51-cjk", reasonText: v.reason };
    }
    if (!cfg.enabled || corePaths.length === 0) return { allowed: true, hits: [], reason: "off" };
    // 只看「会落到哪个路径」，不看内容（见 targetText 的注释）。
    const text = targetText(args);
    const hits = coreHits(text, corePaths);
    if (hits.length === 0) return { allowed: true, hits: [], reason: "outside-core" };
    // 读操作先放行：白名单管的是“谁能写”，不是“谁能看”。
    if (isReadOnlyCall(toolName, text)) return { allowed: true, hits, reason: "read-only" };
    const name = String(toolName || "");
    if (allowTools.some((re) => re.test(name))) return { allowed: true, hits, reason: "allow-tool" };
    if (allowCommands.some((re) => re.test(text))) return { allowed: true, hits, reason: "allow-command" };
    return { allowed: false, hits, reason: "not-allowlisted" };
  }

  function record(toolName, args, verdict) {
    log({
      mode: cfg.mode,
      tool: String(toolName || ""),
      allowed: verdict.allowed,
      reason: verdict.reason,
      hits: verdict.hits
    });
  }

  return { cfg, judge, record, logFile, corePaths };
}

// 接到 tools/pre-execute 上。dry-run 只记录；enforce 才 deny。
export function installCoreGuard(ctx, { root, cfg, logger }) {
  const guard = createCoreGuard({ root, cfg, logger });
  if (!guard.cfg.enabled || guard.corePaths.length === 0) {
    logger?.info?.("shannon-anchor: core-guard off (no core paths configured)");
    return guard;
  }
  try {
    ctx.on("tools/pre-execute", async (exec, next) => {
      try {
        const toolName = exec?.name;
        const args = (exec && (exec.arguments ?? exec.args)) || {};
        const verdict = guard.judge(toolName, args);
        if (!verdict.allowed) {
          guard.record(toolName, args, verdict);
          // 编码闸门不看 mode：它拦的是必然失败的命令，不是策略选择。
          if (verdict.reason === "powershell-51-cjk") {
            logger?.info?.(`shannon-anchor: core-guard denied ${toolName} (powershell 5.1 + CJK)`);
            return { kind: "deny", reason: verdict.reasonText };
          }
          if (guard.cfg.mode === "enforce") {
            logger?.info?.(`shannon-anchor: core-guard denied ${toolName} (${verdict.hits.join(", ")})`);
            return {
              kind: "deny",
              reason: `核心区写入未走白名单：${verdict.hits.join(", ")}。请用 memory_write 或 allowCommands 里配的命令，或先确认这是有意为之。`
            };
          }
          logger?.info?.(`shannon-anchor: core-guard dry-run: ${toolName} touched core (${verdict.hits.join(", ")})`);
        }
      } catch (e) {
        logger?.warn?.(`shannon-anchor: core-guard judge failed: ${String(e?.message || e)}`);
      }
      return next();
    });
  } catch (e) {
    logger?.warn?.(`shannon-anchor: core-guard subscribe failed: ${String(e?.message || e)}`);
  }
  return guard;
}
