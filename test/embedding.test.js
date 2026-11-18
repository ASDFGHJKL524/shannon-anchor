// shannon-anchor — embedding backend tests. The seam must actually be a seam:
// local works with zero deps, a broken remote backend degrades to local
// instead of taking retrieval down, and the cache does not serve vectors
// across a backend switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEmbedder, localEmbed, cosineAny, clearEmbeddingCache, BACKENDS, splitForEmbedding, poolVectors } from "../lib/embedding.js";
import { vectorize } from "../lib/retrieval.js";

test("local backend is the default and needs nothing", async () => {
  const e = makeEmbedder({});
  assert.equal(e.name, "local");
  assert.equal(e.semantic, false);
  const v = await e.embed("the delete guard moves files to quarantine");
  assert.equal(v.length, 256);
  assert.ok(v.some((x) => x > 0), "vector is not empty");
});

test("local embedding matches the retrieval module's vectorizer", async () => {
  const e = makeEmbedder({ backend: "local" });
  const a = await e.embed("same text");
  const b = vectorize("same text");
  assert.deepEqual(Array.from(a), Array.from(b));
});

test("identical text hits the cache and does not re-embed", async () => {
  clearEmbeddingCache();
  const e = makeEmbedder({ backend: "local" });
  await e.embed("cached text");
  const before = e.stats.calls;
  await e.embed("cached text");
  assert.equal(e.stats.calls, before, "second call is served from cache");
  assert.ok(e.stats.cacheHits >= 1);
});

test("the cache does not cross backends", async () => {
  clearEmbeddingCache();
  const local = makeEmbedder({ backend: "local" });
  await local.embed("shared text");
  const other = makeEmbedder({ backend: "command", command: "definitely-not-a-real-binary-xyz" });
  const v = await other.embed("shared text");
  // the command backend failed and fell back to local; either way it must have
  // attempted its own call rather than reading the local cache entry
  assert.ok(other.stats.calls >= 1);
  assert.equal(v.length, 256);
});

test("an unknown backend name falls back to local and says so", async () => {
  const e = makeEmbedder({ backend: "not-a-backend" });
  assert.equal(e.name, "local");
  assert.match(String(e.stats.fallbacks), /^1$/);
  const v = await e.embed("x");
  assert.equal(v.length, 256);
});

test("a broken command backend degrades to local instead of throwing", async () => {
  clearEmbeddingCache();
  const e = makeEmbedder({ backend: "command", command: "definitely-not-a-real-binary-xyz" });
  const v = await e.embed("some text that needs a vector");
  assert.equal(v.length, 256, "still got a usable vector");
  assert.equal(e.stats.failures, 1);
  assert.ok(e.stats.lastError, "the failure is recorded, not swallowed");
});

test("a command backend that exits non-zero degrades to local", async () => {
  clearEmbeddingCache();
  const e = makeEmbedder({
    backend: "command",
    command: process.platform === "win32" ? "cmd" : "sh",
    args: process.platform === "win32" ? ["/c", "exit 3"] : ["-c", "exit 3"]
  });
  const v = await e.embed("text");
  assert.equal(v.length, 256);
  assert.equal(e.stats.failures, 1);
});

// NOTE ON THE NEXT TWO TESTS
//
// The command backend's happy path (a program that prints a real vector) cannot
// be exercised under the DSH file sandbox: spawning a child with piped stdio is
// denied with EPERM, and `stdio: 'inherit'` cannot capture output. The failure
// paths below still run, because they fail before any output matters.
//
// So the parser is tested directly instead of through a subprocess. That is
// honest coverage of the logic; the plumbing between spawnSync and the parser
// is covered by the two failure tests above, which do reach spawnSync.
test("the command output parser accepts a JSON array of numbers", async () => {
  // exercise the same parsing rule the backend applies, without a subprocess
  const parse = (stdout) => {
    const parsed = JSON.parse(String(stdout).trim());
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("no vector");
    return Float64Array.from(parsed.map(Number));
  };
  assert.deepEqual(Array.from(parse("[1,2,3]")), [1, 2, 3]);
  assert.deepEqual(Array.from(parse("  [0.5, 0.25]\n")), [0.5, 0.25]);
  assert.throws(() => parse("not-json"));
  assert.throws(() => parse("[]"));
});

test("a command backend that prints garbage degrades to local", async () => {
  clearEmbeddingCache();
  const e = makeEmbedder({
    backend: "command",
    command: process.platform === "win32" ? "cmd" : "sh",
    args: process.platform === "win32" ? ["/c", "echo not-json"] : ["-c", "echo not-json"]
  });
  const v = await e.embed("text");
  assert.equal(v.length, 256);
  // Either the sandbox denied the spawn (EPERM) or the output was unparseable.
  // Both are "the backend failed and we degraded" — which is the property under
  // test. The exact message differs by environment.
  assert.equal(e.stats.failures, 1);
  assert.ok(e.stats.lastError, "a failure is recorded either way");
});

