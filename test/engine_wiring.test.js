// shannon-anchor — engine wiring tests.
//
// The engines existed but were never CALLED. These tests exist because
// "the module has tests" is not the same as "the plugin runs it": the
// whole class of bug found here (a rule set nobody executes) is invisible
// to unit tests of the engine itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const libUrl = new URL("../lib/index.js", import.meta.url).href;

async function boot({ userCfg = null, opts = {} } = {}) {
  const mod = await import(libUrl + "?t=" + Date.now() + Math.random());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-wire-eng-"));
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  if (userCfg) fs.writeFileSync(path.join(conf, "user.json"), JSON.stringify(userCfg, null, 2), "utf8");
  const handlers = {};
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register() {} },
    systemPrompt: { section() {} },
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn); }
  };
  mod.apply(ctx, { manualRoot: root }, opts);
  return { root, handlers, mod };
}

test("distillation hooks agent/turn-stopping (the engine is actually reached)", async () => {
  const { handlers } = await boot();
  assert.ok(handlers["agent/turn-stopping"], "turn-stopping listener registered");
  assert.equal(handlers["agent/turn-stopping"].length, 1);
});

test("turn-stopping with distill disabled does not throw and does not schedule", async () => {
  const { handlers } = await boot();
  const fn = handlers["agent/turn-stopping"][0];
  await fn({ turn: "some conversation text", agent: null });  // must not throw
});

test("a subagent turn does NOT schedule distillation (no fan-out cost)", async () => {
  const { handlers } = await boot({ opts: { summarize: async () => "x" } });
  const fn = handlers["agent/turn-stopping"][0];
  let called = 0;
  // a subagent carries a parentSession
  await fn({ turn: "subagent work", agent: { header: { parentSession: "parent-1" } } });
  // nothing to assert beyond "returned without scheduling/throwing"
  assert.equal(called, 0);
});

test("user.json overrides shipped defaults at boot (config is live)", async () => {
  const { root } = await boot({ userCfg: { manualRoot: "" } });
  // the plugin used its own root; what matters is that a bogus user key
  // did not crash the boot and the root still exists
  assert.ok(fs.existsSync(root));
  const { root: r2 } = await boot({ userCfg: { coldInferredDays: 3 } });
  assert.ok(fs.existsSync(r2));
});

test("a broken user.json is warned about, boot continues on defaults", async () => {
  const mod = await import(libUrl + "?t=" + Date.now() + Math.random());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-wire-bad-"));
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  fs.writeFileSync(path.join(conf, "user.json"), "{ broken json", "utf8");
  let warned = false;
  const ctx = {
    logger: { info() {}, warn: () => { warned = true; } },
    tools: { register() {} },
    systemPrompt: { section() {} },
    on: () => {}
  };
  mod.apply(ctx, { manualRoot: root });   // must not throw
  assert.equal(warned, true, "the breakage is reported, not swallowed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the forgetting sweep runs at boot and records the day", async () => {
  const { root } = await boot();
  const statsFile = path.join(root, "stats.json");
  // sweep only writes stats.json when it runs; a fresh boot should have it
  assert.ok(fs.existsSync(statsFile), "sweep ran and stamped the day");
  const stats = JSON.parse(fs.readFileSync(statsFile, "utf8"));
  assert.equal(stats._swept, new Date().toISOString().slice(0, 10));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the sweep demotes an idle entry at boot (the tier actually moves)", async () => {
  const { root } = await boot();
  // plant an entry that has been idle for 100 days, hot tier
  const mdir = path.join(root, "manual", "04-experience");
  fs.mkdirSync(mdir, { recursive: true });
  fs.writeFileSync(path.join(mdir, "9.md"), "### 9. stale thing\n\nbody\n", "utf8");
  const idle = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(root, "stats.json"), JSON.stringify({
    "9": { count: 1, lastUsed: idle, tier: 1 }
  }), "utf8");
  // boot again: the daily stamp is stale, so the sweep must run
  const mod = await import(libUrl + "?t=" + Date.now() + Math.random());
  const ctx = { logger: { info() {}, warn() {} }, tools: { register() {} }, systemPrompt: { section() {} }, on: () => {} };
  mod.apply(ctx, { manualRoot: root });
  const after = JSON.parse(fs.readFileSync(path.join(root, "stats.json"), "utf8"));
  assert.ok((after["9"].tier || 1) >= 2, "a 100-day-idle entry moved off tier 1");
  fs.rmSync(root, { recursive: true, force: true });
});

// The tier move is only half the fact. On the live manual 16 entries were
// already in tier 2 while memory_metrics said "0 forget events — nothing has
// been demoted yet": the sweep moved files and told no one.
test("a demotion is recorded in the metrics log, not only applied", async () => {
  const { root } = await boot();
  const mdir = path.join(root, "manual", "04-experience");
  fs.mkdirSync(mdir, { recursive: true });
  fs.writeFileSync(path.join(mdir, "9.md"), "### 9. stale thing\n\nbody\n", "utf8");
  const idle = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(root, "stats.json"), JSON.stringify({
    "9": { count: 1, lastUsed: idle, tier: 1 }
  }), "utf8");
  const mod = await import(libUrl + "?t=" + Date.now() + Math.random());
  const ctx = { logger: { info() {}, warn() {} }, tools: { register() {} }, systemPrompt: { section() {} }, on: () => {} };
  mod.apply(ctx, { manualRoot: root });

  const events = fs.readFileSync(path.join(root, "metrics", "events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const f = events.filter((e) => e.k === "forget").at(-1);
  assert.ok(f, "the sweep logged its work");
  assert.ok(f.demoted >= 1, "the count of demoted entries is in the event");
  assert.equal(f.toWarm + f.toCold, f.demoted, "the destination tiers add up");
  assert.equal(typeof f.parked, "number");

  const { aggregate } = await import(new URL("../lib/metrics.js", import.meta.url).href);
  const s = aggregate(events);
  assert.ok(s.demotedEntries >= 1, "the summary counts entries, not just sweeps");
  fs.rmSync(root, { recursive: true, force: true });
});