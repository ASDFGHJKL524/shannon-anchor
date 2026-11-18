// Retirement must be a metadata marker, not a word in the prose.
//
// Regression: the real manual's entry 98 explains the supersede mechanism
// ("旧的标 superseded_by 永不删除"). Body-scanning for the word flagged it as
// retired, so the index showed a live rule with a strikethrough — and the
// entry that ranked first for "删除文件之前要做什么" was one marked as dead.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadManual, indexOf } from "../lib/manual_store.js";

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-supersede-"));
  fs.mkdirSync(path.join(root, "manual", "01-rules"), { recursive: true });
  return root;
}

function put(root, n, head, body) {
  const text = [`### ${n}. 条目 ${n}`, "", head, "", body].filter((l) => l !== "").join("\n") + "\n";
  fs.writeFileSync(path.join(root, "manual", "01-rules", `${n}.md`), text, "utf8");
}

test("prose that explains the mechanism is NOT retired", () => {
  const root = tmpRoot();
  put(root, 1, "<!-- created: 2026-10-17 -->", "冲突四级 + 三动作：旧的标 superseded_by 永不删除，血缘链需要它存在过。");
  const e = loadManual(root).entries.find((x) => x.number === 1);
  assert.equal(e.superseded, false);
});

test("hyphen marker retires the entry", () => {
  const root = tmpRoot();
  put(root, 2, "<!-- superseded-by: 12 (2026-10-18) -->", "正文完全没提那个词。");
  assert.equal(loadManual(root).entries.find((x) => x.number === 2).superseded, true);
});

test("underscore marker retires the entry", () => {
  const root = tmpRoot();
  put(root, 3, "<!-- superseded_by: 12 -->", "手册传统写法。");
  assert.equal(loadManual(root).entries.find((x) => x.number === 3).superseded, true);
});

test("merge marker retires the entry", () => {
  const root = tmpRoot();
  put(root, 4, "<!-- merged-into: 59 -->", "并进了另一条。");
  assert.equal(loadManual(root).entries.find((x) => x.number === 4).superseded, true);
});

test("empty marker value does not retire", () => {
  const root = tmpRoot();
  put(root, 5, "<!-- superseded-by: -->", "标记没填目标，等于没标。");
  assert.equal(loadManual(root).entries.find((x) => x.number === 5).superseded, false);
});

test("marker outside the head window does not retire", () => {
  const root = tmpRoot();
  const far = ["<!-- created: 2026-10-17 -->", ...Array.from({ length: 20 }, (_, i) => `第 ${i} 行正文。`), "<!-- superseded-by: 12 -->"].join("\n");
  fs.writeFileSync(path.join(root, "manual", "01-rules", "6.md"), `### 6. 条目 6\n\n${far}\n`, "utf8");
  // Documented limit, not a silent pass: the parser only reads the head.
  assert.equal(loadManual(root).entries.find((x) => x.number === 6).superseded, false);
});

test("the successor number and marker kind are carried on the entry", () => {
  const root = tmpRoot();
  put(root, 9, "<!-- superseded-by: 12 (2026-10-18) -->", "被 12 取代。");
  const e = loadManual(root).entries.find((x) => x.number === 9);
  assert.equal(e.supersededBy, 12);
  assert.equal(e.linkKind, "superseded_by");
});

test("index marks only the retired one", () => {
  const root = tmpRoot();
  put(root, 7, "<!-- created: 2026-10-17 -->", "讲机制：旧的标 superseded_by 永不删除。");
  put(root, 8, "<!-- superseded-by: 7 -->", "真退役了。");
  const out = indexOf(loadManual(root), { tiers: "all" });
  const line7 = out.split("\n").find((l) => l.startsWith("| 7 |"));
  const line8 = out.split("\n").find((l) => l.startsWith("| 8 |"));
  assert.ok(line7 && !line7.includes("~superseded~"), `条目 7 被误标：${line7}`);
  assert.ok(line8 && line8.includes("~superseded~"), `条目 8 没被标：${line8}`);
});
