// shannon-anchor — hash chain wiring: the chain must exist at runtime.
// The bug this pins: computeChain/verifyChain were imported but never
// called, chain.txt was never written, and memory_write's claim of a
// one-transaction baseline update was false. Fixed 2026-10-18 (定制版):
// boot verifies then re-anchors; memory_write and the delete guard
// refresh after a successful change.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyChain } from "../lib/hash_chain.js";

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-chain-"));
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(
    new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  return root;
}

function stubCtx(warnings) {
  const registered = [];
  const ctx = {
    logger: { info() {}, warn: (m) => warnings.push(m) },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: () => {} },
    on: () => {}
  };
  return { ctx, registered };
}

async function freshApply() {
  const mod = await import("../lib/index.js?t=" + Date.now());
  const root = mkRoot();
  const warnings = [];
  const { ctx, registered } = stubCtx(warnings);
  mod.apply(ctx, { manualRoot: root });
  return { mod, root, warnings, registered };
}

test("boot anchors the chain file", async () => {
  const { root } = await freshApply();
  assert.ok(fs.existsSync(path.join(root, "chain.txt")), "chain.txt must exist after apply()");
  assert.equal(verifyChain(root).ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("memory_write refreshes the chain in the same call", async () => {
  const { registered, root } = await freshApply();
  const w = registered.find((t) => t.name === "memory_write");
  const r = await w.execute({ title: "chained write", body: "body text", source: "test" });
  assert.ok(!r.error, `write should succeed: ${r.error}`);
  const chain = fs.readFileSync(path.join(root, "chain.txt"), "utf8");
  assert.match(chain, /1\.md/, "the new entry must appear in the chain");
  assert.equal(verifyChain(root).ok, true, "chain must verify right after a routed write");
  fs.rmSync(root, { recursive: true, force: true });
});

test("boot warns about unrouted drift, then re-anchors", async () => {
  const { mod, root, registered } = await freshApply();
  const w = registered.find((t) => t.name === "memory_write");
  const r = await w.execute({ title: "tamper me", body: "original", source: "test" });
  assert.ok(!r.error);
  const f = path.join(root, "manual", r.path);
  fs.appendFileSync(f, "\nsneaky edit\n", "utf8");

  const v = verifyChain(root);
  assert.equal(v.ok, false, "verify must see the unrouted edit");
  assert.ok(v.problems.some((p) => /content changed|size changed/.test(p)));

  const warnings = [];
  const { ctx } = stubCtx(warnings);
  mod.apply(ctx, { manualRoot: root });
  assert.ok(warnings.some((m) => /hash chain problems/.test(m)), "boot must log the drift");
  assert.equal(verifyChain(root).ok, true, "boot re-anchors after reporting");
  fs.rmSync(root, { recursive: true, force: true });
});
