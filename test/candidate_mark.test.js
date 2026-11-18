// shannon-anchor — candidate marker: rule #98/#71 says every agent-inferred
// entry starts as 候选 (candidate) until it has been followed and proven.
// The bug this pins: memory_write only recorded confidence: agent-inferred
// and never generated the marker, so the rule lived in the manual while
// the write path ignored it. Fixed 2026-10-18 (定制版) in entries.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEntry } from "../lib/entries.js";

const BASE = { number: 1, title: "t", body: "b", source: "s", created: "2026-10-18" };

test("agent-inferred entry carries the candidate marker in its head", () => {
  const e = parseEntry({ ...BASE, confidence: "agent-inferred" });
  const head = e.lines.slice(0, 8).join("\n");
  assert.match(head, /<!-- 候选: 2026-10-18 \| 待验证 -->/);
});

test("omitted confidence defaults to agent-inferred AND gets the marker", () => {
  const e = parseEntry({ ...BASE, number: 2 });
  assert.ok(e.lines.some((l) => l.startsWith("<!-- 候选:")), "marker present");
  assert.ok(e.lines.some((l) => l === "<!-- confidence: agent-inferred -->"));
});

test("user-confirmed entry does NOT carry the candidate marker", () => {
  const e = parseEntry({ ...BASE, number: 3, confidence: "user-confirmed" });
  assert.ok(!e.lines.some((l) => l.includes("候选")), "confirmed entries are not candidates");
});

test("marker sits inside the 15-line head window loadManual scans", () => {
  const e = parseEntry({ ...BASE, number: 4, confidence: "agent-inferred" });
  const idx = e.lines.findIndex((l) => l.startsWith("<!-- 候选:"));
  assert.ok(idx >= 0 && idx < 15, `marker at line ${idx} must be within the head window`);
});

test("memory_write generates the marker end-to-end", async () => {
  const mod = await import("../lib/index.js?t=" + Date.now());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-cand-"));
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const registered = [];
  mod.apply({
    logger: { info() {}, warn() {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: () => {} },
    on: () => {}
  }, { manualRoot: root });
  const w = registered.find((t) => t.name === "memory_write");
  const r = await w.execute({ title: "candidate e2e", body: "body text", source: "test" });
  assert.ok(!r.error, `write should succeed: ${r.error}`);
  const text = fs.readFileSync(path.join(root, "manual", r.path), "utf8");
  assert.match(text, /<!-- 候选: \d{4}-\d{2}-\d{2} \| 待验证 -->/, "written file carries the marker");
  fs.rmSync(root, { recursive: true, force: true });
});