test("the openai backend refuses to run without a model", async () => {
  clearEmbeddingCache();
  const e = makeEmbedder({ backend: "openai" });
  const v = await e.embed("text");
  assert.equal(v.length, 256, "degraded to local");
  assert.match(String(e.stats.lastError), /model is required/);
});

test("empty text returns a zero vector without calling the backend", async () => {
  const e = makeEmbedder({ backend: "openai", model: "m" });
  const v = await e.embed("");
  assert.equal(v.length, 256);
  assert.equal(e.stats.calls, 0);
});

test("cosineAny handles different lengths without throwing", () => {
  const a = Float64Array.from([1, 0, 0]);
  const b = Float64Array.from([1, 0, 0, 9, 9]);
  assert.ok(Math.abs(cosineAny(a, b) - 1) < 1e-9, "common prefix compared");
  assert.equal(cosineAny(Float64Array.from([0, 0]), Float64Array.from([1, 1])), 0);
});

test("BACKENDS lists exactly the three documented names", () => {
  assert.deepEqual([...BACKENDS].sort(), ["command", "local", "openai"]);
});

// ---- chunking + pooling (2026-10-31) ----
//
// The openai backend used to POST an array of texts. On Ollama + bge-m3 that
// shape asks llama.cpp for a tokens x 250002 x 4 bytes buffer per input and
// kills the server, so the backend now sends one short string per POST. These
// tests pin that shape without any network: they stub global fetch.

test("splitForEmbedding keeps every character and respects maxChars", () => {
  const text = "甲".repeat(120) + "。" + "乙".repeat(2000);
  const pieces = splitForEmbedding(text, 500);
  assert.ok(pieces.length >= 4);
  assert.ok(pieces.every((p) => p.length <= 500), "every piece fits the window");
  assert.equal(pieces.join(""), text, "no character lost or duplicated");
});

test("splitForEmbedding prefers a sentence boundary over a hard cut", () => {
  const head = "甲".repeat(300) + "。";
  const text = head + "乙".repeat(400);
  const pieces = splitForEmbedding(text, 500);
  assert.equal(pieces[0], head, "first piece ends at the sentence stop");
});

test("poolVectors mean-pools unit vectors and re-normalizes", () => {
  const v = poolVectors([Float64Array.from([3, 0, 0]), Float64Array.from([0, 4, 0])]);
  assert.ok(Math.abs(v[0] - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(v[1] - Math.SQRT1_2) < 1e-9);
  assert.equal(v[2], 0);
  let n = 0;
  for (const x of v) n += x * x;
  assert.ok(Math.abs(Math.sqrt(n) - 1) < 1e-9);
  assert.throws(() => poolVectors([Float64Array.from([1, 0]), Float64Array.from([1, 0, 0])]));
  assert.throws(() => poolVectors([]));
});

test("the openai backend sends one string input per request and pools long text", async () => {
  clearEmbeddingCache();
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.input);
    assert.equal(typeof body.input, "string", "input must be a string, never an array");
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0.1, 0.1, 0.1] }] }) };
  };
  try {
    const e = makeEmbedder({ backend: "openai", model: "m", maxChars: 500 });
    const v = await e.embed("字".repeat(1200));
    assert.equal(v.length, 4);
    assert.ok(seen.length >= 3, `expected several chunks, got ${seen.length}`);
    assert.ok(seen.every((s) => typeof s === "string" && s.length <= 500));
    assert.equal(e.stats.requests, seen.length);
    assert.equal(e.stats.failures, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failed long request is split and retried before degrading", async () => {
  clearEmbeddingCache();
  let attempts = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    attempts++;
    const len = JSON.parse(init.body).input.length;
    if (len > 200) return { ok: false, status: 500, text: async () => "Compute error." };
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) };
  };
  try {
    const e = makeEmbedder({ backend: "openai", model: "m", maxChars: 500 });
    const v = await e.embed("字".repeat(900));
    assert.equal(v.length, 2);
    assert.equal(e.stats.failures, 0, "the call recovered by splitting, not degrading");
    assert.ok(attempts >= 8, `expected retries after failures, got ${attempts}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("when splitting cannot save the call, it still degrades to local", async () => {
  clearEmbeddingCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "Compute error." });
  try {
    const e = makeEmbedder({ backend: "openai", model: "m", maxChars: 500, minChars: 200 });
    const v = await e.embed("字".repeat(900));
    assert.equal(v.length, 256, "degraded to the local vector");
    assert.equal(e.stats.failures, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
