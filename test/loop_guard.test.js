// loop-guard / core-guard 单元测试。
//
// 重点不是“函数能跑”，而是三条边界：
//   1. 正常长文本不误杀（列表、代码块、表格）；
//   2. 真复读能命中，且每个 turn 有次数上限；
//   3. core-guard 在 dry-run 下只记录、不 deny。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectLoop, thinkingTextOf, stripNoise, createLoopGuard, DEFAULTS } from "../lib/loop-guard.js";
import { createCoreGuard, coreHits } from "../lib/core-guard.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-guard-"));
}

// ---- loop-guard ----

test("thinkingTextOf reads both thinking and reasoning chunk shapes", () => {
  assert.equal(thinkingTextOf({ type: "thinking", thinking: "abc" }), "abc");
  assert.equal(thinkingTextOf({ type: "reasoning", text: "xyz" }), "xyz");
  assert.equal(thinkingTextOf({ type: "text", text: "正文" }), "");
  assert.equal(thinkingTextOf(null), "");
});

test("stripNoise removes code blocks and table rows", () => {
  const s = stripNoise("前\n```\n重复重复重复\n```\n| a | b |\n后");
  assert.ok(!s.includes("重复重复重复"));
  assert.ok(!s.includes("| a | b |"));
  assert.ok(s.includes("前") && s.includes("后"));
});

test("normal long prose does not trip the detector", () => {
  const prose = "先检查配置文件是否存在，然后读取其中的字段，确认版本号与当前安装一致，再决定是否需要迁移。"
    + "如果版本不一致，先备份原文件，再按迁移步骤逐条执行，每步之后回读确认结果。"
    + "最后跑一遍自检脚本，确认所有入口都通过，才算完成。";
  assert.equal(detectLoop(prose.repeat(2), { ...DEFAULTS }), null);
});

test("a real repetition loop is detected", () => {
  const loop = "做。好。执行。".repeat(20);
  const hit = detectLoop(loop, { ...DEFAULTS });
  assert.ok(hit, "should detect the loop");
  assert.ok(hit.count >= DEFAULTS.repeatThreshold);
});

