// shannon-anchor — trigger tests. The bell must ring only when it should.
// A trigger that fires on everything costs context every turn; one that
// never fires is decoration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRIGGERS, matchTriggers, composeInjection } from "../lib/triggers.js";

test("delete-shaped pwsh call rings the delete bell", () => {
  const hits = matchTriggers("pwsh", { command: "Remove-Item -Recurse foo" }, DEFAULT_TRIGGERS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "delete");
});

test("plain pwsh command stays silent", () => {
  const hits = matchTriggers("pwsh", { command: "Get-ChildItem -Force" }, DEFAULT_TRIGGERS);
  assert.equal(hits.length, 0);
  assert.equal(composeInjection(hits), null);
});

test("backup task rings the backup bell", () => {
  const hits = matchTriggers("pwsh", { command: "python _snapshot.py --reason '备份'" }, DEFAULT_TRIGGERS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "backup");
});

test("write to a path outside the workspace rings write-outside", () => {
  const hits = matchTriggers("write", { file_path: "~/.dsh\\AGENTS.md", content: "x" }, DEFAULT_TRIGGERS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "write-outside");
});

test("an ordinary workspace write stays silent (no drive guessing)", () => {
  const hits = matchTriggers("write", { file_path: "D:\\work\\notes.md", content: "x" }, DEFAULT_TRIGGERS);
  assert.equal(hits.length, 0);
});

test("a write into the agent home config directory rings write-outside", () => {
  const hits = matchTriggers("write", { file_path: "~/.dsh/AGENTS.md", content: "x" }, DEFAULT_TRIGGERS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "write-outside");
});

test("unwatched tool never fires even with matching args", () => {
  const hits = matchTriggers("read", { file_path: "whatever" }, DEFAULT_TRIGGERS);
  assert.equal(hits.length, 0);
});

test("multiple hits compose into one line", () => {
  const rules = [
    { id: "a", tools: ["pwsh"], argPattern: "del", instruction: 1 },
    { id: "b", tools: ["pwsh"], argPattern: "备份", instruction: 2 }
  ];
  const hits = matchTriggers("pwsh", { command: "del 备份" }, rules);
  assert.equal(hits.length, 2);
  const line = composeInjection(hits);
  assert.equal(line, "按指令 1、2");
  assert.ok(line.length < 20, "injection is just a digit, not a sentence");
});

test("a broken user pattern never fires, never throws", () => {
  const rules = [{ id: "broken", tools: ["pwsh"], argPattern: "([unclosed", hint: "x" }];
  const hits = matchTriggers("pwsh", { command: "anything" }, rules);
  assert.equal(hits.length, 0);
});

test("string args are matched too", () => {
  const hits = matchTriggers("pwsh", "Remove-Item -Force x", DEFAULT_TRIGGERS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "delete");
});

test("empty rules mean silent", () => {
  assert.equal(matchTriggers("pwsh", { command: "del x" }, []).length, 0);
});

// 定制版（2026-10-18）：hits 带 line 时优先用 line，这样触发行直接说
// 「memory_recall 95」，不再靠另一处文案记会过时的 01-rules/N.md 路径。
test("a caller-supplied line wins (recall number, not a path)", () => {
  const hits = [
    { id: "delete", instruction: 1, line: "按指令 1（memory_recall 11）" },
    { id: "backup", instruction: 2, line: "按指令 2（memory_recall 12）" }
  ];
  const line = composeInjection(hits);
  assert.match(line, /memory_recall 11/);
  assert.match(line, /memory_recall 12/);
  assert.ok(!/01-rules/.test(line), "the stale path form is gone");
});

test("without a line the old digit-only behaviour is preserved", () => {
  const hits = [{ id: "delete", instruction: 1 }];
  assert.equal(composeInjection(hits), "按指令 1");
});

// 2026-10-29：上一轮用 pwsh 探网失败，把「一次失败」写成了「本机没有外网」。
// 探测命令本身和它的报错原文都要响，提醒先读 #39 的病 A，而不是下全局结论。
test("a network probe rings the net bell", () => {
  const hits = matchTriggers("pwsh", { command: "Test-NetConnection www.baidu.com -Port 443" }, DEFAULT_TRIGGERS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "net");
});

test("Invoke-WebRequest rings the net bell", () => {
  const hits = matchTriggers("pwsh", { command: "Invoke-WebRequest -Uri https://www.modelscope.cn" }, DEFAULT_TRIGGERS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "net");
});

test("the schannel failure text itself rings the net bell", () => {
  const hits = matchTriggers("pwsh", { command: "schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)" }, DEFAULT_TRIGGERS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "net");
});

test("an ordinary listing still stays silent after the pattern widened", () => {
  const hits = matchTriggers("pwsh", { command: "Get-ChildItem ~/models -Recurse" }, DEFAULT_TRIGGERS);
  assert.equal(hits.length, 0);
});