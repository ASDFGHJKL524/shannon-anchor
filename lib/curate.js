// shannon-anchor — curate: the shape layer (self-stacking, phase 1).
//
// Two jobs, both deliberately small:
//   1. suggest(text)  — read-only. "Does this look like something I already
//      know? Which entry? Is it a conflict?" Zero LLM: BM25 + 256-dim
//      feature-hash cosine from retrieval.js, a mechanical dedupe hash, and
//      a crude one-sided-negation check. The output is a suggestion table;
//      the human decides.
//   2. linkEntry()    — the ONLY phase-1 write. It appends one metadata
//      marker to an entry's head (superseded_by / merged_into) plus an
//      evidence line, then updates memory.json. The prose is never touched:
//      "only append, never overwrite" is the whole point of the lineage.
//
// Thresholds are NOT measured yet (see docs/USAGE.md). They are
// starting points; every suggestion carries the raw score so a human can
// judge, and the bands can be retuned without rewriting callers.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readEntry, loadManual, manifestPath } from "./manual_store.js";
import { bm25, cosine, vectorize } from "./retrieval.js";

// A candidate must clear these bands to earn a suggestion. Unmeasured.
export const BAND_MERGE = 0.75;
export const BAND_SIMILAR = 0.45;
export const MIN_BODY_CHARS = 20;
const COSINE_FLOOR = 0.3;

