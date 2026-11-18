// 启动自检：插件没有 engines.dsh / peerDependencies，DSH 升级不会拦它，也不会保护它。
// 接口缺了就点名报出来——静默降级比崩溃难查（2026-11-17）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function mod() {
  return import("../lib/index.js?t=" + Date.now() + Math.random());
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-host-"));
}

test("缺宿主接口时点名缺什么，strictHost 直接抛", async () => {
  const m = await mod();
  const errs = [];
  const root = tmpRoot();
  const ctx = { logger: { info() {}, warn() {}, error: (x) => errs.push(String(x)) } };

  assert.throws(() => m.apply(ctx, { manualRoot: root }, { strictHost: true }), /不兼容/);
  const text = errs.join("\n");
  assert.match(text, /tools\.register/);
  assert.match(text, /systemPrompt\.section/);
  assert.match(text, /ctx\.on/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("默认不抛：缺接口也不把整个 DSH 拖下水，但必须留痕", async () => {
  const m = await mod();
  const errs = [];
  const root = tmpRoot();
  const ctx = { logger: { info() {}, warn() {}, error: (x) => errs.push(String(x)) } };

  // 适配层把缺失接口换成 no-op，apply 走完不崩——降级好过起不来。
  assert.doesNotThrow(() => m.apply(ctx, { manualRoot: root }, {}));
  assert.match(errs.join("\n"), /不兼容/, "必须留下可读的原因");

  const report = path.join(root, "runtime", "host-report.json");
  assert.ok(fs.existsSync(report), "缺接口时要写 host-report.json");
  const r = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(r.degraded, true);
  assert.ok(r.missing.length >= 3, "tools/prompt/event 三个都缺");
  fs.rmSync(root, { recursive: true, force: true });
});

test("接口改名时自动接上候选，并留下适配痕迹", async () => {
  const m = await mod();
  const warns = [];
  const sections = [];
  const root = tmpRoot();
  const ctx = {
    logger: { info() {}, warn: (x) => warns.push(String(x)), error() {} },
    tools: { register: () => {} },
    prompts: { section: (o) => sections.push(o) }, // 假设 DSH 把它改名成 prompts.section
    on: () => {}
  };
  m.apply(ctx, { manualRoot: root }, { strictHost: true });

  assert.ok(sections.length > 0, "提示注入应该走通新路径");
  assert.match(warns.join("\n"), /自动适配/, "走了候选路径必须留一声");
  const report = JSON.parse(fs.readFileSync(path.join(root, "runtime", "host-report.json"), "utf8"));
  assert.equal(report.picked.prompt, "prompts.section");
  assert.equal(report.degraded, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("接口齐的宿主不误报", async () => {
  const m = await mod();
  const errs = [];
  const root = tmpRoot();
  const ctx = {
    logger: { info() {}, warn() {}, error: (x) => errs.push(String(x)) },
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    on: () => {}
  };
  m.apply(ctx, { manualRoot: root }, { strictHost: true });
  assert.equal(errs.length, 0, "正常宿主不该报不兼容：" + errs.join("; "));
  fs.rmSync(root, { recursive: true, force: true });
});
