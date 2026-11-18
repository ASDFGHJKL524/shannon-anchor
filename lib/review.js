// review.js — the write-after review queue (plan §2A, plugin side only).
//
// Why this exists: every quality judgment in this system happens inside the same
// context that made the decision. `memory_curate` returns similarity,
// `integrity` returns a threshold, `distill` and `voice_case` ask me to judge —
// and the standard is written in the manual I am supposed to follow. That is
// marking your own homework. The only cut that breaks the confirmation bias is a
// reviewer with NO context from this conversation.
//
// So the split is deliberate:
//   - the plugin queues, keeps the ledger and reports the account (this file);
//   - a separate subagent, given only the entry text and the criteria, returns
//     keep/merge/drop and one reason;
//   - the agent that wrote the entry executes the verdict. The reviewer never
//     writes the manual.
//
// The plugin does not call a model: lib/judge.js states the constraint (local, no
// LLM, no key, no network) and memory is not allowed to depend on a service.
//
// Nothing here stores an entry body. The queue holds a hash so a later edit can
// be told apart from the reviewed text, plus the title for a readable preview.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ageDays } from "./eviction.js";
import { reserve, commit, release, markDone, readQueue, OUTSTANDING } from "./queue.js";

const DEFAULT_MAX_PENDING = 6;
const DEFAULT_WINDOW_HOURS = 24;
// wrong（2026-11-17）：drop 说的是"不值得留"，wrong 说的是"内容错了"。两种处置
// 完全不同——前者走淘汰，后者要加 wrong 标记（检索降权、注入跳过、正文保留追溯）。
// 混在一个词里，结果就是判了 drop 也没人知道该不该隔离。
const VERDICTS = ["keep", "merge", "drop", "wrong"];

export function reviewDir(root) { return path.join(root, "review"); }
export function pendingPath(root) { return path.join(reviewDir(root), "pending.jsonl"); }
export function decidedPath(root) { return path.join(reviewDir(root), "decided.jsonl"); }

export function bodyHash(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex").slice(0, 16);
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function listReview(root) {
  return readQueue(root, "review").filter((x) => x && x.id && OUTSTANDING.has(x.status));
}

function oneLine(text, n) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// queueReview: called after a successful write. The id is derived from the entry
// number and a hash of the reviewed text, so the same entry queued twice is one
// item — and a later edit produces a different id rather than pretending the
// reviewed text is the current text.
export function queueReview(root, { number, title, body, source = "" } = {}, opts = {}) {
  if (!Number.isInteger(number) || number <= 0) return { queued: false, reason: "no entry number" };
  const hash = bodyHash(`${title}\n${body}`);
  const id = `r-${number}-${hash.slice(0, 8)}`;
  const max = opts.maxPending ?? DEFAULT_MAX_PENDING;
  // Phase 4: a full queue rejects the new item instead of evicting the oldest.
  // The eviction ledger is evidence, not a second queue; it must not grow.
  const slot = reserve(root, "review", {
    id,
    number,
    title: oneLine(title, 200),
    bodyHash: hash,
    at: new Date().toISOString(),
    source: oneLine(source, 120)
  }, { max });
  if (!slot.ok) {
    return { queued: false, reason: slot.reason, outstanding: slot.outstanding, max: slot.max, id };
  }
  if (slot.duplicate) return { queued: false, reason: "already pending", id };
  commit(root, "review", slot.queue_id);
  return { queued: true, id };
}

// reserveReview: the write path's "required post-processing" form. Reserve the
// slot BEFORE the entry is written; commit after the write succeeds, release if
// it fails. A full queue refuses the write instead of writing and dropping the
// review on the floor.
export function reserveReview(root, { number, title, body, source = "" } = {}, opts = {}) {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, reason: "no entry number" };
  const hash = bodyHash(`${title}\n${body}`);
  const id = `r-${number}-${hash.slice(0, 8)}`;
  const max = opts.maxPending ?? DEFAULT_MAX_PENDING;
  const slot = reserve(root, "review", {
    id,
    number,
    title: oneLine(title, 200),
    bodyHash: hash,
    at: new Date().toISOString(),
    source: oneLine(source, 120)
  }, { max });
  if (!slot.ok) return { ok: false, reason: slot.reason, outstanding: slot.outstanding, max: slot.max, id };
  return { ok: true, queue_id: slot.queue_id, id, duplicate: slot.duplicate === true };
}

export function commitReview(root, queueId) { return commit(root, "review", queueId); }
export function releaseReview(root, queueId) { return release(root, "review", queueId); }

