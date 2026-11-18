// shannon-anchor — candidateAutoPromote: when enabled, a candidate that crosses
// the heat threshold is promoted without a human call, and the head records
// "auto:" so the machine decision stays visible. Default is OFF.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEntry } from "../lib/entries.js";
import { guardedWrite } from "../lib/guard.js";
import { loadManual } from "../lib/manual_store.js";
import { candidates } from "../lib/curate.js";

function mkRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-auto-")); }

function seed(root, { number, title, body, heat }) {
  const e = parseEntry({ number, title, body, source: "test fixture", created: "2026-10-18", confidence: "agent-inferred" });
  guardedWrite(root, e, { guard: false });
  fs.writeFileSync(path.join(root, "stats.json"),
    JSON.stringify({ [String(number)]: { count: heat, lastUsed: "2026-10-18", tier: 1 } }), "utf8");
}

function userCfg(root, obj) {
  fs.mkdirSync(path.join(root, "conf"), { recursive: true });
  fs.writeFileSync(path.join(root, "conf", "user.json"), JSON.stringify(obj), "utf8");
}

async function applyWith(root) {
  const mod = await import("../lib/index.js?t=" + Date.now());
  const registered = [];
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(["info", m]), warn: (m) => logs.push(["warn", m]) },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section() {} },
    on() {}
  };
  mod.apply(ctx, { manualRoot: root });
  return { registered, logs };
}

const BODY = "这条记录着一条还没被证明的经验，热度够了才该转正。";

test("default off: a hot candidate is reported but NOT promoted", async () => {
  const root = mkRoot();
  seed(root, { number: 1, title: "候选条", body: BODY, heat: 5 });
  userCfg(root, { candidatePromoteHeat: 2 });
  const { logs } = await applyWith(root);
  assert.ok(logs.some(([, m]) => /hot enough to promote/.test(m)), JSON.stringify(logs));
  assert.equal(candidates(loadManual(root)).length, 1, "still a candidate");
  fs.rmSync(root, { recursive: true, force: true });
});

test("autoPromote on: boot promotes candidates already past the threshold", async () => {
  const root = mkRoot();
  seed(root, { number: 2, title: "候选条", body: BODY, heat: 2.5 });
  userCfg(root, { candidateAutoPromote: true, candidatePromoteHeat: 2 });
  const { logs } = await applyWith(root);
  assert.equal(candidates(loadManual(root)).length, 0, "promoted at boot");
  const file = path.join(root, "manual", "04-experience", "2.md");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /promoted:/);
  assert.match(text, /auto: heat 2\.5 >= 2 at boot/);
  assert.ok(logs.some(([, m]) => /auto-promoted 1 candidate/.test(m)), JSON.stringify(logs));
  fs.rmSync(root, { recursive: true, force: true });
});

test("autoPromote on: crossing the threshold during recall promotes immediately", async () => {
  const root = mkRoot();
  seed(root, { number: 3, title: "候选条", body: BODY, heat: 0 });
  userCfg(root, { candidateAutoPromote: true, candidatePromoteHeat: 1 });
  const { registered } = await applyWith(root);
  const recall = registered.find((t) => t.name === "memory_recall");
  const res = await recall.execute({ number: 3 });
  assert.match(res.text, /\[候选 → 自动转正\]/);
  assert.equal(candidates(loadManual(root)).length, 0, "promoted at recall");
  const text = fs.readFileSync(path.join(root, "manual", "04-experience", "3.md"), "utf8");
  assert.match(text, /auto: heat 1 >= 1 at recall/);
  fs.rmSync(root, { recursive: true, force: true });
});
