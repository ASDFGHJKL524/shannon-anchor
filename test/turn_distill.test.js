// shannon-anchor — mode=turn: end-of-turn distillation without an LLM handle.
// The host emits agent/turn-stopping with { turn: NUMBER, signal } — no
// transcript. The queue records the turn id; the content is the agent's own
// context on the next turn. Tests below use the REAL payload shape; the
// string-turn case is kept for callers that do supply text.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queueTurn, pendingTurns, turnPreview } from "../lib/distill.js";

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-turn-"));
  fs.mkdirSync(path.join(root, "conf"), { recursive: true });
  return root;
}

function writeUser(root, obj) {
  fs.writeFileSync(path.join(root, "conf", "user.json"), JSON.stringify(obj, null, 2), "utf8");
}

async function applyWith(root) {
  const mod = await import("../lib/index.js?t=" + Date.now());
  const registered = [];
  const sections = [];
  const handlers = {};
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: (s) => sections.push(s) },
    on: (ev, fn) => { handlers[ev] = fn; }
  };
  mod.apply(ctx, { manualRoot: root });
  return { mod, registered, sections, handlers };
}

function pendingFile(root) { return path.join(root, "distill", "pending.jsonl"); }
function readPending(root) { return pendingTurns(root); }

const LONG = "删临时文件之前先逐个列名，不许用通配符，选和删分两步走。".repeat(3);

