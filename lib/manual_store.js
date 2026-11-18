// shannon-anchor — manual store: index + numbered entry files on disk.
//
// Layout under manualRoot:
//   manual/
//     README.md          generated index (number -> one-line -> path)
//     01-rules/...        numbered entry files, one experience per file
//   memory.json          machine-readable manifest (id -> sha256, bytes, dates)
//
// The index is generated from the entry files, never hand-edited: a stale
// index would make recall miss. History only grows: entries are marked
// superseded, never unlinked.

import fs from "node:fs";
import path from "node:path";
import { chainFile } from "./hash_chain.js";

const ENTRY_RE = /^### (\d+)\.\s*(.+?)\s*$/;
// Retirement is a metadata marker, never a word in the prose. Scanning the
// body for "superseded" flags any entry that explains the mechanism itself.
// Both spellings are accepted: the manual tradition uses underscores, the
// HTML-comment style uses hyphens.
const SUPERSEDE_KEYS = ["superseded_by", "superseded-by", "merged_into", "merged-into"];
// link_reverted cancels the last link marker. The reader takes the LAST
// marker in the head as current state, so reverting is itself append-only.
const LINK_KEYS = new Set([...SUPERSEDE_KEYS, "link_reverted"]);
const SECTIONS = [
  ["01-rules", "Rules (how to behave)"],
  ["02-method", "Method (how to work)"],
  ["03-machine", "Machine facts (this environment)"],
  ["04-experience", "Experience (what happened, what was learned)"],
];

export function manualDir(root) { return path.join(root, "manual"); }
export function indexPath(root) { return path.join(manualDir(root), "README.md"); }
export function manifestPath(root) { return path.join(root, "memory.json"); }

export function ensureLayout(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const [dir] of SECTIONS) fs.mkdirSync(path.join(manualDir(root), dir), { recursive: true });
}

// A cheap "did the manual change" probe. chain.txt lists a hash and size for
// every entry file plus memory.json/identity.md, and every routed write
// rewrites it, so its own size+mtime moves whenever the corpus does — one
// stat instead of 179. An edit that skips the write path (hand-editing a .md)
// is invisible here; callers must not treat this as a correctness guarantee,
// only as a cache key with a bounded age.
export function manualStamp(root) {
  try {
    const st = fs.statSync(chainFile(root));
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "no-chain";
  }
}

// The index needs the title and the metadata comments, not the prose. Reading
// every full entry was ~39 ms per call on the live 179-entry manual, on a path
// that runs before EVERY model step. The head of an entry is all of 15 lines,
// so read a bounded slice instead, and cache it by path+size+mtime.
//
// The size/mtime are read from the same stat the caller already needed for
// `bytes`, and the body cache reuses them too: one stat per file per load.
const HEADER_BYTES = 8192;
const HEADER_CACHE = new Map();
const HEADER_CACHE_MAX = 4000;

