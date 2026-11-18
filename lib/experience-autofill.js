// experience-autofill — 规则表的自我补全
//
// 起因：机械触发应该像经验库一样有自我补全能力。
// 经验库会自己蒸馏、转正、淘汰；规则表原来只会等人手动加词。
// 2026-11-06 那次「用moss…」没命中，就是因为 match 里没有 moss —— 靠人发现。
//
// 这里做三件事，全部有出处、可回滚：
//   1. 未命中记录：pre-step 没命中任何规则时，把用户那句话记进 miss 日志。
//   2. 自动补词：miss 里反复出现的词，如果正好是某条手册条目的 tag，
//      就补进「最相关」那条规则的 match，并把条目号加进 recall。
//   3. 失效清理：recall 里指向已不存在条目的编号，自动移除。
//
// 边界：只补手册 tags 里确实有的词（有出处），每次最多 3 个，写前备份。
// 规则表是数据，补完热加载生效，不用重启。

import fs from "node:fs";
import path from "node:path";

const MISS_REL = path.join("guard", "experience-miss.jsonl");
const MAX_MISS_LINES = 400;
const AUTOFILL_EVERY = 20; // 每攒够 20 条未命中跑一次
const MAX_FILLS_PER_RUN = 3;

function missPath(root) {
  return path.join(root, MISS_REL);
}

export function recordMiss(root, text) {
  const t = String(text || "").trim();
  if (!t || t.length < 2) return;
  try {
    const p = missPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), text: t.slice(0, 200) }) + "\n", "utf8");
    // 超长就截断，只留最近 MAX_MISS_LINES 行
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_MISS_LINES) {
      fs.writeFileSync(p, lines.slice(-MAX_MISS_LINES).join("\n") + "\n", "utf8");
    }
  } catch {
    /* 记账不能影响主流程 */
  }
}

export function readMisses(root) {
  try {
    const p = missPath(root);
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 扫手册条目文件头里的 <!-- tags: a,b,c -->
export function scanManualTags(root) {
  const manualRoot = path.join(root, "manual");
  const out = [];
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith(".md")) {
        try {
          const head = fs.readFileSync(p, "utf8").slice(0, 1200);
          const m = /<!--\s*tags:\s*([^>]+?)\s*-->/.exec(head);
          const num = /^(\d+)\.md$/.exec(e.name);
          if (m && num) {
            out.push({
              number: Number(num[1]),
              tags: m[1].split(/[,，]/).map((s) => s.trim()).filter(Boolean),
            });
          }
        } catch {
          /* 单个文件读不了不影响整体 */
        }
      }
    }
  };
  walk(manualRoot);
  return out;
}

// 中文 2-4 字滑窗 + 英文词，统计频次
function extractTerms(texts) {
  const freq = new Map();
  const bump = (w) => {
    if (!w) return;
    freq.set(w, (freq.get(w) || 0) + 1);
  };
  const STOP = new Set([
    "然后", "应该", "一个", "这个", "那个", "什么", "怎么", "可以", "帮我", "我们",
    "现在", "还是", "就是", "不是", "没有", "已经", "因为", "所以", "但是", "如果",
    "the", "and", "for", "with", "that", "this", "you", "are", "was", "have",
  ]);
  for (const t of texts) {
    const s = String(t || "");
    // 英文词
    for (const w of s.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) || []) {
      const lw = w.toLowerCase();
      if (!STOP.has(lw)) bump(lw);
    }
    // 中文 2-4 字
    const cjk = s.replace(/[^\u4e00-\u9fa5]/g, " ");
    for (const seg of cjk.split(/\s+/)) {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= seg.length; i++) {
          const w = seg.slice(i, i + n);
          if (!STOP.has(w)) bump(w);
        }
      }
    }
  }
  return freq;
}

