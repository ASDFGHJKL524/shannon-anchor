// core-guard enforce 白名单的回归测试（2026-11-02 切 enforce 时立）。
//
// 关键约束：核心区只保护「记忆内容」（手册、人设、记忆库、语感），
// 不拦「配置文件」（conf/、stats.json）——否则改配置本身就被闸门挡住，
// dry-run 期间 8 次 write 全是改配置，直接切 enforce 会把人锁死。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCoreGuard } from "../lib/core-guard.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = {
  ...JSON.parse(fs.readFileSync(path.join(PKG, "conf/default.json"), "utf8")).coreGuard,
  // 测试自带一条白名单命令，不依赖某台机器上的脚本文件名
  allowCommands: ["delete-guard\\.py"]
};
const ROOT = "~/.dsh/shannon-anchor";

function guard() {
  return createCoreGuard({ root: ROOT, cfg, logger: { info() {}, warn() {} } });
}

test("配置是 enforce 且核心区已收窄到记忆内容", () => {
  assert.equal(cfg.mode, "enforce");
  const paths = cfg.paths.join("|");
  assert.ok(paths.includes("manual"), "手册目录要保护");
  assert.ok(paths.includes("identity.md"), "人设要保护");
  assert.ok(!paths.includes("conf"), "配置目录不能被拦（否则自己锁死）");
});

test("write 写手册 → 拦", () => {
  const v = guard().judge("write", { path: `${ROOT}/manual/01-rules/1.md`, content: "x" });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "not-allowlisted");
});

test("编辑普通文档、正文提到核心区路径 → 放行（2026-11-02 误伤修复）", () => {
  // 典型误伤：改一份待办文档，只因为正文里提到了核心区路径就被拦。
  // 判定只该看目标路径，不看内容。
  const v = guard().judge("edit", {
    file_path: "~/.dsh/notes/todo.md",
    old_string: "旧内容",
    new_string: `这里提到了 ${ROOT}/manual 这个路径`
  });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, "outside-core");
});

test("pwsh 命令里提到核心区路径 → 仍然拦（命令真会写）", () => {
  const v = guard().judge("pwsh", { command: `Copy-Item x '${ROOT}/manual/1.md'` });
  assert.equal(v.allowed, false);
});

test("write 写配置 → 放行（这条是切 enforce 的前提）", () => {
  const v = guard().judge("write", { path: `${ROOT}/conf/user.json`, content: "x" });
  assert.equal(v.allowed, true);
});

test("write 写 stats.json → 放行", () => {
  const v = guard().judge("write", { path: `${ROOT}/stats.json`, content: "x" });
  assert.equal(v.allowed, true);
});

test("memory_write → 放行（它才是写手册的正门）", () => {
  const v = guard().judge("memory_write", { title: "t", body: "b" });
  assert.equal(v.allowed, true);
});

test("pwsh 直写手册 → 拦", () => {
  const v = guard().judge("pwsh", { command: `Set-Content '${ROOT}/manual/01-rules/1.md' 'x'` });
  assert.equal(v.allowed, false);
});

test("护栏脚本删手册 → 放行（白名单命令）", () => {
  const v = guard().judge("pwsh", {
    command: `python delete-guard.py '${ROOT}/manual/x.md' --reason r`
  });
  assert.equal(v.allowed, true);
});

test("读手册 → 放行（白名单管写不管读）", () => {
  const v = guard().judge("read", { file_path: `${ROOT}/manual/01-rules/1.md` });
  assert.equal(v.allowed, true);
});

test("pwsh 写 global AGENTS.md → 拦", () => {
  const v = guard().judge("pwsh", { command: `Set-Content '~/.dsh/AGENTS.md' 'x'` });
  assert.equal(v.allowed, false);
});

test("5.1 + 中文命令 → 编码闸门拦下（与 mode 无关）", () => {
  const v = guard().judge("pwsh", { command: "powershell -File 'D:/示例用户/tools/x.ps1'" });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "powershell-51-cjk");
});