// One-sided negation is a weak conflict signal on purpose: "possible
// conflict, compare by hand" — never "these contradict" as a verdict.
const NEGATION_RE =
  /(不要|不许|禁止|禁用|从不|永不|绝不|never|must\s+not|do\s+not|don't|no\s+longer)/i;

export function fingerprint(text) {
  const norm = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  return crypto.createHash("sha256").update(norm).digest("hex");
}

// readEntry().body includes the metadata comment lines; they are provenance
// noise for similarity and dedupe. Compare prose only.
export function proseOf(text) {
  return String(text || "")
    .split("\n")
    .filter((l) => !/^\s*<!--.*-->\s*$/.test(l))
    .join("\n")
    .trim();
}

// entryText is computed inline in suggest(): each entry's title + body is the
// comparison text, while dedupe compares body against body.

// suggest(text, manual, opts={limit}) -> suggestion report
export function suggest(text, manual, opts = {}) {
  const body = String(text || "").trim();
  if (!body) return { action: "reject", reason: "empty text" };
  if (body.length < MIN_BODY_CHARS) {
    return { action: "reject", reason: `too short (${body.length} < ${MIN_BODY_CHARS} chars)` };
  }

  const live = manual.entries.filter((e) => !e.superseded);
  const items = live.map((e) => {
    const full = readEntry(manual, e.number);
    const body = proseOf(full ? full.body : "");
    return { number: e.number, title: e.title, path: e.path, body, text: `${e.title}\n${body}` };
  });

  // 1) mechanical dedupe: identical normalized body -> drop
  const fp = fingerprint(body);
  for (const it of items) {
    if (fingerprint(it.body) === fp) {
      if (manual.root) logShadow(manual.root, { action: "drop", len: body.length, fp: fp.slice(0, 16), top: [{ n: it.number, s: 1 }] });
      return { action: "drop", reason: `identical to #${it.number} (${it.title})`, top: [] };
    }
  }

  // 2) shape scoring over the live corpus
  const corpus = items.map((it) => it.text);
  const bm = bm25(corpus, body);
  const maxBm = Math.max(...bm, 1e-9);
  const qv = vectorize(body);
  const scored = items
    .map((it, i) => {
      const bmN = bm[i] / maxBm;
      const cosRaw = cosine(vectorize(it.text), qv);
      const cos = cosRaw >= COSINE_FLOOR ? cosRaw : 0;
      return {
        number: it.number,
        title: it.title,
        score: Math.round((bmN * 0.65 + cos * 0.35) * 100) / 100,
        bm25: Math.round(bmN * 100) / 100,
        cosine: Math.round(cos * 100) / 100
      };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, opts.limit || 3);
  const best = top[0];
  const bestItem = best ? items.find((it) => it.number === best.number) : null;
  const conflict =
    !!best &&
    best.score >= BAND_SIMILAR &&
    NEGATION_RE.test(body) !== NEGATION_RE.test(bestItem ? bestItem.text : "");

  let action = "new";
  let band = "不像";
  if (best && best.score >= BAND_MERGE) {
    action = "merge";
    band = "极像";
  } else if (best && best.score >= BAND_SIMILAR) {
    action = "supersede";
    band = "像";
  }
  if (conflict) action = "conflict";

  const hint = {
    merge: best ? `并入 #${best.number}（新内容补进该条，不新开条目）` : "新条",
    supersede: best ? `可能取代 #${best.number}：先确认是不是同一件事的更新版` : "新条",
    conflict: best ? `与 #${best.number} 可能结论相反：人工比对后再决定` : "新条",
    new: "新条：没有足够像的旧条目"
  }[action];

  const rows = top.map((t) => {
    const b = t.score >= BAND_MERGE ? "极像" : t.score >= BAND_SIMILAR ? "像" : "不像";
    const adv =
      t === best
        ? { merge: "merge", supersede: "supersede？", conflict: "冲突？", new: "—" }[action]
        : "参考";
    return `| #${t.number} | ${t.title} | ${t.score.toFixed(2)} | ${b} | ${adv} |`;
  });
  const table = [
    "| 最相似 | 条目 | 分数 | 档位 | 建议 |",
    "|---|---|---|---|---|",
    ...rows
  ].join("\n");

  const shadow = {
    action,
    len: body.length,
    fp: fingerprint(body).slice(0, 16),
    top: top.map((t) => ({ n: t.number, s: t.score }))
  };
  if (manual.root) logShadow(manual.root, shadow);

  return { action, band, conflict, top, hint, table, reason: hint };
}

// Shadow log: one line per suggestion, scores only (no prose). The point is
// to have real decisions to calibrate the 0.45/0.75 bands later instead of
// guessing them again.
function logShadow(root, rec) {
  try {
    const dir = path.join(root, "curate");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "shadow.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
  } catch { /* best effort: never let telemetry break a suggestion */ }
}

// appendToEntry(root, number, text, {date, source}) — the merge write path.
// Appends a dated block to the entry body; the original prose is untouched.
export function appendToEntry(root, number, text, { date, source } = {}) {
  const body = String(text || "").trim();
  if (!body) return { ok: false, reason: "empty text" };
  const manual = loadManual(root);
  const hit = manual.entries.find((e) => e.number === Number(number));
  if (!hit) return { ok: false, reason: `no entry #${number}` };
  if (hit.superseded) return { ok: false, reason: `#${number} is superseded — write a new entry instead` };

  const file = path.join(root, "manual", hit.path);
  let content = fs.readFileSync(file, "utf8");
  const stamp = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const clean = source ? String(source).replace(/--/g, "-").replace(/[\r\n]+/g, " ").trim().slice(0, 240) : "";
  const block = `\n\n---\n\n**合并补充（${stamp}${clean ? " · " + clean : ""}）**\n\n${body}\n`;
  content = content.replace(/\s+$/, "") + block;
  fs.writeFileSync(file, content, "utf8");

  writeManifestRecord(root, hit.path, content);
  logCurate(root, { action: "merge", target: Number(number), bytes: body.length, source: clean });
  return { ok: true, path: hit.path, bytes: Buffer.byteLength(content, "utf8") };
}

// tagEntry(root, number, tags) — 给条目加/替换场景标签（2026-11-03）。
// 标签写在注释块里，和 source/created 同级。已有 tags 行就替换，没有就插在
// confidence 后面。标签参与检索（retrieval.js 的 haystackOf），让"用词不同
// 但场景相同"的查询也能命中。
export function tagEntry(root, number, tags) {
  const list = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [];
  if (!list.length) return { ok: false, reason: "empty tags" };
  const manual = loadManual(root);
  const hit = manual.entries.find((e) => e.number === Number(number));
  if (!hit) return { ok: false, reason: `no entry #${number}` };

  const file = path.join(root, "manual", hit.path);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const tagLine = `<!-- tags: ${list.join(",")} -->`;
  const ti = lines.findIndex((l) => /^<!--\s*tags:/.test(l.trim()));
  if (ti >= 0) {
    lines[ti] = tagLine;
  } else {
    const ci = lines.findIndex((l) => /^<!--\s*confidence:/.test(l.trim()));
    lines.splice(ci >= 0 ? ci + 1 : 1, 0, tagLine);
  }
  const content = lines.join("\n");
  fs.writeFileSync(file, content, "utf8");
  writeManifestRecord(root, hit.path, content);
  logCurate(root, { action: "tag", target: Number(number), tags: list });
  return { ok: true, path: hit.path, tags: list };
}

// retitleEntry(root, number, {title, evidence}) — 只改标题行（2026-11-17）。
// 标题是 memory_list 和检索结果里唯一露出来的部分。正文已经更正、标题还停在旧结论时，
// 下次靠标题召回就会拿错结论（#386「第一嫌疑」就是这样）。memory_rewrite 要求草稿比原文
// 短，改不了这种情况；直接写文件又绕过守卫。所以给它一条正规的小路，且强制留证据。
export function retitleEntry(root, number, { title, evidence } = {}) {
  const clean = String(title || "").replace(/[\r\n]+/g, " ").trim();
  if (!clean) return { ok: false, reason: "title required" };
  if (!evidence || !String(evidence).trim()) {
    return { ok: false, reason: "evidence required: say why the old title no longer matches" };
  }
  const manual = loadManual(root);
  const hit = manual.entries.find((e) => e.number === Number(number));
  if (!hit) return { ok: false, reason: `no entry #${number}` };

  const file = path.join(root, "manual", hit.path);
  const original = fs.readFileSync(file, "utf8");
  const lines = original.split("\n");
  const idx = lines.findIndex((l) => /^#{1,4}\s*\d+[.、]\s*/.test(l));
  if (idx < 0) return { ok: false, reason: "标题行（### N. ...）没找到" };
  const old = lines[idx];
  const prefix = /^(#{1,4}\s*\d+[.、]\s*)/.exec(old)[1];
  lines[idx] = prefix + clean;
  const content = lines.join("\n");

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(root, "backup");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupName = `${hit.path.replace(/[\\/]/g, "-")}.bak-retitle-${ts}`;
  fs.writeFileSync(path.join(backupDir, backupName), original, "utf8");

  fs.writeFileSync(file, content, "utf8");
  writeManifestRecord(root, hit.path, content);
  logCurate(root, {
    action: "retitle", target: Number(number),
    old: old.replace(/^#{1,4}\s*\d+[.、]\s*/, "").slice(0, 120),
    new: clean.slice(0, 120),
    evidence: String(evidence).replace(/[\r\n]+/g, " ").slice(0, 240),
    backup: backupName
  });
  return { ok: true, path: hit.path, title: clean, backup: `backup/${backupName}` };
}

// markLocalJudged / clearLocalJudged — 本地判卷的待复核标记（2026-11-17）。
// 本地模型判过的条目先打标记，等人在 recall 时把内容核对过一遍再摘。标记是纯注释：
// 不进正文、不参与检索，作用只是让读到的人知道"这条还没人复核过"。
// 摘标记这个动作本身就是确认，比一次性信任本地模型稳。
export function markLocalJudged(root, number, { verdict, into = null, date } = {}) {
  const manual = loadManual(root);
  const hit = manual.entries.find((e) => e.number === Number(number));
  if (!hit) return { ok: false, reason: `no entry #${number}` };
  if (!verdict) return { ok: false, reason: "verdict required" };

  const file = path.join(root, "manual", hit.path);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const stamp = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const what = verdict === "merge" && Number.isInteger(into) ? `merge->${into}` : String(verdict);
  const marker = `<!-- 待复核: 本地判卷 ${what} ${stamp} -->`;
  const li = lines.findIndex((l) => /^<!--\s*待复核:/.test(l.trim()));
  if (li >= 0) {
    lines[li] = marker;
  } else {
    const ci = lines.findIndex((l) => /^<!--\s*confidence:/.test(l.trim()));
    lines.splice(ci >= 0 ? ci + 1 : 1, 0, marker);
  }
  const content = lines.join("\n");
  fs.writeFileSync(file, content, "utf8");
  writeManifestRecord(root, hit.path, content);
  logCurate(root, { action: "local-judged", target: Number(number), verdict: what });
  return { ok: true, path: hit.path, marker };
}

export function clearLocalJudged(root, number, { by = "agent", date } = {}) {
  const manual = loadManual(root);
  const hit = manual.entries.find((e) => e.number === Number(number));
  if (!hit) return { ok: false, reason: `no entry #${number}` };

  const file = path.join(root, "manual", hit.path);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const li = lines.findIndex((l) => /^<!--\s*待复核:/.test(l.trim()));
  if (li < 0) return { ok: false, reason: `#${number} 没有待复核标记` };

  const stamp = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  lines.splice(li, 1);
  const ci = lines.findIndex((l) => /^<!--\s*confidence:/.test(l.trim()));
  lines.splice(ci >= 0 ? ci + 1 : 1, 0, `<!-- 已复核: ${stamp} | ${String(by).slice(0, 40)} -->`);
  const content = lines.join("\n");
  fs.writeFileSync(file, content, "utf8");
  writeManifestRecord(root, hit.path, content);
  logCurate(root, { action: "verified", target: Number(number), by: String(by).slice(0, 40) });
  return { ok: true, path: hit.path };
}

// promoteEntry(root, number, {evidence, date}) — candidate -> proven.
// Per rule #71: remove the 候选 marker and set last-used to today.
export function promoteEntry(root, number, { evidence, date } = {}) {
  if (!evidence || !String(evidence).trim()) {
    return { ok: false, reason: "evidence required: say how the entry proved itself" };
  }
  const manual = loadManual(root);
  const hit = manual.entries.find((e) => e.number === Number(number));
  if (!hit) return { ok: false, reason: `no entry #${number}` };

  const file = path.join(root, "manual", hit.path);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const ci = lines.findIndex((l) => /^<!--\s*候选:/.test(l.trim()));
  if (ci < 0) return { ok: false, reason: `#${number} is not a candidate` };

  const stamp = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const clean = String(evidence).replace(/--/g, "-").replace(/[\r\n]+/g, " ").trim().slice(0, 240);
  lines.splice(ci, 1);
  const li = lines.findIndex((l) => /^<!--\s*last-used:/.test(l.trim()));
  if (li >= 0) lines[li] = `<!-- last-used: ${stamp} -->`;
  const k = lines.findIndex((l) => /^<!--\s*confidence:/.test(l.trim()));
  lines.splice(k >= 0 ? k + 1 : 0, 0, `<!-- promoted: ${stamp} | ${clean} -->`);
  const content = lines.join("\n");
  fs.writeFileSync(file, content, "utf8");

  writeManifestRecord(root, hit.path, content);
  logCurate(root, { action: "promote", target: Number(number), evidence: clean });
  return { ok: true, path: hit.path, bytes: Buffer.byteLength(content, "utf8"), promoted: stamp };
}

// rewriteEntry(root, number, {evidence, date}) — promote a distilled draft
// (<n>.md.draft, from tools/distill_entry.mjs) over its entry. This is the
// ONLY sanctioned overwrite path in an append-only system, so it is wrapped
// in refusals: a human must have generated the draft, the original is backed
// up first, the draft must be shorter, and its first line must carry the
// same entry number — a number mismatch is exactly how #130 lost an entry.
export function rewriteEntry(root, number, { evidence, date } = {}) {
  if (!evidence || !String(evidence).trim()) {
    return { ok: false, reason: "evidence required: say what was checked against the original before replacing it" };
  }
  const manual = loadManual(root);
  const hit = manual.entries.find((e) => e.number === Number(number));
  if (!hit) return { ok: false, reason: `no entry #${number}` };
  if (hit.superseded) return { ok: false, reason: `#${number} is superseded — rewriting a retired entry makes no sense` };

  const file = path.join(root, "manual", hit.path);
  const draftPath = file + ".draft";
  if (!fs.existsSync(draftPath)) {
    return { ok: false, reason: `no draft beside ${hit.path} — generate one with tools/distill_entry.mjs first` };
  }

  const content = fs.readFileSync(draftPath, "utf8");
  const original = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(content, "utf8") >= Buffer.byteLength(original, "utf8")) {
    return { ok: false, reason: "draft is not shorter than the entry — rewrite exists for compression, this would only churn the chain" };
  }
  const first = content.split("\n", 1)[0];
  const fm = /^###\s*(\d+)\./.exec(first);
  if (!fm || Number(fm[1]) !== Number(number)) {
    return { ok: false, reason: `draft first line must be "### ${number}. <title>" (got: ${first.slice(0, 60)}) — refusing; #130 lost an entry to a path/number mismatch` };
  }

  const stamp = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(root, "backup");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupName = `${hit.path.replace(/[\\/]/g, "-")}.bak-${ts}`;
  fs.writeFileSync(path.join(backupDir, backupName), original, "utf8");

  fs.writeFileSync(file, content, "utf8");
  writeManifestRecord(root, hit.path, content);
  // The draft is consumed: keeping it would make the recall note claim a
  // short form exists beside an entry that already IS the short form.
  try { fs.rmSync(draftPath); } catch { /* a leftover draft only re-shows the recall note */ }
  logCurate(root, {
    action: "rewrite", target: Number(number),
    evidence: String(evidence).replace(/--/g, "-").replace(/[\r\n]+/g, " ").trim().slice(0, 240),
    backup: backupName, bytes: Buffer.byteLength(content, "utf8"), promoted: stamp
  });
  return { ok: true, path: hit.path, bytes: Buffer.byteLength(content, "utf8"), backup: `backup/${backupName}`, promoted: stamp };
}

// unlinkEntry(root, {number, date, reason}) — revert a link marker.
// Append-only: a link_reverted marker is inserted after the last link
// marker in the head; the reader takes the last marker as current state.
// Prose is never touched.
const LINK_MARKER_RE = /^<!--\s*(superseded_by|superseded-by|merged_into|merged-into|link_reverted)\s*:/;
const NOTE_RE = /^<!--\s*[a-z_-]+_note\s*:/;

export function unlinkEntry(root, { number, date, reason } = {}) {
  if (!reason || !String(reason).trim()) {
    return { ok: false, reason: "reason required: say why the link is reverted" };
  }
  const manual = loadManual(root);
  const hit = manual.entries.find((e) => e.number === Number(number));
  if (!hit) return { ok: false, reason: `no entry #${number}` };
  if (!hit.superseded) return { ok: false, reason: `#${number} is not linked` };

  const file = path.join(root, "manual", hit.path);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const stamp = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const clean = String(reason).replace(/--/g, "-").replace(/[\r\n]+/g, " ").trim().slice(0, 240);
  const marker = `<!-- link_reverted: ${stamp} | ${clean} -->`;

  let anchor = -1;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const t = lines[i].trim();
    if (LINK_MARKER_RE.test(t) || NOTE_RE.test(t)) anchor = i;
  }
  if (anchor < 0) {
    const k = lines.findIndex((l) => /^<!--\s*confidence:/.test(l.trim()));
    anchor = k >= 0 ? k : 0;
  }
  lines.splice(anchor + 1, 0, marker);
  const content = lines.join("\n");
  fs.writeFileSync(file, content, "utf8");

  writeManifestRecord(root, hit.path, content);
  logCurate(root, { action: "unlink", target: Number(number), evidence: clean });
  return { ok: true, path: hit.path, marker, bytes: Buffer.byteLength(content, "utf8") };
}

// demoteEntry(root, {number, date, reason}) — revoke a promotion.
// Append-only: a demoted note plus a fresh 候选 line go to the end of the
// file (the candidate scanner reads the whole body, not just the head).
export function demoteEntry(root, { number, date, reason } = {}) {
  if (!reason || !String(reason).trim()) {
    return { ok: false, reason: "reason required: say why the promotion is revoked" };
  }
  const manual = loadManual(root);
  const hit = manual.entries.find((e) => e.number === Number(number));
  if (!hit) return { ok: false, reason: `no entry #${number}` };

  const file = path.join(root, "manual", hit.path);
  const text = fs.readFileSync(file, "utf8");
  if (/<!--\s*候选:/.test(text)) return { ok: false, reason: `#${number} is already a candidate` };
  const pm = /<!--\s*promoted:\s*(\d{4}-\d{2}-\d{2})/.exec(text);
  if (!pm) return { ok: false, reason: `#${number} has no promotion to revoke` };

  const stamp = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const clean = String(reason).replace(/--/g, "-").replace(/[\r\n]+/g, " ").trim().slice(0, 240);
  const block = `<!-- demoted: ${stamp} | ${clean} | was promoted ${pm[1]} -->\n` +
                `<!-- 候选: ${stamp} | 待验证（demoted） -->`;
  const content = text.replace(/\s*$/, "") + "\n\n" + block + "\n";
  fs.writeFileSync(file, content, "utf8");

  writeManifestRecord(root, hit.path, content);
  logCurate(root, { action: "demote", target: Number(number), evidence: clean });
  return { ok: true, path: hit.path, bytes: Buffer.byteLength(content, "utf8"), demoted: stamp };
}

// candidates(manual, {days}) — read-only: which entries are still candidates,
// and which have outlived the 45-day window (the rule says: ask the user).
// Heat comes from the forgetting engine (stats.json): a candidate that keeps
// being recalled is a candidate that keeps being mentioned.
function readStats(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "stats.json"), "utf8")); } catch { return {}; }
}

