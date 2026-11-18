
// shannon-anchor — distill engine: automatic accumulation.
//
// The pipe (see docs/USAGE.md):
//   turn-stopping -> debounce queue -> LLM distills the turn -> criteria
//   funnel (mechanical gate + judge) -> batch N rollouts -> strict
//   validate -> merge -> guarded write into the manual.
//
// Two couplings are injected, not imported:
//   - the LLM call comes from the host (DSH llm service); we take a
//     summarize(text) -> Promise<string> function.
//   - everything else is pure and unit-testable.
//
// The funnel is what makes this ours, not dsh-memory's: theirs pours
// every turn into memory with no sieve. Ours asks "would the future me
// re-trip this pit?" and only passing ones reach the manual.
//
// Failure posture: distillation never blocks a turn. Model unavailable,
// timeout, garbage output — skipped with one warning, tools unaffected.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { scanContent } from "./guard.js";
import { judgeWorthRecording } from "./judge.js";
import { messageText, stripInjection } from "./predict.js";

export function rolloutsDir(root) { return path.join(root, "distill", "rollouts"); }
export function rejectLogPath(root) { return path.join(root, "distill", "rejected.jsonl"); }

function sha(s) { return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12); }
function nowIso() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); }

// ---- mode=turn: end-of-turn distillation without an LLM handle ----
// The host emits agent/turn-stopping with { turn, signal } — turn is a
// NUMBER, not the transcript. So the queue records the turn id, never
// assuming text exists; the content is the agent's own context on the next
// turn. A caller that does have text may pass it (preview + hash for dedupe).
import { appendEvicted, appendObserve, clip as clipLine } from "./eviction.js";
import { reserve, commit, markDone, markExpiredUnreviewed, readQueue, OUTSTANDING } from "./queue.js";

export function queuePath(root) { return path.join(root, "distill", "pending.jsonl"); }

// A bare turn number is unreadable in `memory_distill status`. The preview is
// a label, not the record: the transcript is still the agent's own context on
// the next turn. Only the latest user request and the assistant text that
// follows it are kept; tool output is deliberately excluded (it says what was
// run, not what was asked or concluded).
const PREVIEW_MAX = 900;
const PREVIEW_USER_MAX = 320;

function oneLine(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

export function turnPreview(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const max = opts.maxChars ?? PREVIEW_MAX;
  const userMax = opts.maxUserChars ?? PREVIEW_USER_MAX;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    if (m.role !== "user" && m.role !== undefined) continue;
    if (oneLine(stripInjection(messageText(m)))) { lastUser = i; break; }
  }
  if (lastUser === -1) {
    // Compaction can remove every user message and leave tool output last.
    // Fall back to the newest non-tool/system message so the label is not blank.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || typeof m !== "object") continue;
      if (m.role === "tool" || m.role === "system") continue;
      if (oneLine(stripInjection(messageText(m)))) { lastUser = i; break; }
    }
  }
  const start = lastUser === -1 ? Math.max(0, messages.length - 1) : lastUser;
  let user = "";
  const assistant = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    if (m.role === "tool" || m.role === "system") continue;
    const t = oneLine(stripInjection(messageText(m)));
    if (!t) continue;
    if (m.role === "assistant") assistant.push(t);
    else if (!user) user = t;
  }
  const userPart = user ? `用户：${user.slice(0, userMax)}` : "";
  const assistantText = assistant.join(" ").trim();
  const budget = Math.max(0, max - userPart.length - (userPart && assistantText ? 2 : 0));
  const assistantPart = assistantText && budget > 0 ? `助手：${assistantText.slice(0, budget)}` : "";
  return [userPart, assistantPart].filter(Boolean).join("\n\n").slice(0, max);
}

export function pendingTurns(root) {
  return readQueue(root, "distill").filter((x) => OUTSTANDING.has(x.status));
}

