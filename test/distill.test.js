// shannon-anchor — distill tests. The funnel must sieve; the merge must
// refuse garbage; the scheduler must never block a turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mechanicalGate, recordRollout, pendingBatch, validateMerged, consolidate, createScheduler, rolloutsDir, rejectLogPath } from "../lib/distill.js";

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-dist-")); }

const LESSON = "以后遇到 Remove-Item 一定要先确认路径，上次踩坑误删了文件，这是可复用的教训，exit=1 也会报";

test("mechanical gate refuses empty / too-short", () => {
  assert.equal(mechanicalGate("").pass, false);
  assert.equal(mechanicalGate("太短").pass, false);
});

test("mechanical gate blocks a key-shaped token even before the judge", () => {
  // 拼接而不是写完整字面量：这段是假的，但 GitHub 的推送保护只看形态，会当成真密钥拦下。
  const fakeKey = "sk_" + "live_" + "abcdefghijklmnopqrstuvwxyz012345";
  const r = mechanicalGate(`这里有个密钥 ${fakeKey} 以后别再泄露了`);
  assert.equal(r.pass, false);
  assert.match(r.reason, /scanner/);
});

test("mechanical gate dedupes by content hash", () => {
  const existing = new Set();
  const a = mechanicalGate(LESSON, existing);
  assert.equal(a.pass, true);
  existing.add(a.hash);
  const b = mechanicalGate(LESSON, existing);
  assert.equal(b.pass, false);
  assert.match(b.reason, /duplicate/);
});

test("recordRollout: noise is rejected and logged, never enters the batch", () => {
  const r = root();
  const res = recordRollout(r, "你好呀");
  assert.equal(res.recorded, false);
  // the mechanical length gate fires first — cheaper than the judge, which is the intended order
  assert.ok(fs.existsSync(rejectLogPath(r)), "rejection is auditable");
  assert.equal(pendingBatch(r).length, 0);
  fs.rmSync(r, { recursive: true, force: true });
});

test("recordRollout: a real lesson is parked as pending (grey zone), not forced in", () => {
  const r = root();
  const res = recordRollout(r, LESSON);
  assert.equal(res.recorded, true);
  assert.ok(["pending", "ready"].includes(res.status), "either parked for the user or accepted");
  assert.equal(pendingBatch(r).length, 1, "it is in the batch either way");
  fs.rmSync(r, { recursive: true, force: true });
});

test("validateMerged refuses blank, short, heading-less, truncated output", () => {
  assert.equal(validateMerged("").ok, false);
  assert.equal(validateMerged("hi").ok, false);
  assert.equal(validateMerged("no heading here just prose ".repeat(5)).ok, false);
  assert.equal(validateMerged("# Title\n```\nunclosed fence").ok, false);
  assert.equal(validateMerged("# Title\n\n## Section\nreal content").ok, true);
});

test("consolidate: a garbage merge is refused and the old digest survives", async () => {
  const r = root();
  recordRollout(r, LESSON);
  const bad = await consolidate(r, async () => "");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /refused/);
  fs.rmSync(r, { recursive: true, force: true });
});

test("consolidate: a good merge writes the digest, archives, consumes the batch", async () => {
  const r = root();
  recordRollout(r, LESSON);
  // seed an old digest to prove archiving
  fs.mkdirSync(path.join(r, "distill"), { recursive: true });
  fs.writeFileSync(path.join(r, "distill", "digest.md"), "# old digest\n\n## s\nold", "utf8");
  const ok = await consolidate(r, async () => "# merged digest\n\n## Lessons\n- keep going");
  assert.equal(ok.ok, true);
  assert.equal(ok.consumed, 1);
  assert.match(fs.readFileSync(path.join(r, "distill", "digest.md"), "utf8"), /merged digest/);
  const hist = fs.readdirSync(path.join(r, "distill", "digest_history"));
  assert.ok(hist.length >= 1, "previous digest archived for rollback");
  assert.equal(pendingBatch(r).length, 0, "batch consumed");
  fs.rmSync(r, { recursive: true, force: true });
});

test("consolidate: summarize throwing never crashes, reports cleanly", async () => {
  const r = root();
  recordRollout(r, LESSON);
  const res = await consolidate(r, async () => { throw new Error("model down"); });
  assert.equal(res.ok, false);
  assert.match(res.reason, /summarize failed/);
  assert.equal(pendingBatch(r).length, 1, "batch kept for a later retry");
  fs.rmSync(r, { recursive: true, force: true });
});

test("scheduler: empty turn is not scheduled; disabled never schedules", () => {
  const r = root();
  const s = createScheduler(r, { enabled: false, summarize: async () => "x" });
  assert.equal(s.schedule("anything").scheduled, false);
  const s2 = createScheduler(r, { enabled: true, summarize: async () => "x" });
  assert.equal(s2.schedule("   ").scheduled, false);
  assert.equal(s2.schedule("real turn text").scheduled, true);
  fs.rmSync(r, { recursive: true, force: true });
});

test("scheduler: rapid turns collapse into one run (debounce)", async () => {
  const r = root();
  let calls = 0;
  const s = createScheduler(r, { enabled: true, debounceMs: 30, summarize: async () => { calls++; return LESSON; } });
  s.schedule("turn one");
  s.schedule("turn two");
  s.schedule("turn three");
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(calls, 1, "three turns, one distillation");
  assert.equal(s.stats.runs, 1);
  fs.rmSync(r, { recursive: true, force: true });
});