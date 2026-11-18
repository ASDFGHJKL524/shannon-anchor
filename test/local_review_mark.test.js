// 本地判卷的「待复核」标记：本地模型判完不算数，条目带标记，等 recall 时人工核对，
// 摘标记的动作本身就是确认（2026-11-17）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function bootstrap() {
  const mod = await import("../lib/index.js?t=" + Date.now() + Math.random());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-localmark-"));
  fs.mkdirSync(path.join(root, "conf"), { recursive: true });
  const tools = {};
  mod.apply({
    logger: { info() {}, warn() {} },
    tools: { register: (t) => { tools[t.name] = t; } },
    systemPrompt: { section: () => {} },
    on: () => {}
  }, { manualRoot: root });
  return { root, tools };
}

function pendingIds(root) {
  const f = path.join(root, "review", "pending.jsonl");
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id);
}

test("local confirm 打标记，recall 露出来，verified 摘掉", async () => {
  const { root, tools } = await bootstrap();
  const w = await tools.memory_write.execute({ title: "本地判卷标记测试", body: "正文内容", source: "test" });
  assert.ok(!w.error, w.error);

  const id = pendingIds(root)[0];
  assert.ok(id, "队列里应该有这条");

  const c = await tools.memory_review.execute({
    action: "confirm", id, verdict: "keep", reason: "本地模型判 keep", local: true
  });
  assert.ok(!c.error, c.error);
  assert.match(c.text, /待复核/);

  const file = path.join(root, "manual", w.path);
  const afterMark = fs.readFileSync(file, "utf8");
  assert.match(afterMark, /<!--\s*待复核: 本地判卷 keep \d{4}-\d{2}-\d{2}\s*-->/, "标记进了文件头");

  const recall = await tools.memory_recall.execute({ number: w.number });
  assert.match(recall.text, /\[待复核\]/, "recall 必须提示这条还没人核对");
  assert.match(recall.text, new RegExp(`verified target=${w.number}`), "告诉读者怎么摘");

  const v = await tools.memory_curate.execute({
    action: "verified", target: w.number, evidence: "人工核对正文与来源一致"
  });
  assert.ok(!v.error, v.error);

  const afterClear = fs.readFileSync(file, "utf8");
  assert.ok(!/待复核:/.test(afterClear), "标记应该没了");
  assert.match(afterClear, /<!--\s*已复核: \d{4}-\d{2}-\d{2}/, "留下复核记录");

  const recall2 = await tools.memory_recall.execute({ number: w.number });
  assert.ok(!/\[待复核\]/.test(recall2.text), "摘掉后不再提示");

  fs.rmSync(root, { recursive: true, force: true });
});

test("不带 local 的 confirm 不打标记（普通裁决不受影响）", async () => {
  const { root, tools } = await bootstrap();
  const w = await tools.memory_write.execute({ title: "普通裁决", body: "正文", source: "test" });
  const id = pendingIds(root)[0];
  const c = await tools.memory_review.execute({ action: "confirm", id, verdict: "keep", reason: "人工判的" });
  assert.ok(!c.error, c.error);
  assert.ok(!/待复核/.test(c.text));

  const file = path.join(root, "manual", w.path);
  assert.ok(!/待复核:/.test(fs.readFileSync(file, "utf8")), "人工裁决不产生待复核标记");
  fs.rmSync(root, { recursive: true, force: true });
});

test("wrong 裁决要求理由，并且真的把条目隔离掉", async () => {
  const { root, tools } = await bootstrap();
  const w = await tools.memory_write.execute({ title: "一条后来发现是错的结论", body: "正文", source: "test" });
  const id = pendingIds(root)[0];

  // 没理由的 wrong 不受理——wrong 会把理由写进条目头部当证据。
  const bad = await tools.memory_review.execute({ action: "confirm", id, verdict: "wrong" });
  assert.match(String(bad.error || ""), /reason/);

  const ok = await tools.memory_review.execute({
    action: "confirm", id, verdict: "wrong", reason: "实测否定了这条结论"
  });
  assert.ok(!ok.error, ok.error);
  assert.match(ok.text, /已标 wrong/);

  const file = path.join(root, "manual", w.path);
  assert.match(fs.readFileSync(file, "utf8"), /<!--\s*wrong: \d{4}-\d{2}-\d{2} \| 实测否定了这条结论 -->/);

  const recall = await tools.memory_recall.execute({ number: w.number });
  assert.match(recall.text, /\[已推翻\]/);
  assert.match(recall.text, /不要照着做/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("retitle 只改标题行，正文一字不动，且强制留证据", async () => {
  const { root, tools } = await bootstrap();
  const w = await tools.memory_write.execute({
    title: "旧标题：结论已经被推翻", body: "正文第一段。\n\n正文第二段，带实测数据 30 秒。", source: "test"
  });

  const bad = await tools.memory_curate.execute({ action: "retitle", target: w.number, title: "新标题" });
  assert.match(String(bad.error || ""), /evidence/);

  const ok = await tools.memory_curate.execute({
    action: "retitle", target: w.number, title: "新标题：已更正为不是原因",
    evidence: "正文已更正，标题停在旧结论，检索只显示标题会误导"
  });
  assert.ok(!ok.error, ok.error);

  const text = fs.readFileSync(path.join(root, "manual", w.path), "utf8");
  assert.match(text, new RegExp(`^### ${w.number}\\. 新标题：已更正为不是原因$`, "m"));
  assert.ok(text.includes("正文第二段，带实测数据 30 秒。"), "正文必须原样保留");
  assert.ok(!text.includes("旧标题：结论已经被推翻"), "旧标题不该还在");
  fs.rmSync(root, { recursive: true, force: true });
});

test("没有标记的条目摘标记时报错，而不是假装成功", async () => {
  const { root, tools } = await bootstrap();
  const w = await tools.memory_write.execute({ title: "没标记", body: "正文", source: "test" });
  const v = await tools.memory_curate.execute({ action: "verified", target: w.number });
  assert.match(String(v.error || ""), /没有待复核标记/);
  fs.rmSync(root, { recursive: true, force: true });
});