export function candidates(manual, { days = 45 } = {}) {
  const out = [];
  const stats = manual.root ? readStats(manual.root) : {};
  for (const e of manual.entries) {
    const full = readEntry(manual, e.number);
    const m = /<!--\s*候选:\s*(\d{4}-\d{2}-\d{2})/.exec(full ? full.body : "");
    if (!m) continue;
    const age = Math.max(0, Math.floor((Date.now() - new Date(`${m[1]}T00:00:00`).getTime()) / 86400000));
    const st = stats[String(e.number)] || null;
    out.push({
      number: e.number,
      title: e.title,
      since: m[1],
      days: age,
      stale: age >= days,
      heat: st ? Math.round((st.count || 0) * 10) / 10 : 0,
      lastUsed: st ? st.lastUsed || null : null
    });
  }
  return out.sort((a, b) => b.heat - a.heat);
}

function writeManifestRecord(root, relPath, content) {
  const manifest = manifestPath(root);
  let m = {};
  if (fs.existsSync(manifest)) {
    try { m = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { m = {}; }
  }
  const rec = m[relPath] || { number: Number((/(\d+)\.md$/.exec(relPath) || [])[1] || 0) };
  rec.sha256 = crypto.createHash("sha256").update(content).digest("hex");
  rec.bytes = Buffer.byteLength(content, "utf8");
  m[relPath] = rec;
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2), "utf8");
}