test("mode=off: turn-stopping queues nothing", async () => {
  const root = mkRoot();
  writeUser(root, { distill: { mode: "off" } });
  const { handlers } = await applyWith(root);
  await handlers["agent/turn-stopping"]({ turn: 1 });
  assert.equal(fs.existsSync(pendingFile(root)), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("mode=turn: the real payload shape ({turn: number}) is queued and the prompt reminds", async () => {
  const root = mkRoot();
  writeUser(root, { distill: { mode: "turn" } });
  const { handlers, sections } = await applyWith(root);
  assert.equal(readPending(root).length, 0, "empty at boot");
  await handlers["agent/turn-stopping"]({ turn: 3 });
  const items = readPending(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].turn, 3);
  const sec = sections.find((s) => s.name === "shannon-anchor-distill");
  assert.ok(sec, "distill prompt section registered");
  assert.match(sec.text(), /1 条/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("mode=turn: pre-step supplies the preview that turn-stopping stores", async () => {
  const root = mkRoot();
  writeUser(root, { distill: { mode: "turn" } });
  const { handlers, sections } = await applyWith(root);
  assert.ok(handlers["agent/pre-step"], "pre-step is registered for turn mode even with prediction off");

  const decision = { messages: [
    { role: "user", content: [{ type: "text", text: "删除临时脚本前要先列名，别用通配符。" }] },
    { role: "assistant", content: [
      { type: "text", text: "我先看一遍候选文件，然后分两步删。" },
      { type: "tool-call", name: "glob", arguments: {} }
    ] },
    { role: "tool", content: [{ type: "tool-result", text: "这个工具输出不该进预览" }] }
  ] };
  const returned = await handlers["agent/pre-step"]({ agent: { header: {} } }, async () => decision);
  assert.equal(returned, decision, "the decision passes through unchanged");
  await handlers["agent/turn-stopping"]({ turn: 21 });
  const items = readPending(root);
  assert.equal(items.length, 1);
  assert.ok(items[0].chars > 0, "the preview is no longer zero chars");
  assert.match(items[0].preview, /删除临时脚本/);
  assert.match(items[0].preview, /我先看一遍/);
  assert.doesNotMatch(items[0].preview, /这个工具输出不该进预览/);
  const sec = sections.find((s) => s.name === "shannon-anchor-distill");
  assert.match(sec.text(), /最近一条：用户：删除临时脚本/, "the nudge names the turn it wants revisited");
  fs.rmSync(root, { recursive: true, force: true });
});

test("mode=turn: a subagent pre-step cannot overwrite the root preview", async () => {
  const root = mkRoot();
  writeUser(root, { distill: { mode: "turn" } });
  const { handlers } = await applyWith(root);
  await handlers["agent/pre-step"]({ agent: { header: {} } }, async () => ({
    messages: [{ role: "user", content: [{ type: "text", text: "根对话的问题" }] }]
  }));
  await handlers["agent/pre-step"]({ agent: { header: { parentSession: "p1" } } }, async () => ({
    messages: [{ role: "user", content: [{ type: "text", text: "子代理的问题" }] }]
  }));
  await handlers["agent/turn-stopping"]({ turn: 22 });
  const items = readPending(root);
  assert.equal(items.length, 1);
  assert.match(items[0].preview, /根对话的问题/);
  assert.doesNotMatch(items[0].preview, /子代理的问题/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("mode=turn: a host reminder is not stored as the user's turn", async () => {
  const root = mkRoot();
  writeUser(root, { distill: { mode: "turn" } });
  const { handlers } = await applyWith(root);
  const reminder = "<system-reminder>\nThe available skill catalog changed.\n</system-reminder>";
  await handlers["agent/pre-step"]({ agent: { header: {} } }, async () => ({
    messages: [
      { role: "user", content: [{ type: "text", text: `${reminder}\n帮我把语音合成插件调一下` }] },
      { role: "assistant", content: [{ type: "text", text: "我先看端口和采样率。" }] }
    ]
  }));
  await handlers["agent/turn-stopping"]({ turn: 31 });
  const items = readPending(root);
  assert.equal(items.length, 1);
  assert.match(items[0].preview, /语音合成插件/);
  assert.doesNotMatch(items[0].preview, /system-reminder|skill catalog/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("mode=turn: a supplied string turn is queued with its preview", async () => {
  const root = mkRoot();
  writeUser(root, { distill: { mode: "turn" } });
  const { handlers } = await applyWith(root);
  await handlers["agent/turn-stopping"]({ turn: LONG });
  const items = readPending(root);
  assert.equal(items.length, 1);
  assert.match(items[0].preview, /删临时文件/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("queueTurn: short supplied text is not queued, but a bare turn number is", () => {
  const root = mkRoot();
  assert.equal(queueTurn(root, { text: "好。" }).queued, false);
  assert.equal(queueTurn(root, { turn: 5 }).queued, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("queueTurn: a short preview WITH a turn number still queues", () => {
  const root = mkRoot();
  const r = queueTurn(root, { text: "修一下", turn: 6 });
  assert.equal(r.queued, true, "the length floor guards transcripts, not preview labels");
  assert.equal(readPending(root)[0].preview, "修一下");
  fs.rmSync(root, { recursive: true, force: true });
});

test("mode=turn: the same turn number twice is not queued twice", async () => {
  const root = mkRoot();
  writeUser(root, { distill: { mode: "turn" } });
  const { handlers } = await applyWith(root);
  await handlers["agent/turn-stopping"]({ turn: 7 });
  await handlers["agent/turn-stopping"]({ turn: 7 });
  assert.equal(readPending(root).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("mode=turn: a full queue rejects the newest turn instead of evicting", async () => {
  const root = mkRoot();
  writeUser(root, { distill: { mode: "turn", maxPending: 2 } });
  const { handlers } = await applyWith(root);
  await handlers["agent/turn-stopping"]({ turn: 1 });
  await handlers["agent/turn-stopping"]({ turn: 2 });
  await handlers["agent/turn-stopping"]({ turn: 3 });
  const items = readPending(root);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((x) => x.turn), [1, 2], "the oldest turns stay; the new one is rejected");
  fs.rmSync(root, { recursive: true, force: true });
});

test("memory_distill: status lists, skip clears and archives", async () => {
  const root = mkRoot();
  writeUser(root, { distill: { mode: "turn" } });
  const { handlers, registered } = await applyWith(root);
  await handlers["agent/turn-stopping"]({ turn: 9 });
  const tool = registered.find((t) => t.name === "memory_distill");
  assert.ok(tool, "memory_distill registered");

  const st = await tool.execute({ action: "status" });
  assert.equal(st.count, 1);
  assert.match(st.text, /Queued turns/);

  const noReason = await tool.execute({ action: "skip" });
  assert.ok(noReason.error, "skip without reason is refused");

  const sk = await tool.execute({ action: "skip", reason: "这回合没有值得记的经验" });
  assert.equal(sk.cleared, 1);
  assert.equal(readPending(root).length, 0, "cleared items are no longer outstanding");
  const archive = path.join(root, "distill", "cleared.jsonl");
  assert.ok(fs.existsSync(archive));
  assert.match(fs.readFileSync(archive, "utf8"), /没有值得记/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("turnPreview falls back to assistant text when compaction removed the user turn", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "<compacted-summary>earlier work</compacted-summary>" }] },
    { role: "assistant", content: [{ type: "text", text: "根因在 distill.js 的回退扫描。" }] },
    { role: "tool", content: [{ type: "text", text: "grep output" }] }
  ];
  const p = turnPreview(messages);
  assert.match(p, /助手：根因在 distill\.js/);
  assert.ok(!/compacted-summary|grep output/.test(p), `wrong source in preview: ${p}`);
});

test("mode=turn: the prompt is empty once the queue is cleared", async () => {
  const root = mkRoot();
  writeUser(root, { distill: { mode: "turn" } });
  const { handlers, sections, registered } = await applyWith(root);
  const sec = sections.find((s) => s.name === "shannon-anchor-distill");
  assert.equal(sec.text(), "", "empty queue renders no prompt");
  await handlers["agent/turn-stopping"]({ turn: 11 });
  assert.notEqual(sec.text(), "");
  const tool = registered.find((t) => t.name === "memory_distill");
  await tool.execute({ action: "done", reason: "已写入条目" });
  assert.equal(sec.text(), "");
  fs.rmSync(root, { recursive: true, force: true });
});
