// shannon-anchor — config tests. The user owns the system; the AI never owns
// its guards. Every test below is a statement about who may change what.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, setKey, applyProposal, listProposals, userPath, historyPath } from "../lib/config.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-cfg-"));
  const conf = path.join(root, "conf");
  fs.mkdirSync(conf, { recursive: true });
  const def = JSON.parse(fs.readFileSync(
    new URL("../conf/default.json", import.meta.url), "utf8"));
  fs.writeFileSync(path.join(conf, "default.json"), JSON.stringify(def, null, 2), "utf8");
  return root;
}

test("default config loads with nothing overridden", () => {
  const root = setup();
  const { config, sources } = loadConfig(root);
  assert.equal(config.guardWrites, true);
  assert.equal(sources.guardWrites, "default");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the eviction and review defaults are conservative and explicit", () => {
  // These are the switches that decide whether a discarded candidate leaves a
  // trace and whether a write owes a review. A silent change to any of them
  // changes behaviour nobody would look for, so pin them here.
  const root = setup();
  const { config } = loadConfig(root);
  assert.deepEqual(config.evict, { observe: false, voiceExpireDays: 3, distillExpireDays: 3 });
  assert.deepEqual(config.review, { enabled: true, inject: true, maxPending: 6, promptMaxAgeHours: 24 });
  fs.rmSync(root, { recursive: true, force: true });
});

test("user override merges over default; untouched keys stay default", () => {
  const root = setup();
  fs.writeFileSync(userPath(root), JSON.stringify({ manualRoot: "D:\\mine" }, null, 2), "utf8");
  const { config, sources } = loadConfig(root);
  assert.equal(config.manualRoot, "D:\\mine");
  assert.equal(sources.manualRoot, "user");
  assert.equal(config.guardWrites, true, "untouched keys keep default");
  assert.equal(sources.guardWrites, "default");
  fs.rmSync(root, { recursive: true, force: true });
});

test("deep merge keeps sibling defaults", () => {
  const root = setup();
  fs.writeFileSync(userPath(root), JSON.stringify({ distill: { maxPending: 9 } }, null, 2), "utf8");
  const { config } = loadConfig(root);
  assert.equal(config.distill.maxPending, 9);
  assert.equal(config.distill.debounceMs, 600000, "sibling default survives");
  fs.rmSync(root, { recursive: true, force: true });
});

// The merged view is for DISPLAY. Anything that layers configuration must
// take `user`: reapplying the merge re-imposes shipped defaults over the
// caller's config (2026-10-25 — predict.enabled=true from apply() was
// silently turned back off by default.json).
test("user is the raw override file, not the merged view", () => {
  const root = setup();
  fs.writeFileSync(userPath(root), JSON.stringify({ predict: { enabled: true } }, null, 2), "utf8");
  const { config, user } = loadConfig(root);
  assert.deepEqual(user, { predict: { enabled: true } });
  assert.equal(user.predict.floor, undefined, "raw user must not carry default siblings");
  assert.equal(config.predict.floor, 0.46, "the merged view still fills them in");
  assert.equal(config.predict.enabled, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("broken user.json fails loud, does NOT silently fall back", () => {
  const root = setup();
  fs.writeFileSync(userPath(root), "{ broken", "utf8");
  assert.throws(() => loadConfig(root), /not valid JSON/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("type mismatch is reported, user value adopted", () => {
  const root = setup();
  fs.writeFileSync(userPath(root), JSON.stringify({ guardWrites: "yes" }, null, 2), "utf8");
  const { config, mismatches } = loadConfig(root);
  assert.equal(config.guardWrites, "yes");
  assert.equal(mismatches.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("user may change a LOCKED key directly — it is their system", () => {
  const root = setup();
  const r = setKey(root, "guardWrites", false, "user", "testing my own system");
  assert.equal(r.applied, true);
  const { config } = loadConfig(root);
  assert.equal(config.guardWrites, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("AI may NEVER apply a locked key — proposal only, no silent path", () => {
  const root = setup();
  const r = setKey(root, "guardWrites", false, "ai", "to skip the scan");
  assert.equal(r.applied, false);
  assert.equal(r.needsApproval, true);
  const { config } = loadConfig(root);
  assert.equal(config.guardWrites, true, "guard still ON — AI did not get its way");
  assert.equal(listProposals(root).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("AI CAN apply an unlocked threshold key directly", () => {
  const root = setup();
  const r = setKey(root, "coldInferredDays", 20, "ai", "evidence shows 15 too long");
  assert.equal(r.applied, true);
  const { config } = loadConfig(root);
  assert.equal(config.coldInferredDays, 20);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a proposal is applied by the user, not the AI", () => {
  const root = setup();
  const p = setKey(root, "guardDeletes", false, "ai", "user said it is fine");
  assert.equal(p.needsApproval, true);
  // AI tries to apply its own proposal -> refused
  const aiApply = applyProposal(root, p.id, "ai");
  assert.equal(aiApply.ok, false);
  // user applies -> done
  const uApply = applyProposal(root, p.id, "user");
  assert.equal(uApply.applied, true);
  const { config } = loadConfig(root);
  assert.equal(config.guardDeletes, false);
  assert.equal(listProposals(root).length, 0, "proposal consumed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("every change is written to the audit trail", () => {
  const root = setup();
  setKey(root, "coldConfirmedDays", 45, "user", "observed too many colds");
  setKey(root, "guardWrites", false, "ai", "sneaky");
  const log = fs.readFileSync(historyPath(root), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(log.length, 2);
  assert.equal(log[0].kind, "apply");
  assert.equal(log[0].actor, "user");
  assert.equal(log[0].reason, "observed too many colds");
  assert.equal(log[1].kind, "proposal");
  assert.equal(log[1].actor, "ai");
  fs.rmSync(root, { recursive: true, force: true });
});

test("no reason, no change", () => {
  const root = setup();
  assert.equal(setKey(root, "coldConfirmedDays", 99, "user", "").ok, false);
  assert.equal(setKey(root, "coldConfirmedDays", 99, "user", "   ").ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a stale default.json inside the data root is ignored (defaults come from the package)", () => {
  // The 2026-10-18 incident, pinned: a data directory copied from another
  // install carried its own conf/default.json with an old manualRoot, and
  // loadConfig believed it. Shipped defaults must come from the code.
  const root = setup();
  fs.writeFileSync(path.join(root, "conf", "default.json"),
    JSON.stringify({ manualRoot: "G:/stale-copy", guardWrites: false }, null, 2), "utf8");
  const { config, sources } = loadConfig(root);
  assert.equal(config.manualRoot, "~/.dsh/shannon-anchor", "package default wins over the data-dir copy");
  assert.equal(config.guardWrites, true, "a stale copy cannot turn guards off");
  assert.equal(sources.guardWrites, "default");
  fs.rmSync(root, { recursive: true, force: true });
});