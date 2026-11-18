// shannon-anchor — candidates share the forgetting engine's heat: every recall
// is a mention, and a candidate that keeps being mentioned warms up. Heat is
// a triage signal, not proof — promotion still needs an explicit call.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEntry } from "../lib/entries.js";
import { guardedWrite } from "../lib/guard.js";
import { loadManual } from "../lib/manual_store.js";
import { candidates } from "../lib/curate.js";
import { countUsage } from "../lib/forget.js";

function mkRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-heat-")); }

function addEntry(root, { number, title, body, confidence = "agent-inferred" }) {
  const e = parseEntry({ number, title, body, source: "test fixture", created: "2026-10-18", confidence });
  guardedWrite(root, e, { guard: false });
}

async function applyWith(root) {
  const mod = await import("../lib/index.js?t=" + Date.now());
  const registered = [];
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(["info", m]), warn: (m) => logs.push(["warn", m]) },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section() {} },
    on() {}
  };
  mod.apply(ctx, { manualRoot: root });
  return { registered, logs };
}

test("candidates: heat starts at 0 and grows with countUsage", () => {
  const root = mkRoot();
  addEntry(root, { number: 3, title: "候选条", body: "这条还是候选，被召回几次之后热度应该上涨。" });
  assert.equal(candidates(loadManual(root))[0].heat, 0);
  countUsage(root, 3);
  countUsage(root, 3);
  const c = candidates(loadManual(root))[0];
  assert.ok(c.heat > 0, `heat ${c.heat}`);
  assert.equal(c.number, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test("memory_recall: a candidate comes back with its heat and the promote hint", async () => {
  const root = mkRoot();
  addEntry(root, { number: 4, title: "候选条", body: "这条还是候选，召回时应当看到热度和转正提示。" });
  const { registered } = await applyWith(root);
  const recall = registered.find((t) => t.name === "memory_recall");
  const res = await recall.execute({ number: 4 });
  assert.match(res.text, /\[候选 · 热度 /);
  assert.match(res.text, /memory_curate promote/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("boot reports candidates hot enough to promote", async () => {
  const root = mkRoot();
  addEntry(root, { number: 5, title: "候选条", body: "热度够了启动时应当被点名，提醒转正。" });
  fs.writeFileSync(path.join(root, "stats.json"), JSON.stringify({ "5": { count: 2.5, lastUsed: "2026-10-18", tier: 1 } }), "utf8");
  fs.mkdirSync(path.join(root, "conf"), { recursive: true });
  fs.writeFileSync(path.join(root, "conf", "user.json"), JSON.stringify({ candidatePromoteHeat: 2 }), "utf8");
  const { logs } = await applyWith(root);
  assert.ok(logs.some(([, m]) => /hot enough to promote/.test(m) && /#5/.test(m)), JSON.stringify(logs));
  fs.rmSync(root, { recursive: true, force: true });
});

test("memory_forget candidates: the table carries the heat column", async () => {
  const root = mkRoot();
  addEntry(root, { number: 6, title: "候选条", body: "列表里也应该有热度列，方便排序复核。" });
  const { registered } = await applyWith(root);
  const forget = registered.find((t) => t.name === "memory_forget");
  const res = await forget.execute({ action: "candidates" });
  assert.match(res.text, /\| heat \|/);
  fs.rmSync(root, { recursive: true, force: true });
});