// 规则与一组 tags 的相关度：match 词命中 tags 的个数。
// 中文按共同字符算（"生图" 与 "出图" 共享 "图"），否则同义不同词永远配不上。
function relevance(rule, tags) {
  let n = 0;
  for (const kw of rule.match || []) {
    const a = String(kw).toLowerCase();
    for (const t of tags) {
      const b = String(t).toLowerCase();
      if (a === b || a.includes(b) || b.includes(a)) {
        n += 2;
        break;
      }
      const common = [...a].filter((ch) => /[\u4e00-\u9fa5]/.test(ch) && b.includes(ch)).length;
      if (common >= 1) {
        n += common;
        break;
      }
    }
  }
  return n;
}

// 生成补全建议：{ ruleId, word, entry }
export function suggestFills(misses, manualTags, rules) {
  const texts = misses.map((m) => m.text);
  const freq = extractTerms(texts);
  const fills = [];
  const seen = new Set();

  // 按频次从高到低看
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  for (const [word, count] of ranked) {
    if (count < 2) break; // 只补反复出现的
    if (fills.length >= MAX_FILLS_PER_RUN) break;
    // 这个词必须是某条手册条目的 tag
    const owners = manualTags.filter((e) =>
      e.tags.some((t) => t.toLowerCase() === word.toLowerCase() || t.toLowerCase().includes(word.toLowerCase()))
    );
    if (!owners.length) continue;
    // 找最相关规则
    let best = null;
    let bestScore = 0;
    for (const r of rules) {
      const s = relevance(r, owners.flatMap((o) => o.tags));
      if (s > bestScore) {
        bestScore = s;
        best = r;
      }
    }
    if (!best || bestScore === 0) continue;
    // 已经在这个规则的 match 里就跳过
    if ((best.match || []).some((k) => k.toLowerCase() === word.toLowerCase())) continue;
    const key = `${best.id}::${word}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fills.push({ ruleId: best.id, word, entry: owners[0].number, count });
  }
  return fills;
}

// 清理 recall 里指向不存在条目的编号
export function pruneStaleRecall(rules, existingNumbers) {
  const existing = new Set(existingNumbers);
  const removed = [];
  for (const r of rules) {
    const before = r.recall || [];
    const after = before.filter((n) => existing.has(n));
    if (after.length !== before.length) {
      removed.push({ ruleId: r.id, dropped: before.filter((n) => !existing.has(n)) });
      r.recall = after;
    }
  }
  return removed;
}

// 应用补全：备份 → 写回 → 返回变更摘要
export function applyFills(root, rules, fills) {
  if (!fills.length) return null;
  const p = path.join(root, "conf", "experience-rules.json");
  const raw = fs.readFileSync(p, "utf8");
  const backupDir = path.join(root, "backup");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(backupDir, `experience-rules.${stamp}.json`), raw, "utf8");

  for (const f of fills) {
    const r = rules.find((x) => x.id === f.ruleId);
    if (!r) continue;
    r.match = [...(r.match || []), f.word];
    if (f.entry && !(r.recall || []).includes(f.entry)) {
      r.recall = [...(r.recall || []), f.entry];
    }
  }
  const doc = { version: 1, note: "任务 → 经验条目 的映射表。experience-router 用它在动手前提醒该查哪些条目。新增规则只改这个文件，不改代码。", rules };
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return { applied: fills, backup: `backup/experience-rules.${stamp}.json` };
}

// 主入口：攒够阈值才跑，返回摘要或 null
export function maybeAutofill(root, rules) {
  const misses = readMisses(root);
  if (misses.length < AUTOFILL_EVERY) return null;
  const manualTags = scanManualTags(root);
  const existingNumbers = manualTags.map((e) => e.number);
  const fills = suggestFills(misses, manualTags, rules);
  const pruned = pruneStaleRecall(rules, existingNumbers);
  if (!fills.length && !pruned.length) return null;
  const applied = applyFills(root, rules, fills);
  // 清空 miss 日志，避免同一批反复补
  try {
    fs.writeFileSync(missPath(root), "", "utf8");
  } catch {
    /* ignore */
  }
  return { fills: applied?.applied || [], pruned, backup: applied?.backup || null };
}
