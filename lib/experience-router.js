// experience-router — 任务 → 经验 的路由（纯函数层）。
//
// 起因：同一类错误连犯三次（PowerShell 5.1 的 BOM、显示乱码、
// 传参变 ?）：手册里全有，动手时一次没翻。软约束靠不住，改成机械触发。
//
// 这里只放判定逻辑，不碰 ctx。挂载点是 index.js 已有的那个 pre-step 监听器
// （predict / turn-distill / voice 共用），所以不新增监听器、不破坏测试里
// "默认不挂 pre-step" 的契约。命令闸门由 core-guard 的 judge 调用。
//
// 规则表是数据：新增任务类型只改 conf/experience-rules.json。

import fs from "node:fs";
import path from "node:path";
import { stripInjection } from "./predict.js";

export function loadRules(pkgRoot) {
  const p = path.join(pkgRoot, "conf", "experience-rules.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(j.rules) ? j.rules : [];
  } catch {
    return [];
  }
}

// 热加载：规则表是数据，改完不该为了它重启 DSH。
// 按文件 mtime 缓存，文件没动就不重读（每个 pre-step 都读一次 JSON 没必要）。
let ruleCache = { path: null, mtimeMs: 0, rules: [] };

export function loadRulesHot(pkgRoot) {
  const p = path.join(pkgRoot, "conf", "experience-rules.json");
  try {
    const st = fs.statSync(p);
    if (ruleCache.path === p && ruleCache.mtimeMs === st.mtimeMs) return ruleCache.rules;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const rules = Array.isArray(j.rules) ? j.rules : [];
    ruleCache = { path: p, mtimeMs: st.mtimeMs, rules };
    return rules;
  } catch {
    return ruleCache.rules || [];
  }
}

// 中文散在消息里，用子串匹配比正则稳；英文命令关键字也走同一条路。
export function matchByKeywords(text, rules) {
  const out = [];
  const t = String(text || "");
  if (!t) return out;
  for (const r of rules) {
    for (const kw of r.match || []) {
      if (kw && t.includes(kw)) {
        out.push(r);
        break;
      }
    }
  }
  return out;
}

export function matchByCommand(cmd, rules) {
  const out = [];
  const c = String(cmd || "");
  if (!c) return out;
  for (const r of rules) {
    for (const pat of r.commandMatch || []) {
      try {
        if (new RegExp(pat, "i").test(c)) {
          out.push(r);
          break;
        }
      } catch {
        // 规则表里写坏的正则不该拖垮整个闸门
      }
    }
  }
  return out;
}

// 从 messages 里取最后一条用户发言。宿主把整段对话交过来，找 role=user 的。
// 把消息内容压成纯文本。
//
// 原来对非字符串 content 直接 JSON.stringify —— 如果 content 是
// 分段数组（[{type:"text", text:"帮你删个文件"}]），stringify 会把中文转成
// \u5e2e\u6211... 这种转义，后面的 includes("删") 就永远匹配不上。
// 提示链路整条静默失效，看起来像"router 没生效"。
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p.text === "string") return p.text;
        if (p && typeof p.content === "string") return p.content;
        return "";
      })
      .join(" ");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  try {
    return JSON.stringify(content ?? "");
  } catch {
    return "";
  }
}

// 取「用户实际说的最后一句」。
//
// 两道过滤，缺一不可（2026-11-02 两次踩坑）：
//
// 1. content 可能是分段数组（[{type:"text", text:"帮我删个文件"}]）。
//    原来对非字符串直接 JSON.stringify，中文变成 \u5e2e\u6211 这种转义，
//    后面的 includes("删") 永远匹配不上。
//
// 2. **host 会往 user-role 消息里塞它自己的机器消息**：system-reminder、
//    skill 目录、runtime context 快照、压缩 checkpoint。从后往前找到的第一条
//    user 消息很可能不是人说的（predict.js 早就为这个坑写了 stripInjection）。
//    所以剥完注入如果是空的，必须继续往前找，不能就此返回 ""。
//
// 这两条合起来，就是"提示链路静默失效"的全部原因：命中永远为空。
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const role = m.role || m.type;
    if (role === "user" || role === "human") {
      const text = stripInjection(contentText(m.content)).trim();
      if (text) return text;
      // 剥完是空的 → 这条是 host 机器消息，继续往前找真正的用户发言。
    }
  }
  return "";
}

// 把命中的规则渲染成给模型看的一行提示。最多 3 条，多了反而稀释注意力。
export function renderHint(hits) {
  const top = (hits || []).slice(0, 3);
  if (!top.length) return "";
  const lines = top.map((r) => `- ${r.hint}（条目 #${r.recall.join(" / #")}）`);
  return `⚠ 这件事手册里有现成经验，动手前先取全文（memory_recall）：\n${lines.join("\n")}`;
}

// 5.1 的 powershell 收到中文参数会变成 ?，原生程序（icacls 之类）直接报错。
// 只认"明确调 powershell"且"命令里有中文"这一种，不扩大打击面。
const HAS_CJK = /[\u4e00-\u9fa5]/;
const CALLS_51 = /\bpowershell(\.exe)?\b/i;
const CALLS_PWSH7 = /7\.6\.9[\\/]pwsh\.exe|\bpwsh\b/i;

export function judgeCommand51(command) {
  const c = String(command || "");
  if (!CALLS_51.test(c)) return null;
  if (CALLS_PWSH7.test(c)) return null;
  if (!HAS_CJK.test(c)) return null;
  return {
    reason:
      "这条命令用 PowerShell 5.1 跑且带中文参数：5.1 传给原生程序的中文会变成 ?（2026-11-01 实测 icacls 报 Invalid parameter）。改用 pwsh 7（pwsh）或 node。"
  };
}
