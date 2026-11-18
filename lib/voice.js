// shannon-anchor — voice: the case library for HOW 助手 talks.
//
// Why this is not a manual section: the manual holds propositions ("备份怎么验"),
// this holds sentences ("这句为什么不像人"). A rule abstracted out of its example
// is exactly the rule that stops working — you can recite 「别说套话」 and still
// write 套话. So every record here stays concrete: 原话 / 哪不对 / 人怎么说.
//
// Two writers, one gate:
//   capture — a user message that reads like a correction is paired with the
//             assistant line it reacts to and queued in voice/pending.jsonl.
//             Deliberately dumb and conservative: a false positive costs one
//             prompt line, a missed one costs a lesson.
//   judge   — the agent confirms or drops it (voice_case). Nothing is promoted
//             automatically: a correction the model did not understand is not a
//             lesson yet, it is a pending item.
//
// Files, under <manualRoot>/voice/:
//   pending.jsonl  candidates (scratch; bounded, oldest evicted)
//   cases.jsonl    append-only record; a recurrence is an extra date line, never
//                  an edit, so "同一毛病不写第二遍" is structural
//   案例库.md      rendered digest, newest first, hard-capped at maxLines — the
//                  cap is on the VIEW; a case pushed out of the view is still in
//                  the record
//
// The jsonl is the source of truth; the md is derived and can be regenerated.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { messageText, stripInjection } from "./predict.js";
import { scanContent } from "./guard.js";

export const DEFAULT_MAX_LINES = 60;
export const DEFAULT_MAX_PENDING = 8;

// Generous: the prompt clips for display, the case keeps the sentence.
const MAX_TEXT = 1200;
const MAX_VIEW_LINE = 160;

// Named patterns: the stored signal says WHICH rule fired, so a false positive
// can be traced to a pattern instead of blamed on "the capture".
const STRONG = [
  ["别再说", /(别|不要)(再)?说|少说两句/],
  ["不是这个意思", /(不是这(个|么)意思|我没(有)?让你|谁让你)/],
  ["换说法", /(说人话|换(个|种)说法|重新(说|讲)|再说一遍|说清楚(点|些)?|直接(说|给|讲))/],
  ["套话", /(太(机械|假|官方|生硬)|套话|人机味|AI\s?[味腔]|不像人(话)?|降智)/],
  ["播报流程", /(播报|念流程|念步骤|讲重点|说重点)/],
  ["废话", /(废话(太|真)多|又(说|写)了?(一堆|一大段|这么多))/],
  ["格式", /(别|不要|少)(用|加|整)?(加粗|破折号|表格|金句|排比|感叹号)/],
  ["你刚才", /你刚才(说|讲|写|回)/],
  ["english", /\b(not what i (said|meant)|stop saying|don'?t say|sound(s|ed)? like an ai|too robotic|that'?s wrong)\b/i]
];

// A bare 不对 is a coin flip ("这样不对吗？"), so weak signals need a short,
// non-question message to count.
const WEAK = [
  ["不对", /(不对|错了|不合适|不准确|有点假)/]
];

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sha(s) { return crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex"); }

// Punctuation and spacing differ between a repeat and the original; the words
// do not. That is the unit a recurrence is judged on.
function norm(s) {
  return String(s || "").replace(/[\s，。！？、,.!?~～…—\-「」『』"'“”‘’()（）:：;；]/g, "");
}

function triggerHash(s) { return sha(norm(s)).slice(0, 12); }

function clip(s, n) {
  s = String(s || "");
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function oneLine(s, n) { return clip(String(s || "").replace(/\s+/g, " ").trim(), n); }

export function voiceDir(root) { return path.join(root, "voice"); }
export function pendingPath(root) { return path.join(voiceDir(root), "pending.jsonl"); }
export function casesPath(root) { return path.join(voiceDir(root), "cases.jsonl"); }
export function libraryPath(root) { return path.join(voiceDir(root), "案例库.md"); }

function readJsonl(p) {
  let raw = "";
  try { raw = fs.readFileSync(p, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* one torn line must not hide the rest */ }
  }
  return out;
}

function appendJsonl(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + "\n", "utf8");
}

// A workspace-instruction dump, a trigger line, or a pasted document is not a
// correction. Without this gate the AGENTS.md block ("不要播报…") is captured on
// every fresh session.
function looksInjected(t) {
  if (t.length > 2000) return true;
  if (t.split("\n").length > 12) return true;
  return /^<|^按指令\s*\d|Instructions from:|Current runtime context|Current working directory:|^#\s/.test(t);
}

export function looksLikeCorrection(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  for (const [name, re] of STRONG) {
    if (t.length <= 400 && re.test(t)) return { strength: "strong", signal: name };
  }
  if (t.length < 4 || t.length > 80) return null;
  if (/[?？]\s*$|(吗|呢|吧)\s*$/.test(t)) return null;
  for (const [name, re] of WEAK) {
    if (re.test(t)) return { strength: "weak", signal: name };
  }
  return null;
}

function isUser(m) { return m && typeof m === "object" && (m.role === "user" || m.role === undefined); }
function isAssistant(m) { return m && typeof m === "object" && m.role === "assistant"; }

// The correction and the line it is reacting to. Tool results and system text
// are not the user's voice; the nearest assistant prose before the user message
// is what was actually said.
//
// Host machinery rides along inside user-role messages (runtime-context
// snapshots, skill catalogs, checkpoints). looksInjected() only fences the
// obvious cases by shape; a short real correction with a snapshot appended
// underneath passes that fence and would be stored as the case's 原话 with the
// snapshot inside. Stripping is the same function prediction uses, so a stored
// case and a predicted query see the same text.
export function pairFromMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  let u = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUser(messages[i])) { u = i; break; }
  }
  if (u < 0) return null;
  const userText = stripInjection(messageText(messages[u])).trim();
  if (!userText) return null;
  let assistantText = "";
  for (let i = u - 1; i >= 0; i--) {
    if (!isAssistant(messages[i])) continue;
    const t = stripInjection(messageText(messages[i])).trim();
    if (t) { assistantText = t; break; }
  }
  return { userText, assistantText };
}