function readHeader(file, st) {
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  const hit = HEADER_CACHE.get(key);
  if (hit) return hit;
  const want = Math.min(st.size, HEADER_BYTES);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(want);
    const read = fs.readSync(fd, buf, 0, want, 0);
    const head = buf.toString("utf8", 0, read).split("\n", 16).slice(0, 15);
    const out = { line: head[0] || "", head };
    if (HEADER_CACHE.size >= HEADER_CACHE_MAX) {
      HEADER_CACHE.delete(HEADER_CACHE.keys().next().value);
    }
    HEADER_CACHE.set(key, out);
    return out;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

export function loadManual(root) {
  ensureLayout(root);
  const entries = [];
  for (const [dir] of SECTIONS) {
    const d = path.join(manualDir(root), dir);
    for (const f of fs.readdirSync(d).sort()) {
      const m = /^(\d+)\.md$/.exec(f);
      if (!m) continue;
      const num = Number(m[1]);
      const full = path.join(d, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      const header = readHeader(full, st);
      if (!header) continue;
      const em = ENTRY_RE.exec(header.line);
      if (!em || Number(em[1]) !== num) continue;
      const meta = {};
      const linkEvents = [];
      for (const l of header.head) {
        const mm = /^<!--\s*([a-z_-]+):\s*(.*?)\s*-->$/.exec(l.trim());
        if (!mm) continue;
        meta[mm[1]] = mm[2];
        if (LINK_KEYS.has(mm[1]) && mm[2] && mm[2].trim()) linkEvents.push(mm[1]);
      }
      const lastLink = linkEvents.length ? linkEvents[linkEvents.length - 1] : null;
      const superseded = lastLink !== null && lastLink !== "link_reverted";
      // wrong（2026-11-03）：被推翻的结论。和 superseded 不同——superseded 是
      // "有更新的版本"，wrong 是"这条本身是错的"。wrong 条目检索时降权、
      // 注入时跳过，但正文保留（append-only，可追溯）。wrong_reverted 撤销。
      const wrong = Boolean(meta.wrong) && !meta.wrong_reverted;
      const wrongReason = wrong ? String(meta.wrong).trim() : null;
      // The target is what makes a retired entry actionable: "recalled #21"
      // must say "read #136 instead", not merely "dead".
      const target = superseded ? /^(\d+)\b/.exec(String(meta[lastLink] || "").trim()) : null;
      entries.push({
        number: num,
        title: em[2].replace(/<!--.*?-->/g, "").trim(),
        path: `${dir}/${f}`,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        superseded,
        supersededBy: target ? Number(target[1]) : null,
        linkKind: superseded ? lastLink.replace(/-/g, "_") : null,
        wrong,
        wrongReason,
        created: meta.created || null,
        lastUsed: meta["last-used"] || null,
        confidence: meta.confidence || "agent-inferred",
        // 场景标签（2026-11-03）：`<!-- tags: a,b,c -->`。没有标签就是空数组，
        // 老条目照常工作，只是"用词不同但场景相同"的查询命中不了。
        tags: meta.tags ? String(meta.tags).split(",").map((s) => s.trim()).filter(Boolean) : []
      });
    }
  }
  entries.sort((a, b) => a.number - b.number);
  return { root, entries };
}

export function readEntry(manual, n) {
  const hit = manual.entries.find((e) => e.number === n);
  if (!hit) return null;
  const full = path.join(manualDir(manual.root), hit.path);
  const text = fs.readFileSync(full, "utf8");
  const body = text.split("\n").slice(1).join("\n").trim();
  return { ...hit, body };
}

// loadManualWithBodies(manual, opts?) -> entries WITH body text.
//
// The index deliberately loads metadata only: reading every entry body on every
// call would make a large manual expensive for the common case (list, recall
// one). Predictive recall is the one caller that genuinely needs the text of
// every entry, because it scores the current turn against the whole library.
//
// Caching: keyed by path + byte size + mtime. A rewrite changes at least one of
// those, so a stale body is not possible; a cheap stat per entry replaces a
// full read on the hot path. The cache lives on the manual object so it dies
// with the caller's load, and never leaks across roots.
const BODY_CACHE = new Map();

export function loadManualWithBodies(manual, opts = {}) {
  const max = opts.maxEntries ?? 5000; // a sanity bound, not a target
  const entries = [];
  for (const e of manual.entries) {
    if (entries.length >= max) break;
    const full = path.join(manualDir(manual.root), e.path);
    let size = e.bytes;
    let mtime = e.mtimeMs;
    if (typeof size !== "number" || typeof mtime !== "number") {
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtimeMs;
      } catch { continue; }
    }
    const key = `${full}:${size}:${mtime}`;
    let body = BODY_CACHE.get(key);
    if (body === undefined) {
      try {
        const text = fs.readFileSync(full, "utf8");
        body = text.split("\n").slice(1).join("\n").trim();
      } catch {
        continue;
      }
      // Bounded cache: drop the oldest insertion when it grows past the bound.
      if (BODY_CACHE.size > 2000) {
        const oldest = BODY_CACHE.keys().next().value;
        BODY_CACHE.delete(oldest);
      }
      BODY_CACHE.set(key, body);
    }
    entries.push({ ...e, body });
  }
  return { ...manual, entries };
}

const TIER_MARK = { 1: "hot", 2: "warm", 3: "cold", 4: "forgotten" };

// indexOf(manual, opts?) — tier-aware index.
//   opts.section  filter by section dir
//   opts.tiers    "1" (default: active only, cheap) | "all"
//   opts.stats    usage stats { num: { tier, count } } — adds the tier +
//                 heat columns. Without stats the tier column reads "?".
//   opts.includeSuperseded  list retired entries in a tier-1 view too
// Design: tier-1 is the DEFAULT view. A model on a task should see the
// active shelf, not the whole attic; cold and forgotten entries are
// listed on request, never hidden-by-default-but-invisible — they carry
// the information "this may be stale, verify on use".
// Retired entries are the exception: "verify on use" cannot rescue a
// conclusion that has already been replaced, so they stay off the default
// shelf. tiers="all" is the lineage view.
export function indexOf(manual, opts = {}) {
  const { section = null, tiers = "1", stats = null, includeSuperseded = false, compact = false } = opts;
  const tierOf = (e) => stats && stats[String(e.number)] ? (stats[String(e.number)].tier || 1) : 1;
  const heatOf = (e) => stats && stats[String(e.number)] ? (Math.round((stats[String(e.number)].count || 0) * 10) / 10) : null;
  const shown = manual.entries.filter((e) => {
    if (section && !e.path.startsWith(section)) return false;
    if (e.superseded && tiers !== "all" && !includeSuperseded) return false;
    if (tiers === "all") return true;
    return tierOf(e) <= Number(tiers);
  });
  const hiddenRetired = manual.entries.filter((e) => e.superseded && !shown.includes(e)).length;
  // Token 瘦身（2026-11-03）：默认只给编号+标题。挑条目只需要这两样，
  // path/tier/heat 是"要看细节"时才需要的列。全表 317 行约 4k token，
  // 精简后约 1.5k。
  if (compact) {
    const rows = shown.map((e) => `${e.number}. ${e.superseded ? "~" : ""}${e.title}`);
    const tail = [
      "",
      `共 ${shown.length} 条（tier <= ${tiers}）。要 path/tier/heat 加 detail: true；要看正文用 memory_recall <n>。`
    ];
    if (hiddenRetired) tail.push(`${hiddenRetired} 条 retired 已隐藏（血缘用，不是现行建议）。`);
    return [...rows, ...tail].join("\n");
  }
  const rows = shown.map((e) => {
    const tier = tierOf(e);
    const heat = heatOf(e);
    return `| ${e.number} | ${e.superseded ? "~superseded~ " : ""}${e.title} | \`${e.path}\` | ${TIER_MARK[tier] || "?"} | ${heat === null ? "-" : heat} |`;
  });
  const head = ["| # | summary | path | tier | heat |", "|---|---|---|---|---|"];
  const tail = [
    "",
    "Sections: " + SECTIONS.map(([d, t]) => `\`${d}\` (${t})`).join(" · "),
    `Showing ${shown.length} of ${manual.entries.length} entries (tier <= ${tiers}). Use memory_recall <n> for the full text; memory_list with tiers=all to see cold and retired entries.`
  ];
  if (hiddenRetired) {
    tail.push(`${hiddenRetired} retired (superseded) entr${hiddenRetired === 1 ? "y" : "ies"} hidden — lineage, not advice; tiers=all to view.`);
  }
  return [...head, ...rows, ...tail].join("\n");
}

export function writeIndex(manual, opts = {}) {
  const stats = opts.stats || null;
  const rows = manual.entries.map((e) => {
    const s = stats && stats[String(e.number)];
    const tier = s ? (s.tier || 1) : 1;
    return `| ${e.number} | ${e.superseded ? "~superseded~ " : ""}${e.title} | \`${e.path}\` | ${TIER_MARK[tier] || "?"} |`;
  });
  const lines = [
    "# shannon-anchor manual index",
    "",
    "Generated from the entry files. Do not hand-edit; run memory_write to add entries.",
    "",
    "| # | summary | path | tier |",
    "|---|---|---|---|",
    ...rows,
    "",
    "Sections: " + SECTIONS.map(([d]) => `\`${d}\``).join(" · ")
  ];
  fs.mkdirSync(path.dirname(indexPath(manual.root)), { recursive: true });
  fs.writeFileSync(indexPath(manual.root), lines.join("\n") + "\n", "utf8");
  return indexPath(manual.root);
}

export { SECTIONS, ENTRY_RE };