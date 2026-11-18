// Wiring: does the sweep actually run through the real tool, not just as a
// function in isolation? The unit tests prove the mechanics; this proves the
// plugin calls them.
//
// The specific risk: expiry is deliberately timer-free (plan §2B.3), so it only
// happens if a real read path calls the sweep. A sweep that exists but is never
// invoked looks exactly like a working one in unit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DAY = 86400e3;

async function freshApply(opts = {}) {
  const mod = await import("../lib/index.js?t=" + Date.now());
  const registered = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pagi-evict-wire-"));
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  if (opts.userConfig) {
    fs.writeFileSync(path.join(conf, "user.json"), JSON.stringify(opts.userConfig, null, 2), "utf8");
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section() {} },
    on() {}
  };
  mod.apply(ctx, { manualRoot: root });
  const tool = (name) => {
    const t = registered.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} was not registered`);
    return t;
  };
  return { root, tool };
}

function seedOldTurn(root, { days = 10, turn = 1, text = "old queued turn" } = {}) {
  const p = path.join(root, "distill", "pending.jsonl");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({
      queue_id: String(turn),
      status: "pending",
      ts: new Date(Date.now() - days * DAY).toISOString(),
      turn,
      chars: text.length,
      preview: text,
      hash: String(turn)
    }) + "\n",
    "utf8"
  );
  return p;
}

test("memory_distill status marks an expired turn expired_unreviewed", async () => {
  const { root, tool } = await freshApply();
  const p = seedOldTurn(root, { days: 10, turn: 42 });
  assert.equal(fs.readFileSync(p, "utf8").trim().split("\n").length, 1);

  const r = await tool("memory_distill").execute({ action: "status" });
  assert.equal(r.count, 1, "expired_unreviewed still counts toward outstanding");
  assert.match(r.text, /old queued turn/);

  // ...and it left a trail: cleared.jsonl says expired, not "the file vanished".
  const arch = fs
    .readFileSync(path.join(root, "distill", "cleared.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(arch.length, 1);
  assert.equal(arch[0].kind, "expired");
  assert.equal(arch[0].count, 1);
  assert.equal(arch[0].items[0].turn, 42);
  fs.rmSync(root, { recursive: true, force: true });
});

test("memory_distill action=evicted reports the account", async () => {
  const { root, tool } = await freshApply();
  seedOldTurn(root, { days: 10, turn: 7 });
  await tool("memory_distill").execute({ action: "status" });
  const r = await tool("memory_distill").execute({ action: "evicted" });
  assert.match(r.text, /distill evicted 1/, r.text);
  assert.match(r.text, /expired/, r.text);
  assert.equal(r.stats.distill.n, 1);
  assert.equal(r.stats.distill.byReason.expired, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("observe:true makes status record the intent and keep the turn", async () => {
  const { root, tool } = await freshApply({ userConfig: { evict: { observe: true } } });
  const p = seedOldTurn(root, { days: 10, turn: 8 });

  const r = await tool("memory_distill").execute({ action: "status" });
  assert.equal(r.count, 1, "observe mode must not clear the queue");
  assert.equal(fs.readFileSync(p, "utf8").trim().split("\n").length, 1);
  assert.equal(fs.existsSync(path.join(root, "distill", "cleared.jsonl")), false);

  const obs = fs
    .readFileSync(path.join(root, "metrics", "observe.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(obs.length, 1);
  assert.equal(obs[0].what, "expire-distill");
  assert.equal(obs[0].wouldHave, "skip");
  assert.ok(obs[0].ageDays >= 9, JSON.stringify(obs[0]));

  // Reading twice must not double-count: the ledger would otherwise measure how
  // often status was called.
  await tool("memory_distill").execute({ action: "status" });
  const obs2 = fs.readFileSync(path.join(root, "metrics", "observe.jsonl"), "utf8").trim().split("\n");
  assert.equal(obs2.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a window of 0 disables expiry rather than clearing the queue", async () => {
  const { root, tool } = await freshApply({
    userConfig: { evict: { observe: false, distillExpireDays: 0 } }
  });
  seedOldTurn(root, { days: 999, turn: 9 });
  const r = await tool("memory_distill").execute({ action: "status" });
  assert.equal(r.count, 1, "expireDays 0 must be off, not infinite");
  fs.rmSync(root, { recursive: true, force: true });
});