import { appendEvicted, appendObserve, clip as clipLine, ageDays } from "./eviction.js";
import { reserve, commit, markDone, markExpiredUnreviewed, readQueue, OUTSTANDING } from "./queue.js";

export function listPending(root) {
  return readQueue(root, "voice").filter((x) => x && x.id && OUTSTANDING.has(x.status));
}

export function readCases(root) {
  return readJsonl(casesPath(root)).filter((x) => x && (x.id || x.recurrenceOf));
}

function appendRecurrence(root, base, { note } = {}) {
  const day = today();
  const already = readCases(root).some((c) => c.recurrenceOf === base.id && c.created === day);
  if (already) return { id: base.id, created: day, duplicate: true };
  appendJsonl(casesPath(root), {
    recurrenceOf: base.id,
    created: day,
    at: new Date().toISOString(),
    note: clip(String(note || "").trim(), 200)
  });
  return { id: base.id, created: day };
}

// captureFromMessages(root, messages, opts) -> what happened. Never throws on
// an unexpected message shape: pairFromMessages degrades to null.
export function captureFromMessages(root, messages, opts = {}) {
  const pair = pairFromMessages(messages);
  if (!pair) return { captured: false, reason: "no user message" };
  if (looksInjected(pair.userText)) return { captured: false, reason: "injected/system text" };
  const hit = looksLikeCorrection(pair.userText);
  if (!hit) return { captured: false, reason: "not a correction" };

  const user = clip(pair.userText.trim(), MAX_TEXT);
  const assistant = clip(pair.assistantText.trim(), MAX_TEXT);
  const scanned = scanContent(`${user}\n${assistant}`);
  if (scanned.blocked) return { captured: false, reason: `guard: ${scanned.reason}` };

  const trigger = triggerHash(user);
  const cases = readCases(root);
  const same = cases.find((c) => !c.recurrenceOf && c.trigger === trigger);
  if (same) {
    // The same correction again is the most valuable signal there is: the
    // lesson did not stick. Record the date; do not open a second case.
    const rec = appendRecurrence(root, same, { note: "" });
    try { renderLibrary(root, { maxLines: opts.maxLines }); } catch { /* the digest is derived */ }
    return { captured: true, recurrence: true, id: same.id, caseId: same.id, duplicateDay: rec.duplicate === true };
  }

  const pending = listPending(root);
  const already = pending.find((p) => p.trigger === trigger);
  if (already) return { captured: false, reason: "already pending", id: already.id };

  const maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
  const item = {
    id: `p-${trigger.slice(0, 8)}`,
    at: new Date().toISOString(),
    created: today(),
    signal: hit.signal,
    strength: hit.strength,
    trigger,
    user,
    assistant
  };
  // Phase 4: a full queue rejects the new candidate instead of evicting an
  // older one. The user's confirm/drop flow is unchanged.
  const slot = reserve(root, "voice", { ...item, queue_id: item.id }, { max: maxPending });
  if (!slot.ok) {
    return { captured: false, reason: "QUEUE_FULL", outstanding: slot.outstanding, max: slot.max };
  }
  if (slot.duplicate) return { captured: false, reason: "already pending", id: item.id };
  commit(root, "voice", slot.queue_id);
  return { captured: true, item, id: item.id };
}

