// shannon-anchor — redundancy: 只读的冗余检测（2026-11-03）。
//
// 四类冗余里，两类能真检测（记忆、数据），两类只能给静态说明（提示、输出）——
// 提示段落长度和工具返回大小在插件内部拿不到可靠数据，硬编一个数字就是造假。
// 所以这里只报能证明的，不能证明的明说"不检测"。
//
// 全部是读操作：不删、不合并、不改任何条目。报告写文件，决策交给人。

import fs from "node:fs";
import path from "node:path";
import { loadManual, loadManualWithBodies } from "./manual_store.js";
import { vectorize, cosine } from "./retrieval.js";

// 前提词：这些词出现在标题里，说明条目在描述"当时的环境"，环境一变就可能过时。
const PREMISE_RE = /当前|现在|本机|这台机器|目前|如今|眼下/;
// 阈值 0.7 是实测断点，不是拍的（2026-11-03，318 条 5 万对）：
//   0.9+ 0 对 / 0.8-0.9 0 对 / 0.7-0.8 1 对（#197/#198，标题几乎一样，真重复）
//   0.6-0.7 0 对 / 0.5-0.6 5 对
// 0.7 以上和以下有明显间隔，所以取 0.7。原来的 0.85 一对都抓不到。
// 注意：256 维特征哈希对中文标题不敏感（#176 vs #226 是 0.000），
// 所以这个检测只能抓"标题几乎一样"的重复，抓不到"换个说法讲同一件事"。
const DUP_THRESHOLD = 0.7;
const STALE_DAYS = 30;
const NEVER_USED_DAYS = 60;
const CANDIDATE_DAYS = 45;

function daysSince(dateStr) {
  if (!dateStr) return null;
  const t = new Date(`${dateStr}T00:00:00`).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// ---- 记忆冗余 ----
function scanMemory(entries, stats) {
  // 1. 重复：两两算 256 维特征哈希余弦。317 条 = 5 万对，毫秒级。
  //    用标题+标签而不是正文：正文长，两篇讲不同事的文章也会因为共用词而相似。
  const vecs = entries.map((e) => ({
    e,
    v: vectorize(`${e.title} ${(e.tags || []).join(" ")}`)
  }));
  const dupes = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const c = cosine(vecs[i].v, vecs[j].v);
      if (c >= DUP_THRESHOLD) {
        dupes.push({
          a: vecs[i].e.number,
          b: vecs[j].e.number,
          score: Number(c.toFixed(3)),
          aTitle: vecs[i].e.title,
          bTitle: vecs[j].e.title
        });
      }
    }
  }
  dupes.sort((x, y) => y.score - x.score);

  // 2. 过时：标题带前提词 + 写入超过 30 天。只报，不判断是否真过时。
  const stale = entries
    .filter((e) => !e.superseded && PREMISE_RE.test(e.title) && (daysSince(e.created) ?? 0) > STALE_DAYS)
    .map((e) => ({ number: e.number, title: e.title, age: daysSince(e.created), created: e.created }));

  // 3. 从未召回：stats 里没有记录或 count 为 0，且写入超过 60 天。
  const neverUsed = entries
    .filter((e) => {
      if (e.superseded) return false;
      const age = daysSince(e.created);
      if (age === null || age <= NEVER_USED_DAYS) return false;
      const s = stats[String(e.number)];
      return !s || !s.count;
    })
    .map((e) => ({ number: e.number, title: e.title, age: daysSince(e.created), bytes: e.bytes }));

  // 4. 候选过期：带候选标记 + 写入超过 45 天。
  const expiredCandidates = entries
    .filter((e) => {
      if (e.superseded) return false;
      const age = daysSince(e.created);
      if (age === null || age <= CANDIDATE_DAYS) return false;
      return /<!--\s*候选:/.test(e.body || "");
    })
    .map((e) => ({ number: e.number, title: e.title, age: daysSince(e.created) }));

  return { dupes, stale, neverUsed, expiredCandidates };
}

// ---- 数据冗余 ----
function dirSize(p) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.isFile()) {
        try { bytes += fs.statSync(fp).size; files++; } catch { /* 读不到就跳过 */ }
      }
    }
  };
  walk(p);
  return { bytes, files };
}

function scanData(root, extraPaths = []) {
  const dirs = [];
  const candidates = [
    ...fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name)),
    ...extraPaths.filter((p) => fs.existsSync(p))
  ];
  for (const p of candidates) {
    const { bytes, files } = dirSize(p);
    dirs.push({ path: p, bytes, files });
  }
  dirs.sort((a, b) => b.bytes - a.bytes);

  // 大日志：单个文件 > 10 MB
  const bigLogs = [];
  const logDir = path.join(root, "logs");
  if (fs.existsSync(logDir)) {
    for (const f of fs.readdirSync(logDir)) {
      const fp = path.join(logDir, f);
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && st.size > 10 * 1024 * 1024) bigLogs.push({ file: f, bytes: st.size });
      } catch { /* 跳过 */ }
    }
  }
  return { dirs, bigLogs };
}

// ---- 提示冗余 ----
// 常驻段落长度在插件内部拿不到（section 是运行时注册的），硬编数字就是造假。
// 只报已知的静态事实：hint 和指令表是常驻的，其余空队列时为零。
function scanPrompt() {
  return {
    note: "常驻段落只有 hint（约 200 字）和指令表（约 300 字）；distill/voice/review 空队列时返回空串，零成本。段落间重复未检测——没有可靠数据源。",
    notDetected: ["段落间重复", "运行时 section 实际长度"]
  };
}

