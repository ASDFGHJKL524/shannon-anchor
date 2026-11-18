// experience-autofill 的回归测试（2026-11-06）。
//
// 动机：机械触发应该像经验库一样有自我补全能力。
// 这里钉住四件事：未命中会记账、手册 tags 能读、反复出现的词能补进规则、
// 失效的 recall 编号会被清掉。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  recordMiss,
  readMisses,
  scanManualTags,
  suggestFills,
  pruneStaleRecall,
  applyFills,
} from "../lib/experience-autofill.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "exp-autofill-"));
  fs.mkdirSync(path.join(d, "guard"), { recursive: true });
  fs.mkdirSync(path.join(d, "conf"), { recursive: true });
  fs.mkdirSync(path.join(d, "manual", "04-experience"), { recursive: true });
  return d;
}

test("未命中的用户消息会记进 miss 日志", () => {
  const root = tmpRoot();
  recordMiss(root, "用moss跑一张");
  recordMiss(root, "用moss再跑一张");
  const misses = readMisses(root);
  assert.equal(misses.length, 2);
  assert.match(misses[0].text, /moss/);
});

// 真实手册的 tags 只有在本机（包旁边放着 runtime）时才验得到。发布包不含手册数据，
// 这种情况跳过而不是报红 —— 缺数据不等于代码坏了。
const RUNTIME_ROOT = path.join(PKG, "..", "shannon-anchor-runtime");

test("手册条目的 tags 能读出来",
  { skip: fs.existsSync(RUNTIME_ROOT) ? false : "没有运行时手册，跳过真实 tags 的读取" },
  () => {
  const tags = scanManualTags(RUNTIME_ROOT);
  // 真实手册里 #357 的 tags 含 moss / klein
  const e357 = tags.find((e) => e.number === 357);
  assert.ok(e357, "应能读到 #357");
  assert.ok(e357.tags.some((t) => /moss/i.test(t)), "#357 的 tags 应含 moss");
});

test("反复出现的词若是手册 tag，会补进最相关规则", () => {
  const rules = [
    { id: "model-run", match: ["comfyui", "生图"], recall: [42] },
    { id: "delete-anything", match: ["删"], recall: [73] },
  ];
  const manualTags = [{ number: 357, tags: ["出图", "模型", "MOSS", "Klein"] }];
  const misses = [
    { text: "用moss跑一张" },
    { text: "用moss再跑一张" },
    { text: "moss 出图" },
  ];
  const fills = suggestFills(misses, manualTags, rules);
  assert.ok(fills.length >= 1, "应至少补一个词");
  const mossFill = fills.find((f) => /moss/i.test(f.word));
  assert.ok(mossFill, "应补 moss");
  assert.equal(mossFill.ruleId, "model-run");
  assert.equal(mossFill.entry, 357);
});

test("只出现一次的词不补（宁缺勿滥）", () => {
  const rules = [{ id: "model-run", match: ["comfyui"], recall: [42] }];
  const manualTags = [{ number: 357, tags: ["MOSS"] }];
  const fills = suggestFills([{ text: "用moss跑一张" }], manualTags, rules);
  assert.equal(fills.length, 0);
});

test("recall 里指向不存在条目的编号会被清掉", () => {
  const rules = [{ id: "x", match: ["a"], recall: [42, 99999] }];
  const pruned = pruneStaleRecall(rules, [42, 357]);
  assert.equal(rules[0].recall.length, 1);
  assert.deepEqual(rules[0].recall, [42]);
  assert.equal(pruned[0].dropped[0], 99999);
});

test("applyFills 会备份并写回规则表", () => {
  const root = tmpRoot();
  const rulesPath = path.join(root, "conf", "experience-rules.json");
  fs.writeFileSync(
    rulesPath,
    JSON.stringify({ version: 1, rules: [{ id: "model-run", match: ["comfyui"], recall: [42] }] }, null, 2),
    "utf8"
  );
  const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8")).rules;
  const res = applyFills(root, rules, [{ ruleId: "model-run", word: "moss", entry: 357 }]);
  assert.ok(res.backup, "应返回备份路径");
  const after = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
  assert.ok(after.rules[0].match.includes("moss"));
  assert.ok(after.rules[0].recall.includes(357));
  assert.ok(fs.existsSync(path.join(root, res.backup)), "备份文件应存在");
});
