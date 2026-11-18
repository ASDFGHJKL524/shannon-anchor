// shannon-anchor — voice channel: how something was said.
//
// The rule this file guards: capture never writes a case. Only an explicit
// confirmation does, because a correction the model did not understand is a
// pending item, not a lesson. The other rule: the 60-line digest is a VIEW cap,
// the jsonl record keeps every case.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  looksLikeCorrection,
  captureFromMessages,
  listPending,
  listCases,
  addCase,
  confirmPending,
  dropPending,
  renderLibrary,
  voicePrompt,
  pendingPath,
  casesPath
} from "../lib/voice.js";

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-voice-"));
}

const CORRECTION = "别再说这种套话了，直接说重点。";
const MINE = "好的，那我先说明一下处理流程：第一步，第二步……";

function msgs({ user, assistant = MINE }) {
  return [
    { role: "user", content: [{ type: "text", text: "把那个文件处理一下。" }] },
    { role: "assistant", content: [{ type: "text", text: assistant }] },
    { role: "user", content: [{ type: "text", text: user }] }
  ];
}

test("looksLikeCorrection: strong fires, bare 不对 is weak, questions and injections do not", () => {
  assert.equal(looksLikeCorrection(CORRECTION).strength, "strong");
  assert.equal(looksLikeCorrection("这句不对").strength, "weak");
  assert.equal(looksLikeCorrection("这样不对吗？"), null, "a question is not a correction");
  assert.equal(looksLikeCorrection("没事"), null);
});

test("capture pairs the correction with the assistant line it reacts to, and only queues", () => {
  const root = mkRoot();
  const cap = captureFromMessages(root, msgs({ user: CORRECTION }));
  assert.equal(cap.captured, true);
  const pending = listPending(root);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].assistant, MINE, "the line being corrected is kept");
  assert.equal(fs.existsSync(casesPath(root)), false, "nothing is a case yet");
  fs.rmSync(root, { recursive: true, force: true });
});

