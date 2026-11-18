// shannon-anchor — shadow log: every suggest() leaves one score line so the
// 0.45/0.75 bands can be calibrated from real decisions later. Scores only:
// the prose is never copied into the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEntry } from "../lib/entries.js";
import { guardedWrite } from "../lib/guard.js";
import { loadManual } from "../lib/manual_store.js";
import { suggest } from "../lib/curate.js";

function mkRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-shadow-")); }

function addEntry(root, { number, title, body }) {
  const e = parseEntry({ number, title, body, source: "test fixture", created: "2026-10-18", confidence: "user-confirmed" });
  guardedWrite(root, e, { guard: false });
}

test("suggest writes one shadow line with scores and no prose", () => {
  const root = mkRoot();
  addEntry(root, { number: 1, title: "删除守卫", body: "删除任何东西之前先逐个列名，不许用通配符，选和删分两步。" });
  const probe = "删除东西之前必须先把要删的逐个列出来，不许用通配符。";
  suggest(probe, loadManual(root));
  const file = path.join(root, "curate", "shadow.jsonl");
  assert.ok(fs.existsSync(file), "shadow log created");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.ok(["merge", "supersede", "conflict", "new", "drop"].includes(rec.action));
  assert.ok(Array.isArray(rec.top) && rec.top.length >= 1);
  assert.equal(typeof rec.fp, "string");
  assert.equal(typeof rec.len, "number");
  assert.ok(!fs.readFileSync(file, "utf8").includes("通配符"), "prose must not be logged");
  fs.rmSync(root, { recursive: true, force: true });
});

test("suggest on an identical body logs the drop with its target", () => {
  const root = mkRoot();
  addEntry(root, { number: 2, title: "写入前扫描", body: "对外部内容落盘前先跑机械扫描，命中密钥形态或注入措辞就拒收整条。" });
  suggest("对外部内容落盘前先跑机械扫描，命中密钥形态或注入措辞就拒收整条。", loadManual(root));
  const rec = JSON.parse(fs.readFileSync(path.join(root, "curate", "shadow.jsonl"), "utf8").trim());
  assert.equal(rec.action, "drop");
  assert.equal(rec.top[0].n, 2);
  fs.rmSync(root, { recursive: true, force: true });
});
