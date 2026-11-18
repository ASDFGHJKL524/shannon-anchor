// The behaviour plan §2B and §2C exist to guarantee, as tests.
//
// The failure being locked out is not "eviction happens" — a cap has to cut
// something. It is "eviction happens and nobody can ever tell what was cut",
// which made every threshold in these queues untunable from evidence.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  appendEvicted,
  appendObserve,
  readEvicted,
  readObserved,
  evictionStats,
  clip,
  ageDays
} from "../lib/eviction.js";
import { expirePending, listPending } from "../lib/voice.js";
import { expireTurns, pendingTurns, queueTurn } from "../lib/distill.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pagi-evict-"));
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

const DAY = 86400e3;

// ---- the ledger itself ----

test("evicted rows are appended per area and survive a reread", () => {
  const root = tmpRoot();
  appendEvicted(root, "voice", { id: "p-1", reason: "cap", preview: "x" });
  appendEvicted(root, "distill", { ts: "t", turn: 3, reason: "expired" });
  appendEvicted(root, "voice", { id: "p-2", reason: "expired" });
  assert.equal(readEvicted(root, "voice").length, 2);
  assert.equal(readEvicted(root, "distill").length, 1);
  assert.equal(readEvicted(root, "nonsense").length, 0, "unknown area is empty, not an error");
  fs.rmSync(root, { recursive: true, force: true });
});

