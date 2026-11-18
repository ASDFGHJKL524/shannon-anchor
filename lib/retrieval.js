
// shannon-anchor — retrieval: find entries without loading them all.
//
// Why this exists: a memory system designed to GROW cannot afford a
// full-table index. dsh-memory solved it with BM25 + vectors; we take the
// zero-dependency half of that and keep the seam pluggable, so a heavier
// backend (sqlite-vec / remote embeddings) can be swapped in later
// WITHOUT touching callers (docs/USAGE.md: retrieval is a necessity,
// not a luxury).
//
// Scoring (ranked, with reasons so the caller can judge):
//   - BM25 over the tokenizer (latin words + CJK bigrams)
//   - + a cosine-similarity term over a 256-dim feature-hash vector,
//     which catches fuzzy/paraphrase matches the inverted index misses.
//     Callers that own a real embedder may pass precomputed vectors instead
//     (opts.queryVector / opts.docVectors) — same ranking, better semantics
//   - cold-tier entries are down-weighted, never hidden: a demoted entry
//     that still answers the query is worth showing WITH its tier label
//
// This module is PURE (no fs, no host). The caller supplies entries.

import { tokenizeList } from "./tokenize.js";

// Corpus cache: tokenization and hashing are the expensive half of a search,
// and on the prediction path they were redone for every entry on every model
// step (measured 2026-10-25: ~31 ms of the ~90 ms per-step cost, on 179
// entries). The text is the cache key, so an edited entry misses by itself —
// there is no version to invalidate.
//
// Eviction is LRU, and that matters: every step inserts a fresh query key
// while re-hitting the same ~360 corpus keys (body + title/path, tokens and
// vector each). Under FIFO the one-off queries would eventually push the
// stable corpus out and the cache would thrash. Re-inserting on a hit keeps
// the live corpus at the tail; the queries are what falls off first.
const CORPUS_CACHE = new Map();
const CORPUS_CACHE_MAX = 2048;

function remember(key, make) {
  const hit = CORPUS_CACHE.get(key);
  if (hit !== undefined) {
    CORPUS_CACHE.delete(key);
    CORPUS_CACHE.set(key, hit);
    return hit;
  }
  const val = make();
  if (CORPUS_CACHE.size >= CORPUS_CACHE_MAX) {
    CORPUS_CACHE.delete(CORPUS_CACHE.keys().next().value);
  }
  CORPUS_CACHE.set(key, val);
  return val;
}

// Token lists are shared by bm25 and vectorize; both read them, neither writes.
function tokensOf(text) {
  return remember(`t\u0000${text}`, () => tokenizeList(text));
}

const DIM = 256;
// Character-hash noise floor. 256 buckets is small, so unrelated tokens
// collide by chance and cosine comes out non-zero (measured: 0.08 between
// two texts sharing ZERO tokens). Without a floor, that noise passes every
// minScore gate and search returns junk. 0.3 is the starting point used by
// dsh-memory for the same reason; treat it as a tuning knob, not truth.
const COSINE_FLOOR = 0.3;

