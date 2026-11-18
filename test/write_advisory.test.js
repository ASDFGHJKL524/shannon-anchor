// shannon-anchor — memory_write shape advisory: the write is never blocked, but
// the response must carry the near-duplicate evidence so the "new entry vs
// merge/link" decision is made before a duplicate exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEntry } from "../lib/entries.js";
import { guardedWrite } from "../lib/guard.js";

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-advisory-"));
}

function addEntry(root, { number, title, body }) {
  const e = parseEntry({ number, title, body, source: "test fixture", created: "2026-10-18", confidence: "user-confirmed" });
  guardedWrite(root, e, { guard: false });
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
  return registered.find((t) => t.name === "memory_write");
}

const DEL_GUARD = "删除任何东西之前先逐个列名，不许用通配符，选和删分两步。";

test("memory_write: a paraphrase carries the near-duplicate advisory but still writes", async () => {
  const root = mkRoot();
  addEntry(root, { number: 1, title: "删除守卫", body: DEL_GUARD });
  const write = await applyWith(root);
  const res = await write.execute({
    title: "删文件要两步走",
    body: "删除东西之前必须先把要删的逐个列出来，不许用通配符；选择和删除分成两步做。",
    source: "test"
  });
  assert.ok(res.number, `write failed: ${res.error || res.text}`);
  assert.match(res.text, /写前形状检查/);
  assert.match(res.text, /#1/);
  assert.equal(fs.existsSync(path.join(root, "manual", "04-experience", `${res.number}.md`)) ||
               fs.existsSync(path.join(root, "manual", "01-rules", `${res.number}.md`)) ||
               fs.existsSync(path.join(root, "manual", "03-machine", `${res.number}.md`)) ||
               fs.existsSync(path.join(root, "manual", "02-method", `${res.number}.md`)), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("memory_write: an unrelated body writes with no advisory", async () => {
  const root = mkRoot();
  addEntry(root, { number: 1, title: "删除守卫", body: DEL_GUARD });
  const write = await applyWith(root);
  const res = await write.execute({
    title: "生图提示词顺序",
    body: "写生图提示词时先写镜头再写光线，模型对顺序敏感，反过来容易糊。",
    source: "test"
  });
  assert.ok(res.number, `write failed: ${res.error || res.text}`);
  assert.doesNotMatch(res.text, /写前形状检查/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("memory_write: a too-short body does not crash the advisory", async () => {
  const root = mkRoot();
  const write = await applyWith(root);
  const res = await write.execute({ title: "短", body: "好", source: "test" });
  assert.ok(res.number || res.error, "either written or refused, never a throw");
  fs.rmSync(root, { recursive: true, force: true });
});
