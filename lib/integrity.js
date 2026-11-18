// shannon-anchor — integrity: judge whether an entry is trustworthy BEFORE it
// becomes part of the manual.
//
// Why this exists: the largest attack surface of a memory system is not an
// intruder breaking in. It is a plausible-looking wrong entry that lands in
// the manual and then steers every later decision. The write guard already
// scans for secrets and injection phrasing (guard.js) — that answers "is this
// safe to store". It does not answer "should this be believed".
//
// Borrowed idea: dsh-mnemos ships "poisoning defense". This is an independent
// implementation with the same goal and a deliberately different shape: no
// model, no network, no claims of semantic understanding. It looks for the
// mechanical signatures of a poisoned or unverifiable entry and returns a
// verdict the caller must record. It is a screen, not a judge.
//
// The four signals, cheapest first:
//   1. NO PROVENANCE       source is empty, or names nothing checkable.
//   2. CONTRADICTION       the entry asserts something the manual already
//                          denies, with no supersede marker to justify it.
//   3. OVERREACH           absolute claims ("always", "never", "guaranteed")
//                          with no evidence, which is how a bad rule spreads.
//   4. IMPERSONATION       the body issues instructions to the reader rather
//                          than recording a fact ("you must now...", "ignore...").
//
// Verdicts: "accept" | "review" | "reject". Anything not "accept" is meant to
// be surfaced to the human with the reason attached. This module never writes.

import { tokenize } from "./tokenize.js";

// How much weight each signal carries when summing the risk. Deliberately
// coarse: these are ordering hints, not measurements, and the thresholds below
// are starting points with no backing data. Same honesty as retrieval.js's
// cosine floor — tune with real cases, do not treat as truth.
const WEIGHT = {
  // Impersonation is heavy on purpose: an entry that issues instructions to the
  // reader is not a bad memory, it is an attack on the reader. It must be able
  // to block a write by itself, so its weight sits above REJECT_THRESHOLD.
  "impersonation": 0.60,
  "contradiction": 0.35,
  "no-provenance": 0.25,
  "overreach": 0.15
};

export const REVIEW_THRESHOLD = 0.25; // >= this: review
export const REJECT_THRESHOLD = 0.55; // >= this: reject