// decideReview: the agent's verdict, after the reviewer answered. The verdict is
// advisory to the write path — nothing here deletes or edits an entry. That is
// deliberate: §2B's note says a resolution step must never reach into manual/.
export function decideReview(root, { id, verdict, into = null, reason = "", regret = false } = {}) {
  if (!id) return { ok: false, error: "id required" };
  if (!VERDICTS.includes(verdict)) return { ok: false, error: `verdict must be one of ${VERDICTS.join("|")}` };
  if (verdict === "merge" && !Number.isInteger(into)) {
    return { ok: false, error: "merge needs into=<existing entry number>" };
  }
  // wrong 会把理由写进条目头部，空理由等于没留证据。
  if (verdict === "wrong" && !String(reason || "").trim()) {
    return { ok: false, error: "wrong needs a reason: say what is actually false" };
  }
  const items = listReview(root);
  const item = items.find((x) => x.id === id);
  if (!item) return { ok: false, error: `no pending review ${id}` };

  const ageHours = ageDays(item.at) === null ? null : Number((ageDays(item.at) * 24).toFixed(1));
  const decision = {
    id,
    number: item.number ?? null,
    title: item.title ?? "",
    bodyHash: item.bodyHash ?? null,
    verdict,
    into: verdict === "merge" ? into : null,
    // regret: a drop that was actually worth keeping. Without this field the
    // "how many did we wrongly block" number does not exist, and that number is
    // the whole point of keeping the ledger.
    regret: regret === true,
    reason: oneLine(reason, 300),
    ageHours,
    at: new Date().toISOString()
  };
  try {
    fs.mkdirSync(path.dirname(decidedPath(root)), { recursive: true });
    fs.appendFileSync(decidedPath(root), JSON.stringify(decision) + "\n", "utf8");
  } catch (e) {
    return { ok: false, error: `could not record decision: ${String(e.message || e)}` };
  }
  markDone(root, "review", item.queue_id);
  return { ok: true, ...decision };
}

// reviewStats: the three numbers §2A asks for — blocked, passed, wrongly blocked.
// The third one needs `regret` on a later verdict; it is not inferable.
export function reviewStats(root) {
  const pending = listReview(root);
  const decided = readJsonl(decidedPath(root));
  const byVerdict = { keep: 0, merge: 0, drop: 0, wrong: 0 };
  for (const d of decided) {
    if (VERDICTS.includes(d.verdict)) byVerdict[d.verdict]++;
  }
  const regrets = decided.filter((d) => d.regret === true).length;
  const blocked = byVerdict.drop + byVerdict.merge + byVerdict.wrong;
  const ages = pending.map((p) => ageDays(p.at)).filter((x) => x !== null);
  return {
    pending: pending.length,
    oldestPendingHours: ages.length ? Number((Math.max(...ages) * 24).toFixed(1)) : null,
    decided: decided.length,
    passed: byVerdict.keep,
    blocked,
    byVerdict,
    regrets,
    // Rate over BLOCKED decisions only: a keep cannot be wrongly blocked.
    regretRate: blocked ? Number((regrets / blocked).toFixed(3)) : null
  };
}

// reviewPrompt: the nudge. Deliberately the same shape as voicePrompt — only
// fresh items, at most two, and nothing once the queue is empty. A permanent nag
// trains the reader to skip the block, which is how a review queue becomes
// decoration.
//
// EXCEPT when the queue is FULL. Then it is not a nudge, it is a closed door:
// memory_write is already refusing, and staying quiet about a stale backlog is
// how a full queue silently blocks every future lesson. 2026-11-16 measured the
// bug in the wild: the prompt said "1 条待复查" while the queue stood at 6/6,
// because it only counted items inside the 24h freshness window and never
// compared against the cap. A full queue now reports the total, lists every
// outstanding item (there are at most cap), and does NOT filter by freshness.
export function reviewPrompt(root, opts = {}) {
  const maxShown = opts.max ?? 2;
  const windowHours = opts.maxAgeHours ?? DEFAULT_WINDOW_HOURS;
  const cap = opts.maxPending ?? DEFAULT_MAX_PENDING;
  const all = listReview(root);
  if (!all.length) return "";

  const tally = "裁决用 memory_review action=confirm id=<id> verdict=keep|merge|drop，merge 要带 into=<条目号>，reason 一句。复查者不写手册。";

  if (all.length >= cap) {
    const lines = [
      `shannon-anchor 复查：队列已满 ${all.length}/${cap} —— memory_write 现在会被拒绝，先裁决下面这些才能继续写经验。`
    ];
    for (const p of all.slice(-cap)) {
      lines.push(`- ${p.id}｜#${p.number} ${oneLine(p.title, 80)}`);
    }
    lines.push(tally);
    return lines.join("\n");
  }

  const fresh = all.filter((p) => {
    const age = ageDays(p.at);
    return age !== null && age * 24 <= windowHours;
  });
  if (!fresh.length) return "";
  const lines = [`shannon-anchor 复查：${fresh.length} 条写入待复查（另起一个不带本场上下文的会话，只给条目全文和判据，问 keep/merge/drop）。`];
  for (const p of fresh.slice(-maxShown)) {
    lines.push(`- ${p.id}｜#${p.number} ${oneLine(p.title, 80)}`);
  }
  lines.push(tally);
  return lines.join("\n");
}