test("per-turn retry cap and cooldown are enforced", () => {
  let t = 1000;
  const root = tmpRoot();
  const g = createLoopGuard({ root, cfg: { cooldownMs: 8000, maxRetries: 2 }, now: () => t });
  // 一次喂一遍循环（140 字）：窗口里足够命中一次；命中后清空窗口。
  const loop = "做。好。执行。".repeat(20);
  const feedAll = (turn) => g.feedText("s1", loop, turn, 20);

  const a = feedAll(1);
  assert.ok(a && a.fired, "first hit fires");
  assert.equal(a.retry, 1);

  t += 1000; // 仍在冷却窗口内
  const b = feedAll(1);
  assert.equal(b, null, "cooldown suppresses a second hit");

  t += 9000; // 冷却已过
  const c = feedAll(1);
  assert.ok(c && c.fired && c.retry === 2, "second retry after cooldown");

  t += 9000;
  const d = feedAll(1);
  assert.equal(d, null, "third hit is capped for this turn");

  t += 9000;
  const e = feedAll(2);
  assert.ok(e && e.fired && e.retry === 1, "a new turn resets the cap");

  // 日志只记真正触发的三次
  const lines = fs.readFileSync(g.logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

// 回归：窗口是“最近 windowChars 字”，一次喂入超过窗口长度的循环时，
// 前面的内容被挤掉，命中次数会下降。这是设计，不是 bug；测试要按
// 真实流的节奏分片喂，不能一次性喂 140 字再断言“必然命中”。
test("a single oversized feed is bounded by the window", () => {
  const root = tmpRoot();
  const g = createLoopGuard({ root, cfg: { windowChars: 200 } });
  const r = g.feed("s1", "做。好。执行。".repeat(20), 1);
  // 140 字 < 200 窗口，能命中；但只够一次
  assert.ok(r && r.fired);
  fs.rmSync(root, { recursive: true, force: true });
});

test("disabled guard never fires", () => {
  const root = tmpRoot();
  const g = createLoopGuard({ root, cfg: { enabled: false } });
  assert.equal(g.feed("s1", "做。好。执行。".repeat(20), 1), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- core-guard ----

test("coreHits matches paths regardless of slash direction", () => {
  const hits = coreHits("~/.dsh/shannon-anchor\\manual\\1.md", ["~/.dsh/shannon-anchor"]);
  assert.equal(hits.length, 1);
});

test("memory_write is allowlisted, shell write is not", () => {
  const root = tmpRoot();
  const g = createCoreGuard({ root, cfg: { paths: [root] } });
  const ok = g.judge("memory_write", { file_path: path.join(root, "manual", "1.md") });
  assert.equal(ok.allowed, true);
  assert.equal(ok.reason, "allow-tool");
  const bad = g.judge("pwsh", { command: `Set-Content '${path.join(root, "manual", "1.md")}' x` });
  assert.equal(bad.allowed, false);
  assert.equal(bad.reason, "not-allowlisted");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the sanctioned delete script is allowlisted", () => {
  const root = tmpRoot();
  // 白名单命令由测试自己给，不依赖某台机器上的脚本文件名
  const g = createCoreGuard({ root, cfg: { paths: [root], allowCommands: ["delete-guard\\.py"] } });
  const v = g.judge("pwsh", { command: `python delete-guard.py "${path.join(root, "manual", "1.md")}" --reason x` });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, "allow-command");
  fs.rmSync(root, { recursive: true, force: true });
});

test("writes outside the core are ignored", () => {
  const root = tmpRoot();
  const g = createCoreGuard({ root, cfg: { paths: [root] } });
  const v = g.judge("pwsh", { command: "Set-Content ~/.dsh/tmp/x.txt y" });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, "outside-core");
  fs.rmSync(root, { recursive: true, force: true });
});

// 回归（2026-11-01 实测）：读核心区被记成“非白名单写入”，dry-run 日志
// 全是误报。读操作必须先放行，白名单只管写。
test("reading the core is not a write violation", () => {
  const root = tmpRoot();
  const g = createCoreGuard({ root, cfg: { paths: [root] } });
  const readCmd = g.judge("pwsh", { command: `Get-Content '${path.join(root, "guard", "core-writes.jsonl")}'` });
  assert.equal(readCmd.allowed, true);
  assert.equal(readCmd.reason, "read-only");
  const listCmd = g.judge("pwsh", { command: `Get-ChildItem '${root}'` });
  assert.equal(listCmd.allowed, true);
  assert.equal(listCmd.reason, "read-only");
  const readTool = g.judge("read", { file_path: path.join(root, "manual", "1.md") });
  assert.equal(readTool.allowed, true);
  assert.equal(readTool.reason, "read-only");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a read command that also writes is still judged as a write", () => {
  const root = tmpRoot();
  const g = createCoreGuard({ root, cfg: { paths: [root] } });
  const v = g.judge("pwsh", {
    command: `Get-Content '${path.join(root, "a.md")}' | Set-Content '${path.join(root, "b.md")}'`
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "not-allowlisted");
  fs.rmSync(root, { recursive: true, force: true });
});

test("dry-run records but does not deny", async () => {
  const root = tmpRoot();
  const handlers = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    on: (ev, fn) => { if (ev === "tools/pre-execute") handlers.push(fn); }
  };
  const { installCoreGuard } = await import("../lib/core-guard.js");
  const g = installCoreGuard(ctx, { root, cfg: { paths: [root], mode: "dry-run" } });
  assert.equal(handlers.length, 1);
  const res = await handlers[0](
    { name: "pwsh", arguments: { command: `Set-Content '${path.join(root, "x.md")}' y` } },
    async () => ({ kind: "enter" })
  );
  assert.equal(res.kind, "enter", "dry-run must let the call through");
  const logged = fs.readFileSync(g.logFile, "utf8").trim().split("\n");
  assert.equal(logged.length, 1);
  assert.equal(JSON.parse(logged[0]).allowed, false);
  fs.rmSync(root, { recursive: true, force: true });
});
