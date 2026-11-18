// localjudge.js — 可选的本地判卷者，接在写后复查队列前面当"第一道筛子"。
//
// 为什么单独一个文件：review.js 的注释里写着插件不调模型（memory 不该依赖服务）。
// 这条约束仍然成立——这里调的是本机 ollama，127.0.0.1，没有 key、不联网、不做主流程的
// 前置条件。judgeEntry 失败时只返回 {ok:false}，调用方照旧走"另起无上下文会话"那条老路。
//
// 分工照 #382 的结论来：模型给判断，脚本筛机械缺陷，人做取舍。
// 这里能筛的只有四类——格式、引用存在性、合并目标不是自己、drop 时正文有没有强证据。
// "这条规则我认不认"不在脚本能力范围内，也不该在这里假装能判。
import { loadManual, readEntry } from "./manual_store.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "gemma4-12b";
const DEFAULT_TIMEOUT_MS = 120000;

// 判卷 prompt 里不要出现"如果…就…"的状态暗示。2026-11-17 实测：一句
// "如果标了 merged_into 就按那个状态判" 能把三个模型的裁决全推成 drop。
const PROMPT = `你是写后复查者。判定这条刚写入记忆手册的条目：该留（keep）、该并进已有条目（merge）、还是该丢（drop）。

判据，按顺序问：
1. 删掉这条，未来的我会少踩一个坑吗？不会 → drop
2. 与已有条目讲同一件事、且这条更弱或重复 → merge（要给出并入的条目号）
3. 有出处、可复用、不重复 → keep

条目开头的 <!-- --> 是元数据，不是正文。

—— 条目开始 ——
{text}
—— 条目结束 ——

只输出严格这三行，不要别的话：
verdict: keep 或 merge 或 drop
into: 条目号，不是 merge 就写 -
理由: 一句话`;

function endpointOf(opts) {
  return opts.endpoint || process.env.SHANNON_ANCHOR_JUDGE_URL || DEFAULT_ENDPOINT;
}

function modelOf(opts) {
  return opts.model || process.env.SHANNON_ANCHOR_JUDGE_MODEL || DEFAULT_MODEL;
}

async function chat(prompt, opts) {
  const url = `${endpointOf(opts).replace(/\/+$/, "")}/api/chat`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelOf(opts),
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
      options: { num_predict: 300, temperature: 0.2 }
    }),
    signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const out = await res.json();
  const msg = out.message || {};
  return String(msg.content || msg.thinking || "").trim();
}

export function parseVerdict(reply) {
  const m = /verdict:\s*(keep|merge|drop)/i.exec(reply);
  const intoM = /into:\s*(\d+|-)/i.exec(reply);
  const reasonM = /理由:\s*(.+)/.exec(reply);
  return {
    verdict: m ? m[1].toLowerCase() : "?",
    into: intoM && intoM[1] !== "-" ? Number(intoM[1]) : null,
    reason: reasonM ? reasonM[1].trim().slice(0, 200) : ""
  };
}

function bigrams(s) {
  const t = String(s || "").replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, "").toLowerCase();
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function overlap(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
}

// 强证据信号：带这些的条目判 drop 之前值得人再看一眼。
const EVIDENCE = /(实测|报错|路径|原话|命令行|代码|[\d.]+\s*(秒|分钟|小时|GB|MB|MiB|tok\/s))/i;

export function verifyVerdict(manual, number, parsed, entry) {
  const checks = [];
  const add = (name, ok, note) => checks.push({ name, ok, note });

  add("format", parsed.verdict !== "?", `verdict=${parsed.verdict}`);

  if (parsed.verdict === "merge") {
    const intoNum = Number(parsed.into);
    const target = Number.isInteger(intoNum) ? manual.entries.find((e) => e.number === intoNum) : null;
    add("into-exists", !!target, target ? `#${intoNum} 在手册里` : `#${parsed.into} 不在手册里`);
    add("not-self", intoNum !== number, intoNum === number ? "判成合并进自己" : "目标不是自己");
    if (target) {
      const sim = overlap(`${entry.title}\n${entry.body}`, `${target.title}\n${target.body || ""}`);
      add("related", sim >= 0.12, `与 #${intoNum} 的二元组重合 ${(sim * 100).toFixed(0)}%`);
    }
  }

  if (parsed.verdict === "drop") {
    const strong = EVIDENCE.test(String(entry.body || ""));
    add("drop-has-evidence", !strong, strong ? "判 drop，但正文带实测/数值，值得再看一眼" : "正文没有强证据");
  }

  return checks;
}

export function renderVerdict(r) {
  if (!r.ok) return `本地判卷失败：${r.error}`;
  const failed = r.checks.filter((c) => !c.ok);
  const head = r.verdict === "merge" ? `merge -> #${r.into}` : r.verdict;
  const lines = [
    `本地判卷（${r.model}）：#${r.number} ${head}`,
    `理由：${r.reason || "（无）"}`
  ];
  if (r.checks.length) {
    lines.push("校验：");
    for (const c of r.checks) lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.note}`);
  }
  lines.push(failed.length ? "有校验没过，建议人工确认后再 confirm。" : "校验全过，可以直接 confirm。");
  return lines.join("\n");
}

// judgeEntry: 给一个条目号，跑本地模型 + 机械校验。不写手册、不动队列。
export async function judgeEntry(root, number, opts = {}) {
  const manual = loadManual(root);
  const entry = readEntry(manual, Number(number));
  if (!entry) return { ok: false, error: `手册里没有 #${number}` };

  const text = `#${entry.number} · ${entry.title}\n\n${entry.body || ""}`;
  let reply;
  try {
    reply = await chat(PROMPT.replace("{text}", text), opts);
  } catch (e) {
    return { ok: false, error: `本地模型不可用：${String((e && e.message) || e)}` };
  }

  const parsed = parseVerdict(reply);
  const checks = verifyVerdict(manual, entry.number, parsed, entry);
  return {
    ok: true,
    model: modelOf(opts),
    number: entry.number,
    verdict: parsed.verdict,
    into: parsed.into,
    reason: parsed.reason,
    checks,
    raw: reply
  };
}