test("injected workspace text is not captured", () => {
  const root = mkRoot();
  const injected = "按指令 5 写入即同步，改完就同步校验链，不要留在最后。";
  const cap = captureFromMessages(root, msgs({ user: injected }));
  assert.equal(cap.captured, false);
  assert.equal(listPending(root).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a full queue rejects the new candidate instead of evicting", () => {
  const root = mkRoot();
  const first = captureFromMessages(root, msgs({ user: "别再说第0句，换种说法。" }), { maxPending: 2 });
  const second = captureFromMessages(root, msgs({ user: "别再说第1句，换种说法。" }), { maxPending: 2 });
  const third = captureFromMessages(root, msgs({ user: "别再说第2句，换种说法。" }), { maxPending: 2 });
  assert.equal(first.captured, true);
  assert.equal(second.captured, true);
  assert.equal(third.captured, false);
  assert.equal(third.reason, "QUEUE_FULL");
  const pending = listPending(root);
  assert.equal(pending.length, 2);
  assert.match(pending.map((p) => p.user).join("\n"), /第0句/, "the oldest candidate stays");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the same correction twice does not open a second pending item", () => {
  const root = mkRoot();
  captureFromMessages(root, msgs({ user: CORRECTION }));
  const again = captureFromMessages(root, msgs({ user: CORRECTION }));
  assert.equal(again.captured, false);
  assert.equal(again.reason, "already pending");
  assert.equal(listPending(root).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("confirm turns a pending item into a case and empties the queue", () => {
  const root = mkRoot();
  captureFromMessages(root, msgs({ user: CORRECTION }));
  const p = listPending(root)[0];
  const r = confirmPending(root, p.id, { what: "用套话开场，没直接给结论", human: "结论先说，过程可以省略" });
  assert.equal(r.ok, true);
  assert.equal(listPending(root).length, 0);
  const cases = listCases(root);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].original, MINE, "the case keeps the line that was objected to");
  const view = fs.readFileSync(r.path, "utf8");
  assert.match(view, /结论先说/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("confirm without what is refused — a case needs the reason, not just the quote", () => {
  const root = mkRoot();
  captureFromMessages(root, msgs({ user: CORRECTION }));
  const p = listPending(root)[0];
  const r = confirmPending(root, p.id, { what: "  " });
  assert.equal(r.ok, false);
  assert.match(r.error, /what required/);
  assert.equal(listPending(root).length, 1, "the candidate is not consumed by a failed confirm");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a recurrence appends a date instead of a second case, once per day", () => {
  const root = mkRoot();
  // Seed through the real path so the trigger is the one capture computes.
  captureFromMessages(root, msgs({ user: CORRECTION }));
  const p = listPending(root)[0];
  confirmPending(root, p.id, { what: "套话开场" });
  const cap = captureFromMessages(root, msgs({ user: CORRECTION }));
  assert.equal(cap.captured, true);
  assert.equal(cap.recurrence, true);
  assert.equal(cap.id, "v1");

  const lines = fs.readFileSync(casesPath(root), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "base case + one recurrence line");
  assert.equal(cap.duplicateDay, false);

  const dup = captureFromMessages(root, msgs({ user: CORRECTION }));
  assert.equal(dup.duplicateDay, true, "the same day is not recorded twice");
  assert.equal(fs.readFileSync(casesPath(root), "utf8").trim().split("\n").length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the digest is capped but the record is not", () => {
  const root = mkRoot();
  for (let i = 0; i < 3; i++) {
    addCase(root, { original: `第${i}次别再说，换种说法`, what: `毛病${i}`, human: "" });
  }
  const view = renderLibrary(root, { maxLines: 12 });
  assert.ok(view.lines <= 12, `view stays inside the cap (got ${view.lines})`);
  assert.equal(view.shown, 1);
  assert.equal(view.total, 3, "all three cases still exist");
  assert.equal(listCases(root).length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test("voicePrompt is empty when idle and after candidates go stale", () => {
  const root = mkRoot();
  assert.equal(voicePrompt(root, { maxAgeHours: 24 }), "");

  fs.mkdirSync(path.dirname(pendingPath(root)), { recursive: true });
  fs.writeFileSync(pendingPath(root), JSON.stringify({
    id: "p-old00000",
    at: "2020-01-01T00:00:00.000Z",
    user: CORRECTION,
    assistant: MINE
  }) + "\n", "utf8");
  assert.equal(voicePrompt(root, { maxAgeHours: 24 }), "", "an old candidate stops costing prompt space");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- wiring: the host actually reaches the channel ----

async function boot(userCfg) {
  const mod = await import("../lib/index.js?t=" + Date.now() + Math.random());
  const root = mkRoot();
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  if (userCfg) {
    fs.writeFileSync(path.join(conf, "user.json"), JSON.stringify(userCfg, null, 2), "utf8");
  }
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
  return { root, registered, sections, handlers };
}

test("off by default: no voice_case tool, no voice section, no pre-step hook", async () => {
  const { root, registered, sections, handlers } = await boot({ distill: { mode: "off" } });
  assert.equal(registered.some((t) => t.name === "voice_case"), false);
  assert.equal(sections.some((s) => s.name === "shannon-anchor-voice"), false);
  assert.equal(handlers["agent/pre-step"], undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test("enabled: capture runs at turn end even with distillation off, then confirm writes a case", async () => {
  const { root, registered, sections, handlers } = await boot({
    distill: { mode: "off" },
    voice: { enabled: true, maxPending: 2, maxLines: 12 }
  });
  const tool = registered.find((t) => t.name === "voice_case");
  assert.ok(tool, "voice_case is registered when the channel is on");
  const sec = sections.find((s) => s.name === "shannon-anchor-voice");
  assert.ok(sec, "the voice prompt section is registered");
  assert.equal(sec.text(), "", "idle: zero prompt cost");

  const decision = { messages: msgs({ user: CORRECTION }) };
  const returned = await handlers["agent/pre-step"]({ agent: { header: {} } }, async () => decision);
  assert.equal(returned, decision, "the decision passes through unchanged");
  await handlers["agent/turn-stopping"]({ turn: 7 });

  const pending = listPending(root);
  assert.equal(pending.length, 1, "capture is independent of distill mode");
  assert.match(sec.text(), /疑似纠正/);

  const r = await tool.execute({
    action: "confirm",
    id: pending[0].id,
    what: "用套话开场，没直接给结论",
    human: "结论先说，过程可以省略"
  });
  assert.ok(!r.error, String(r.error));
  assert.equal(listPending(root).length, 0);
  assert.equal(listCases(root).length, 1);
  assert.match(sec.text(), /刚记下的语感案例/, "a fresh case stays in view for a while");

  // the same words again: recurrence, not a second case
  await handlers["agent/pre-step"]({ agent: { header: {} } }, async () => decision);
  await handlers["agent/turn-stopping"]({ turn: 8 });
  assert.equal(listCases(root).length, 1);
  const listed = await tool.execute({ action: "list" });
  assert.match(listed.text, /复发/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("drop discards a candidate and leaves a reason line", async () => {
  const { root, registered, handlers } = await boot({
    distill: { mode: "off" },
    voice: { enabled: true }
  });
  const tool = registered.find((t) => t.name === "voice_case");
  const decision = { messages: msgs({ user: CORRECTION }) };
  await handlers["agent/pre-step"]({ agent: { header: {} } }, async () => decision);
  await handlers["agent/turn-stopping"]({ turn: 3 });
  const p = listPending(root)[0];
  const r = await tool.execute({ action: "drop", id: p.id, reason: "说的是事实不是语气" });
  assert.ok(!r.error, String(r.error));
  assert.equal(listPending(root).length, 0);
  assert.equal(listCases(root).length, 0);
  const dropped = fs.readFileSync(path.join(root, "voice", "dropped.jsonl"), "utf8");
  assert.match(dropped, /事实不是语气/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("subagent turns never capture (no fan-out of the user's sentences)", async () => {
  const { root, handlers } = await boot({
    distill: { mode: "off" },
    voice: { enabled: true }
  });
  const decision = { messages: msgs({ user: CORRECTION }) };
  await handlers["agent/pre-step"]({ agent: { header: { parentSession: "p-1" } } }, async () => decision);
  await handlers["agent/turn-stopping"]({ turn: 4, agent: { header: { parentSession: "p-1" } } });
  assert.equal(listPending(root).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