export function queueTurn(root, payload = {}, opts = {}) {
  // Accept the old (text, opts) shape and the new ({text, turn}, opts) shape.
  const p0 = typeof payload === "string" ? { text: payload } : (payload || {});
  const t = String(p0.text ?? "").trim();
  const turnNo = p0.turn ?? null;
  // The length floor guards legacy text-only calls, where the text IS the
  // transcript. With a turn number the text is only a preview label, so a
  // short one must still queue — an unreadable nudge beats a missing turn.
  if (t && (turnNo === null || turnNo === undefined) && t.length < (opts.minChars ?? 80)) {
    return { queued: false, reason: "turn too short to hold a lesson" };
  }
  const rec = {
    ts: new Date().toISOString(),
    turn: turnNo,
    chars: t.length,
    preview: t.slice(0, opts.maxPreview ?? 240),
    hash: t ? sha(t) : null
  };
  const items = pendingTurns(root);
  const last = items.length ? items[items.length - 1] : null;
  if (last && ((rec.hash && last.hash === rec.hash) || (turnNo !== null && last.turn === turnNo))) {
    return { queued: false, reason: "this turn is already queued" };
  }
  const max = opts.maxPending ?? 20;
  // Phase 4: optional post-processing. A full queue returns
  // NOT_SCHEDULED_OPTIONAL — no task is created, no hidden backlog.
  const slot = reserve(root, "distill", {
    ...rec,
    queue_id: rec.hash || `q-distill-${Date.now().toString(36)}`
  }, { max });
  if (!slot.ok) {
    return { queued: false, reason: "NOT_SCHEDULED_OPTIONAL", outstanding: slot.outstanding, max: slot.max };
  }
  if (slot.duplicate) return { queued: false, reason: "this turn is already queued" };
  commit(root, "distill", slot.queue_id);
  return { queued: true, count: pendingTurns(root).length };
}

// expireTurns: turns older than the window stop being a queue and become an
// archive row. Idempotent; observe mode only records.
export function expireTurns(root, now = Date.now(), opts = {}) {
  const days = Number(opts.expireDays ?? 3);
  if (!(days > 0)) return { expired: [], observed: 0 };
  const cutoff = now - days * 86400e3;
  const items = pendingTurns(root);
  const old = items.filter((x) => {
    if (x.status !== "pending") return false;
    const t = Date.parse(x.ts || "");
    return Number.isFinite(t) && t < cutoff;
  });
  if (!old.length) return { expired: [], observed: 0 };
  if (opts.observe === true) {
    for (const x of old) {
      appendObserve(root, {
        what: "expire-distill",
        target: x.turn ?? null,
        wouldHave: "skip",
        reason: "expired",
        ageDays: Math.floor(((now - Date.parse(x.ts)) / 86400e3) * 10) / 10
      });
    }
    return { expired: [], observed: old.length };
  }
  // Phase 4: a timeout is not a decision. The item stays in the queue as
  // expired_unreviewed and still counts toward outstanding.
  for (const x of old) {
    markExpiredUnreviewed(root, "distill", x.queue_id);
  }
  try {
    // The same archive clearPending writes, with kind "expired" so a timeout is
    // distinguishable from a deliberate skip in every later read.
    const arch = path.join(root, "distill", "cleared.jsonl");
    fs.mkdirSync(path.dirname(arch), { recursive: true });
    fs.appendFileSync(arch, JSON.stringify({
      ts: new Date(now).toISOString(),
      kind: "expired",
      reason: "expired",
      count: old.length,
      items: old
    }) + "\n", "utf8");
  } catch { /* archive is best-effort; the expiry itself already happened */ }
  for (const x of old) {
    appendEvicted(root, "distill", {
      ts: x.ts,
      turn: x.turn ?? null,
      reason: "expired",
      chars: x.chars ?? null,
      preview: clipLine(x.preview)
    });
  }
  return { expired: old.map((x) => x.turn ?? x.ts), observed: 0 };
}

// clearPending: the agent decided (wrote something or judged it worthless).
// The batch is archived, never silently dropped.
export function clearPending(root, { reason = "", kind = "skip" } = {}) {
  const items = pendingTurns(root);
  if (!items.length) return { cleared: 0 };
  try {
    const arch = path.join(root, "distill", "cleared.jsonl");
    fs.mkdirSync(path.dirname(arch), { recursive: true });
    fs.appendFileSync(arch, JSON.stringify({ ts: new Date().toISOString(), kind, reason, count: items.length, items }) + "\n", "utf8");
  } catch { /* archive is best-effort; clearing still proceeds */ }
  for (const x of items) {
    markDone(root, "distill", x.queue_id);
  }
  return { cleared: items.length };
}

// ---- level 1: mechanical gate (no tokens, always on) ----
export function mechanicalGate(summary, existing) {
  if (!summary || !summary.trim()) return { pass: false, reason: "empty summary" };
  if (summary.trim().length < 20) return { pass: false, reason: "too short to be a lesson" };
  const scan = scanContent(summary);
  if (scan.blocked) return { pass: false, reason: `scanner: ${scan.reason}` };
  const h = sha(summary.trim());
  if (existing && existing.has(h)) return { pass: false, reason: "duplicate of an existing entry" };
  return { pass: true, hash: h };
}

// ---- level 2: judge funnel ----
export function judgeGate(summary, opts) {
  return judgeWorthRecording(summary, opts);
}

