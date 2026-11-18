
// shannon-anchor - judge layer: System-One-style decisions, local, no LLM.
//
// Pattern borrowed from TypeSafe Jev (System One model: noul / choice /
// score, no text generation) - the SHAPE, not the API. No key, no network,
// no external dependency: our own rules say memory must not depend on an
// outside service. The default backend is pure heuristics; the interface
// is fixed so a real small model can be swapped in later without callers.

import { tokenize as toksSet } from "./tokenize.js";

// primitives (the three question types)
export function noul(instructions, opts = {}) {
  return { type: "noul", instructions, ...opts };
}
export function choice(instructions, criteria, opts = {}) {
  return { type: "choice", instructions, criteria, ...opts };
}
export function score(instructions, rubric, opts = {}) {
  return { type: "score", instructions, rubric, ...opts };
}

// ---- local heuristic backend ----
// Deliberately dumb and inspectable: a first-pass screen that pulls out
// the obviously-worthless and the obviously-worthwhile, and calls
// everything in between "undecided". It does NOT try to be smart.
const RECUR_MARKERS = [
  "以后", "下次", "再也不", "别再", "别再犯", "踩过", "踩坑", "坑",
  "教训", "记住", "别忘", "以后要", "same mistake", "next time",
  "won't again", "lesson", "remember", "again"
];
const CONCRETE_MARKERS = [
  /[A-Za-z]:\\/, /\d+\.\d+\.\d+/, /`[^`]+`/, /```/, /\bmemory_\w+/,
  /--[a-z-]+/, /\u6307\u4ee4\s*\d/, /exit\s*[=＝]\s*\d/
];
const NOISE_MARKERS = ["你好", "谢谢", "哈哈", "晚安", "在吗", "ok", "嗯"];

function countHits(text, arr) {
  let n = 0;
  for (const m of arr) {
    if (typeof m === "string") { if (text.includes(m)) n++; }
    else if (m.test(text)) n++;
  }
  return n;
}

// 0..1 how "worth keeping" a piece of text looks
function worthness(text) {
  if (!text || !text.trim()) return 0;
  const t = text.trim();
  if (t.length < 12) return 0;
  const recur = countHits(t, RECUR_MARKERS);
  const concrete = countHits(t, CONCRETE_MARKERS);
  const noise = countHits(t.slice(0, 60), NOISE_MARKERS);
  if (noise > 0 && recur === 0 && concrete === 0) return 0.05;
  let s = 0.15;
  s += Math.min(recur, 3) * 0.18;
  s += Math.min(concrete, 3) * 0.12;
  if (t.length > 200) s += 0.08;
  return Math.max(0, Math.min(1, s));
}

// ---- the judge entry ----
// confidence floor: below this everything is "undecided". Configurable.
export const DEFAULT_CONFIDENCE_FLOOR = 0.5;

export function judge(state, questions, opts = {}) {
  const floor = opts.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const answers = {};
  for (const [key, q] of Object.entries(questions || {})) {
    answers[key] = judgeOne(state, q, floor);
  }
  return { answers };
}

function judgeOne(state, q, floor) {
  if (!q || !q.type) return { undecided: true, reason: "bad question" };
  if (q.type === "noul") return judgeNoul(state, q, floor);
  if (q.type === "choice") return judgeChoice(state, q, floor);
  if (q.type === "score") return judgeScore(state, q, floor);
  return { undecided: true, reason: "unknown question type" };
}

function judgeNoul(state, q, floor) {
  const w = worthness(state);
  const confidence = Math.abs(w - 0.5) * 2;
  if (confidence < floor) {
    return { noul: w, prob: w, confidence, undecided: true,
             reason: "low confidence - grey zone, route upward" };
  }
  return { noul: w > 0.5 ? 1 : 0, prob: w, confidence, undecided: false };
}

function judgeChoice(state, q, floor) {
  const criteria = q.criteria || {};
  const keys = Object.keys(criteria);
  if (keys.length === 0) return { undecided: true, reason: "no options" };
  let best = null, bestScore = 0;
  for (const k of keys) {
    const sc = overlapScore(state, String(criteria[k]));
    if (sc > bestScore) { bestScore = sc; best = k; }
  }
  if (best === null || bestScore <= 0) {
    return { choice: null, prob: 0, confidence: 0, undecided: true,
             reason: "no option matched" };
  }
  const confidence = bestScore;
  if (confidence < floor) {
    return { choice: best, prob: bestScore, confidence, undecided: true,
             reason: "low confidence match" };
  }
  return { choice: best, prob: bestScore, confidence, undecided: false };
}

function judgeScore(state, q, floor) {
  const rubric = q.rubric || [];
  if (rubric.length === 0) return { undecided: true, reason: "empty rubric" };
  const w = worthness(state);
  const idx = Math.min(rubric.length - 1, Math.floor(w * rubric.length));
  const confidence = Math.abs(w - 0.5) * 2;
  if (confidence < floor) {
    return { score: idx, prob: w, confidence, undecided: true };
  }
  return { score: idx, prob: w, confidence, undecided: false };
}

function overlapScore(state, desc) {
  const a = toksSet(state);
  const b = toksSet(desc);
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const t of b) if (a.has(t)) hit++;
  return hit / b.size;
}

// ---- the call site our system actually uses ----
// verdict: "record" | "discard" | "undecided".
// "undecided" goes to the pending zone, NEVER straight into memory.
export function judgeWorthRecording(summary, opts) {
  const r = judge(summary, {
    worth: noul("This lesson would save the future me from repeating a mistake")
  }, opts);
  const a = r.answers.worth;
  if (a.undecided) return { verdict: "undecided", prob: a.prob, confidence: a.confidence };
  return { verdict: a.noul === 1 ? "record" : "discard", prob: a.prob, confidence: a.confidence };
}