// 256-dim feature hash: hash each token into a bucket, weight by tf.
// Zero-dependency, no model. Threshold 0.3 is a starting point with no
// measured backing — tune it with real queries, do not trust it blindly.
// The returned vector is cached and therefore READ-ONLY by contract: mutating
// it would poison every later search over the same text. Callers that need to
// own their array must copy it (embedding.js already does).
export function vectorize(text, dim = DIM) {
  return remember(`v\u0000${dim}\u0000${text}`, () => {
    const v = new Float64Array(dim);
    for (const t of tokensOf(text)) {
      let h = 2166136261;
      for (let i = 0; i < t.length; i++) {
        h ^= t.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      v[Math.abs(h) % dim] += 1;
    }
    return v;
  });
}

// Cosine over the COMMON PREFIX, not over `a.length`. Equal dimensions behave
// exactly as before; a width change (local 256 vs a 1024-dim model) degrades
// to a comparable prefix instead of reading past the shorter array and
// returning NaN. Callers must still not mix spaces within one ranking.
export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// The exact text that gets indexed. Exported so an embedder embeds the SAME
// string BM25 reads: title and path repeated (a title match outranks a passing
// body mention), then the body. Two call sites building this by hand drifted
// once already.
export function haystackOf(entry) {
  // 场景标签（2026-11-03）和标题同权重：两者都回答"这条讲什么"，
  // 正文回答"具体怎么做"。标签让"用词不同但场景相同"的查询也能命中。
  const tags = Array.isArray(entry.tags) && entry.tags.length ? ` ${entry.tags.join(" ")}` : "";
  const head = `${entry.title || ""}${tags} ${entry.path || ""}`;
  return `${head} ${head} ${entry.body || ""}`;
}

// BM25 over a small in-memory corpus. k1/b are the standard defaults.
//
// IDF floor — why it exists (measured; see docs/USAGE.md):
// the query "今天天气怎么样" scored 14.46 against entry #128 while every
// other entry scored under 5. The cause was NOT long-document bias (BM25's
// b term already penalizes length — #128 is 1415 tokens against an average
// of 307, so it is divided by 4.6x). The cause was that "今天"/"怎么" are
// words EVERY entry in a memory manual contains, so df -> N and idf -> 0...
// except that #128 repeats them so often that term frequency alone carries
// it to the top. A word that appears in most documents must not be allowed
// to dominate a document's score no matter how often it repeats there.
//
// The floor is the standard BM25+ style correction: idf is clamped to a
// small positive value instead of collapsing to ~0, so ubiquitous words
// still contribute a little (they are not noise, they are just weak) but
// cannot carry an entry on their own.
const IDF_FLOOR = 0.05;

export function bm25(corpus, query, k1 = 1.5, b = 0.75) {
  const q = tokensOf(query);
  if (q.length === 0) return corpus.map(() => 0);
  const docs = corpus.map((c) => tokensOf(c));
  const avgdl = docs.reduce((a, d) => a + d.length, 1) / Math.max(1, docs.length);
  const df = new Map();
  for (const d of docs) {
    for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = docs.length;
  return docs.map((d) => {
    let score = 0;
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of q) {
      const n = df.get(t) || 0;
      if (n === 0) continue;
      const rawIdf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      const idf = Math.max(rawIdf, IDF_FLOOR);
      const f = tf.get(t) || 0;
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.length / avgdl))));
    }
    return score;
  });
}

const TIER_PENALTY = { 1: 1, 2: 0.85, 3: 0.6, 4: 0.3 };

