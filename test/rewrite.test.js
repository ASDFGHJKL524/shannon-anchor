// memory_rewrite / rewriteEntry — the only sanctioned overwrite path.
// Append-only is the default; this is the deliberate exception, so every
// refusal matters as much as the success path. The refusals encode two
// real failure modes: an entry lost to a path/number mismatch, and a
// (13 KB of merge accretion that needed compression, not more appending).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rewriteEntry } from "../lib/curate.js";

function freshRoot(bodyPad = 2000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pagi-rewrite-"));
  const dir = path.join(root, "manual", "02-method");
  fs.mkdirSync(dir, { recursive: true });
  const body = "### 128. a long entry\n\n<!-- source: test -->\n<!-- created: 2026-10-19 -->\n\n" + "x".repeat(bodyPad) + "\n";
  fs.writeFileSync(path.join(dir, "128.md"), body, "utf8");
  return { root, dir, file: path.join(dir, "128.md") };
}

const GOOD_DRAFT = "### 128. a long entry\n\n<!-- source: test -->\n\ndistilled short form\n";

test("rewrite refuses without evidence", () => {
  const { root, dir } = freshRoot();
  fs.writeFileSync(path.join(dir, "128.md.draft"), GOOD_DRAFT, "utf8");
  const r = rewriteEntry(root, 128, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /evidence required/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("rewrite refuses when no draft exists", () => {
  const { root } = freshRoot();
  const r = rewriteEntry(root, 128, { evidence: "checked" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no draft beside/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("rewrite refuses a draft whose first line carries another number", () => {
  const { root, dir } = freshRoot();
  fs.writeFileSync(path.join(dir, "128.md.draft"), "### 999. wrong number\n\nshort\n", "utf8");
  const r = rewriteEntry(root, 128, { evidence: "checked" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /first line must be/);
  assert.ok(fs.existsSync(path.join(dir, "128.md")), "the entry must be untouched");
  fs.rmSync(root, { recursive: true, force: true });
});

test("rewrite refuses a draft that is not shorter", () => {
  const { root, dir } = freshRoot(10);
  fs.writeFileSync(path.join(dir, "128.md.draft"), GOOD_DRAFT + "y".repeat(500), "utf8");
  const r = rewriteEntry(root, 128, { evidence: "checked" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not shorter/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("rewrite refuses a superseded entry", () => {
  const { root, dir, file } = freshRoot();
  const content = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, content.replace("<!-- created: 2026-10-19 -->", "<!-- created: 2026-10-19 -->\n<!-- superseded_by: 200 -->"), "utf8");
  fs.writeFileSync(path.join(dir, "128.md.draft"), GOOD_DRAFT, "utf8");
  const r = rewriteEntry(root, 128, { evidence: "checked" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /superseded/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("rewrite promotes the draft: replace, back up, consume, log", () => {
  const { root, dir, file } = freshRoot();
  fs.writeFileSync(path.join(dir, "128.md.draft"), GOOD_DRAFT, "utf8");
  const before = fs.readFileSync(file, "utf8");

  const r = rewriteEntry(root, 128, { evidence: "compared draft against original line by line" });
  assert.equal(r.ok, true);
  assert.equal(r.path, "02-method/128.md");
  assert.ok(r.bytes < Buffer.byteLength(before, "utf8"));

  // the entry now IS the draft
  assert.equal(fs.readFileSync(file, "utf8"), GOOD_DRAFT);
  // the draft is consumed
  assert.ok(!fs.existsSync(path.join(dir, "128.md.draft")));
  // the original is backed up under root/backup
  const backups = fs.readdirSync(path.join(root, "backup"));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^02-method-128\.md\.bak-/);
  assert.equal(fs.readFileSync(path.join(root, "backup", backups[0]), "utf8"), before);
  // the decision is logged
  const hist = fs.readFileSync(path.join(root, "curate", "history.jsonl"), "utf8").trim().split("\n");
  const rec = JSON.parse(hist[hist.length - 1]);
  assert.equal(rec.action, "rewrite");
  assert.equal(rec.target, 128);
  fs.rmSync(root, { recursive: true, force: true });
});
