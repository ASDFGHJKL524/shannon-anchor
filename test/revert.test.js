// shannon-anchor — revert paths: link -> unlink and promote -> demote are both
// append-only. The reader takes the LAST link marker as current state, and
// the candidate scanner reads the whole body.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEntry } from "../lib/entries.js";
import { guardedWrite } from "../lib/guard.js";
import { loadManual, readEntry } from "../lib/manual_store.js";
import { linkEntry, unlinkEntry, promoteEntry, demoteEntry, candidates, proseOf } from "../lib/curate.js";
import { verifyChain } from "../lib/hash_chain.js";

function mkRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-revert-")); }

function addEntry(root, { number, title, body, confidence = "user-confirmed" }) {
  const e = parseEntry({ number, title, body, source: "test fixture", created: "2026-10-18", confidence });
  guardedWrite(root, e, { guard: false });
  return e;
}

async function applyWith(root) {
  const mod = await import("../lib/index.js?t=" + Date.now());
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section() {} },
    on() {}
  };
  mod.apply(ctx, { manualRoot: root });
  return registered;
}

test("unlink: reverts a link and restores the active state, prose untouched", () => {
  const root = mkRoot();
  addEntry(root, { number: 1, title: "旧规矩", body: "删除之前先逐个列名，不许用通配符。" });
  addEntry(root, { number: 2, title: "新规矩", body: "删除前必须逐个列名，选和删分两步，不许通配符。" });
  const proseBefore = proseOf(readEntry(loadManual(root), 1).body);

  const lk = linkEntry(root, { target: 1, newNumber: 2, evidence: "新条取代旧条" });
  assert.equal(lk.ok, true);
  assert.equal(loadManual(root).entries.find((e) => e.number === 1).superseded, true);

  const ul = unlinkEntry(root, { number: 1, reason: "标错了，两条是互补不是取代" });
  assert.equal(ul.ok, true, ul.reason);
  assert.equal(loadManual(root).entries.find((e) => e.number === 1).superseded, false);
  assert.equal(proseOf(readEntry(loadManual(root), 1).body), proseBefore);
  const text = fs.readFileSync(path.join(root, "manual", lk.path), "utf8");
  assert.match(text, /link_reverted/);
  assert.match(text, /superseded_by/, "the original marker stays — append-only");
  fs.rmSync(root, { recursive: true, force: true });
});

test("unlink: refuses when the entry is not linked", () => {
  const root = mkRoot();
  addEntry(root, { number: 1, title: "独条", body: "这条没有链接，回滚应当被拒绝。" });
  const r = unlinkEntry(root, { number: 1, reason: "试试" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not linked/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("demote: revokes a promotion and restores the candidate state", () => {
  const root = mkRoot();
  addEntry(root, { number: 3, title: "候选条", body: "这条先是候选，转正之后又被认为证据不足。", confidence: "agent-inferred" });
  assert.equal(candidates(loadManual(root)).length, 1);

  const pr = promoteEntry(root, 3, { evidence: "按它做对了一次" });
  assert.equal(pr.ok, true, pr.reason);
  assert.equal(candidates(loadManual(root)).length, 0);

  const dm = demoteEntry(root, { number: 3, reason: "后来发现那次成功是巧合" });
  assert.equal(dm.ok, true, dm.reason);
  const again = candidates(loadManual(root));
  assert.equal(again.length, 1);
  assert.equal(again[0].number, 3);
  assert.equal(loadManual(root).entries.find((e) => e.number === 3).superseded, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("demote: refuses when there is no promotion to revoke", () => {
  const root = mkRoot();
  addEntry(root, { number: 4, title: "从未转正", body: "没有 promoted 行，撤销转正应当被拒绝。", confidence: "user-confirmed" });
  const r = demoteEntry(root, { number: 4, reason: "试试" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no promotion/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("memory_curate tool: link then unlink keeps the chain consistent", async () => {
  const root = mkRoot();
  addEntry(root, { number: 1, title: "旧规矩", body: "删除之前先逐个列名，不许用通配符。" });
  addEntry(root, { number: 2, title: "新规矩", body: "删除前必须逐个列名，选和删分两步，不许通配符。" });
  const tools = await applyWith(root);
  const curate = tools.find((t) => t.name === "memory_curate");

  const lk = await curate.execute({ action: "link", target: 1, newNumber: 2, evidence: "新条取代旧条" });
  assert.ok(!lk.error, lk.error);
  const ul = await curate.execute({ action: "unlink", target: 1, evidence: "标错了要回滚" });
  assert.ok(!ul.error, ul.error);
  const chk = verifyChain(root);
  assert.equal(chk.ok, true, JSON.stringify(chk.problems));
  fs.rmSync(root, { recursive: true, force: true });
});
