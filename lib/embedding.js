// shannon-anchor — embedding backends: make retrieval pluggable for real.
//
// Why this exists: retrieval.js scores with BM25 + a 256-dim feature-hash
// vector. That hash vector is a bag-of-characters approximation — two texts
// sharing no tokens score near zero, and once the manual passes a few hundred
// entries the semantic distinction collapses. The file's own comment admits the
// 0.3 floor has "no measured backing".
//
// The fix is not to embed a model in this package (zero-dependency is a stated
// red line: memory must not depend on an outside service). The fix is to make
// the backend a seam, ship the honest local one, and let a real embedder be
// plugged in without touching any caller.
//
// Three backends ship:
//   "local"      feature-hash (default, zero deps, no network, no model)
//   "openai"     any OpenAI-compatible /v1/embeddings endpoint
//   "command"    shell out to a program that reads text on stdin and prints a
//                JSON array on stdout — how you wire in a local model without
//                this package knowing anything about it
//
// Failure policy, deliberate: a remote/command backend that fails does NOT
// throw and does NOT silently return zeros. It records the failure and falls
// back to local for that call, so retrieval degrades to the honest baseline
// instead of returning garbage. The failure is reported to the caller.

import { spawnSync } from "node:child_process";
import { vectorize as localVectorize, cosine } from "./retrieval.js";

export const BACKENDS = ["local", "openai", "command"];

// Kept as a separate export because callers and tests import it from here.
// The implementation lives in retrieval.js now — one definition, not two.
export const cosineAny = cosine;

// Vector cache. Embedding calls are the expensive part, and the same entry text
// is re-embedded on every search. Keyed by backend + MODEL + text hash: two
// models produce incomparable vectors, so a model switch must miss, not serve
// the previous model's 256-dim rows next to fresh 1024-dim ones.
const CACHE_LIMIT = 2000;
const cache = new Map();

function cacheKey(backend, cfg, text) {
  // cheap FNV-1a over the text; collisions here only cost a re-embed
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const model = cfg.model || cfg.command || "";
  return `${backend}:${model}:${text.length}:${(h >>> 0).toString(16)}`;
}

function cacheGet(k) {
  const v = cache.get(k);
  if (v === undefined) return undefined;
  // refresh recency (Map preserves insertion order)
  cache.delete(k);
  cache.set(k, v);
  return v;
}

function cacheSet(k, v) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(k, v);
}

export function clearEmbeddingCache() { cache.clear(); }

// ---- backends ----

// Local: the shipped feature-hash vector. Synchronous, instant, no deps.
export function localEmbed(text, opts = {}) {
  return localVectorize(String(text || ""), opts.dim || 256);
}

// OpenAI-compatible endpoint. Config: { baseUrl, apiKey, model, timeoutMs,
// maxChars, minChars, maxDepth }.
// Deliberately uses global fetch (Node 18+) rather than a client library.
//
// ONE INPUT PER REQUEST, after splitting. Measured 2026-10-31 on Ollama 0.35.1 +
// bge-m3: in embedding mode llama.cpp reserves an output buffer of
// tokens x vocab(250002) x 4 bytes PER INPUT, so an array of long texts asks
// for gigabytes; llama-server dies with "Compute error" and took the host down
// once. 500 chars is ~287 tokens of Chinese and was stable across 862 requests.
// A piece that still fails is split again; only after minChars/maxDepth are
// exhausted does the whole call degrade to the local backend.
export const DEFAULT_MAX_CHARS = 500;
export const DEFAULT_MIN_CHARS = 80;
export const DEFAULT_MAX_DEPTH = 4;

