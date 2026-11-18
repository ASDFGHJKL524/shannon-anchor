// 用法速查：常驻注入，且清单从代码生成而不是手写（2026-11-17）。
// 动机：插件内部各个部分怎么调用，作者自己也记不得；
// 写死一份说明就会过期，所以模块清单取自文件头注释、工具计数取自注册处。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { moduleCatalog, summaryText } from "../lib/usage-index.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-usage-"));
}

test("模块清单从文件头注释生成，不是手写表", () => {
  const mods = moduleCatalog();
  assert.ok(mods.length > 20, `应该扫出二十多个模块，实际 ${mods.length}`);
  const undocumented = mods.filter((m) => !m.documented);
  assert.deepEqual(undocumented.map((m) => m.name), [], "每个模块都该在头注释写一句用途");
  const forget = mods.find((m) => m.name === "forget");
  assert.ok(forget && /forgetting/i.test(forget.purpose), "用途要读得到");
});

test("速查内容指向完整文档", () => {
  const text = summaryText({ tools: ["a", "b"], modules: moduleCatalog() });
  assert.match(text, /memory_write/);
  assert.match(text, /memory_curate/);
  assert.match(text, /memory_review/);
  assert.match(text, /docs\/USAGE\.md/);
  assert.match(text, /工具 2 个/, "计数要跟着传入的工具数走");
});

test("新模块没写头注释会被点名——这是可扩展性的保障", () => {
  const dir = tmpRoot();
  fs.writeFileSync(path.join(dir, "fresh.js"), "export const x = 1;\n", "utf8");
  fs.writeFileSync(path.join(dir, "documented.js"), "// does something specific.\nexport const y = 1;\n", "utf8");
  const mods = moduleCatalog(dir);
  const fresh = mods.find((m) => m.name === "fresh");
  assert.equal(fresh.documented, false);
  const text = summaryText({ tools: [], modules: mods });
  assert.match(text, /未写用途注释的模块：fresh/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("apply 之后用法速查真的进了系统提示", async () => {
  const m = await import("../lib/index.js?t=" + Date.now() + Math.random());
  const sections = [];
  const root = tmpRoot();
  m.apply(
    {
      logger: { info() {}, warn() {}, error() {} },
      tools: { register: () => {} },
      systemPrompt: { section: (o) => sections.push(o) },
      on: () => {}
    },
    { manualRoot: root },
    { strictHost: true }
  );
  const usage = sections.find((s) => s.name === "shannon-anchor-usage");
  assert.ok(usage, "必须注入 shannon-anchor-usage");
  const text = usage.text();
  assert.match(text, /插件用法速查/);
  assert.match(text, /工具 \d+ 个 \/ 模块 \d+ 个/);
  fs.rmSync(root, { recursive: true, force: true });
});
