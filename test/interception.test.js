// shannon-anchor — interception tests: judge the ACTION, not the knife.
//
// The original gate matched tool NAMES only, so a model could call the
// generic shell tool with "Remove-Item <manual path>" and slip past it.
// These tests pin the behaviour: name-based AND content-based routing,
// path extraction from commands, and refusal (not guessing) when the
// target cannot be resolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const libUrl = new URL("../lib/index.js", import.meta.url).href;

async function freshApply() {
  const mod = await import(libUrl + "?t=" + Date.now());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-icept-"));
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  const preExec = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register() {} },
    systemPrompt: { section() {} },
    on: (ev, fn) => { if (ev === "tools/pre-execute") preExec.push(fn); }
  };
  mod.apply(ctx, { manualRoot: root });
  return { preExec: preExec[0], root };
}

function victimIn(root) {
  const v = path.join(root, "manual", "01-rules", "1.md");
  fs.mkdirSync(path.dirname(v), { recursive: true });
  fs.writeFileSync(v, "precious", "utf8");
  return v;
}

test("a shell command deleting a manual path is blocked without touching the file", async () => {
  const { preExec, root } = await freshApply();
  const victim = victimIn(root);
  const r = await preExec({ name: "pwsh", args: { command: `Remove-Item -Force ${victim}` } }, async () => ({ passed: true }));
  // The target here is scraped out of command text — a guess. Twice on
  // 2026-10-19 the guard acted on such a guess: it quarantined a file nobody
  // was deleting, then refused the command, so the file vanished with no one
  // able to explain why. The guard blocks guesses; it never acts on them.
  // The bypass stays closed either way: the command does not run.
  assert.equal(r.kind, "deny", "the bypass that used to work is still closed");
  assert.match(r.reason, /not executed/);
  assert.ok(fs.existsSync(victim), "blocking is not acting: the file stays where it was");
  assert.equal(fs.existsSync(path.join(root, "_quarantine")), false, "no quarantine for a scraped target");
  fs.rmSync(root, { recursive: true, force: true });
});