// Split on a sentence/paragraph boundary inside the window when one exists, so
// a chunk does not start mid-sentence. Always returns pieces of <= maxChars,
// and the pieces concatenate back to the original text.
export function splitForEmbedding(text, maxChars = DEFAULT_MAX_CHARS) {
  const s = String(text ?? "");
  if (!s) return [];
  if (s.length <= maxChars) return [s];
  const out = [];
  let rest = s;
  const boundaries = ["\n", "。", "！", "？", "；", ".", "!", "?", ";", " "];
  while (rest.length > maxChars) {
    let cut = -1;
    for (const ch of boundaries) {
      const at = rest.lastIndexOf(ch, maxChars - 1);
      if (at > cut) cut = at;
    }
    // no boundary in the window: hard cut
    if (cut < Math.floor(maxChars * 0.5)) cut = maxChars - 1;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) out.push(rest);
  return out;
}

// Mean-pool unit vectors, then re-normalize. Pieces are normalized first so a
// long piece cannot dominate by raw magnitude.
export function poolVectors(vecs) {
  if (!Array.isArray(vecs) || vecs.length === 0) throw new Error("cannot pool zero vectors");
  const dim = vecs[0].length;
  if (dim === 0) throw new Error("cannot pool empty vectors");
  const sum = new Float64Array(dim);
  for (const v of vecs) {
    if (v.length !== dim) throw new Error("cannot pool vectors of different dimensions");
    let n = 0;
    for (let i = 0; i < dim; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < dim; i++) sum[i] += v[i] / n;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += sum[i] * sum[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) sum[i] /= n;
  return sum;
}

// One POST, one string input.
async function openaiEmbedOne(text, cfg = {}) {
  const baseUrl = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = cfg.model;
  if (!model) throw new Error("embedding.openai.model is required");
  const headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  let res;
  try {
    // A hanging endpoint must not hang memory_search forever: this call sits
    // inside a tool the model is waiting on.
    res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: text }),
      signal: AbortSignal.timeout(cfg.timeoutMs || 60000)
    });
  } catch (e) {
    throw new Error(`embedding endpoint unreachable: ${String(e.message || e)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`embedding endpoint ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const rows = json?.data;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("embedding endpoint returned no vectors");
  // The spec says data[].index carries the position; one input is one row, but
  // a gateway may reorder, so sort before taking the first.
  rows.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
  const v = rows[0]?.embedding;
  if (!Array.isArray(v) || v.length === 0) throw new Error("embedding endpoint returned an empty vector");
  return Float64Array.from(v);
}

// Embed one text: split to <= maxChars, one POST per piece, pool. A piece that
// fails is split in half and retried until maxDepth / minChars is reached; then
// the error propagates so embedBatch can degrade the whole call.
async function openaiEmbedText(text, cfg = {}, onRequest = () => {}, depth = 0) {
  const maxChars = Math.max(1, cfg.maxChars || DEFAULT_MAX_CHARS);
  const minChars = Math.max(1, cfg.minChars || DEFAULT_MIN_CHARS);
  const maxDepth = Number.isInteger(cfg.maxDepth) ? cfg.maxDepth : DEFAULT_MAX_DEPTH;
  const pieces = splitForEmbedding(text, maxChars);
  if (pieces.length === 0) throw new Error("embedding text is empty");
  const vecs = [];
  for (const piece of pieces) {
    try {
      onRequest();
      vecs.push(await openaiEmbedOne(piece, cfg));
    } catch (e) {
      if (depth >= maxDepth || piece.length <= minChars) throw e;
      const mid = Math.floor(piece.length / 2);
      vecs.push(await openaiEmbedText(piece.slice(0, mid), cfg, onRequest, depth + 1));
      vecs.push(await openaiEmbedText(piece.slice(mid), cfg, onRequest, depth + 1));
    }
  }
  return vecs.length === 1 ? vecs[0] : poolVectors(vecs);
}

// Command backend: run a program, feed text on stdin, read a JSON array of
// numbers on stdout. This is the escape hatch for local models — the package
// never learns what model it is talking to.
function commandEmbed(text, cfg = {}) {
  const cmd = cfg.command;
  if (!cmd) throw new Error("embedding.command.command is required");
  const args = Array.isArray(cfg.args) ? cfg.args : [];
  const res = spawnSync(cmd, args, {
    input: String(text || ""),
    encoding: "utf8",
    timeout: cfg.timeoutMs || 30000,
    windowsHide: true
  });
  if (res.error) throw new Error(`embedding command failed: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`embedding command exited ${res.status}: ${(res.stderr || "").slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(String(res.stdout || "").trim());
  } catch {
    throw new Error("embedding command did not print a JSON array");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("embedding command returned no vector");
  return Float64Array.from(parsed.map(Number));
}

// ---- the facade ----

// makeEmbedder(cfg) -> { name, dim, embed(text), embedBatch(texts), stats }
//
// cfg = { backend: "local"|"openai"|"command", ...backend opts }
// Unknown backend names fall back to local WITH a recorded warning — a typo in
// config must not make the memory system silently stop retrieving.
export function makeEmbedder(cfg = {}) {
  const requested = String(cfg.backend || "local");
  const backend = BACKENDS.includes(requested) ? requested : "local";
  const fallback = requested !== backend ? `unknown backend "${requested}", using local` : null;

  // calls counts texts sent to the backend; requests counts actual backend
  // round-trips. They differ because one text is split into several chunks, and
  // only requests predicts how many times a local server reloads its model.
  const stats = { calls: 0, requests: 0, cacheHits: 0, failures: 0, lastError: null, fallbacks: fallback ? 1 : 0 };

  // embedBatch(texts) -> { vectors, degraded }
  //
  // The fallback is per CALL, not per text. A backend that dies halfway through
  // a corpus must not leave a ranking where half the documents are 1024-dim
  // semantics and half are 256-dim character hashes — those scores are not
  // comparable. One failure and the whole call degrades to local.
  //
  // The same rule governs the cache: a failed batch commits NOTHING, because a
  // partial batch left in the cache would be mixed with local fallbacks on the
  // next call. Only fully successful batches are cached.
  async function embedBatch(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ""));
    const out = new Array(list.length);
    const pending = [];
    for (let i = 0; i < list.length; i++) {
      if (!list[i]) { out[i] = localVectorize("", cfg.dim || 256); continue; }
      const key = cacheKey(backend, cfg, list[i]);
      const hit = cacheGet(key);
      if (hit !== undefined) { stats.cacheHits++; out[i] = hit; continue; }
      pending.push({ i, text: list[i], key });
    }
    if (pending.length === 0) return { vectors: out, degraded: false };

    if (backend === "local") {
      for (const p of pending) {
        stats.calls++;
        out[p.i] = localEmbed(p.text, cfg);
        cacheSet(p.key, out[p.i]);
      }
      return { vectors: out, degraded: false };
    }

    const done = [];
    try {
      for (const p of pending) {
        stats.calls++;
        if (backend === "openai") {
          // One text may cost several requests (one per chunk) — that is the
          // safe shape, not batching.
          const vec = await openaiEmbedText(p.text, cfg, () => { stats.requests++; });
          done.push([p, vec]);
        } else {
          stats.requests++;
          done.push([p, commandEmbed(p.text, cfg)]);
        }
      }
    } catch (e) {
      // Degrade, do not die. A dead embedder must not take retrieval with it.
      stats.failures++;
      stats.lastError = String(e.message || e);
      stats.fallbacks++;
      for (const p of pending) out[p.i] = localEmbed(p.text, cfg);
      return { vectors: out, degraded: true };
    }
    for (const [p, vec] of done) {
      cacheSet(p.key, vec);
      out[p.i] = vec;
    }
    return { vectors: out, degraded: false };
  }

  async function embed(text) {
    const { vectors } = await embedBatch([text]);
    return vectors[0];
  }

  return {
    name: backend,
    dim: cfg.dim || (backend === "local" ? 256 : null),
    embed,
    embedBatch,
    stats,
    // True when this backend is expected to produce semantically meaningful
    // vectors. The local one is a bag-of-characters approximation and says so.
    semantic: backend !== "local"
  };
}