function logCurate(root, rec) {
  try {
    const dir = path.join(root, "curate");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "history.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
  } catch { /* best effort */ }
}

// markWrongEntry(root, {number, date, reason}) — 标记一条被推翻的结论。
// 和 superseded 不同：superseded 是"有更新版本"，wrong 是"这条本身错了"。
// append-only：在头部插入 wrong 标记，正文不动。检索降权、注入跳过。
export function markWrongEntry(root, { number, date, reason } = {}) {
  if (!reason || !String(reason).trim()) {
    return { ok: false, reason: "reason required: say why this entry is wrong" };
  }
  const manual = loadManual(root);
  const hit = manual.entries.find((e) => e.number === Number(number));
  if (!hit) return { ok: false, reason: `no entry #${number}` };
  if (hit.wrong) return { ok: false, reason: `#${number} is already marked wrong` };

  const file = path.join(root, "manual", hit.path);
  const text = fs.readFileSync(file, "utf8");
  const stamp = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const clean = String(reason).replace(/--/g, "-").replace(/[\r\n]+/g, " ").trim().slice(0, 240);
  const marker = `<!-- wrong: ${stamp} | ${clean} -->`;

  const lines = text.split("\n");
  let at = -1;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (/^<!--\s*confidence:/.test(lines[i].trim())) { at = i + 1; break; }
  }
  if (at < 0) return { ok: false, reason: "entry head has no confidence line to anchor on" };
  lines.splice(at, 0, marker);
  const content = lines.join("\n");
  fs.writeFileSync(file, content, "utf8");

  writeManifestRecord(root, hit.path, content);
  logCurate(root, { action: "wrong", target: Number(number), evidence: clean });
  return { ok: true, path: hit.path, marker, bytes: Buffer.byteLength(content, "utf8") };
}