// recordRollout: append one distilled turn to the batch dir.
export function recordRollout(root, summary, opts = {}) {
  const mech = mechanicalGate(summary, opts.existingHashes);
  if (!mech.pass) {
    logReject(root, summary, "mechanical", mech.reason);
    return { recorded: false, stage: "mechanical", reason: mech.reason };
  }
  const verdict = judgeGate(summary, opts.judgeOpts);
  if (verdict.verdict === "discard") {
    logReject(root, summary, "judge", `discard (prob ${verdict.prob})`);
    return { recorded: false, stage: "judge", reason: "judged not worth recording" };
  }
  const p = rolloutsDir(root);
  fs.mkdirSync(p, { recursive: true });
  const rec = {
    ts: new Date().toISOString(),
    status: verdict.verdict === "undecided" ? "pending" : "ready",
    hash: mech.hash,
    prob: verdict.prob,
    confidence: verdict.confidence,
    body: summary.trim()
  };
  fs.writeFileSync(path.join(p, `${nowIso()}-${rec.status}-${mech.hash}.json`), JSON.stringify(rec, null, 2), "utf8");
  return { recorded: true, status: rec.status, hash: mech.hash };
}

function logReject(root, summary, stage, reason) {
  const p = rejectLogPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({
    ts: new Date().toISOString(), stage, reason,
    preview: summary.slice(0, 120)
  }) + "\n", "utf8");
}

// ---- batching ----
export function pendingBatch(root) {
  const p = rolloutsDir(root);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const rec = JSON.parse(fs.readFileSync(path.join(p, f), "utf8"));
      return { file: f, ...rec };
    })
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

// validateMerged: refuse to write garbage. An LLM "merge" can emit a
// blank file or a truncated stream; the old digest stays if so.
export function validateMerged(text) {
  if (!text || !text.trim()) return { ok: false, reason: "empty merge output" };
  if (text.trim().length < 15) return { ok: false, reason: "merge output suspiciously short" };
  const hasTitle = /^#{1,3}\s+\S/m.test(text);
  if (!hasTitle) return { ok: false, reason: "no markdown heading" };
  const sections = (text.match(/^##\s+\S/gm) || []).length;
  if (sections < 1) return { ok: false, reason: "no ## section" };
  const fences = (text.match(/^```/gm) || []).length;
  if (fences % 2 !== 0) return { ok: false, reason: "unbalanced code fence (truncated?)" };
  return { ok: true };
}

// consolidate(root, summarize, opts): merge ready+pending rollouts into a
// digest, validate, archive old, write. summarize is INJECTED.
export async function consolidate(root, summarize, opts = {}) {
  if (typeof summarize !== "function") return { ok: false, reason: "no summarize function injected" };
  const batch = pendingBatch(root);
  if (batch.length === 0) return { ok: false, reason: "nothing to consolidate" };
  const bodies = batch.map((b) => `- [${b.status}] ${b.body}`).join("\n");
  let merged;
  try {
    merged = await summarize(bodies);
  } catch (e) {
    return { ok: false, reason: `summarize failed: ${String(e.message || e)}` };
  }
  const v = validateMerged(merged);
  if (!v.ok) {
    return { ok: false, reason: `merge refused: ${v.reason}`, draft: merged };
  }
  const out = path.join(root, "distill", "digest.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out)) {
    const arch = path.join(root, "distill", "digest_history");
    fs.mkdirSync(arch, { recursive: true });
    fs.copyFileSync(out, path.join(arch, `${nowIso()}-digest.md`));
  }
  fs.writeFileSync(out, merged, "utf8");
  for (const b of batch) {
    try { fs.unlinkSync(path.join(rolloutsDir(root), b.file)); } catch { /* keep */ }
  }
  return { ok: true, path: out, consumed: batch.length };
}

// ---- the turn-stopping scheduler (host hook) ----
// Debounced: rapid turns collapse into one distillation. Never blocks.
export function createScheduler(root, opts = {}) {
  const debounceMs = opts.debounceMs ?? 600000;
  const enabled = opts.enabled ?? true;
  let timer = null;
  let pending = [];
  const stats = { scheduled: 0, skipped: 0, runs: 0, lastError: null };

  function schedule(turnText) {
    if (!enabled) return { scheduled: false, reason: "distill disabled" };
    if (!turnText || !turnText.trim()) return { scheduled: false, reason: "empty turn" };
    pending.push(turnText);
    stats.scheduled++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const texts = pending.splice(0, pending.length);
      if (!opts.summarize) { stats.lastError = "no summarize injected"; return; }
      try {
        stats.runs++;
        const summary = await opts.summarize(texts.join("\n---\n"));
        const r = recordRollout(root, summary, opts);
        if (!r.recorded) stats.skipped++;
      } catch (e) {
        stats.lastError = String(e.message || e);
        stats.skipped++;
      }
    }, debounceMs);
    return { scheduled: true, queueDepth: pending.length };
  }

  return { schedule, stats, get pending() { return pending.length; } };
}
