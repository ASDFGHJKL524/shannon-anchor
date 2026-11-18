// shannon-anchor — memory_search tool tests.
// The library existed but was never wired: the model could only browse.
// These tests prove the wiring is real, end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const libUrl = new URL("../lib/index.js", import.meta.url).href;

async function freshApply() {
  const mod = await import(libUrl + "?t=" + Date.now());
  const registered = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-search-"));
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section() {} },
    on() {}
  };
  mod.apply(ctx, { manualRoot: root });
  return { registered, root, mod };
}

async function seedEntries(tools, root) {
  const write = tools.find((t) => t.name === "memory_write");
  await write.execute({ title: "删除守卫：禁通配符、两段式令牌", body: "以后删除一定要逐个列名，用通配符误删过一批文件，不可恢复", source: "test" });
  await write.execute({ title: "备份与自保：包和密码分开放", body: "备份密码不进公开记录，包和密码别在同一块盘上一起坏掉", source: "test" });
  return root;
}

test("memory_search is registered", async () => {
  const { registered } = await freshApply();
  assert.ok(registered.some((t) => t.name === "memory_search"));
});

test("Chinese query finds the Chinese entry through the tool", async () => {
  const { registered, root } = await freshApply();
  await seedEntries(registered, root);
  const s = registered.find((t) => t.name === "memory_search");
  const r = await s.execute({ query: "删除 通配符" });
  assert.match(r.text, /删除守卫/);
  assert.ok(r.top >= 1);
  assert.match(r.text, /via/);
  assert.match(r.text, /written \| last used/, "rows carry dates, not just a rank");
  assert.match(r.text, /\| \d{4}-\d{2}-\d{2} \|/, "the write date is visible");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a no-match query says so instead of returning noise", async () => {
  const { registered, root } = await freshApply();
  await seedEntries(registered, root);
  const s = registered.find((t) => t.name === "memory_search");
  const r = await s.execute({ query: "zzzqqqxxx完全无关" });
  assert.match(r.text, /no match/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("search then recall round-trips (the intended workflow)", async () => {
  const { registered, root } = await freshApply();
  await seedEntries(registered, root);
  const s = registered.find((t) => t.name === "memory_search");
  const r = await s.execute({ query: "备份 密码" });
  const top = r.top;
  const recall = registered.find((t) => t.name === "memory_recall");
  const full = await recall.execute({ number: top });
  assert.match(full.text, /密码/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("search on an empty library does not throw", async () => {
  const { registered, root } = await freshApply();
  const s = registered.find((t) => t.name === "memory_search");
  const r = await s.execute({ query: "删除" });
  assert.match(r.text, /no match/);
  fs.rmSync(root, { recursive: true, force: true });
});