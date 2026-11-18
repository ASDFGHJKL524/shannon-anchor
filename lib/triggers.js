// shannon-anchor — task triggers: a mechanical bell that rings only when the
// model is about to do something the manual has opinions about.
//
// It does NOT recall entries into context. It does NOT decide anything.
// It watches tools/pre-execute, matches the pending call against a small
// rule table, and on a hit sends ONE short line that points back at the
// standing rule ("check the manual first") — the same entry the resident
// prompt already names. No new doctrine, no per-turn cost, no guessing
// what the model is thinking: it only looks at what the model is about
// to call.
//
// Cost model: silent by default; a hit costs one ~40-char line in the
// next step's context. That is the whole budget.
//
// Matching is pure and synchronous so it is unit-testable without a host.
//
// On the write-outside rule: it never guesses which drive is the workspace.
// A drive letter means nothing across machines, and a wrong guess either
// fires on every ordinary write (context tax every turn) or stays blind.
// It only matches explicit out-of-home shapes; users widen it via config.

// Default rules. Users edit these in cordis.patch.yml config; this table
// is only the shipped starting point. Each rule: what to watch, and the
// one short line to send on a hit.
export const DEFAULT_TRIGGERS = [
  {
    id: "delete",
    tools: ["pwsh", "powershell", "bash", "shell"],
    argPattern: "Remove-Item|\\bdel\\b|\\brmdir\\b|\\brm\\b|删除守卫",
    instruction: 1,
    hint: "删除任务：按全局规范主动读手册那条，先查再动手"
  },
  {
    id: "write-outside",
    tools: ["write", "edit"],
    argPattern: "~/\.dsh|~/|\.dsh[\\\\/]",
    instruction: 3,
    hint: "写工作区外：按全局规范主动读手册那条，先查再动手"
  },
  {
    id: "backup",
    tools: ["pwsh", "powershell", "bash", "shell"],
    argPattern: "备份|backup|快照|snapshot|zip",
    instruction: 2,
    hint: "备份任务：按全局规范主动读手册那条，查 58–60"
  },
  {
    id: "longtask",
    tools: ["workflow", "subagent"],
    argPattern: ".",
    instruction: 4,
    hint: "长任务：按全局规范主动读手册那条，先报预计耗时"
  },
  {
    // 2026-10-27：联网失败曾被当成"pwsh 没有外网"直接下结论，
    // 病根是 Schannel（#39）。真开始下载/探网时响一下，先读 #39/#135/#190。
    // 2026-10-29 扩：探测本身（Test-NetConnection / Invoke-WebRequest）和报错
    // 原文（schannel / SEC_E_NO_CREDENTIALS / SSL）也要响。上一轮是探到了
    // 报错却没人提醒「这是低完整性拿不到凭证，不是没网」，于是把一次失败
    // 当成了整台机器的事实。
    id: "net",
    tools: ["pwsh", "powershell", "bash", "shell"],
    argPattern: "huggingface|hf-mirror|modelscope|download|下载|Invoke-WebRequest|Invoke-RestMethod|Test-NetConnection|Resolve-DnsName|curl|wget|aria2|git clone|pip install|urllib|requests\\.|https?://|schannel|SEC_E_NO_CREDENTIALS|SSL|联网|外网",
    instruction: 10,
    hint: "联网/下载：按全局规范主动读手册那条，先看 #39 的病 A"
  }
];

// argsToString: whatever shape exec.args arrives in, get searchable text.
// Never throws — a trigger that crashes would be worse than one that misses.
function argsToString(args) {
  try {
    if (typeof args === "string") return args;
    return JSON.stringify(args ?? {});
  } catch {
    return String(args ?? "");
  }
}

// matchTriggers(toolName, args, rules) -> [{ id, hint }]
// Pure. A rule hits when the tool name is watched AND its pattern matches
// the serialized args. Order preserved; empty pattern matches anything.
export function matchTriggers(toolName, args, rules) {
  if (!toolName || !Array.isArray(rules) || rules.length === 0) return [];
  const text = argsToString(args);
  const hits = [];
  for (const rule of rules) {
    if (!rule || !rule.id) continue;
    const watched = Array.isArray(rule.tools) && rule.tools.includes(toolName);
    if (!watched) continue;
    let patternOk = true;
    if (rule.argPattern && rule.argPattern !== ".") {
      try {
        patternOk = new RegExp(rule.argPattern, "i").test(text);
      } catch {
        patternOk = false; // a broken user pattern never fires
      }
    }
    if (patternOk) hits.push({ id: rule.id, instruction: rule.instruction });
  }
  return hits;
}

// The line that actually gets injected. Kept to one sentence so the
// context cost stays trivial and the model never confuses it with a task.
// composeInjection: the line actually sent. It is just the instruction
// number(s) — the resident table already tells the model what each number
// means. Shortest possible: a digit, not a sentence.
//
// 定制版（2026-10-18）：hits 可以带自己的 `line`（调用方按指令表查出
// memory_recall 条目号）。带了就优先用，这样触发行直接说「recall 95」，
// 不需要另一处文案去记 01-rules/N.md 这种会过时的路径。
// 不带 line 的旧调用方式行为不变。
export function composeInjection(hits) {
  if (!hits || hits.length === 0) return null;
  const lines = [...new Set(hits.filter((h) => h.line).map((h) => h.line))];
  if (lines.length === 1) return lines[0];
  if (lines.length > 1) return lines.join("；");
  const nums = [...new Set(hits.map((h) => h.instruction))];
  return "按指令 " + nums.join("、");
}
