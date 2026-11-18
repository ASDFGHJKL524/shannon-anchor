// shannon-anchor — retrieval tests.
// What must hold: Chinese is searchable (bigram tokenizer), fuzzy matches
// land (vector fallback), cold entries are down-weighted but never hidden,
// and a query that matches nothing returns nothing without throwing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { search, bm25, vectorize, cosine } from "../lib/retrieval.js";
import { tokenize } from "../lib/tokenize.js";

const ENTRIES = [
  { number: 73, title: "删除守卫：禁通配符、两段式令牌", path: "01-rules/73.md", superseded: false },
  { number: 58, title: "备份与自保：包和密码分开放", path: "01-rules/58.md", superseded: false },
  { number: 76, title: "插件报 binary not available 先查真实安装路径", path: "02-method/76.md", superseded: false },
  { number: 12, title: "WorkBuddy 国内版路径已过期", path: "04-experience/12.md", superseded: true }
];
const STATS = { "58": { tier: 3, count: 0.2 }, "73": { tier: 1, count: 9 } };

test("Chinese query finds the Chinese entry", () => {
  const r = search(ENTRIES, "删除");
  assert.ok(r.length >= 1);
  assert.equal(r[0].entry.number, 73);
});

test("English query finds the English entry", () => {
  const r = search(ENTRIES, "binary not available");
  assert.ok(r.length >= 1);
  assert.equal(r[0].entry.number, 76);
});

test("a cold-tier hit is down-weighted but NOT hidden", () => {
  const hot = search(ENTRIES, "删除", { stats: { "73": { tier: 1 }, "58": { tier: 1 } } });
  const cold = search(ENTRIES, "删除", { stats: { "73": { tier: 1 }, "58": { tier: 3 } } });
  // entry 58 is cold in `cold`; if it appears at all it must score lower
  if (cold.find((r) => r.entry.number === 58)) {
    assert.ok(cold.find((r) => r.entry.number === 58).score <= (hot.find((r) => r.entry.number === 58) || { score: 0 }).score);
  }
  assert.ok(hot.length > 0, "the query still returns results");
});

test("a relevant cold entry still surfaces (labelled, not invisible)", () => {
  const r = search(ENTRIES, "备份 密码 分开放", { stats: { "58": { tier: 3, count: 0.1 } } });
  assert.ok(r.some((x) => x.entry.number === 58), "cold but relevant beats invisible");
  assert.equal(r.find((x) => x.entry.number === 58).tier, 3);
});

test("superseded entries are excluded by default", () => {
  const r = search(ENTRIES, "WorkBuddy 路径", {});
  assert.equal(r.some((x) => x.entry.number === 12), false, "a replaced conclusion must not surface as advice");
});

test("includeSuperseded exposes retired entries, still flagged", () => {
  const r = search(ENTRIES, "WorkBuddy 路径", { includeSuperseded: true });
  const hit = r.find((x) => x.entry.number === 12);
  assert.ok(hit, "the lineage view still has it");
  assert.equal(hit.superseded, true);
});

test("no match returns empty, not garbage", () => {
  const r = search(ENTRIES, "zzzqqqxxx");
  assert.equal(r.length, 0);
});

test("empty query is a no-op", () => {
  assert.equal(search(ENTRIES, "").length, 0);
  assert.equal(search(ENTRIES, "   ").length, 0);
});

test("bm25 ranks the exact-term entry first", () => {
  const s = bm25(["删除 通配符 令牌", "备份 密码"], "通配符");
  assert.ok(s[0] > s[1]);
});

test("vectorize is deterministic and cosine is 1 for identical text", () => {
  const a = vectorize("删除守卫");
  const b = vectorize("删除守卫");
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9, "identical vector is ~1 up to float error");
});

// Measured on the live manual 2026-10-30: every unrelated query returned five
// entries at absolute 0.49-0.53 on the strength of 怎么/什么 alone, because a
// manual full of incident reports is also full of "怎么办". The question word
// is not the topic.
test("an interrogative is not a topic", () => {
  const manual = [
    { number: 1, title: "今天犯的三次错", path: "04-experience/1.md" },
    { number: 2, title: "接口挂了怎么查", path: "04-experience/2.md" }
  ];
  assert.equal(search(manual, "今天天气怎么样").length, 0, "date + question words carry no topic");
  assert.equal(search(manual, "晚饭吃什么").length, 0, "the question word alone is not a hit");
  assert.equal(search(manual, "接口挂了怎么查")[0].entry.number, 2, "a real question still finds its entry");
});

test("a Latin word typed against Chinese stays one token", () => {
  // "tts是什么" used to yield tt/ts/s是 — 是 is a stop word, so only the
  // identifier-shaped fragments survived, and 0.657 matched router.ts.
  const t = tokenize("tts是什么");
  assert.ok(t.has("tts"), "the word the user typed is the token");
  assert.ok(!t.has("ts"), "ts is a fragment of router.ts, not a topic");
});

test("cutting a stop phrase splits the run instead of gluing its neighbours", () => {
  const t = tokenize("删除守卫怎么用");
  assert.ok(t.has("守卫"));
  assert.ok(!t.has("卫用"), "卫用 is a bigram nobody wrote");
});

test("limit is respected", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ number: i, title: `删除 守卫 ${i}`, path: `x/${i}.md` }));
  assert.equal(search(many, "删除", { limit: 5 }).length, 5);
});

// The tokenizer emits bigrams across word boundaries: 问题是什么 yields
// 问题 + 题是, and 主题是配色 also contains 题是. Once any entry carries that
// accident it becomes a df=1 token at max idf and taxes every OTHER entry's
// coverage. Measured on the live manual 2026-10-31: #305 brought 题是 into the
// corpus and silenced a good Codex fire (0.479 -> 0.433). A bigram glued
// across two words is neither evidence for nor against an entry.
test("a cross-word bigram in the corpus is not evidence", () => {
  const manual = [
    { number: 1, title: "问题排查", path: "04-experience/1.md" },
    { number: 2, title: "主题是配色", path: "04-experience/2.md" }
  ];
  // search() also returns cosine-only rows, so the length is not the claim:
  // the claim is that 题是 gives entry 2 no coverage and no absolute score.
  const rows = search(manual, "问题是什么", { absolute: true, minScore: 0 });
  const topical = rows.find((r) => r.entry.number === 1);
  const artifact = rows.find((r) => r.entry.number === 2);
  assert.ok(topical, "the entry carrying 问题 must be scored");
  assert.equal(topical.coverage, 1, "题是 must not dilute the coverage denominator");
  assert.ok(topical.abs > 0);
  if (artifact) {
    assert.equal(artifact.coverage, 0, `题是 gave 主题是配色 coverage ${artifact.coverage}`);
    assert.equal(artifact.abs, 0, `题是 gave 主题是配色 abs ${artifact.abs}`);
  }
});