// search(entries, query, opts) -> ranked [{ entry, score, why }]
// opts.stats    tier/count map; opts.limit; opts.minScore
// opts.queryVector + opts.docVectors (parallel to entries): precomputed
//   embeddings from a real backend. When both are present the cosine term
//   uses them instead of the local feature hash; the function stays
//   SYNCHRONOUS, so predict.js keeps its per-step budget and every caller
//   without an embedder is unchanged.
// opts.cosineFloor  override the 0.3 hash-noise floor (semantic models need a
//   different cutoff; see COSINE_FLOOR).
// opts.absolute when true, also return `abs` — the UNNORMALIZED relevance.
//   Why it matters: `score` is normalized by the best hit in THIS query, so
//   the top result always looks strong even when nothing is relevant (an
//   unrelated query still yields ~0.65 because it is the best of a bad set).
//   That is fine for "rank these for someone who already asked", and wrong for
//   "decide whether to say anything at all" — see predict.js, which needs a
//   number that means the same thing across different queries.
// A superseded entry is EXCLUDED by default. A retired conclusion is not a
// weak answer — it is a wrong one, and recall carries no "obsolete" banner in
// the body. Callers that want the lineage pass opts.includeSuperseded.
export function search(entries, query, opts = {}) {
  if (!query || !query.trim()) return [];
  const stats = opts.stats || null;
  const tierOf = (e) => (stats && stats[String(e.number)] && stats[String(e.number)].tier) || 1;

  // 加权：本对话用过的 > 最近用过的 > 其余。
  //
  // 2026-11-02 加分对话维度：同一轮对话里反复查的经验，是这台机器当下的
  // 主线；而"三个月前很热、这个对话没碰过"对现在没有指示意义。所以本会话
  // 命中给最高权重，时间窗做次一档的近似（调用方没传 sessionId 时退回时间窗）。
  //
  // 上限刻意压低：热度是注意力信号，不是正确性证据，不能盖过内容匹配本身。
  const sid = opts && opts.sessionId ? String(opts.sessionId) : null;
  const recencyBoost = (num) => {
    const s = stats && stats[String(num)];
    if (!s) return 1;
    if (sid && s.sessions && s.sessions[sid]) return 1.8;
    if (!s.lastUsedAt) return 1;
    const t = Date.parse(s.lastUsedAt);
    if (!Number.isFinite(t)) return 1;
    const mins = (Date.now() - t) / 60000;
    if (mins <= 30) return 1.5;
    if (mins <= 120) return 1.2;
    return 1;
  };
  // Title and body answer different questions. A title is the entry's own
  // summary; a body is where the topic words usually live. Index both, with
  // the title repeated so a title match still outranks a passing mention in a
  // long body. Measured 2026-10-30: indexing the title alone left rule #91
  // unreachable for "删除守卫怎么用" — its title is 删除与不可逆操作的边界,
  // and 守卫 appears only in the body. Callers that pass metadata-only
  // entries simply get the old behaviour (body is empty).
  const haystacks = entries.map(haystackOf);
  const bm = bm25(haystacks, query);
  const supplied =
    Array.isArray(opts.docVectors) &&
    opts.docVectors.length === entries.length &&
    opts.queryVector &&
    opts.queryVector.length > 0;
  const qv = supplied ? opts.queryVector : vectorize(query);
  const cosFloor = typeof opts.cosineFloor === "number" ? opts.cosineFloor : COSINE_FLOOR;
  // Query coverage: how much of the QUESTION this entry answers, weighted by
  // how specific each query token is. The absolute blend alone cannot tell a
  // document that answers two content words from one that happens to share a
  // single ubiquitous bigram. Measured: "帮我看看这个报错" matched
  // only 看这 in #282 and still scored 0.596, above every real query (top 0.516
  // to 0.782) — no floor could separate them.
  // Coverage is measured against the LITERAL query. predict() scores an
  // expanded query (destructive wording gains 删除/不可逆 so the guard entry is
  // reachable), but expansion is a retrieval trick, not something the user
  // said; letting its added words into the denominator would penalize a real
  // question for words it never contained.
  //
  // The added words still count as EVIDENCE, capped at full coverage: they are
  // inferred from the user's own wording, and the guard entry can answer a
  // destructive question while sharing no bigram with it at all. Measured
  // with expansion words excluded everywhere, 「我要删掉手册里的文件」
  // gave the guard entry zero coverage (删掉 vs 删除 share no token) and the
  // generic 先查手册 entry outranked it.
  const literalTokens = [...new Set(tokensOf(opts.coverageQuery ?? query))];
  const extraTokens = [...new Set(tokensOf(query))].filter((t) => !literalTokens.includes(t));
  const docTokens = haystacks.map((h) => new Set(tokensOf(h)));
  const df = new Map();
  for (const s of docTokens) for (const t of s) df.set(t, (df.get(t) || 0) + 1);
  const corpusSize = entries.length;
  const idfOf = (t) => {
    const n = df.get(t) || 0;
    return Math.max(Math.log((corpusSize - n + 0.5) / (n + 0.5) + 1), IDF_FLOOR);
  };
  // A query token the corpus NEVER contains is usually not a rare word — it is
  // a bigram the tokenizer cut across a word boundary ("备份包放哪" gives
  // 份包/包放/放哪; "测试挂了怎么查" gives 试挂). Counting those at maximum idf
  // made the denominator unbeatable: a real question that matched every word
  // the manual actually knows still covered only ~30% and sank to 0.17. They
  // are excluded from coverage entirely — an unknown word cannot be evidence
  // for OR against an entry. A query made only of unknown words has an empty
  // denominator, so it scores zero rather than a free pass.
  // A CJK bigram that contains a single-char function word is usually a
  // word-boundary artifact (问题+是 -> 题是, 现在+的 -> 的现), not a topic.
  // While the corpus does not contain it, coverage already ignores it (df=0).
  // The problem is corpus growth: once ANY entry contains it, it becomes a
  // df=1 "rare word" at max idf and taxes every OTHER entry. Measured
  // 2026-10-31: #305 brought 题是 into the corpus, lifting t380's coverage
  // denominator 22.6% and silencing a good Codex fire (0.479 -> 0.433).
  // Such a token is neither evidence for nor against an entry, so it leaves
  // both the denominator and the numerator. Unique REAL words (openrouter,
  // 寝室) stay counted — dropping every df=1 token added 40 fires, 33 of them
  // backed by genuine unique words.
  const STOP_CJK = new Set(["的", "了", "是", "在", "和", "与", "就", "都", "也", "很", "吗", "呢", "吧", "啊", "我", "你", "他", "她", "它"]);
  const isArtifact = (t) =>
    df.get(t) === 1 &&
    /^[\u4e00-\u9fa5]{2}$/.test(t) &&
    [...t].some((c) => STOP_CJK.has(c));
  const knownLiteral = literalTokens.filter((t) => df.get(t) && !isArtifact(t));
  const knownExtra = extraTokens.filter((t) => df.get(t) && !isArtifact(t));
  const qWeight = knownLiteral.reduce((a, t) => a + idfOf(t), 0) || 1;
  const maxBm = Math.max(...bm, 1e-9);
  const scored = entries.map((e, i) => {
    const bmN = bm[i] / maxBm;                 // 0..1
    const docVec = supplied ? opts.docVectors[i] : vectorize(haystacks[i]);
    const cosRaw = docVec && docVec.length ? cosine(docVec, qv) : 0;
    const cos = cosRaw >= cosFloor ? cosRaw : 0;
    const tier = tierOf(e);
    const raw = bmN * 0.65 + cos * 0.35;
    // 2026-11-02: 时间窗加权。stats 里刚记了精确时间戳，30 分钟内查过的最优先
    // （近似"本对话刚用过"——同一轮里前后脚 recall 的东西通常相关）。
    // 只加不乘到 0：它是提醒注意力，不是正确性证据。
    const score = raw * (TIER_PENALTY[tier] || 0.5) * recencyBoost(e.number) * (e.wrong ? 0.2 : 1);
    const row = { entry: e, score, bm25: bmN, cosine: cos, tier, superseded: !!e.superseded, wrong: !!e.wrong };
    if (opts.absolute) {
      // Absolute blend: raw BM25 (not divided by the query's best) plus cosine,
      // saturated so a genuinely irrelevant query lands near zero instead of at
      // the top of an empty field. Multiplied by idf-weighted coverage so that
      // sharing one word cannot look like answering the question.
      const bmAbs = bm[i] > 0 ? bm[i] / (bm[i] + 1.5) : 0;
      // Coverage is counted in TOKENS, not in idf weights. The weights made this
      // ratio depend on corpus size and document frequency, so every entry added
      // to the manual silently moved every absolute score: between 284 and 307
      // entries, 4 of the 28 labelled-good turns fell under the fixed floor while
      // their correct entry stayed on top. Measured with that change in place
      // (labeled check): drift 4 -> 1, noise fires unchanged at 4/30.
      // Expansion tokens still add evidence but cannot exceed the literal
      // question, same rule as before — only the unit changed.
      let matchedWeight = 0;
      for (const t of knownLiteral) if (docTokens[i].has(t)) matchedWeight += 1;
      for (const t of knownExtra) if (docTokens[i].has(t)) matchedWeight += 0.5;
      matchedWeight = Math.min(matchedWeight, knownLiteral.length || 1);
      // Square root: coverage is a multiplier on a score that is already
      // dominated by one strong term. Linear coverage double-counted the
      // penalty and buried real questions (测试挂了怎么查: 0.516 -> 0.171 for
      // matching the two words the manual knows). The sqrt still pushes a
      // single passing mention down without erasing two-of-three matches.
      const coverage = Math.sqrt(matchedWeight / (knownLiteral.length || 1));
      row.coverage = coverage;
      row.abs = (bmAbs * 0.65 + cos * 0.35) * coverage * (TIER_PENALTY[tier] || 0.5) * (e.wrong ? 0.2 : 1);
    }
    return row;
  });
  const min = opts.minScore ?? 0.05;
  const includeSuperseded = opts.includeSuperseded === true;
  return scored
    .filter((r) => includeSuperseded || !r.entry.superseded)
    .filter((r) => r.score >= min && (r.bm25 > 0 || r.cosine > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit || 10)
    .map((r) => ({ ...r, why: r.bm25 > 0 && r.cosine > 0 ? "bm25+vector" : r.bm25 > 0 ? "bm25" : "vector" }));
}
