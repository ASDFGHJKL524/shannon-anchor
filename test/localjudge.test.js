import assert from "node:assert/strict";
import { test } from "node:test";

import { parseVerdict, verifyVerdict, renderVerdict } from "../lib/localjudge.js";

const manual = {
  entries: [
    { number: 380, title: "评审设计：机器当筛子，人当法官", body: "kappa 跨判据失效；calib3 实测 20 条；机器抓缺陷，人做取舍。" },
    { number: 400, title: "Blender 无头 Cycles 默认走 CPU", body: "实测 5 分 24 秒降到 30 秒，设置 compute_device_type。" }
  ]
};

const entry = {
  number: 381,
  title: "Blender 无头渲染要设 OPTIX",
  body: "实测 RTX 5060 从 5 分 24 秒降到 30 秒，路径 D:\\blender.exe。"
};

test("parseVerdict 认三种裁决和 into", () => {
  assert.deepEqual(
    parseVerdict("verdict: keep\ninto: -\n理由: 有出处").verdict,
    "keep"
  );
  const m = parseVerdict("verdict: merge\ninto: 380\n理由: 同一件事");
  assert.equal(m.verdict, "merge");
  assert.equal(m.into, 380);
  const d = parseVerdict("verdict: drop\ninto: -\n理由: 没价值");
  assert.equal(d.verdict, "drop");
  assert.equal(d.into, null);
});

test("模型乱说话时 verdict 是 ?，不是一个默认值", () => {
  const r = parseVerdict("我觉得这条还行吧");
  assert.equal(r.verdict, "?", "不能把解析失败猜成 keep");
});

test("merge 指向不存在的条目会被标出来", () => {
  const parsed = { verdict: "merge", into: 999, reason: "x" };
  const checks = verifyVerdict(manual, 381, parsed, entry);
  const c = checks.find((x) => x.name === "into-exists");
  assert.equal(c.ok, false);
  assert.match(c.note, /999/);
});

test("merge 进自己会被标出来（E4B 犯过的错）", () => {
  const parsed = { verdict: "merge", into: 381, reason: "x" };
  const checks = verifyVerdict(manual, 381, parsed, entry);
  const c = checks.find((x) => x.name === "not-self");
  assert.equal(c.ok, false);
});

test("merge 到内容不相关的条目会被标出来", () => {
  const parsed = { verdict: "merge", into: 380, reason: "x" };
  const checks = verifyVerdict(manual, 381, parsed, entry);
  const c = checks.find((x) => x.name === "related");
  assert.equal(c.ok, false, "Blender 渲染并进评审设计显然不对");
});

test("merge 到讲同一件事的条目能过相关性", () => {
  const parsed = { verdict: "merge", into: 400, reason: "x" };
  const checks = verifyVerdict(manual, 381, parsed, entry);
  const c = checks.find((x) => x.name === "related");
  assert.equal(c.ok, true);
});

test("判 drop 但正文带实测数值时提醒人看一眼", () => {
  const checks = verifyVerdict(manual, 381, { verdict: "drop", into: null, reason: "x" }, entry);
  const c = checks.find((x) => x.name === "drop-has-evidence");
  assert.equal(c.ok, false);
});

test("干净条目判 drop 不触发证据提醒", () => {
  const plain = { number: 402, title: "一句空话", body: "要注意分寸。" };
  const checks = verifyVerdict(manual, 402, { verdict: "drop", into: null, reason: "x" }, plain);
  const c = checks.find((x) => x.name === "drop-has-evidence");
  assert.equal(c.ok, true);
});

test("本地模型不可用时 render 说清楚，而不是假装判过", () => {
  const text = renderVerdict({ ok: false, error: "ECONNREFUSED" });
  assert.match(text, /失败/);
  assert.match(text, /ECONNREFUSED/);
});

test("render 会把没过的校验列出来", () => {
  const text = renderVerdict({
    ok: true, model: "m", number: 381, verdict: "merge", into: 999,
    reason: "同一件事",
    checks: [{ name: "into-exists", ok: false, note: "#999 不在手册里" }]
  });
  assert.match(text, /✗ into-exists/);
  assert.match(text, /人工确认/);
});
