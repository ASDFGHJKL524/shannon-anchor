// shannon-anchor — bootstrap tests. The first growth must be guaranteed:
// fixed shape, user-filled content, never overwrite what the user built.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOOTSTRAP_QUESTIONS, DEFAULT_IDENTITY, composeIdentity, bootstrapPrompt, needsBootstrap, identityPath } from "../lib/bootstrap.js";

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "shannon-anchor-boot-")); }

test("three fixed questions, three stable keys", () => {
  assert.equal(BOOTSTRAP_QUESTIONS.length, 3);
  assert.deepEqual(BOOTSTRAP_QUESTIONS.map(q => q.key), ["identity", "boundaries", "voice"]);
  for (const q of BOOTSTRAP_QUESTIONS) {
    assert.ok(q.ask && q.ask.length > 5, "each question is a real sentence");
    assert.ok(q.hint, "each question carries a hint");
  }
});

test("default identity is a floor, not the whole thing", () => {
  assert.equal(DEFAULT_IDENTITY.length, 3);
  assert.ok(DEFAULT_IDENTITY.some(d => d.key === "honesty"));
  assert.ok(DEFAULT_IDENTITY.some(d => d.key === "reversibility"));
  assert.ok(DEFAULT_IDENTITY.some(d => d.key === "read-first"));
});

test("bootstrap runs only when identity is missing", () => {
  const root = tmpRoot();
  fs.mkdirSync(root, { recursive: true });
  assert.equal(needsBootstrap(root), true);
  fs.writeFileSync(identityPath(root), "existing", "utf8");
  assert.equal(needsBootstrap(root), false, "never overwrite an existing identity");
  fs.rmSync(root, { recursive: true, force: true });
});

test("composeIdentity keeps user answers AND the default floor", () => {
  const body = composeIdentity({
    identity: "叫我阿伟，性格直接点",
    boundaries: "花钱和对外发送先问我",
    voice: "简短，别啰嗦"
  });
  assert.match(body, /阿伟/);
  assert.match(body, /花钱和对外发送先问我/);
  assert.match(body, /简短，别啰嗦/);
  // the floor survives even when the user answers everything
  assert.match(body, /不骗用户/);
  assert.match(body, /先问/);
  assert.match(body, /先查记忆手册/);
});

test("composeIdentity degrades gracefully on empty answers", () => {
  const body = composeIdentity({});
  assert.match(body, /未答，用默认/);
  assert.match(body, /不骗用户/, "floor still present with zero answers");
});

test("bootstrapPrompt is short and names the write target", () => {
  const p = bootstrapPrompt();
  assert.ok(p.length < 600, "costs context on one turn only");
  assert.match(p, /identity\.md/);
  assert.match(p, /一次问一个/);
});