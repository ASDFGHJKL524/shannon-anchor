// shannon-anchor — the prediction corpus cache. What must hold: it is an
// optimisation, never a source of stale answers. A routed write refreshes
// chain.txt, so the next step must see the new entry; two roots must never
// score each other's library; and the pre-step hook must not record the same
// prediction once per model step.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEvents } from "../lib/metrics.js";

async function boot(extra = {}, user = null) {
  const mod = await import("../lib/index.js?t=" + Date.now() + "-" + Math.random());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-corpus-"));
  if (user) {
    fs.mkdirSync(path.join(root, "conf"), { recursive: true });
    fs.writeFileSync(path.join(root, "conf", "user.json"), JSON.stringify(user, null, 2), "utf8");
  }
  const registered = [];
  const hooks = {};
  let section = null;
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: (s) => { if (s.name === "shannon-anchor-predict") section = s; } },
    on: (name, fn) => { hooks[name] = fn; }
  };
  mod.apply(ctx, {
    manualRoot: root,
    predict: { enabled: true, floor: 0.05, limit: 3, turns: 1 },
    ...extra
  });
  return { root, registered, hooks, text: () => (section ? section.text() : "") };
}

async function step(hooks, text) {
  const handler = hooks["agent/pre-step"];
  assert.ok(handler, "the pre-step hook must be registered when prediction is on");
  return handler({ agent: { header: {} } }, async () => ({
    messages: [{ role: "user", content: [{ type: "text", text }] }]
  }));
}

function write(booted, title, body) {
  const w = booted.registered.find((t) => t.name === "memory_write");
  assert.ok(w, "memory_write must be registered");
  return w.execute({ title, body, source: "corpus cache test" });
}

const BACKUP_Q = "备份密码放在哪块盘上比较安全";
const BREAD_Q = "面包烘焙温度要设多少度";

test("a routed write invalidates the cached corpus", async () => {
  const b = await boot();
  await step(b.hooks, BACKUP_Q);
  assert.equal(b.text(), "", "an empty manual must stay silent");

  const r = await write(b, "备份包和密码分开存放",
    "备份包和密码必须分开存放，不能放在同一块盘上，避免一起坏掉。");
  assert.ok(!r.error, `write failed: ${r.error}`);

  await step(b.hooks, BACKUP_Q);
  assert.match(b.text(), /#1\b/, "the step after the write must see the new entry");
  fs.rmSync(b.root, { recursive: true, force: true });
});

test("two roots never share a corpus", async () => {
  const a = await boot();
  await write(a, "备份包和密码分开存放",
    "备份包和密码必须分开存放，不能放在同一块盘上，避免一起坏掉。");
  await step(a.hooks, BACKUP_Q);
  assert.match(a.text(), /#1\b/, "root A should predict its own entry");

  const b = await boot();
  await step(b.hooks, BACKUP_Q);
  assert.equal(b.text(), "", "root B is empty and must not borrow root A's library");

  fs.rmSync(a.root, { recursive: true, force: true });
  fs.rmSync(b.root, { recursive: true, force: true });
});

test("metrics count a prediction once, not once per model step", async () => {  const b = await boot();
  await write(b, "备份包和密码分开存放",
    "备份包和密码必须分开存放，不能放在同一块盘上，避免一起坏掉。");

  await step(b.hooks, BACKUP_Q);
  await step(b.hooks, BACKUP_Q); // a tool-call loop: same turn, same context
  const after1 = readEvents(b.root).filter((e) => e.k === "predict");
  assert.equal(after1.length, 1, `got ${after1.length} predict events for one turn`);

  await step(b.hooks, BACKUP_Q + " 还有别的办法吗");
  const after2 = readEvents(b.root).filter((e) => e.k === "predict");
  assert.equal(after2.length, 2, "a changed context is a new prediction");
  fs.rmSync(b.root, { recursive: true, force: true });
});

// Precedence: shipped defaults < apply() config < user.json. The reverse
// case is covered above (apply config alone can switch prediction on); this
// pins that the user's own file still wins over the host's config block.
test("user.json overrides the config passed to apply()", async () => {
  const b = await boot(
    { predict: { enabled: true, floor: 0.05, limit: 3, turns: 1 } },
    { predict: { enabled: false } }
  );
  assert.equal(b.hooks["agent/pre-step"], undefined,
    "user.json turning prediction off must beat the host config turning it on");
  fs.rmSync(b.root, { recursive: true, force: true });
});
