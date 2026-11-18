// The after-write review queue (plan §2A), plugin side.
//
// The property that matters is not "items get queued" — it is that the queue is
// honest: the same entry cannot be reviewed twice, a cap cut leaves a row, a
// body is never copied into the queue, and "how many did we wrongly block" is a
// number that exists instead of a feeling.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  queueReview,
  listReview,
  decideReview,
  reviewStats,
  reviewPrompt,
  bodyHash,
  pendingPath,
  decidedPath
} from "../lib/review.js";
import { readEvicted } from "../lib/eviction.js";

const DAY = 86400e3;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pagi-review-"));
}

test("a successful write is queued with a hash, not a body", () => {
  const root = tmpRoot();
  const r = queueReview(root, { number: 7, title: "备份怎么验", body: "先查包再查密码", source: "本机" });
  assert.equal(r.queued, true);
  assert.match(r.id, /^r-7-[0-9a-f]{8}$/);
  const items = listReview(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].number, 7);
  assert.equal(items[0].status, "pending");
  assert.equal(items[0].bodyHash, bodyHash("备份怎么验\n先查包再查密码"));
  assert.equal(items[0].title, "备份怎么验");
  // The queue must never become a second copy of the manual.
  const raw = fs.readFileSync(pendingPath(root), "utf8");
  assert.ok(!raw.includes("先查包再查密码"), raw);
  assert.ok(!Object.prototype.hasOwnProperty.call(items[0], "body"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the same entry does not queue twice, but an edited body does", () => {
  const root = tmpRoot();
  queueReview(root, { number: 3, title: "t", body: "v1" });
  const again = queueReview(root, { number: 3, title: "t", body: "v1" });
  assert.equal(again.queued, false);
  assert.equal(again.reason, "already pending");
  assert.equal(listReview(root).length, 1);
  // Edited text is a different thing to review: same number, new id.
  queueReview(root, { number: 3, title: "t", body: "v2" });
  assert.equal(listReview(root).length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a full queue rejects the new item instead of evicting the oldest", () => {
  const root = tmpRoot();
  const first = queueReview(root, { number: 1, title: "标题1", body: "正文1" }, { maxPending: 2 });
  const second = queueReview(root, { number: 2, title: "标题2", body: "正文2" }, { maxPending: 2 });
  assert.equal(first.queued, true);
  assert.equal(second.queued, true);
  const third = queueReview(root, { number: 3, title: "标题3", body: "正文3" }, { maxPending: 2 });
  assert.equal(third.queued, false);
  assert.equal(third.reason, "QUEUE_FULL");
  const items = listReview(root);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((x) => x.number), [1, 2], "the oldest items stay; nothing is evicted");
  assert.equal(readEvicted(root, "review").length, 0, "no eviction ledger row is written");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a write without a number is refused instead of queued anonymously", () => {
  const root = tmpRoot();
  const r = queueReview(root, { title: "t", body: "b" });
  assert.equal(r.queued, false);
  assert.equal(listReview(root).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("confirm records the verdict and removes the item", () => {
  const root = tmpRoot();
  const q = queueReview(root, { number: 9, title: "t", body: "b" });
  const d = decideReview(root, { id: q.id, verdict: "keep", reason: "确实是一条经验" });
  assert.equal(d.ok, true);
  assert.equal(d.verdict, "keep");
  assert.equal(listReview(root).length, 0);
  const rows = fs.readFileSync(decidedPath(root), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, q.id);
  assert.equal(rows[0].reason, "确实是一条经验");
  assert.equal(rows[0].regret, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("merge needs a target, and an unknown id is an error not a crash", () => {
  const root = tmpRoot();
  const q = queueReview(root, { number: 11, title: "t", body: "b" });
  const noTarget = decideReview(root, { id: q.id, verdict: "merge" });
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.error, /into/);
  assert.equal(listReview(root).length, 1, "a refused verdict leaves the item pending");
  const merged = decideReview(root, { id: q.id, verdict: "merge", into: 4 });
  assert.equal(merged.ok, true);
  assert.equal(merged.into, 4);
  const bad = decideReview(root, { id: "r-999-deadbeef", verdict: "drop" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no pending review/);
  const badVerdict = decideReview(root, { id: q.id, verdict: "maybe" });
  assert.equal(badVerdict.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("stats give blocked / passed / wrongly-blocked", () => {
  const root = tmpRoot();
  const a = queueReview(root, { number: 1, title: "a", body: "b1" });
  const b = queueReview(root, { number: 2, title: "b", body: "b2" });
  const c = queueReview(root, { number: 3, title: "c", body: "b3" });
  const d = queueReview(root, { number: 4, title: "d", body: "b4" });
  decideReview(root, { id: a.id, verdict: "keep" });
  decideReview(root, { id: b.id, verdict: "drop", reason: "一次性自责" });
  decideReview(root, { id: c.id, verdict: "merge", into: 2 });
  // Later: that drop was actually worth keeping.
  decideReview(root, { id: d.id, verdict: "drop", reason: "猜的", regret: true });
  const st = reviewStats(root);
  assert.equal(st.pending, 0);
  assert.equal(st.decided, 4);
  assert.equal(st.passed, 1);
  assert.equal(st.blocked, 3, "two drops + one merge are all blocks");
  assert.deepEqual(st.byVerdict, { keep: 1, merge: 1, drop: 2, wrong: 0 });
  assert.equal(st.regrets, 1);
  assert.equal(st.regretRate, 0.333, "1 regret over 3 blocked decisions");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the nudge only shows fresh items and at most two", () => {
  const root = tmpRoot();
  assert.equal(reviewPrompt(root), "", "empty queue says nothing");
  for (let i = 1; i <= 3; i++) queueReview(root, { number: i, title: `新${i}`, body: `b${i}` });
  // One stale item that must not be surfaced.
  const stale = listReview(root);
  stale[0].at = new Date(Date.now() - 3 * DAY).toISOString();
  fs.writeFileSync(pendingPath(root), stale.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const text = reviewPrompt(root, { maxAgeHours: 24, max: 2 });
  assert.match(text, /复查/);
  const listed = text.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(listed.length, 2, text);
  assert.ok(!text.includes("新1"), "the 3-day-old title must not be surfaced");
  assert.match(text, /memory_review action=confirm/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a full queue says so, counts the total, and ignores the freshness window", () => {
  const root = tmpRoot();
  // 2026-11-16 bug: the queue was full and the write path was refusing, but the
  // prompt only counted items inside the 24h window — every blocking item was
  // stale, so the prompt said nothing. A closed door must announce itself.
  for (let i = 1; i <= 6; i++) queueReview(root, { number: i, title: `旧${i}`, body: `b${i}` });
  const items = listReview(root);
  for (const it of items) it.at = new Date(Date.now() - 3 * DAY).toISOString();
  fs.writeFileSync(pendingPath(root), items.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const text = reviewPrompt(root, { maxAgeHours: 24, max: 2 });
  assert.match(text, /队列已满 6\/6/, text);
  assert.match(text, /memory_write 现在会被拒绝/, text);
  const listed = text.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(listed.length, 6, "every outstanding item is listed, stale or not");
  assert.ok(text.includes("旧1"), "a stale item must stay visible when it is what blocks the queue");
  fs.rmSync(root, { recursive: true, force: true });
});

test("stats on an empty queue report zero rather than null-everything", () => {
  const root = tmpRoot();
  const st = reviewStats(root);
  assert.equal(st.pending, 0);
  assert.equal(st.decided, 0);
  assert.equal(st.blocked, 0);
  assert.equal(st.regretRate, null, "no blocked decisions means no rate, not 0");
  fs.rmSync(root, { recursive: true, force: true });
});