function nextCaseId(cases) {
  let max = 0;
  for (const c of cases) {
    const m = /^v(\d+)$/.exec(String(c.id || ""));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `v${max + 1}`;
}

export function addCase(root, { original, what, human = "", source, created, trigger, maxLines } = {}) {
  const o = String(original || "").trim();
  const w = String(what || "").trim();
  if (!o || !w) return { ok: false, error: "original and what are required" };
  const scanned = scanContent(`${o}\n${w}\n${human}`);
  if (scanned.blocked) return { ok: false, error: `guard: ${scanned.reason}` };

  const cases = readCases(root);
  const triggerH = trigger || triggerHash(`${o}\n${w}`);
  const same = cases.find((c) => !c.recurrenceOf && c.trigger === triggerH);
  if (same) {
    const rec = appendRecurrence(root, same, { note: "" });
    const view = renderLibrary(root, { maxLines });
    return { ok: true, recurrence: true, id: same.id, created: rec.created, lines: view.lines, path: view.path };
  }

  const item = {
    id: nextCaseId(cases),
    created: created || today(),
    at: new Date().toISOString(),
    source: String(source || "").trim() || "(self-caught)",
    original: clip(o, MAX_TEXT),
    what: clip(w, MAX_TEXT),
    human: clip(String(human || "").trim(), MAX_TEXT),
    trigger: triggerH
  };
  appendJsonl(casesPath(root), item);
  const view = renderLibrary(root, { maxLines });
  return { ok: true, case: item, id: item.id, lines: view.lines, path: view.path };
}

export function confirmPending(root, id, { what, human = "", source, sameAs, maxLines } = {}) {
  const pending = listPending(root);
  const item = pending.find((p) => p.id === id);
  if (!item) return { ok: false, error: `no pending ${id}; voice_case action=list shows what exists` };
  const w = String(what || "").trim();
  if (!w) return { ok: false, error: "what required: 说清楚这句哪儿不对，具体到用词/结构/立场，不写感想" };

  const cases = readCases(root);
  const target = sameAs || (cases.find((c) => !c.recurrenceOf && c.trigger === item.trigger) || {}).id || null;
  let result;
  if (target) {
    const base = cases.find((c) => c.id === target && !c.recurrenceOf);
    if (!base) return { ok: false, error: `no case ${target}` };
    const rec = appendRecurrence(root, base, { note: "" });
    const view = renderLibrary(root, { maxLines });
    result = { ok: true, recurrence: true, id: base.id, created: rec.created, lines: view.lines, path: view.path };
  } else {
    result = addCase(root, {
      original: item.assistant || item.user,
      what: w,
      human,
      source: source || `voice capture ${item.id}`,
      trigger: item.trigger,
      maxLines
    });
    if (!result.ok) return result;
  }
  markDone(root, "voice", item.queue_id);
  return { ...result, from: item.id };
}

export function dropPending(root, id, reason) {
  const pending = listPending(root);
  const item = pending.find((p) => p.id === id);
  if (!item) return { ok: false, error: `no pending ${id}` };
  markDone(root, "voice", item.queue_id);
  if (reason && String(reason).trim()) {
    appendJsonl(path.join(voiceDir(root), "dropped.jsonl"), {
      id,
      at: new Date().toISOString(),
      created: today(),
      signal: item.signal,
      reason: clip(String(reason).trim(), 300)
    });
  }
  return { ok: true, id };
}

// expirePending: a candidate older than the window stops being a question and
// becomes an archive row. Idempotent — a second sweep finds nothing past the
// cutoff. Expiry is a time judgment, not a capacity limit, so observe mode can
// defer it at no cost: nothing is removed, and the queue is already bounded.
export function expirePending(root, now = Date.now(), opts = {}) {
  const days = Number(opts.expireDays ?? 3);
  if (!(days > 0)) return { expired: [], observed: 0 };
  const cutoff = now - days * 86400e3;
  const pending = listPending(root);
  const old = pending.filter((p) => {
    if (p.status !== "pending") return false;
    const t = Date.parse(p.at || "");
    return Number.isFinite(t) && t < cutoff;
  });
  if (!old.length) return { expired: [], observed: 0 };
  if (opts.observe === true) {
    for (const p of old) {
      appendObserve(root, {
        what: "expire-voice",
        target: p.id,
        wouldHave: "drop",
        reason: "expired",
        ageDays: ageDays(p.at, now)
      });
    }
    return { expired: [], observed: old.length };
  }
  for (const p of old) {
    markExpiredUnreviewed(root, "voice", p.queue_id);
  }
  for (const p of old) {
    // Same shape as a manual drop, with reason "expired", so dropped.jsonl stays
    // one ledger with one schema rather than two that drift apart.
    appendJsonl(path.join(voiceDir(root), "dropped.jsonl"), {
      id: p.id,
      at: new Date(now).toISOString(),
      created: p.created ?? today(),
      signal: p.signal,
      reason: "expired"
    });
    appendEvicted(root, "voice", {
      id: p.id,
      reason: "expired",
      signal: p.signal ?? null,
      ageDays: ageDays(p.at, now),
      preview: clipLine(p.user)
    });
  }
  return { expired: old.map((p) => p.id), observed: 0 };
}

export function listCases(root, opts = {}) {
  const all = readCases(root);
  const recs = all.filter((c) => c.recurrenceOf);
  const out = all
    .filter((c) => !c.recurrenceOf)
    .map((c) => ({ ...c, recurrences: recs.filter((r) => r.recurrenceOf === c.id).map((r) => r.created) }));
  out.reverse();
  const limit = opts.limit ?? 20;
  return out.slice(0, limit);
}

function renderBlock(c) {
  const rec = (c.recurrences || []).slice(-3);
  const tail = rec.length ? ` · 复发 ${rec.map((d) => d.slice(5)).join(" ")}` : "";
  return [
    `### ${c.id} · ${c.created}${tail}`,
    `原话：${clip(String(c.original || "").replace(/\s+/g, " ").trim(), MAX_VIEW_LINE)}`,
    `哪不对：${clip(String(c.what || "").replace(/\s+/g, " ").trim(), MAX_VIEW_LINE)}`,
    `人怎么说：${c.human ? clip(String(c.human).replace(/\s+/g, " ").trim(), MAX_VIEW_LINE) : "（还没找到更好的说法）"}`,
    ""
  ];
}

// The digest is newest-first and budgeted. Old cases falling out of the view is
// the intended behaviour: the cap exists so the reader keeps reading, and the
// record keeps everything.
export function renderLibrary(root, opts = {}) {
  const maxLines = Math.max(12, Number(opts.maxLines) || DEFAULT_MAX_LINES);
  const header = [
    "# 语感案例库（shannon-anchor 生成）",
    "",
    "> 正本：voice/cases.jsonl（只增不改）。这里是最近若干条的摘要；超出行数时旧的只留在正本里。",
    "> 一条三行：原话 / 哪不对 / 人怎么说。同一毛病复发只在标题补日期，不另开一条。",
    ""
  ];
  const all = readCases(root);
  const recs = all.filter((c) => c.recurrenceOf);
  const cases = all
    .filter((c) => !c.recurrenceOf)
    .map((c) => ({ ...c, recurrences: recs.filter((r) => r.recurrenceOf === c.id).map((r) => r.created) }))
    .reverse();

  const budget = maxLines - header.length;
  const blocks = [];
  let used = 0;
  let shown = 0;
  for (const c of cases) {
    const block = renderBlock(c);
    if (used + block.length > budget) break;
    blocks.push(...block);
    used += block.length;
    shown++;
  }
  while (blocks.length && blocks[blocks.length - 1] === "") blocks.pop();
  const text = [...header, ...blocks].join("\n") + "\n";
  const p = libraryPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
  return { path: p, lines: text.split("\n").length - 1, shown, total: cases.length };
}

// The end-of-turn nudge. Only fresh pending items are surfaced: an item older
// than a day stays in the queue for action=list but stops costing prompt space,
// because a permanent nag trains the reader to skip the section.
export function voicePrompt(root, opts = {}) {
  const max = opts.max ?? 2;
  const maxAge = (opts.maxAgeHours ?? 24) * 3600e3;
  const now = Date.now();
  const fresh = listPending(root).filter((p) => {
    const t = Date.parse(p.at || "");
    return Number.isFinite(t) && now - t <= maxAge;
  });
  // Cases confirmed in the last day stay in front of the reader for a while:
  // one viewing is not enough to change a sentence habit.
  const recent = listCases(root, { limit: 20 }).filter((c) => {
    const t = Date.parse(c.at || "");
    return Number.isFinite(t) && now - t <= maxAge;
  }).slice(0, 2);

  if (!fresh.length && !recent.length) return "";

  const lines = [];
  if (fresh.length) {
    lines.push(`shannon-anchor 语感：${fresh.length} 条疑似纠正等着判。`);
    for (const p of fresh.slice(-max)) {
      const said = oneLine(p.user, 100);
      const mine = oneLine(p.assistant, 100);
      lines.push(`- ${p.id}｜你说「${said}」${mine ? `｜我当时说「${mine}」` : ""}`);
    }
    lines.push("是「话怎么说」的案例 → voice_case action=confirm id=<id> what=<哪不对> human=<人怎么说>；不是 → voice_case action=drop id=<id>。别为凑数写。");
  }
  if (recent.length) {
    lines.push("刚记下的语感案例（说话时对照，不要背）：");
    for (const c of recent) {
      lines.push(`- ${c.id}｜原话「${oneLine(c.original, 80)}」｜哪不对：${oneLine(c.what, 100)}${c.human ? `｜人怎么说：${oneLine(c.human, 80)}` : ""}`);
    }
  }
  return lines.join("\n");
}