// The reversible-move behaviour still exists — but only for a target the
// caller declared itself (an explicit path arg), never for one scraped from
// command text.
test("a delete tool with an explicit path arg is quarantined (reversible) and audited", async () => {
  const { preExec, root } = await freshApply();
  const victim = victimIn(root);
  const r = await preExec({ name: "file_delete", arguments: { path: victim, reason: "pinned by test" } }, async () => ({ passed: true }));
  assert.equal(r.kind, "deny");
  assert.match(r.reason, /quarantined/);
  assert.ok(!fs.existsSync(victim), "a declared target goes through the guard: reversible move");
  const batch = fs.readdirSync(path.join(root, "_quarantine"))[0];
  const files = fs.readdirSync(path.join(root, "_quarantine", batch, "files"));
  assert.equal(files.length, 1, "the original bytes are preserved in the batch");
  const lines = fs.readFileSync(path.join(root, "guard", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines[lines.length - 1].batch, "the quarantine batch is audited");
  fs.rmSync(root, { recursive: true, force: true });
});

// The host delivers parsed args as `exec.arguments` (ToolExecution), not
// `exec.args`; the harness shape above once hid this mismatch in production.
test("the host payload shape (exec.arguments) is intercepted too", async () => {
  const { preExec, root } = await freshApply();
  const victim = victimIn(root);
  const r = await preExec({ name: "pwsh", arguments: { command: `Remove-Item -Force ${victim}` } }, async () => ({ passed: true }));
  assert.equal(r.kind, "deny");
  assert.match(r.reason, /not executed/);
  assert.equal(fs.existsSync(path.join(root, "_quarantine")), false, "a scraped target is blocked, never acted on");
  assert.ok(fs.existsSync(victim), "the victim survives in the live tree");
  fs.rmSync(root, { recursive: true, force: true });
});

// A JSON-escaped quote after the word manual (manual\") once read as a
// path separator and misrouted an unrelated delete through the guard.
test("an escaped quote after manual is not a path separator", async () => {
  const { preExec, root } = await freshApply();
  const outside = path.join(os.tmpdir(), `pagi-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, "x", "utf8");
  const r = await preExec({ name: "pwsh", arguments: { command: `Remove-Item '${outside}'; Write-Output 'manual" note'` } }, async () => ({ passed: true }));
  assert.equal(r.passed, true, "target is outside the root; the escaped quote is just text");
  fs.rmSync(outside, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

// A lookup that names a file inside the manual is not a delete. The guard
// once treated any `path` argument as a delete target, so a plain grep
// could quarantine the file it was only trying to read.
test("a read-only lookup with a path inside the manual is not a delete", async () => {
  const { preExec, root } = await freshApply();
  const victim = victimIn(root);
  // args must sit where the host puts them (`exec.arguments`); at the top
  // level the guard never sees them and this test would pass for the wrong
  // reason — which is exactly how it slipped through once already.
  const r = await preExec({ name: "grep", arguments: { path: victim, pattern: "precious" } }, async () => ({ passed: true }));
  assert.equal(r.passed, true, "a lookup is not destructive");
  assert.ok(fs.existsSync(victim), "the file survives the lookup");
  assert.equal(fs.existsSync(path.join(root, "_quarantine")), false, "nothing was quarantined");
  fs.rmSync(root, { recursive: true, force: true });
});

// Pointing a listing at the whole root is also a read, not a delete.
test("a lookup rooted at the manual root is not a delete", async () => {
  const { preExec, root } = await freshApply();
  const r = await preExec({ name: "glob", arguments: { path: root, pattern: "**/*.md" } }, async () => ({ passed: true }));
  assert.equal(r.passed, true, "listing the root is not destructive");
  assert.equal(fs.existsSync(path.join(root, "_quarantine")), false, "nothing was quarantined");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- the audit trail: a guard that cannot explain itself cannot be debugged
//
// On 2026-10-19 a file was quarantined and the only evidence left was a
// manifest saying reason "no reason given". No tool name, no command text, no
// args — so working out WHICH call did it took half an hour of guessing and
// produced two wrong theories. Every guard decision now leaves a line.
test("a quarantine writes an audit line naming the tool and the args", async () => {
  const { preExec, root } = await freshApply();
  const victim = victimIn(root);
  await preExec({ name: "file_delete", arguments: { path: victim, reason: "audit test" } }, async () => ({ passed: true }));

  const audit = path.join(root, "guard", "audit.jsonl");
  assert.ok(fs.existsSync(audit), "the guard must leave a trace");
  const lines = fs.readFileSync(audit, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  assert.equal(last.tool, "file_delete", "the tool name must be recorded");
  assert.equal(last.target, victim, "the resolved target must be recorded");
  assert.ok(last.batch, "the quarantine batch must be recorded");
  assert.ok(last.moved >= 1, "the moved count must be recorded");
  assert.ok(String(last.args).includes("audit test"), "the raw args must be recorded");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a blocked scraped-target delete is audited as a denial, with nothing moved", async () => {
  const { preExec, root } = await freshApply();
  const victim = victimIn(root);
  await preExec({ name: "pwsh", arguments: { command: `Remove-Item -Force ${victim}` } }, async () => ({ passed: true }));
  const lines = fs.readFileSync(path.join(root, "guard", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  assert.equal(last.denied, "scraped-target", "the block reason must be recorded");
  assert.equal(last.moved, 0, "nothing was moved");
  assert.ok(String(last.args).includes("Remove-Item"), "the raw command must still be recorded");
  assert.ok(fs.existsSync(victim), "the file never left the live manual");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a refusal is audited too, with the reason it was refused", async () => {
  const { preExec, root } = await freshApply();
  // a destructive command that touches the manual but names no single path
  await preExec({ name: "pwsh", arguments: { command: "Remove-Item manual/*" } }, async () => ({ passed: true }));
  const audit = path.join(root, "guard", "audit.jsonl");
  assert.ok(fs.existsSync(audit), "refusals must be audited as well");
  const lines = fs.readFileSync(audit, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  assert.equal(last.moved, 0);
  assert.ok(last.denied, "the refusal reason must be recorded");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the audit log never blocks the guard, and never stores it silently", async () => {
  // The audit is best-effort: if the directory cannot be created the guard
  // must still act. Simulate by pointing the root at a path whose guard dir
  // cannot be made — a file where a directory should go.
  const { preExec, root } = await freshApply();
  const victim = victimIn(root);
  fs.rmSync(path.join(root, "guard"), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, "guard"), "not a directory", "utf8");
  const r = await preExec({ name: "file_delete", arguments: { path: victim, reason: "audit-failure test" } }, async () => ({ passed: true }));
  // the guard answers with { kind: "deny", reason } — not `passed`
  assert.equal(r.passed, undefined, "a deny is not a pass");
  assert.equal(r.kind, "deny", "the guard still denies even when it cannot log");
  assert.match(r.reason, /quarantined/);
  assert.ok(!fs.existsSync(victim), "the file was still moved to quarantine");
  fs.rmSync(root, { recursive: true, force: true });
});

test("an ordinary shell command passes untouched", async () => {
  const { preExec, root } = await freshApply();
  const r = await preExec({ name: "pwsh", args: { command: "Get-ChildItem -Force" } }, async () => ({ passed: true }));
  assert.equal(r.passed, true);
  assert.equal(fs.existsSync(path.join(root, "_quarantine")), false, "no quarantine for a read-only command");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a write outside the manual passes untouched", async () => {
  const { preExec, root } = await freshApply();
  const r = await preExec({ name: "write", args: { file_path: "D:\\tmp\\x.txt", content: "hi" } }, async () => ({ passed: true }));
  assert.equal(r.passed, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a destructive command touching the manual with NO resolvable path is REFUSED, not guessed", async () => {
  const { preExec, root } = await freshApply();
  // "manual/*" references the manual by relative shape but names no file:
  // the glob is not a path we can pin, so we must refuse, not sweep.
  const r = await preExec({ name: "pwsh", args: { command: "rm -rf manual/*" } }, async () => ({ passed: true }));
  assert.equal(r.kind, "deny", "refuse rather than sweep a glob");
  assert.match(r.reason, /could not be resolved/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("deleting the WHOLE manual root in one move is refused by name", async () => {
  const { preExec, root } = await freshApply();
  const r = await preExec({ name: "pwsh", args: { command: `rm -rf ${root}` } }, async () => ({ passed: true }));
  assert.equal(r.kind, "deny", "the entire library is not a deletable target");
  assert.match(r.reason, /entire memory manual/);
  assert.ok(fs.existsSync(root), "the library survives");
  fs.rmSync(root, { recursive: true, force: true });
});

test("guardDeletes=false disables the interception (documented escape hatch)", async () => {
  const mod = await import(libUrl + "?t=" + Date.now());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-icept-off-"));
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  const preExec = [];
  const ctx = { logger: { info() {}, warn() {} }, tools: { register() {} }, systemPrompt: { section() {} }, on: (ev, fn) => { if (ev === "tools/pre-execute") preExec.push(fn); } };
  mod.apply(ctx, { manualRoot: root, guardDeletes: false });
  const victim = victimIn(root);
  const r = await preExec[0]({ name: "pwsh", args: { command: `Remove-Item -Force ${victim}` } }, async () => ({ passed: true }));
  assert.equal(r.passed, true, "with the guard off the call passes (the config is the documented off switch)");
  assert.ok(fs.existsSync(victim), "and nothing was moved");
  fs.rmSync(root, { recursive: true, force: true });
});