test("observe rows dedupe on what+target+reason", () => {
  const root = tmpRoot();
  assert.equal(appendObserve(root, { what: "expire-voice", target: "p-1", reason: "expired" }), true);
  assert.equal(appendObserve(root, { what: "expire-voice", target: "p-1", reason: "expired" }), false);
  assert.equal(appendObserve(root, { what: "expire-voice", target: "p-2", reason: "expired" }), true);
  assert.equal(readObserved(root).length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("stats separate cap from expiry, and report observe separately", () => {
  const root = tmpRoot();
  appendEvicted(root, "voice", { id: "p-1", reason: "cap" });
  appendEvicted(root, "voice", { id: "p-2", reason: "expired" });
  appendObserve(root, { what: "expire-distill", target: 7, reason: "expired" });
  const st = evictionStats(root);
  assert.equal(st.voice.n, 2);
  assert.deepEqual(st.voice.byReason, { cap: 1, expired: 1 });
  assert.equal(st.distill.n, 0);
  assert.equal(st.observe.n, 1);
  assert.deepEqual(st.observe.byWhat, { "expire-distill": 1 });
  fs.rmSync(root, { recursive: true, force: true });
});

test("clip keeps one readable line; ageDays is honest about unknown dates", () => {
  assert.equal(clip("a\n  b   c"), "a b c");
  assert.ok(clip("x".repeat(400)).endsWith("…"));
  assert.equal(clip("x".repeat(400)).length, 121);
  assert.equal(ageDays("not a date"), null);
  assert.equal(ageDays(new Date(Date.now() - 2.5 * DAY).toISOString()), 2.5);
});

// ---- distill: cap and expiry ----

test("distill cap rejects new turns instead of evicting", () => {
  const root = tmpRoot();
  // turn lives in the payload, not in opts: queueTurn(root, {text, turn}, opts).
  const first = queueTurn(root, { text: "first turn kept short", turn: 1 }, { maxPending: 2 });
  const second = queueTurn(root, { text: "second turn", turn: 2 }, { maxPending: 2 });
  const third = queueTurn(root, { text: "third turn", turn: 3 }, { maxPending: 2 });
  const fourth = queueTurn(root, { text: "fourth turn", turn: 4 }, { maxPending: 2 });
  assert.equal(first.queued, true);
  assert.equal(second.queued, true);
  assert.equal(third.queued, false);
  assert.equal(third.reason, "NOT_SCHEDULED_OPTIONAL");
  assert.equal(fourth.queued, false);
  assert.equal(pendingTurns(root).length, 2);
  assert.deepEqual(pendingTurns(root).map((x) => x.turn), [1, 2], "the oldest turns stay");
  assert.equal(readEvicted(root, "distill").length, 0, "no eviction ledger row is written");
  fs.rmSync(root, { recursive: true, force: true });
});

test("distill expiry marks expired_unreviewed and is idempotent", () => {
  const root = tmpRoot();
  const old = Date.now() - 10 * DAY;
  writeJsonl(path.join(root, "distill", "pending.jsonl"), [
    { queue_id: "h1", status: "pending", ts: new Date(old).toISOString(), turn: 1, chars: 10, preview: "old one", hash: "h1" },
    { queue_id: "h2", status: "pending", ts: new Date(old).toISOString(), turn: 2, chars: 10, preview: "old two", hash: "h2" },
    { queue_id: "h3", status: "pending", ts: new Date().toISOString(), turn: 3, chars: 10, preview: "fresh", hash: "h3" }
  ]);
  const r = expireTurns(root, Date.now(), { expireDays: 3 });
  assert.deepEqual(r.expired.sort(), [1, 2]);
  const items = pendingTurns(root);
  assert.equal(items.length, 3, "expired items still count toward outstanding");
  assert.equal(items.filter((x) => x.status === "expired_unreviewed").length, 2);
  assert.equal(items.filter((x) => x.status === "pending").length, 1);
  const arch = fs.readFileSync(path.join(root, "distill", "cleared.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(arch.length, 1);
  assert.equal(arch[0].kind, "expired");
  assert.equal(arch[0].count, 2);
  assert.equal(readEvicted(root, "distill").length, 2);
  // Second sweep: nothing left to expire, nothing new written.
  const again = expireTurns(root, Date.now(), { expireDays: 3 });
  assert.deepEqual(again.expired, []);
  assert.equal(fs.readFileSync(path.join(root, "distill", "cleared.jsonl"), "utf8").trim().split("\n").length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- voice: expiry, observe, and the cap ----

test("voice expiry marks expired_unreviewed and keeps one schema in dropped.jsonl", () => {
  const root = tmpRoot();
  const old = Date.now() - 5 * DAY;
  writeJsonl(path.join(root, "voice", "pending.jsonl"), [
    { queue_id: "p-old", status: "pending", id: "p-old", at: new Date(old).toISOString(), created: "2026-10-01", signal: "strong", user: "这句话不对", assistant: "我改" },
    { queue_id: "p-new", status: "pending", id: "p-new", at: new Date().toISOString(), created: "2026-11-01", signal: "weak", user: "嗯", assistant: "" }
  ]);
  const r = expirePending(root, Date.now(), { expireDays: 3 });
  assert.deepEqual(r.expired, ["p-old"]);
  const items = listPending(root);
  assert.equal(items.length, 2, "expired item still counts toward outstanding");
  assert.equal(items.find((p) => p.id === "p-old").status, "expired_unreviewed");
  assert.equal(items.find((p) => p.id === "p-new").status, "pending");
  const dropped = fs.readFileSync(path.join(root, "voice", "dropped.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, "p-old");
  assert.equal(dropped[0].reason, "expired");
  assert.equal(dropped[0].signal, "strong", "same fields a manual drop writes");
  assert.equal(readEvicted(root, "voice").length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("observe mode records what it would do and changes nothing", () => {
  const root = tmpRoot();
  const old = Date.now() - 9 * DAY;
  writeJsonl(path.join(root, "voice", "pending.jsonl"), [
    { queue_id: "p-old", status: "pending", id: "p-old", at: new Date(old).toISOString(), user: "旧", assistant: "" }
  ]);
  writeJsonl(path.join(root, "distill", "pending.jsonl"), [
    { queue_id: "h", status: "pending", ts: new Date(old).toISOString(), turn: 5, chars: 3, preview: "旧", hash: "h" }
  ]);
  const v = expirePending(root, Date.now(), { expireDays: 3, observe: true });
  const d = expireTurns(root, Date.now(), { expireDays: 3, observe: true });
  assert.deepEqual(v.expired, [], "observe removes nothing");
  assert.deepEqual(d.expired, []);
  assert.equal(v.observed, 1);
  assert.equal(d.observed, 1);
  assert.equal(listPending(root).length, 1, "voice queue untouched");
  assert.equal(pendingTurns(root).length, 1, "distill queue untouched");
  assert.equal(fs.existsSync(path.join(root, "voice", "dropped.jsonl")), false);
  assert.equal(fs.existsSync(path.join(root, "distill", "cleared.jsonl")), false);
  const seen = readObserved(root);
  assert.equal(seen.length, 2);
  assert.ok(seen.some((x) => x.what === "expire-voice" && x.wouldHave === "drop" && x.ageDays >= 9));
  assert.ok(seen.some((x) => x.what === "expire-distill" && x.wouldHave === "skip"));
  // A second sweep must not double-count: the ledger is read on every status call.
  expirePending(root, Date.now(), { expireDays: 3, observe: true });
  expireTurns(root, Date.now(), { expireDays: 3, observe: true });
  assert.equal(readObserved(root).length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("turning observe off afterwards still expires the same items", () => {
  const root = tmpRoot();
  const old = Date.now() - 9 * DAY;
  writeJsonl(path.join(root, "voice", "pending.jsonl"), [
    { queue_id: "p-old", status: "pending", id: "p-old", at: new Date(old).toISOString(), user: "旧", assistant: "" }
  ]);
  expirePending(root, Date.now(), { expireDays: 3, observe: true });
  assert.equal(listPending(root).length, 1);
  const real = expirePending(root, Date.now(), { expireDays: 3, observe: false });
  assert.deepEqual(real.expired, ["p-old"]);
  assert.equal(listPending(root).length, 1, "expired item still counts toward outstanding");
  assert.equal(listPending(root)[0].status, "expired_unreviewed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a non-positive window disables expiry instead of expiring everything", () => {
  const root = tmpRoot();
  const old = Date.now() - 99 * DAY;
  writeJsonl(path.join(root, "voice", "pending.jsonl"), [
    { queue_id: "p-old", status: "pending", id: "p-old", at: new Date(old).toISOString(), user: "旧", assistant: "" }
  ]);
  assert.deepEqual(expirePending(root, Date.now(), { expireDays: 0 }).expired, []);
  assert.deepEqual(expireTurns(root, Date.now(), { expireDays: -1 }).expired, []);
  assert.equal(listPending(root).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
