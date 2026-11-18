// shannon-anchor - judge tests. A judge that never says "undecided" is
// guessing; one that never decides is useless. Both failure modes tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, noul, choice, score, judgeWorthRecording, DEFAULT_CONFIDENCE_FLOOR } from "../lib/judge.js";

test("noul: pure noise is discarded with high confidence", () => {
  const r = judge("你好呀", { worth: noul("x") });
  assert.equal(r.answers.worth.undecided, false);
  assert.equal(r.answers.worth.noul, 0);
  assert.ok(r.answers.worth.confidence > 0.5);
});

test("noul: empty / trivial text is worthless", () => {
  assert.equal(judge("", { worth: noul("x") }).answers.worth.noul, 0);
  assert.equal(judge("太短", { worth: noul("x") }).answers.worth.noul, 0);
});

test("noul: a real lesson lands in the grey zone, not a forced record", () => {
  const r = judge("以后遇到 Remove-Item 要先确认路径，上次踩坑误删了文件", { worth: noul("x") });
  const a = r.answers.worth;
  // the whole point: no forced guess in the grey zone
  assert.equal(a.undecided, true);
  assert.ok(a.prob > 0.5, "it does lean toward worth");
});

test("choice: picks the option whose description overlaps the state", () => {
  const r = judge("备份快照没做完就重启了", {
    which: choice("which task", {
      backup: "备份 快照 backup snapshot 归档",
      delete: "删除 移除 remove"
    })
  });
  assert.equal(r.answers.which.choice, "backup");
});

test("choice: no overlap -> undecided, never a forced pick", () => {
  const r = judge("随便一句话", {
    which: choice("which task", { backup: "备份 快照", delete: "删除 移除" })
  });
  assert.equal(r.answers.which.undecided, true);
});

test("score: rates on the rubric", () => {
  const r = judge("你好", { grade: score("rate", ["low", "mid", "high"]) });
  assert.equal(typeof r.answers.grade.score, "number");
  assert.ok(r.answers.grade.score >= 0 && r.answers.grade.score <= 2);
});

test("confidence floor is configurable", () => {
  // raise the floor: the same input that used to decide now goes grey
  const low = judge("你好呀", { worth: noul("x") }, { confidenceFloor: 0.2 });
  const high = judge("你好呀", { worth: noul("x") }, { confidenceFloor: 1.01 });
  assert.equal(low.answers.worth.undecided, false);
  assert.equal(high.answers.worth.undecided, true);
});

test("judgeWorthRecording: discard is confident, undecided routes upward", () => {
  assert.equal(judgeWorthRecording("你好呀").verdict, "discard");
  const u = judgeWorthRecording("以后遇到 Remove-Item 要先确认路径，上次踩坑误删了文件");
  assert.equal(u.verdict, "undecided");
});

test("bad question shape never throws", () => {
  const r = judge("x", { broken: null });
  assert.equal(r.answers.broken.undecided, true);
});