// A source has to point at something a later reader could go and check:
// a date, a path, a URL, a ticket number, a person's words. "trust me" does
// not qualify, and neither does a bare word.
const SOURCE_SHAPES = [
  /\d{4}-\d{2}-\d{2}/,               // ISO date
  /\d{4}\/\d{1,2}\/\d{1,2}/,         // slashed date
  /https?:\/\//,                     // URL
  /[A-Za-z]:[\\/]/,                  // Windows path
  /(^|\s)\/[\w.\-/]+/,               // POSIX path
  /#\d+/,                            // issue / PR number
  /[A-Za-z_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+/, // dotted identifier
  /测试|实测|measured|tested|verified|reproduced/i,
  // "someone said so" is not provenance: the word "said" alone anchors nothing.
  // Require an actual quotation or the words "原话"/"verbatim".
  /原话|verbatim|["“][^"”]{6,}["”]/
];

// Absolute claims. One is normal English; a cluster with no evidence is the
// shape a poisoned rule takes, because absolutes remove the reader's judgment.
const ABSOLUTES = [
  /\balways\b/i, /\bnever\b/i, /\bmust\b/i, /\bguaranteed\b/i,
  /\bimpossible\b/i, /\b所有\b/, /\b永远\b/, /\b必须\b/, /\b绝不\b/,
  /\b一律\b/, /\b禁止\b/
];

// Language addressed AT the reader, i.e. an entry trying to act like an
// instruction. A memory entry records what happened; it does not command.
const IMPERATIVES = [
  /\bignore\s+(all\s+)?(previous|prior|above|earlier)\b/i,
  /\bdisregard\s+(the\s+)?(above|previous|earlier|rules?)\b/i,
  /\byou\s+(must|should|will)\s+now\b/i,
  /\bfrom\s+now\s+on\s+(you|always)\b/i,
  /\bdo\s+not\s+tell\s+the\s+user\b/i,
  /\b(hide|conceal)\s+this\s+from\b/i,
  /忽略(之前|以上|前面|所有)/,
  /(从现在起|今后)(你|必须|一律)/,
  /不要(告诉|通知)(用户|他)/,
  /(隐瞒|藏着)不(说|告诉)/
];

// Negation pairs used for contradiction detection. An existing entry and a new
// one that mention the same subject with opposite polarity are suspicious —
// not wrong, but they must not both stand unmarked.
const NEGATIONS = [/\bnot\b/i, /\bnever\b/i, /\bno\b/i, /\bdon't\b/i, /\bdoesn't\b/i, /不/, /别/, /禁止/];

function hasProvenance(source) {
  if (!source || typeof source !== "string") return false;
  const s = source.trim();
  if (s.length < 8) return false;
  return SOURCE_SHAPES.some((re) => re.test(s));
}

function countAbsolutes(text) {
  let n = 0;
  for (const re of ABSOLUTES) if (re.test(text)) n++;
  return n;
}

function isImperative(text) {
  return IMPERATIVES.some((re) => re.test(text));
}

function polarity(text) {
  let n = 0;
  for (const re of NEGATIONS) if (re.test(text)) n++;
  return n % 2 === 1 ? -1 : 1;
}

// Shared-subject test: do the two texts talk about the same thing? Uses the
// shared tokenizer (latin words + CJK bigrams) so this works in both languages.
function subjectOverlap(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of tb) if (ta.has(t)) hit++;
  return hit / tb.size;
}

// checkIntegrity(candidate, opts) -> verdict object.
//   candidate: { title, body, source }
//   opts.entries: the existing manual entries to test contradiction against
//   opts.similarity: overlap above which two entries count as same-subject
//   opts.thresholds: { review, reject } overrides
//
// Pure: no fs, no host. Callers supply the manual.
export function checkIntegrity(candidate, opts = {}) {
  const title = String(candidate?.title || "");
  const body = String(candidate?.body || "");
  const source = String(candidate?.source || "");
  const text = `${title}\n${body}`;
  const entries = Array.isArray(opts.entries) ? opts.entries : [];
  const similarity = opts.similarity ?? 0.55;
  const review = opts.thresholds?.review ?? REVIEW_THRESHOLD;
  const reject = opts.thresholds?.reject ?? REJECT_THRESHOLD;

  const signals = [];
  let risk = 0;

  // 1. provenance
  if (!hasProvenance(source)) {
    signals.push({
      kind: "no-provenance",
      weight: WEIGHT["no-provenance"],
      detail: source.trim()
        ? "the source names nothing a later reader could check (no date, path, URL, ticket, or quoted words)"
        : "no source given"
    });
    risk += WEIGHT["no-provenance"];
  }

  // 2. contradiction against the existing manual
  // Only same-subject entries can contradict. Two entries on unrelated topics
  // sharing the word "not" is noise, and treating it as conflict would make
  // every write scream.
  let worst = null;
  for (const e of entries) {
    const other = `${e.title || ""} ${e.body || ""}`;
    const ov = subjectOverlap(text, other);
    if (ov < similarity) continue;
    if (polarity(text) === polarity(other)) continue;
    // An entry that already carries a supersede marker is EXPECTED to disagree;
    // that is the mechanism working, not a poison signal.
    if (e.superseded) continue;
    if (!worst || ov > worst.overlap) worst = { entry: e, overlap: ov };
  }
  if (worst) {
    signals.push({
      kind: "contradiction",
      weight: WEIGHT.contradiction,
      detail: `disagrees with entry #${worst.entry.number} (${Math.round(worst.overlap * 100)}% subject overlap, opposite polarity) and neither carries a supersede marker`
    });
    risk += WEIGHT.contradiction;
  }

  // 3. overreach
  const absolutes = countAbsolutes(text);
  if (absolutes >= 2 && !hasProvenance(source)) {
    signals.push({
      kind: "overreach",
      weight: WEIGHT.overreach,
      detail: `${absolutes} absolute claims with no checkable evidence — the shape a bad rule takes`
    });
    risk += WEIGHT.overreach;
  }

  // 4. impersonation
  if (isImperative(text)) {
    signals.push({
      kind: "impersonation",
      weight: WEIGHT.impersonation,
      detail: "the entry addresses the reader as an instruction instead of recording what happened"
    });
    risk += WEIGHT.impersonation;
  }

  risk = Math.min(1, risk);
  const verdict = risk >= reject ? "reject" : risk >= review ? "review" : "accept";

  return {
    verdict,
    risk: Number(risk.toFixed(3)),
    signals,
    // A caller that wants to explain the decision to the user can use this
    // verbatim. Never let a silent rejection happen: the reason is the product.
    reason: signals.length === 0
      ? "no poisoning signals"
      : signals.map((s) => `${s.kind}: ${s.detail}`).join("; ")
  };
}

// Convenience for the tool layer: should this write be blocked outright?
export function blocksWrite(result) {
  return result && result.verdict === "reject";
}

// Convenience for the tool layer: does this write need the human to look?
export function needsReview(result) {
  return result && result.verdict === "review";
}
