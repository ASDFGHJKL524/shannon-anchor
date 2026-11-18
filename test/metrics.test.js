// shannon-anchor — metrics tests. The measurement layer must answer "is this
// working" without becoming a second copy of the manual, and it must never
// break the caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  record, readEvents, aggregate, diagnose, writeSummary,
  eventsPath, summaryPath, textId, EVENT_KINDS
} from "../lib/metrics.js";

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-metrics-")); }

test("record appends one JSON line and readEvents returns it", () => {
  const root = tmpRoot();
  const line = record(root, "write", { id: "abc123", number: 5 });
  assert.ok(line);
  assert.equal(line.k, "write");
  assert.equal(line.id, "abc123");
  const events = readEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].k, "write");
  fs.rmSync(root, { recursive: true, force: true });
});

test("an unknown event kind is refused, not silently written", () => {
  const root = tmpRoot();
  assert.equal(record(root, "not-a-kind", {}), null);
  assert.equal(readEvents(root).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("long prose is reduced to a hash, never stored verbatim", () => {
  const root = tmpRoot();
  const prose = "This is a long sentence that would be a copy of the manual if it were kept in the metric log.";
  record(root, "search", { q: prose });
  const [e] = readEvents(root);
  assert.ok(!String(e.q).includes("copy of the manual"), "prose must not survive");
  assert.match(String(e.q), /^sha:[0-9a-f]{12}$/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("short identifiers survive intact", () => {
  const root = tmpRoot();
  record(root, "recall", { id: "deadbeef1234" });
  const [e] = readEvents(root);
  assert.equal(e.id, "deadbeef1234");
  fs.rmSync(root, { recursive: true, force: true });
});

test("objects are dropped rather than serialized blindly", () => {
  const root = tmpRoot();
  record(root, "write", { payload: { nested: "should not appear" }, number: 3 });
  const [e] = readEvents(root);
  assert.equal(e.payload, undefined);
  assert.equal(e.number, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a torn line does not break reading", () => {
  const root = tmpRoot();
  record(root, "write", { id: "a" });
  fs.appendFileSync(eventsPath(root), '{"t":"broken\n', "utf8");
  record(root, "write", { id: "b" });
  const events = readEvents(root);
  assert.equal(events.length, 2, "the two good lines survive, the torn one is skipped");
  fs.rmSync(root, { recursive: true, force: true });
});

test("record never throws on an unwritable root", () => {
  assert.equal(record("Z:\\definitely\\not\\a\\path\\\u0000bad", "write", {}), null);
});

test("textId is stable and does not reveal the text", () => {
  const a = textId("same text");
  const b = textId("same text");
  assert.equal(a, b);
  assert.equal(a.length, 12);
  assert.notEqual(textId("other text"), a);
});

test("aggregate computes the ratios that matter", () => {
  const root = tmpRoot();
  record(root, "write", { id: "w1" });
  record(root, "write", { id: "w2" });
  record(root, "write", { id: "w3" });
  record(root, "write", { id: "w4" });
  record(root, "recall", { id: "w1" });
  record(root, "search", { hits: 2 });
  record(root, "search", { hits: 0 });
  const s = aggregate(readEvents(root));
  assert.equal(s.writes, 4);
  assert.equal(s.recalls, 1);
  assert.equal(s.recallRatio, 0.25);
  assert.equal(s.searchHitRate, 0.5);
  assert.equal(s.distinctRecalled, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("aggregate counts integrity verdicts separately", () => {
  const root = tmpRoot();
  record(root, "integrity", { verdict: "accept" });
  record(root, "integrity", { verdict: "accept" });
  record(root, "integrity", { verdict: "review" });
  record(root, "integrity", { verdict: "reject" });
  const s = aggregate(readEvents(root));
  assert.deepEqual(s.integrity, { accept: 2, review: 1, reject: 1 });
  fs.rmSync(root, { recursive: true, force: true });
});

test("ratios are null, not zero, when there is nothing to divide", () => {
  const root = tmpRoot();
  record(root, "search", { hits: 1 });
  const s = aggregate(readEvents(root));
  assert.equal(s.recallRatio, null, "no writes means the ratio is undefined, not 0");
  fs.rmSync(root, { recursive: true, force: true });
});

test("diagnose names a hoarding problem", () => {
  const root = tmpRoot();
  for (let i = 0; i < 10; i++) record(root, "write", { id: `w${i}` });
  record(root, "recall", { id: "w0" });
  const notes = diagnose(aggregate(readEvents(root)));
  assert.ok(notes.some((n) => /recalls per write is low/.test(n)), notes.join(" | "));
  fs.rmSync(root, { recursive: true, force: true });
});

test("diagnose names a favourite-list problem", () => {
  const root = tmpRoot();
  record(root, "write", { id: "a" });
  for (let i = 0; i < 10; i++) record(root, "recall", { id: "a" });
  const notes = diagnose(aggregate(readEvents(root)));
  assert.ok(notes.some((n) => /favourite list/.test(n)), notes.join(" | "));
  fs.rmSync(root, { recursive: true, force: true });
});

test("diagnose says there is nothing to measure on an empty log", () => {
  const notes = diagnose(aggregate([]));
  assert.ok(notes.some((n) => /no events yet/.test(n)));
});

test("diagnose refuses to claim health just because nothing looks wrong", () => {
  const root = tmpRoot();
  record(root, "write", { id: "a" });
  record(root, "recall", { id: "a" });
  record(root, "forget", {});
  const notes = diagnose(aggregate(readEvents(root)));
  assert.ok(notes.some((n) => /not proof of usefulness/i.test(n)), notes.join(" | "));
  fs.rmSync(root, { recursive: true, force: true });
});

test("diagnose never turns a fire count over a search count into a fire rate", () => {
  // A search is the user asking for an entry on purpose, and the pre-step hook
  // runs per STEP not per turn — so neither is a denominator for turns, and
  // 20 fires against 2 searches does not mean "almost every turn".
  const root = tmpRoot();
  for (let i = 0; i < 20; i++) record(root, "predict", { topScore: 0.9, floor: 0.47 });
  record(root, "search", { hits: 0 });
  record(root, "search", { hits: 1 });
  const notes = diagnose(aggregate(readEvents(root)));
  assert.ok(!notes.some((n) => /almost every turn/.test(n)), notes.join(" | "));
  fs.rmSync(root, { recursive: true, force: true });
});

test("silent predictions are counted but never pollute the fired-score median", () => {
  // The whole point of a separate kind: predictTopScore answers "when it
  // speaks, how far above the bar is it?", and that reading dies the moment a
  // 0.525-that-stayed-quiet is mixed in with the accepted matches.
  const root = tmpRoot();
  // One fire BEFORE the silent kind existed, one after it. The pre-era fire has
  // no denominator because nothing was logged for quiet turns then; counting it
  // reported 0.95 on the live log when the windowed truth was 0.095.
  record(root, "predict", { topScore: 0.80, floor: 0.47 });
  record(root, "predict-silent", { gate: "thin-entry", best: 155, bestAbs: 0.589, floor: 0.47 });
  record(root, "predict", { topScore: 0.90, floor: 0.47 });
  record(root, "predict-silent", { gate: "floor", best: 64, bestAbs: 0.468, floor: 0.47 });
  record(root, "predict-silent", { gate: "too-short", best: 0, bestAbs: 0, floor: 0.47 });
  const s = aggregate(readEvents(root));
  assert.equal(s.predictFired, 2);
  assert.equal(s.predictSilent, 3);
  assert.deepEqual(s.predictGates, { "thin-entry": 1, floor: 1, "too-short": 1 });
  assert.equal(s.predictTopScore.n, 2);
  assert.equal(s.predictTopScore.median, 0.85);
  assert.equal(s.predictSilentBest.n, 3);
  assert.equal(s.predictSilentBest.scored, 2);
  // Median over the two turns that had a candidate, not over all three: the
  // too-short zero means "never scored", and folding it in describes the wrong
  // population.
  assert.ok(Math.abs(s.predictSilentBest.median - 0.5285) < 0.001, String(s.predictSilentBest.median));
  // 1 in-era fire against (1 fire + 3 silent). The pre-era fire is excluded.
  assert.equal(s.predictFiredSinceSilence, 1);
  assert.equal(s.predictFireRate, 0.25);
  // A turn killed before scoring (too-short) had no candidate to lose, so it
  // is out of both denominators: 2 silent turns scored, 1 of them at/above the
  // floor (0.589), the other 0.002 below it (0.468).
  assert.equal(s.predictSilentScored, 2);
  assert.equal(s.predictNearMiss, 1);
  // diagnose() must be able to READ this summary at all. The first version of
  // the near-miss note called .filter() on predictSilentBest — aggregate()
  // hands back {median,max,n}, not an array — and every summary containing a
  // silent event threw, including writeSummary()'s own path. An end-to-end
  // probe caught it; this line is what keeps it caught.
  const notes = diagnose(s);
  assert.ok(notes.some((n) => /threshold was not what stopped them/.test(n)), notes.join(" | "));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a near-miss is judged against the floor its own turn was scored with", () => {
  // The floor moved 0.47 -> 0.46 on 2026-11-01. Counting near-misses against
  // whatever floor the log ENDS on re-scores old turns against a rule they never
  // saw: a turn refused under its own 0.60 bar becomes a "near miss" the moment
  // the bar drops below its score. Each event carries its floor; use it.
  const root = tmpRoot();
  // Scored under a 0.60 bar and refused there: 0.50 is a real miss for that turn.
  record(root, "predict-silent", { gate: "floor", best: 1, bestAbs: 0.50, floor: 0.60 });
  // Scored under the current 0.46 bar and above it: a genuine near miss.
  record(root, "predict-silent", { gate: "thin-entry", best: 2, bestAbs: 0.47, floor: 0.46 });
  // No candidate at all: never a near miss, whatever the floor says.
  record(root, "predict-silent", { gate: "too-short", best: 0, bestAbs: 0, floor: 0.46 });
  const s = aggregate(readEvents(root));
  assert.equal(s.predictSilent, 3);
  assert.equal(s.predictNearMiss, 1, "only the turn that cleared its own floor counts");
  assert.equal(s.predictFloor, 0.46, "the reported floor is still the latest one");
  fs.rmSync(root, { recursive: true, force: true });
});

test("writeSummary produces a readable snapshot file", () => {
  const root = tmpRoot();
  record(root, "write", { id: "a" });
  const r = writeSummary(root);
  assert.ok(fs.existsSync(summaryPath(root)));
  const onDisk = JSON.parse(fs.readFileSync(summaryPath(root), "utf8"));
  assert.equal(onDisk.summary.writes, 1);
  assert.ok(Array.isArray(onDisk.notes));
  assert.ok(onDisk.generatedAt);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readEvents limit keeps the tail, not the head", () => {
  const root = tmpRoot();
  for (let i = 0; i < 5; i++) record(root, "write", { id: `w${i}` });
  const tail = readEvents(root, { limit: 2 });
  assert.equal(tail.length, 2);
  assert.equal(tail[1].id, "w4");
  fs.rmSync(root, { recursive: true, force: true });
});

test("every documented event kind is accepted", () => {
  const root = tmpRoot();
  for (const k of EVENT_KINDS) assert.ok(record(root, k, {}), `${k} should be recordable`);
  fs.rmSync(root, { recursive: true, force: true });
});
