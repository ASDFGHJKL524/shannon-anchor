// 分对话热度（2026-11-02）：session 维度记账 + 检索加权。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { countUsage, sweep } from "../lib/forget.js";
import { currentSessionId, shortSessionId } from "../lib/session-id.js";
import { search } from "../lib/retrieval.js";

function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pagi-heat-"));
  fs.mkdirSync(path.join(d, "manual"), { recursive: true });
  return d;
}

test("countUsage 记录本次会话，同一会话累加", () => {
  const root = tmpRoot();
  countUsage(root, 7, { sessionId: "sid-a" });
  countUsage(root, 7, { sessionId: "sid-a" });
  countUsage(root, 7, { sessionId: "sid-b" });
  const stats = JSON.parse(fs.readFileSync(path.join(root, "stats.json"), "utf8"));
  const s = stats["7"];
  assert.equal(s.sessions["sid-a"].count, 2);
  assert.equal(s.sessions["sid-b"].count, 1);
  assert.ok(s.lastUsedAt, "精确时间戳要记");
});

test("传 null 会话时只记全局，不写 sessions", () => {
  const root = tmpRoot();
  countUsage(root, 8, { sessionId: null });
  const stats = JSON.parse(fs.readFileSync(path.join(root, "stats.json"), "utf8"));
  assert.equal(stats["8"].sessions, undefined);
  assert.ok(stats["8"].count > 0);
});

test("旧 stats 没有 sessions 字段也能升级写入", () => {
  const root = tmpRoot();
  fs.writeFileSync(
    path.join(root, "stats.json"),
    JSON.stringify({ "9": { count: 3, lastUsed: "2026-10-01", tier: 1 } }),
    "utf8"
  );
  countUsage(root, 9, { sessionId: "sid-c" });
  const stats = JSON.parse(fs.readFileSync(path.join(root, "stats.json"), "utf8"));
  assert.equal(stats["9"].sessions["sid-c"].count, 1);
});

test("会话数超过 20 时只留最近的", () => {
  const root = tmpRoot();
  for (let i = 0; i < 25; i++) {
    countUsage(root, 10, { sessionId: `sid-${i}` });
  }
  const stats = JSON.parse(fs.readFileSync(path.join(root, "stats.json"), "utf8"));
  assert.ok(Object.keys(stats["10"].sessions).length <= 20);
});

test("检索时本会话命中的条目优先于未命中的同类条目", () => {
  const entries = [
    { number: 1, title: "删除守卫", body: "删东西要走删除守卫", path: "a.md" },
    { number: 2, title: "删除守卫二", body: "删东西要走删除守卫", path: "b.md" }
  ];
  const stats = {
    "1": { count: 1, tier: 1, sessions: { "sid-x": { count: 2 } } },
    "2": { count: 1, tier: 1 }
  };
  const hit = search(entries, "删东西 删除守卫", { stats, sessionId: "sid-x", limit: 2 });
  assert.equal(hit.length, 2);
  assert.equal(hit[0].entry.number, 1, "本会话用过的应该排第一");
});

test("currentSessionId 不炸（拿不到返回 null 也可接受）", () => {
  const id = currentSessionId(os.tmpdir());
  assert.ok(id === null || typeof id === "string");
  if (id) assert.equal(typeof shortSessionId(id), "string");
});

test("sweep 不被 sessions 字段干扰", () => {
  const root = tmpRoot();
  countUsage(root, 11, { sessionId: "sid-y" });
  const r = sweep(root, { entries: [{ number: 11, lastUsed: null, created: null }] });
  assert.ok(r && typeof r === "object");
  const stats = JSON.parse(fs.readFileSync(path.join(root, "stats.json"), "utf8"));
  assert.ok(stats["11"].sessions["sid-y"], "sweep 不该清掉会话记录");
});
