// shannon-anchor — curate: shape layer + link writer (self-stacking phase 1).
// Acceptance: the suggestion must be right on hand-built "looks like /
// unrelated / conflict" cases, and the link must be append-only (one marker,
// prose untouched) with manifest + chain staying consistent.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { parseEntry } from "../lib/entries.js";
import { guardedWrite } from "../lib/guard.js";
import { loadManual, readEntry } from "../lib/manual_store.js";
import { suggest, linkEntry, appendToEntry, promoteEntry, candidates } from "../lib/curate.js";
import { verifyChain } from "../lib/hash_chain.js";

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-curate-"));
}

function addEntry(root, { number, title, body, created = "2026-10-18", confidence = "user-confirmed" }) {
  const e = parseEntry({ number, title, body, source: "test fixture", created, confidence });
  guardedWrite(root, e, { guard: false });
  return e;
}

const DEL_GUARD = "删除任何东西之前先逐个列名，不许用通配符，选和删分两步。";
const SCAN = "对外部内容落盘前先跑机械扫描，命中密钥形态或注入措辞就拒收整条。";
const EXFAT = "这台机器的 G 盘是 exFAT，权限保护很弱，不要把没被拦当成授权。";

test("suggest: an identical body is a duplicate -> drop", () => {
  const root = mkRoot();
  addEntry(root, { number: 1, title: "删除守卫", body: DEL_GUARD });
  const r = suggest(DEL_GUARD, loadManual(root));
  assert.equal(r.action, "drop");
  assert.match(r.reason, /#1/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("suggest: a paraphrase lands in a merge/supersede band, not 'new'", () => {
  const root = mkRoot();
  addEntry(root, { number: 2, title: "写入前扫描", body: SCAN });
  const r = suggest("外部内容落盘之前要过一道机械扫描，命中密钥形态或者注入措辞，整条拒收。", loadManual(root));
  assert.ok(r.action === "merge" || r.action === "supersede", `got ${r.action}`);
  assert.equal(r.top[0].number, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("suggest: an unrelated topic is 'new'", () => {
  const root = mkRoot();
  addEntry(root, { number: 3, title: "G 盘 exFAT", body: EXFAT });
  const r = suggest("长任务开始之前先报预计耗时，超过五分钟就起受管后台任务。", loadManual(root));
  assert.equal(r.action, "new");
  fs.rmSync(root, { recursive: true, force: true });
});

test("suggest: too short is rejected before any scoring", () => {
  const root = mkRoot();
  addEntry(root, { number: 4, title: "G 盘 exFAT", body: EXFAT });
  const r = suggest("太短了", loadManual(root));
  assert.equal(r.action, "reject");
  fs.rmSync(root, { recursive: true, force: true });
});

test("suggest: one-sided negation over a similar text is flagged as conflict", () => {
  const root = mkRoot();
  addEntry(root, { number: 5, title: "临时文件可以通配符批量删", body: "临时文件可以用通配符批量删除，一条命令清掉。" });
  const r = suggest("临时文件不许用通配符批量删除，必须逐个列名再删。", loadManual(root));
  assert.ok(r.top[0].score >= 0.45, `similarity too low: ${r.top[0].score}`);
  assert.equal(r.conflict, true);
  assert.equal(r.action, "conflict");
  fs.rmSync(root, { recursive: true, force: true });
});

test("linkEntry writes one marker into the head and leaves the prose untouched", () => {
  const root = mkRoot();
  addEntry(root, { number: 6, title: "旧规矩", body: "旧的写法：先做 A 再做 B。" });
  addEntry(root, { number: 7, title: "新规矩", body: "新的写法：先做 B 再做 A，因为 A 依赖 B 的产物。" });
  const r = linkEntry(root, { target: 6, newNumber: 7, kind: "superseded_by", evidence: "7 修正了顺序", date: "2026-10-18" });
  assert.equal(r.ok, true, r.reason);
  const text = fs.readFileSync(path.join(root, "manual", r.path), "utf8");
  assert.match(text, /<!-- superseded_by: 7 \(2026-10-18\) -->/);
  assert.match(text, /旧的写法：先做 A 再做 B。/, "body must survive verbatim");
  const head = text.split("\n").slice(0, 15).join("\n");
  assert.match(head, /superseded_by/, "marker must be inside the scanned head window");
  fs.rmSync(root, { recursive: true, force: true });
});

test("linkEntry updates memory.json so the manifest matches the new bytes", () => {
  const root = mkRoot();
  addEntry(root, { number: 8, title: "旧", body: "旧内容。" });
  addEntry(root, { number: 9, title: "新", body: "新内容，覆盖旧结论。" });
  const r = linkEntry(root, { target: 8, newNumber: 9, kind: "superseded_by", evidence: "replaced" });
  assert.equal(r.ok, true, r.reason);
  const man = JSON.parse(fs.readFileSync(path.join(root, "memory.json"), "utf8"));
  const buf = fs.readFileSync(path.join(root, "manual", r.path));
  assert.equal(man[r.path].sha256, crypto.createHash("sha256").update(buf).digest("hex"));
  assert.equal(man[r.path].bytes, buf.length);
  fs.rmSync(root, { recursive: true, force: true });
});

test("linkEntry refuses: no evidence, self-link, already linked, missing target", () => {
  const root = mkRoot();
  addEntry(root, { number: 10, title: "a", body: "aaaaaaaaaaaaaaaaaaaaaaaa" });
  addEntry(root, { number: 11, title: "b", body: "bbbbbbbbbbbbbbbbbbbbbbbb" });
  assert.equal(linkEntry(root, { target: 10, newNumber: 11, evidence: "" }).ok, false);
  assert.equal(linkEntry(root, { target: 10, newNumber: 10, evidence: "x" }).ok, false);
  assert.equal(linkEntry(root, { target: 10, newNumber: 99, evidence: "x" }).ok, false);
  const ok = linkEntry(root, { target: 10, newNumber: 11, evidence: "first" });
  assert.equal(ok.ok, true);
  const again = linkEntry(root, { target: 10, newNumber: 11, evidence: "second" });
  assert.equal(again.ok, false, "a linked entry must not be linked twice");
  fs.rmSync(root, { recursive: true, force: true });
});

test("after a link, loadManual reports the entry as superseded", () => {
  const root = mkRoot();
  addEntry(root, { number: 12, title: "old", body: "old body text here" });
  addEntry(root, { number: 13, title: "new", body: "new body text here" });
  linkEntry(root, { target: 12, newNumber: 13, kind: "merged_into", evidence: "folded in" });
  const m = loadManual(root);
  const e = m.entries.find((x) => x.number === 12);
  assert.equal(e.superseded, true);
  assert.equal(m.entries.find((x) => x.number === 13).superseded, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the memory_curate tool: suggest is read-only, link writes and refreshes the chain", async () => {
  const root = mkRoot();
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  const e14 = addEntry(root, { number: 14, title: "旧做法", body: "旧做法：先备份再改源文件，然后再同步校验值，最后回读一次。" });
  addEntry(root, { number: 15, title: "新做法", body: "新做法：先改源文件再同步校验值，备份在改动前，避免两步之间悬空。" });

  const mod = await import("../lib/index.js?t=" + Date.now());
  const registered = [];
  mod.apply({
    logger: { info() {}, warn() {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: () => {} },
    on: () => {}
  }, { manualRoot: root });

  const curate = registered.find((t) => t.name === "memory_curate");
  assert.ok(curate, "memory_curate must be registered");

  const s = await curate.execute({ text: "旧做法是备份之后再改源文件，改完再同步校验值。" });
  assert.ok(!s.error, `suggest failed: ${s.error}`);
  assert.match(s.text, /最相似/);

  const p14 = path.join(root, "manual", e14.path);
  const before = fs.readFileSync(p14, "utf8");
  const l = await curate.execute({ action: "link", target: 14, newNumber: 15, kind: "superseded_by", evidence: "15 覆盖 14 的顺序" });
  assert.ok(!l.error, `link failed: ${l.error}`);
  const after = fs.readFileSync(p14, "utf8");
  assert.ok(after.length > before.length, "link only appends");
  assert.ok(after.includes("旧做法：先备份再改源文件，然后再同步校验值，最后回读一次。"), "prose untouched");
  assert.equal(verifyChain(root).ok, true, "chain must verify after a link");
  fs.rmSync(root, { recursive: true, force: true });
});

test("appendToEntry merges a dated block without touching the prose", () => {
  const root = mkRoot();
  const e = addEntry(root, { number: 20, title: "顺序", body: "原始正文：先做 A 再做 B。" });
  const r = appendToEntry(root, 20, "补充：A 依赖 B 的产物，所以顺序反过来。", { source: "实测" });
  assert.equal(r.ok, true, r.reason);
  const text = fs.readFileSync(path.join(root, "manual", e.path), "utf8");
  assert.ok(text.includes("原始正文：先做 A 再做 B。"), "original prose survives");
  assert.match(text, /合并补充（\d{4}-\d{2}-\d{2} · 实测）/);
  assert.ok(text.indexOf("原始正文") < text.indexOf("合并补充"), "append, not prepend");
  const man = JSON.parse(fs.readFileSync(path.join(root, "memory.json"), "utf8"));
  const buf = fs.readFileSync(path.join(root, "manual", e.path));
  assert.equal(man[e.path].sha256, crypto.createHash("sha256").update(buf).digest("hex"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("promoteEntry removes the candidate marker and refreshes last-used", () => {
  const root = mkRoot();
  const e = addEntry(root, { number: 21, title: "候选条目", body: "这条是推断出来的，等实测。", confidence: "agent-inferred" });
  const before = fs.readFileSync(path.join(root, "manual", e.path), "utf8");
  assert.match(before, /<!-- 候选:/);
  const r = promoteEntry(root, 21, { evidence: "按它做对了一件事" });
  assert.equal(r.ok, true, r.reason);
  const after = fs.readFileSync(path.join(root, "manual", e.path), "utf8");
  assert.ok(!after.includes("<!-- 候选:"), "candidate marker removed");
  assert.match(after, /<!-- promoted: \d{4}-\d{2}-\d{2} \| 按它做对了一件事 -->/);
  const man = JSON.parse(fs.readFileSync(path.join(root, "memory.json"), "utf8"));
  const buf = fs.readFileSync(path.join(root, "manual", e.path));
  assert.equal(man[e.path].sha256, crypto.createHash("sha256").update(buf).digest("hex"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("promoteEntry refuses a non-candidate", () => {
  const root = mkRoot();
  addEntry(root, { number: 22, title: "已确认", body: "用户点头过的条目。" });
  const r = promoteEntry(root, 22, { evidence: "x" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a candidate/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("candidates() flags entries past the 45-day window, and only candidates", () => {
  const root = mkRoot();
  addEntry(root, { number: 23, title: "老候选", body: "很久以前的推断。", created: "2026-09-01", confidence: "agent-inferred" });
  addEntry(root, { number: 24, title: "新候选", body: "今天的推断。", confidence: "agent-inferred" });
  addEntry(root, { number: 25, title: "已确认", body: "不是候选。", confidence: "user-confirmed" });
  const list = candidates(loadManual(root), { days: 45 });
  assert.equal(list.length, 2, "only the two candidates are listed");
  const old = list.find((c) => c.number === 23);
  assert.equal(old.stale, true);
  assert.equal(list.find((c) => c.number === 24).stale, false);
  assert.ok(!list.some((c) => c.number === 25), "confirmed entries are not candidates");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the memory_curate tool: merge and promote write and refresh the chain", async () => {
  const root = mkRoot();
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  const e30 = addEntry(root, { number: 30, title: "候选做法", body: "候选做法：先改文件再同步链。", confidence: "agent-inferred" });
  const e31 = addEntry(root, { number: 31, title: "已有做法", body: "已有做法：先备份再改文件，改完同步。" });

  const mod = await import("../lib/index.js?t=" + Date.now());
  const registered = [];
  mod.apply({
    logger: { info() {}, warn() {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: () => {} },
    on: () => {}
  }, { manualRoot: root });
  const curate = registered.find((t) => t.name === "memory_curate");

  const m = await curate.execute({ action: "merge", target: 31, text: "补充：同步必须在改完之后。" });
  assert.ok(!m.error, `merge failed: ${m.error}`);
  assert.ok(fs.readFileSync(path.join(root, "manual", e31.path), "utf8").includes("合并补充"));

  const p = await curate.execute({ action: "promote", target: 30, evidence: "实测按它做对了" });
  assert.ok(!p.error, `promote failed: ${p.error}`);
  assert.ok(!fs.readFileSync(path.join(root, "manual", e30.path), "utf8").includes("<!-- 候选:"));

  assert.equal(verifyChain(root).ok, true, "chain must verify after merge + promote");
  fs.rmSync(root, { recursive: true, force: true });
});
