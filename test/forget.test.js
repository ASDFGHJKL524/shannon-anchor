// shannon-anchor — forgetting tests.
// The rules this file defends: decay not reset, gradual demotion,
// low-frequency never auto-demoted, forgetting never destroys.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { countUsage, sweep, markLowFrequency, listForgotten, recallForgotten, tierOf, statsPath, DEMOTE_DAYS } from "../lib/forget.js";
import { loadManual } from "../lib/manual_store.js";

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-forget-")); }
function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}
function seedStats(r, obj) {
  fs.mkdirSync(path.dirname(statsPath(r)), { recursive: true });
  fs.writeFileSync(statsPath(r), JSON.stringify(obj), "utf8");
}
function entry(n, confidence = "agent-inferred") {
  return { number: n, title: "t", path: `04-experience/${n}.md`, created: isoDaysAgo(200), bytes: 100, superseded: false, confidence };
}
function manual(nums) {
  return { root: "", entries: nums.map((n) => entry(n)) };
}

test("counting decays, never resets", () => {
  const r = root();
  seedStats(r, { "1": { count: 2.0, lastUsed: isoDaysAgo(10), tier: 1 } });
  countUsage(r, 1);
  const s = JSON.parse(fs.readFileSync(statsPath(r), "utf8"));
  // 2.0 * 0.7 + 1 = 2.4 — decayed first, then the hit
  assert.ok(Math.abs(s["1"].count - 2.4) < 1e-9, "decay then add, not reset");
  assert.equal(s["1"].lastUsed, new Date().toISOString().slice(0, 10));
  fs.rmSync(r, { recursive: true, force: true });
});

test("a long silence cannot be undone by one reference", () => {
  const r = root();
  seedStats(r, { "1": { count: 10.0, lastUsed: isoDaysAgo(90), tier: 1 } });
  countUsage(r, 1);
  const s = JSON.parse(fs.readFileSync(statsPath(r), "utf8"));
  assert.ok(s["1"].count < 10, "one hit after 90 days quiet does not restore an old peak (10 -> 8)");
  fs.rmSync(r, { recursive: true, force: true });
});

test("demotion follows 7/30/90 and never skips a tier", () => {
  const r = root();
  seedStats(r, {
    "1": { count: 1, lastUsed: isoDaysAgo(8), tier: 1 },
    "2": { count: 1, lastUsed: isoDaysAgo(31), tier: 1 },
    "3": { count: 1, lastUsed: isoDaysAgo(200), tier: 1 }
  });
  const res = sweep(r, manual([1, 2, 3]));
  // 8 days idle -> tier 2 (not 3 directly)
  const d1 = res.demoted.find((d) => d.number === 1);
  assert.equal(d1.to, 2);
  fs.rmSync(r, { recursive: true, force: true });
});

test("low-frequency entries never auto-demote", () => {
  const r = root();
  seedStats(r, { "1": { count: 0, lastUsed: isoDaysAgo(400), tier: 1, lowFreq: true } });
  const res = sweep(r, manual([1]));
  assert.equal(res.demoted.length, 0);
  assert.equal(res.forgotten.length, 0);
  const s = JSON.parse(fs.readFileSync(statsPath(r), "utf8"));
  assert.equal(s["1"].tier, 1, "low-frequency means seasonal, not worthless");
  fs.rmSync(r, { recursive: true, force: true });
});

test("being referenced lifts a demoted entry straight back to tier 1", () => {
  const r = root();
  seedStats(r, { "1": { count: 0, lastUsed: isoDaysAgo(40), tier: 3 } });
  countUsage(r, 1);
  const s = JSON.parse(fs.readFileSync(statsPath(r), "utf8"));
  assert.equal(s["1"].tier, 1);
  fs.rmSync(r, { recursive: true, force: true });
});

test("forgetting moves bytes out of the index but never destroys them", () => {
  const r = root();
  const mdir = path.join(r, "manual", "04-experience");
  fs.mkdirSync(mdir, { recursive: true });
  fs.writeFileSync(path.join(mdir, "1.md"), "keep me", "utf8");
  seedStats(r, { "1": { count: 1, lastUsed: isoDaysAgo(400), tier: 3 } });
  const res = sweep(r, manual([1]));
  assert.equal(res.forgotten.length, 1);
  const list = listForgotten(r);
  assert.equal(list.length, 1);
  assert.equal(fs.readFileSync(path.join(r, "forgotten", list[0]), "utf8"), "keep me", "bytes survive");
  fs.rmSync(r, { recursive: true, force: true });
});

test("a forgotten entry can be recalled, and comes back hot", () => {
  const r = root();
  const fdir = path.join(r, "forgotten");
  fs.mkdirSync(fdir, { recursive: true });
  fs.writeFileSync(path.join(fdir, "04-experience_1.md"), "keep me", "utf8");
  const ok = recallForgotten(r, "04-experience_1.md", "04-experience/1.md");
  assert.equal(ok, true);
  assert.equal(fs.existsSync(path.join(r, "manual", "04-experience", "1.md")), true);
  const s = JSON.parse(fs.readFileSync(statsPath(r), "utf8"));
  assert.equal(s["1"].tier, 1, "recalled = hot again");
  fs.rmSync(r, { recursive: true, force: true });
});

test("markLowFrequency protects an entry from here on", () => {
  const r = root();
  markLowFrequency(r, 7, true);
  seedStats(r, { "7": { count: 0, lastUsed: isoDaysAgo(500), tier: 1, lowFreq: true } });
  const res = sweep(r, manual([7]));
  assert.equal(res.forgotten.length, 0);
  fs.rmSync(r, { recursive: true, force: true });
});

test("confidence sets the clock: confirmed entries decay slower than inferred ones", () => {
  const r = root();
  seedStats(r, {
    "1": { count: 1, lastUsed: isoDaysAgo(20), tier: 1 },
    "2": { count: 1, lastUsed: isoDaysAgo(20), tier: 1 }
  });
  const m = { root: "", entries: [entry(1, "agent-inferred"), entry(2, "user-confirmed")] };
  const res = sweep(r, m, {
    byConfidence: {
      "agent-inferred": { tier1_to_2: 15, tier2_to_3: 45 },
      "user-confirmed": { tier1_to_2: 30, tier2_to_3: 90 }
    }
  });
  assert.equal(res.demoted.find((d) => d.number === 1).to, 2, "20 idle is past the inferred 15-day clock");
  assert.equal(res.demoted.find((d) => d.number === 2), undefined, "20 idle is inside the confirmed 30-day clock");
  fs.rmSync(r, { recursive: true, force: true });
});

test("loadManual carries confidence so the sweep can weigh it", () => {
  const r = root();
  const dir = path.join(r, "manual", "04-experience");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "1.md"), [
    "### 1. confirmed fact",
    "",
    "<!-- source: test fixture -->",
    "<!-- created: 2026-01-01 -->",
    "<!-- confidence: user-confirmed -->",
    "",
    "body"
  ].join("\n"), "utf8");
  assert.equal(loadManual(r).entries[0].confidence, "user-confirmed");
  fs.rmSync(r, { recursive: true, force: true });
});

test("thresholds are overridable", () => {
  const r = root();
  seedStats(r, { "1": { count: 1, lastUsed: isoDaysAgo(3), tier: 1 } });
  const res = sweep(r, manual([1]), { thresholds: { tier1_to_2: 2, tier2_to_3: 5, tier3_to_forgotten: 10 } });
  assert.equal(res.demoted[0].to, 2, "a custom 2-day rule demotes a 3-day-idle entry");
  fs.rmSync(r, { recursive: true, force: true });
});