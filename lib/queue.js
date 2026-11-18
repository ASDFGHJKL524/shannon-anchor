// queue.js — bounded queue with slot reservation (Phase 4).
//
// Why: a cap that silently evicts the oldest item just moves the backlog into
// an unbounded evicted.jsonl. This module makes the cap real: a full queue
// returns QUEUE_FULL, and every accepted item has a closed slot lifecycle.
//
// Statuses:
//   reserved -> pending -> in_progress -> done
//   failed_retryable -> pending
//   expired_unreviewed (still counts toward outstanding)
//   released (submission failed / caller cancelled)
//   reserved_unknown (cannot tell whether it was submitted; still counts)
//   deferred (accepted, promised later; still counts)
//
// outstanding = reserved + reserved_unknown + pending + in_progress
//             + expired_unreviewed + deferred
//
// The plugin is single-process; operations are synchronous and the file is
// replaced atomically (tmp + rename), so a crash leaves either the old file or
// the new one, never a half-written queue.
import fs from "node:fs";
import path from "node:path";

export const AREAS = ["distill", "review", "voice"];

export const OUTSTANDING = new Set([
  "reserved", "reserved_unknown", "pending", "in_progress",
  "expired_unreviewed", "deferred"
]);

export const TERMINAL = new Set(["done", "released"]);

export function queuePath(root, area) {
  return path.join(root, area, "pending.jsonl");
}

export function rejectedPath(root, area) {
  return path.join(root, area, "rejected.jsonl");
}

export function readQueue(root, area) {
  try {
    return fs.readFileSync(queuePath(root, area), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeQueue(root, area, items) {
  const file = queuePath(root, area);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const body = items.map((x) => JSON.stringify(x)).join("\n") + (items.length ? "\n" : "");
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
}

export function outstanding(items) {
  return items.filter((x) => OUTSTANDING.has(x.status)).length;
}

// recordRejection: a full queue must leave a countable trace, not just a log
// line. Bounded to the most recent 200 rows, same as the eviction ledger.
export function recordRejection(root, area, reason) {
  try {
    const file = rejectedPath(root, area);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), reason }) + "\n", "utf8");
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > 200) {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, lines.slice(-200).join("\n") + "\n", "utf8");
      fs.renameSync(tmp, file);
    }
  } catch { /* best-effort */ }
}

export function stats(root, area) {
  const items = readQueue(root, area);
  const byStatus = {};
  for (const x of items) byStatus[x.status] = (byStatus[x.status] || 0) + 1;
  const ages = items
    .filter((x) => OUTSTANDING.has(x.status))
    .map((x) => Date.parse(x.created_at || x.at || x.ts || ""))
    .filter(Number.isFinite);
  const rejected = { total: 0, byReason: {} };
  try {
    const lines = fs.readFileSync(rejectedPath(root, area), "utf8").split("\n").filter(Boolean);
    rejected.total = lines.length;
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        rejected.byReason[row.reason] = (rejected.byReason[row.reason] || 0) + 1;
      } catch { /* torn line */ }
    }
  } catch { /* no rejections yet */ }
  return {
    area,
    total: items.length,
    outstanding: outstanding(items),
    byStatus,
    oldestHours: ages.length
      ? Number(((Date.now() - Math.min(...ages)) / 3600e3).toFixed(1))
      : null,
    rejected
  };
}

// reserve: atomically take a slot. Returns QUEUE_FULL instead of evicting.
// A duplicate queue_id is idempotent: the caller gets the existing slot back.
export function reserve(root, area, item, { max = 20 } = {}) {
  const items = readQueue(root, area);
  const queueId = item.queue_id || item.id
    || `q-${area}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const existing = items.find((x) => x.queue_id === queueId);
  if (existing) {
    return { ok: true, queue_id: queueId, duplicate: true, status: existing.status };
  }
  const n = outstanding(items);
  if (n >= max) {
    recordRejection(root, area, "QUEUE_FULL");
    return { ok: false, reason: "QUEUE_FULL", outstanding: n, max };
  }
  const now = new Date().toISOString();
  items.push({
    ...item,
    queue_id: queueId,
    status: "reserved",
    attempts: 0,
    not_before: null,
    created_at: item.created_at || now,
    updated_at: now
  });
  writeQueue(root, area, items);
  return { ok: true, queue_id: queueId };
}

function transition(root, area, queueId, status, patch = {}) {
  const items = readQueue(root, area);
  const index = items.findIndex((x) => x.queue_id === queueId);
  if (index < 0) return { ok: false, reason: "not found", queue_id: queueId };
  items[index] = {
    ...items[index],
    ...patch,
    status,
    updated_at: new Date().toISOString()
  };
  writeQueue(root, area, items);
  return { ok: true, item: items[index] };
}

export function commit(root, area, queueId) {
  return transition(root, area, queueId, "pending");
}

export function release(root, area, queueId) {
  return transition(root, area, queueId, "released");
}

export function markInProgress(root, area, queueId) {
  return transition(root, area, queueId, "in_progress");
}

export function markDone(root, area, queueId) {
  return transition(root, area, queueId, "done");
}

export function markFailedRetryable(root, area, queueId, patch = {}) {
  return transition(root, area, queueId, "failed_retryable", patch);
}

export function markExpiredUnreviewed(root, area, queueId) {
  return transition(root, area, queueId, "expired_unreviewed");
}

export function markReservedUnknown(root, area, queueId) {
  return transition(root, area, queueId, "reserved_unknown");
}

// compactEvicted: the eviction ledger is evidence, not a second queue. Keep the
// most recent `keep` rows so it cannot grow without bound.
export function compactEvicted(root, area, keep = 200) {
  const file = path.join(root, area, "evicted.jsonl");
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length <= keep) return { compacted: 0, kept: lines.length };
    const kept = lines.slice(-keep);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, kept.join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file);
    return { compacted: lines.length - kept.length, kept: kept.length };
  } catch {
    return { compacted: 0, kept: 0 };
  }
}
