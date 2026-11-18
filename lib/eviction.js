// eviction.js — the ledger for everything that leaves a queue.
//
// Two failures this exists to fix (plan §1.2, 2026-11-01):
//
//   1. A cap eviction used to be silent. When voice/pending.jsonl hit its
//      maxPending, the oldest candidate was overwritten with no record
//      (voice.js:217-219), and distill did the same with items.slice(-cap)
//      (distill.js:125-127). After the fact there was no way to ask "of the
//      things we threw away, how many should we have kept?" — and that question
//      is the ONLY evidence a pending-cap or an expiry window can be tuned on.
//
//   2. A pending item past the nudge window sat forever. voicePrompt only
//      surfaces items younger than a day (deliberately: a permanent nag trains
//      the reader to skip the section), so an older one was neither shown nor
//      decided. A queue that never resolves is a shelf with extra steps.
//
// Design rules, both from the same plan:
//   - No timer. The plugin has no reliable background, and a scheduler that
//     silently stops running is worse than none. Sweeps happen when something
//     next asks about the queue, and every sweep is idempotent.
//   - Observe mode changes no state; it only records what it WOULD have done,
//     so a threshold can be set from data instead of a guess.
//
// The ledger never holds an entry body. preview is clipped by the caller: this
// is evidence about a rule, not a second copy of the queue.
import fs from "node:fs";
import path from "node:path";

import { compactEvicted } from "./queue.js";

const AREAS = ["voice", "distill", "review"];

function areaDir(root, area) {
  return path.join(root, AREAS.includes(area) ? area : "voice");
}

export function evictedPath(root, area) {
  return path.join(areaDir(root, area), "evicted.jsonl");
}

export function observePath(root) {
  return path.join(root, "metrics", "observe.jsonl");
}

function appendLine(file, rec) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
    return true;
  } catch {
    // Bookkeeping must never break the caller. A lost ledger row is cheaper
    // than a failed capture or a wedged queue.
    return false;
  }
}

export function appendEvicted(root, area, rec) {
  if (!AREAS.includes(area)) return false;
  const ok = appendLine(evictedPath(root, area), { at: new Date().toISOString(), ...rec });
  // Phase 4: the ledger is evidence, not a second queue. Keep it bounded.
  try { compactEvicted(root, area, 200); } catch { /* best-effort */ }
  return ok;
}

export function appendObserve(root, rec) {
  const row = { at: new Date().toISOString(), ...rec };
  // Idempotency: a sweep runs whenever the queue is next read, so without this
  // the same "would have happened" fact would be logged on every status call and
  // the ledger would measure how often it was read instead of what was pending.
  // One row per (what, target, reason); cap evictions differ by target, so they
  // are unaffected.
  try {
    const same = readObserved(root).some(
      (x) => x.what === row.what
        && String(x.target ?? "") === String(row.target ?? "")
        && String(x.reason ?? "") === String(row.reason ?? "")
    );
    if (same) return false;
  } catch { /* fall through and append: a missing dedupe is better than a gap */ }
  return appendLine(observePath(root), row);
}

function readJsonlSafe(file, limit) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const slice = limit ? lines.slice(-limit) : lines;
    const out = [];
    for (const l of slice) {
      try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ }
    }
    return out;
  } catch {
    return [];
  }
}

export function readEvicted(root, area, opts = {}) {
  if (!AREAS.includes(area)) return [];
  return readJsonlSafe(evictedPath(root, area), opts.limit);
}

export function readObserved(root, opts = {}) {
  return readJsonlSafe(observePath(root), opts.limit);
}

function tally(xs, key) {
  const m = {};
  for (const x of xs) {
    const k = String(x[key] ?? "?");
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

// evictionStats(root) -> the account for the three questions the plan asks:
// what was thrown away at a cap, what expired, and what observe mode WOULD have
// thrown away. "How many of those were worth keeping" still needs a human
// verdict; this only guarantees the row exists to judge.
export function evictionStats(root) {
  const voice = readEvicted(root, "voice");
  const distill = readEvicted(root, "distill");
  const observed = readObserved(root);
  return {
    voice: { n: voice.length, byReason: tally(voice, "reason"), last: voice[voice.length - 1] ?? null },
    distill: { n: distill.length, byReason: tally(distill, "reason"), last: distill[distill.length - 1] ?? null },
    observe: { n: observed.length, byWhat: tally(observed, "what"), last: observed[observed.length - 1] ?? null }
  };
}

// clip keeps one readable line without dragging a transcript into the ledger.
export function clip(text, n = 120) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ageDays is for the record: when a window is later re-tuned, the age an item
// actually had at decision time is what the new threshold has to be compared to.
export function ageDays(at, now = Date.now()) {
  const t = Date.parse(at || "");
  if (!Number.isFinite(t)) return null;
  return Math.floor(((now - t) / 86400e3) * 10) / 10;
}