// ---- 汇总 ----
export function scan(root, { stats = {}, extraPaths = [] } = {}) {
  const manual = loadManual(root);
  const withBodies = manual.entries.length ? loadManualWithBodies(manual) : manual;
  return {
    at: new Date().toISOString(),
    total: manual.entries.length,
    memory: scanMemory(withBodies.entries, stats),
    data: scanData(root, extraPaths),
    prompt: scanPrompt()
  };
}

// ---- 报告 ----
function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatSummary(r) {
  const m = r.memory;
  const d = r.data;
  const totalBytes = d.dirs.reduce((s, x) => s + x.bytes, 0);
  const lines = [
    `冗余扫描 ${r.at.slice(0, 10)}（手册 ${r.total} 条）`,
    `记忆：重复 ${m.dupes.length} 对 / 过时 ${m.stale.length} 条 / 从未召回 ${m.neverUsed.length} 条 / 候选过期 ${m.expiredCandidates.length} 条`,
    `数据：${d.dirs.length} 个目录共 ${mb(totalBytes)}${d.bigLogs.length ? `，${d.bigLogs.length} 个日志超 10MB` : ""}`,
    `提示：${r.prompt.note}`,
    `（要看明细加 detail: true）`
  ];
  return lines.join("\n");
}

export function formatReport(r) {
  const m = r.memory;
  const d = r.data;
  const out = [
    `# 冗余扫描报告 ${r.at}`,
    "",
    `手册 ${r.total} 条。`,
    "",
    "## 记忆冗余",
    "",
    `### 重复条目（标题+标签余弦 ≥ ${DUP_THRESHOLD}）${m.dupes.length} 对`,
    ""
  ];
  if (m.dupes.length) {
    out.push("| A | B | 相似度 |", "|---|---|---|");
    for (const x of m.dupes.slice(0, 50)) {
      out.push(`| #${x.a} ${x.aTitle.slice(0, 30)} | #${x.b} ${x.bTitle.slice(0, 30)} | ${x.score} |`);
    }
    if (m.dupes.length > 50) out.push(`\n（只列前 50 对，共 ${m.dupes.length} 对）`);
  } else {
    out.push("无。");
  }

  out.push("", `### 过时条目（标题含前提词 + 超过 ${STALE_DAYS} 天）${m.stale.length} 条`, "");
  if (m.stale.length) {
    out.push("| # | 标题 | 写入 | 天数 |", "|---|---|---|---|");
    for (const x of m.stale) out.push(`| ${x.number} | ${x.title.slice(0, 40)} | ${x.created} | ${x.age} |`);
  } else {
    out.push("无。");
  }

  out.push("", `### 从未召回（无使用记录 + 超过 ${NEVER_USED_DAYS} 天）${m.neverUsed.length} 条`, "");
  if (m.neverUsed.length) {
    out.push("| # | 标题 | 天数 | 字节 |", "|---|---|---|---|");
    for (const x of m.neverUsed) out.push(`| ${x.number} | ${x.title.slice(0, 40)} | ${x.age} | ${x.bytes} |`);
  } else {
    out.push("无。");
  }

  out.push("", `### 候选过期（带候选标记 + 超过 ${CANDIDATE_DAYS} 天）${m.expiredCandidates.length} 条`, "");
  if (m.expiredCandidates.length) {
    out.push("| # | 标题 | 天数 |", "|---|---|---|");
    for (const x of m.expiredCandidates) out.push(`| ${x.number} | ${x.title.slice(0, 40)} | ${x.age} |`);
  } else {
    out.push("无。");
  }

  out.push("", "## 数据冗余", "", "| 目录 | 大小 | 文件数 |", "|---|---|---|");
  for (const x of d.dirs) out.push(`| \`${x.path}\` | ${mb(x.bytes)} | ${x.files} |`);
  if (d.bigLogs.length) {
    out.push("", "### 大日志（> 10 MB）", "");
    for (const x of d.bigLogs) out.push(`- ${x.file} — ${mb(x.bytes)}`);
  }

  out.push("", "## 提示冗余", "", r.prompt.note, "");
  if (r.prompt.notDetected.length) {
    out.push(`未检测：${r.prompt.notDetected.join("、")}（没有可靠数据源，不编数字）`);
  }

  out.push("", "## 建议", "");
  const advice = [];
  if (m.dupes.length) advice.push(`- ${m.dupes.length} 对重复条目：先看报告，确认是真重复再用 memory_curate merge 合并`);
  if (m.expiredCandidates.length) advice.push(`- ${m.expiredCandidates.length} 条候选过期：按规矩该转正或淘汰，逐条看`);
  if (m.neverUsed.length) advice.push(`- ${m.neverUsed.length} 条从未召回：可能是写得太偏，也可能是检索不到，先补标签再判断`);
  if (m.stale.length) advice.push(`- ${m.stale.length} 条过时：前提词条目，环境变了就该更新或标注`);
  const bigDirs = d.dirs.filter((x) => x.bytes > 100 * 1024 * 1024);
  if (bigDirs.length) advice.push(`- ${bigDirs.length} 个目录超 100 MB：看是不是临时文件，可逆的可以先清`);
  if (!advice.length) advice.push("- 没有需要处理的冗余。");
  out.push(...advice);

  return out.join("\n");
}
