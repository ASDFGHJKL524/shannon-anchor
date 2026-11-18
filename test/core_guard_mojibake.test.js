// core-guard 的乱码容错回归测试。
//
// 2026-11-01 实测：DSH 把工具参数交给插件时，中文路径有时已经是
// "UTF-8 字节被 GBK 解码"的样子（D:\示例用户\... → 一串 GBK 乱码）。
// 不修的话 core-guard 会漏拦：正确路径 allowed=false，乱码路径 allowed=true。
// 这条测试就是钉住那个洞。

import { test } from "node:test";
import assert from "node:assert/strict";
import { coreHits } from "../lib/core-guard.js";

// 故意用带中文的路径：纯 ASCII 路径没有"乱码形态"，测不出这个洞。
const CORE = "D:/示例用户/shannon-anchor-runtime";

function mojibake(p) {
  const dec = new TextDecoder("gbk");
  return dec.decode(Buffer.from(p, "utf8"));
}

test("coreHits matches a plain core path", () => {
  const hits = coreHits(`Set-Content '${CORE}/x.txt' 'a'`, [CORE]);
  assert.deepEqual(hits, [CORE]);
});

test("coreHits still matches when the path arrives as GBK mojibake", () => {
  const bad = mojibake(CORE);
  assert.notEqual(bad, CORE, "precondition: the mojibake form differs from the real path");
  const hits = coreHits(`Set-Content '${bad}/x.txt' 'a'`, [CORE]);
  assert.deepEqual(hits, [CORE], "mojibake paths must not slip through core-guard");
});

test("coreHits ignores paths outside the core", () => {
  assert.deepEqual(coreHits(`Set-Content 'D:/示例用户/other/x.txt' 'a'`, [CORE]), []);
});
