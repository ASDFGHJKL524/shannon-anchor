// Wiring for the after-write review queue: does a real memory_write actually
// queue a review, and does the prompt block appear only when asked for?
//
// Both matter. A queue that is never filled by the write path is decoration, and
// a prompt block that cannot be switched off is the thing §6 says must not
// happen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function freshApply(opts = {}) {
  const mod = await import("../lib/index.js?t=" + Date.now());
  const registered = [];
  const sections = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pagi-review-wire-"));
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  if (opts.userConfig) {
    fs.writeFileSync(path.join(conf, "user.json"), JSON.stringify(opts.userConfig, null, 2), "utf8");
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: (s) => sections.push(s) },
    on() {}
  };
  mod.apply(ctx, { manualRoot: root });
  const tool = (name) => {
    const t = registered.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} was not registered`);
    return t;
  };
  return { root, tool, sections };
}

const body =
  "复查队列这条经验是写给未来的自己看的：判断采光靠的是离窗户的距离和开间进深，不是靠把话说得漂亮。" +
  "写的时候要给出可操作的做法，别写成感想。";

async function writeOne(tool, title = "复查队列测试条目") {
  return tool("memory_write").execute({
    title,
    body,
    source: "2026-11-01 review wiring test",
    confidence: "user-confirmed"
  });
}

test("memory_write queues a review for a reviewer with no context", async () => {
  const { root, tool } = await freshApply();
  const w = await writeOne(tool);
  assert.ok(w.number > 0, JSON.stringify(w));
  const rows = fs
    .readFileSync(path.join(root, "review", "pending.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].number, w.number);
  assert.equal(rows[0].status, "pending");
  assert.ok(rows[0].bodyHash, "the reviewed text is pinned by a hash");
  assert.ok(!fs.readFileSync(path.join(root, "review", "pending.jsonl"), "utf8").includes("离窗户的距离"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("memory_review list/confirm/stats run through the real tool", async () => {
  const { root, tool } = await freshApply();
  const w = await writeOne(tool);
  const list = await tool("memory_review").execute({ action: "list" });
  assert.match(list.text, new RegExp(`#${w.number}`));
  assert.equal(list.count, 1);

  const id = fs.readFileSync(path.join(root, "review", "pending.jsonl"), "utf8").trim().split("\n").map(JSON.parse)[0].id;
  const done = await tool("memory_review").execute({
    action: "confirm",
    id,
    verdict: "keep",
    reason: "确实是一条可操作的经验"
  });
  assert.match(done.text, /keep/);
  assert.equal(done.decision.ok, true);

  const stats = await tool("memory_review").execute({ action: "stats" });
  assert.equal(stats.stats.pending, 0);
  assert.equal(stats.stats.passed, 1);
  assert.equal(stats.stats.decided, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the prompt block appears once something is pending, and can be switched off", async () => {
  const on = await freshApply();
  const section = on.sections.find((s) => s.name === "shannon-anchor-review");
  assert.ok(section, "review section is registered");
  assert.equal(section.text(), "", "silent while the queue is empty");
  await writeOne(on.tool);
  assert.match(section.text(), /复查/);
  fs.rmSync(on.root, { recursive: true, force: true });

  const off = await freshApply({ userConfig: { review: { inject: false } } });
  assert.equal(off.sections.find((s) => s.name === "shannon-anchor-review"), undefined);
  fs.rmSync(off.root, { recursive: true, force: true });
});

test("review.enabled=false keeps the write path untouched", async () => {
  const { root, tool } = await freshApply({ userConfig: { review: { enabled: false } } });
  const w = await writeOne(tool);
  assert.ok(w.number > 0);
  assert.equal(fs.existsSync(path.join(root, "review", "pending.jsonl")), false);
  fs.rmSync(root, { recursive: true, force: true });
});
