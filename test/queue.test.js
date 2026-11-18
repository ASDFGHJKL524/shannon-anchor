// Phase 4: the bounded queue must reject instead of evicting, and every slot
// must have a closed lifecycle. These tests pin the contract.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  reserve,
  commit,
  release,
  markDone,
  markExpiredUnreviewed,
  outstanding,
  readQueue,
  stats,
  compactEvicted
} from "../lib/queue.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pagi-queue-"));
}

test("reserve stops at max and returns QUEUE_FULL", () => {
  const root = tmpRoot();
  for (let i = 0; i < 3; i++) {
    const r = reserve(root, "review", { id: `r-${i}` }, { max: 3 });
    assert.equal(r.ok, true);
  }
  const full = reserve(root, "review", { id: "r-3" }, { max: 3 });
  assert.equal(full.ok, false);
  assert.equal(full.reason, "QUEUE_FULL");
  assert.equal(full.outstanding, 3);
  assert.equal(readQueue(root, "review").length, 3, "rejected item is not written");
  fs.rmSync(root, { recursive: true, force: true });
});

test("commit moves reserved to pending without changing outstanding", () => {
  const root = tmpRoot();
  const r = reserve(root, "review", { id: "r-1" }, { max: 3 });
  assert.equal(r.ok, true);
  commit(root, "review", r.queue_id);
  const items = readQueue(root, "review");
  assert.equal(items[0].status, "pending");
  assert.equal(outstanding(items), 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("release frees the slot", () => {
  const root = tmpRoot();
  const r = reserve(root, "review", { id: "r-1" }, { max: 1 });
  release(root, "review", r.queue_id);
  const items = readQueue(root, "review");
  assert.equal(items[0].status, "released");
  assert.equal(outstanding(items), 0);
  const again = reserve(root, "review", { id: "r-2" }, { max: 1 });
  assert.equal(again.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("expired_unreviewed still counts toward outstanding", () => {
  const root = tmpRoot();
  const r = reserve(root, "review", { id: "r-1" }, { max: 1 });
  markExpiredUnreviewed(root, "review", r.queue_id);
  const items = readQueue(root, "review");
  assert.equal(items[0].status, "expired_unreviewed");
  assert.equal(outstanding(items), 1);
  const full = reserve(root, "review", { id: "r-2" }, { max: 1 });
  assert.equal(full.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("done removes the item from outstanding", () => {
  const root = tmpRoot();
  const r = reserve(root, "review", { id: "r-1" }, { max: 1 });
  markDone(root, "review", r.queue_id);
  const items = readQueue(root, "review");
  assert.equal(items[0].status, "done");
  assert.equal(outstanding(items), 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("duplicate reserve is idempotent", () => {
  const root = tmpRoot();
  reserve(root, "review", { id: "r-1" }, { max: 3 });
  const b = reserve(root, "review", { id: "r-1" }, { max: 3 });
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  assert.equal(readQueue(root, "review").length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("compactEvicted keeps the most recent rows", () => {
  const root = tmpRoot();
  const file = path.join(root, "review", "evicted.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Array.from({ length: 10 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n",
    "utf8"
  );
  const r = compactEvicted(root, "review", 3);
  assert.equal(r.compacted, 7);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[2]), { i: 9 });
  fs.rmSync(root, { recursive: true, force: true });
});

test("stats reports counts and oldest age", () => {
  const root = tmpRoot();
  const r = reserve(root, "review", { id: "r-1" }, { max: 3 });
  commit(root, "review", r.queue_id);
  const s = stats(root, "review");
  assert.equal(s.outstanding, 1);
  assert.equal(s.byStatus.pending, 1);
  assert.ok(s.oldestHours >= 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a full queue records a rejection row", () => {
  const root = tmpRoot();
  reserve(root, "review", { id: "r-1" }, { max: 1 });
  reserve(root, "review", { id: "r-2" }, { max: 1 });
  const s = stats(root, "review");
  assert.equal(s.rejected.total, 1);
  assert.equal(s.rejected.byReason.QUEUE_FULL, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