// linkEntry(root, {target, newNumber, kind, evidence, date}) -> writes ONE marker
// Marker goes into the head window (before half-life) so loadManual sees it.
export function linkEntry(root, { target, newNumber, kind = "superseded_by", evidence = "", date }) {
  const key = String(kind || "").replace(/-/g, "_");
  if (key !== "superseded_by" && key !== "merged_into") {
    return { ok: false, reason: `unknown link kind: ${kind} (superseded_by | merged_into)` };
  }
  const num = Number(target);
  const to = Number(newNumber);
  if (!Number.isInteger(num) || !Number.isInteger(to)) {
    return { ok: false, reason: "target and newNumber must be entry numbers" };
  }
  if (num === to) return { ok: false, reason: "an entry cannot link to itself" };
  if (!evidence || !evidence.trim()) {
    return { ok: false, reason: "evidence required: say why these two are related" };
  }

  const manual = loadManual(root);
  const hit = manual.entries.find((e) => e.number === num);
  if (!hit) return { ok: false, reason: `no entry #${num}` };
  if (hit.superseded) return { ok: false, reason: `#${num} is already linked (superseded)` };
  const targetExists = manual.entries.some((e) => e.number === to);
  if (!targetExists) return { ok: false, reason: `no entry #${to} to link to` };

  const file = path.join(root, "manual", hit.path);
  const text = fs.readFileSync(file, "utf8");
  const stamp = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const clean = String(evidence).replace(/--/g, "-").replace(/[\r\n]+/g, " ").trim().slice(0, 240);
  const marker = `<!-- ${key}: ${to} (${stamp}) -->`;
  const note = `<!-- ${key}_note: ${clean} -->`;

  if (text.includes(marker)) return { ok: false, reason: "marker already present" };

  const lines = text.split("\n");
  let at = -1;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (/^<!--\s*confidence:/.test(lines[i].trim())) { at = i + 1; break; }
  }
  if (at < 0) return { ok: false, reason: "entry head has no confidence line to anchor on" };
  lines.splice(at, 0, marker, note);
  const content = lines.join("\n");

  const stat = fs.statSync(file);
  fs.writeFileSync(file, content, "utf8");

  const manifest = manifestPath(root);
  let m = {};
  if (fs.existsSync(manifest)) {
    try { m = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { m = {}; }
  }
  const rec = m[hit.path] || { number: num };
  rec.sha256 = crypto.createHash("sha256").update(content).digest("hex");
  rec.bytes = Buffer.byteLength(content, "utf8");
  m[hit.path] = rec;
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2), "utf8");

  // audit trail: append-only, one line per link
  try {
    const dir = path.join(root, "curate");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "history.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), action: "link", target: num, newNumber: to, kind: key, evidence: clean }) + "\n",
      "utf8");
  } catch { /* logging is best-effort; the marker is the source of truth */ }

  return {
    ok: true,
    path: hit.path,
    marker,
    note,
    bytes: rec.bytes,
    before: stat.size,
    after: Buffer.byteLength(content, "utf8")
  };
}
