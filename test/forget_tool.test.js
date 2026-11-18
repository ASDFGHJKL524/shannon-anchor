// shannon-anchor — memory_forget tool tests.
// The tier engine was invisible to the model: it could not see tiers, mark
// a seasonal lesson, or bring back a parked entry. This tool is that
// window, and it must never delete anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadManual } from "../lib/manual_store.js";

const libUrl = new URL("../lib/index.js", import.meta.url).href;

async function boot() {
  const mod = await import(libUrl + "?t=" + Date.now() + Math.random());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-ftool-"));
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section() {} },
    on: () => {}
  };
  mod.apply(ctx, { manualRoot: root });
  const tool = (name) => registered.find((t) => t.name === name);
  return { root, tool, registered };
}

async function seed(tool, title, body) {
  return tool("memory_write").execute({ title, body, source: "forget-tool test" });
}

test("memory_forget is registered", async () => {
  const { tool } = await boot();
  assert.ok(tool("memory_forget"));
});

test("status lists entries with tier, idle days and heat", async () => {
  const { tool, root } = await boot();
  await seed(tool, "删除守卫", "以后删除要逐个列名，踩过坑");
  const r = await tool("memory_forget").execute({ action: "status", detail: true });
  assert.match(r.text, /删除守卫/);
  assert.match(r.text, /hot/);
  assert.match(r.text, /idle days/);
  assert.match(r.text, /agent-inferred \d+ days idle -> warm.*user-confirmed \d+ -> warm/s, "the footer quotes both confidence clocks");
  fs.rmSync(root, { recursive: true, force: true });
});

test("status on an empty manual says so instead of rendering an empty table", async () => {
  const { tool, root } = await boot();
  const r = await tool("memory_forget").execute({ action: "status", detail: true });
  assert.match(r.text, /empty/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("mark sets low-frequency, and the flag is visible in status", async () => {
  const { tool, root } = await boot();
  await seed(tool, "年度备份密码轮换", "一年一次，低频但要留着");
  const m = await tool("memory_forget").execute({ action: "mark", number: 1 });
  assert.match(m.text, /low-frequency = true/);
  const s = await tool("memory_forget").execute({ action: "status", detail: true });
  const row = s.text.split("\n").find((l) => l.includes("年度备份"));
  assert.match(row, /yes/, "the low-freq column shows it");
  fs.rmSync(root, { recursive: true, force: true });
});

test("unmark clears it", async () => {
  const { tool, root } = await boot();
  await seed(tool, "某条", "内容够长能过门槛的内容内容");
  await tool("memory_forget").execute({ action: "mark", number: 1 });
  const u = await tool("memory_forget").execute({ action: "unmark", number: 1 });
  assert.match(u.text, /low-frequency = false/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("forgotten lists parked entries, and recall brings one back", async () => {
  const { tool, root } = await boot();
  // park a file by hand (the sweep does this after 90 idle days)
  const fdir = path.join(root, "forgotten");
  fs.mkdirSync(fdir, { recursive: true });
  fs.writeFileSync(path.join(fdir, "04-experience_7.md"), "### 7. old thing\n\nbody\n", "utf8");
  const list = await tool("memory_forget").execute({ action: "forgotten" });
  assert.match(list.text, /04-experience_7\.md/);
  const back = await tool("memory_forget").execute({ action: "recall", file: "04-experience_7.md" });
  assert.match(back.text, /recalled/);
  assert.ok(fs.existsSync(path.join(root, "manual", "04-experience", "7.md")), "bytes are back in the manual");
  assert.equal(fs.existsSync(path.join(fdir, "04-experience_7.md")), false, "no longer parked");
  fs.rmSync(root, { recursive: true, force: true });
});

test("forgetting never deletes: bytes survive a park + recall round-trip", async () => {
  const { tool, root } = await boot();
  const fdir = path.join(root, "forgotten");
  fs.mkdirSync(fdir, { recursive: true });
  const content = "### 3. precious\n\nthe exact bytes must survive\n";
  fs.writeFileSync(path.join(fdir, "02-method_3.md"), content, "utf8");
  await tool("memory_forget").execute({ action: "recall", file: "02-method_3.md" });
  const after = fs.readFileSync(path.join(root, "manual", "02-method", "3.md"), "utf8");
  assert.equal(after, content, "byte-for-byte identical");
  fs.rmSync(root, { recursive: true, force: true });
});

test("recall on a retired entry prints what replaced it", async () => {
  const { tool, root } = await boot();
  await seed(tool, "旧结论", "内容够长能过门槛的内容内容");
  await seed(tool, "新结论", "内容够长能过门槛的内容内容");
  const e = loadManual(root).entries.find((x) => x.number === 1);
  const file = path.join(root, "manual", e.path);
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, text.replace(/\n/, "\n<!-- superseded_by: 2 -->\n"), "utf8");
  const r = await tool("memory_recall").execute({ number: 1 });
  assert.match(r.text, /^#1 · 旧结论/, "the title is part of the recall, not just the body");
  assert.match(r.text, /written \d{4}-\d{2}-\d{2}/, "the reader can see how old the entry is");
  assert.match(r.text, /last used .* · .* · retired/, "date, tier and retired status share one line");
  assert.match(r.text, /已作废/);
  assert.match(r.text, /memory_recall 2/);
  assert.equal(r.superseded, true);
  fs.rmSync(root, { recursive: true, force: true });
});

// The user's complaint was that stale conclusions never left the active layer.
// Search and the index now hide them, but status still rendered all nine as
// "hot", because heat counts reads and a retired entry keeps the heat it earned
// while it was still believed.
test("status shows a retired entry as retired, not as hot", async () => {
  const { tool, root } = await boot();
  await seed(tool, "旧结论", "内容够长能过门槛的内容内容");
  await seed(tool, "新结论", "内容够长能过门槛的内容内容");
  const e = loadManual(root).entries.find((x) => x.number === 1);
  const file = path.join(root, "manual", e.path);
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, text.replace(/\n/, "\n<!-- superseded_by: 2 -->\n"), "utf8");
  const r = await tool("memory_forget").execute({ action: "status", detail: true });
  assert.match(r.text, /\| 1 \| 旧结论 \| retired -> #2 \|/, "state outranks heat in the tier column");
  assert.match(r.text, /1 retired entries are listed for lineage only/);
  assert.ok(!/\| 1 \| 旧结论 \| hot \|/.test(r.text), "the retired entry is not called hot");
  fs.rmSync(root, { recursive: true, force: true });
});

test("unknown action is refused, not silently ignored", async () => {
  const { tool, root } = await boot();
  const r = await tool("memory_forget").execute({ action: "delete-everything" });
  assert.match(r.error, /unknown action/);
  fs.rmSync(root, { recursive: true, force: true });
});