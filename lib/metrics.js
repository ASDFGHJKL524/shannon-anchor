// shannon-anchor — metrics: measure whether the memory system is actually working.
//
// Why this exists: 186 passing tests prove the code does what the tests say.
// They prove nothing about whether the memory is useful. A system can be
// perfectly tested and still be accumulating noise, retrieving the wrong
// entry, or never being consulted at all.
//
// Borrowed idea: dsh-mnemos ships an "open measurement ABI". This is an
// independent implementation with the same goal: expose a small, stable,
// machine-readable set of numbers so "is this getting better or worse" has an
// answer that is not a feeling.
//
// Design constraints, deliberate:
//   - Append-only JSONL. One line per event. `tail` is the whole tool.
//   - No personal content in the metrics file: numbers, hashes, and event
//     kinds only. The manual already holds the prose; the metric log must be
//     safe to paste into an issue.
//   - Cheap enough to call on every tool invocation. No aggregation on write;
//     aggregation happens on read.
//   - Bounded: the log rotates at a size cap so it cannot grow forever.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const EVENT_KINDS = [
  "write",        // an entry was written
  "recall",       // an entry was read
  "search",       // a query ran
  "curate",       // a shape-layer suggestion was produced
  "integrity",    // an integrity verdict was reached
  "forget",       // a tier change happened
  "guard",        // a guard blocked or allowed something
  "chain",        // a chain verification ran
  "predict",      // a predictive-recall suggestion fired
  "predict-silent"// a turn scored and stayed quiet (gate + best candidate)
];

// 4 MB is roughly 40k lines at ~100 bytes each — plenty for months of use,
// small enough that a reader can load the tail without thinking about it.
const MAX_BYTES = 4 * 1024 * 1024;

export function metricsDir(root) { return path.join(root, "metrics"); }
export function eventsPath(root) { return path.join(metricsDir(root), "events.jsonl"); }
export function summaryPath(root) { return path.join(metricsDir(root), "summary.json"); }

// A stable, non-reversible identifier for a piece of text. Used to correlate
// the same entry across events without storing the entry itself in the log.
export function textId(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex").slice(0, 12);
}

function ensureDir(root) {
  fs.mkdirSync(metricsDir(root), { recursive: true });
}

// Rotate before the file gets unwieldy. One generation of history is kept on
// disk (events.jsonl.1), and nothing reads it: readEvents() opens events.jsonl
// only, so every aggregate/diagnose call sees the window since the last
// rotation. The .1 exists as a manual archive, not as part of the measurement.
// This used to claim .1 was "enough to compare this month against last", which
// no code path can do — and rotation is destructive: the second rotation
// overwrites the first archive.
//
// Cost of that, measured 2026-10-31: 244 KB / 3,230 events over 13 days, so
// ~55k lines before the cap and ~236 days at the old rate. Logging silence
// multiplies volume by roughly 4-5x (fires are 55% of the current log and the
// replay says a quiet turn outnumbers a firing one about 9:1), putting the first
// rotation near 50 days out. The fire-rate denominator this file exists to
// collect will therefore start over before it is stale — fine for a rolling
// reading, wrong for a longitudinal claim. Quote a date range, not a total.
function rotateIfNeeded(root) {
  const p = eventsPath(root);
  try {
    const st = fs.statSync(p);
    if (st.size < MAX_BYTES) return false;
    const old = `${p}.1`;
    fs.rmSync(old, { force: true });
    fs.renameSync(p, old);
    return true;
  } catch {
    return false; // no file yet, nothing to rotate
  }
}

// record(root, kind, fields) -> the line that was appended (or null on failure)
//
// Never throws. A metrics write that breaks the caller would be worse than no
// metrics: the memory system's job is to remember, not to count.
export function record(root, kind, fields = {}) {
  try {
    if (!EVENT_KINDS.includes(kind)) return null;
    ensureDir(root);
    rotateIfNeeded(root);
    const line = {
      t: new Date().toISOString(),
      k: kind,
      ...sanitize(fields)
    };
    fs.appendFileSync(eventsPath(root), JSON.stringify(line) + "\n", "utf8");
    return line;
  } catch {
    return null;
  }
}

// Only primitives and short strings survive. Anything that looks like prose is
// dropped — the metric log must never become a second copy of the manual.
function sanitize(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number" || typeof v === "boolean") { out[k] = v; continue; }
    if (typeof v === "string") {
      // Long strings are almost always prose. Keep short identifiers only.
      out[k] = v.length <= 64 ? v : `sha:${textId(v)}`;
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = v.filter((x) => typeof x === "number" || typeof x === "boolean").slice(0, 32);
    }
  }
  return out;
}

// readEvents(root, opts) -> parsed events, oldest first.
// opts.limit keeps the LAST N (the tail is what you want for recent activity).
export function readEvents(root, opts = {}) {
  const p = eventsPath(root);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const slice = opts.limit ? lines.slice(-opts.limit) : lines;
  const out = [];
  for (const l of slice) {
    try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ }
  }
  return out;
}

// aggregate(events) -> the numbers that answer "is this working".
//
// The four that matter:
//   writes         how much is being recorded
//   recalls        how much is being read back
//   recallRatio    recalls per write. Below ~0.2 means the manual is a diary
//                  nobody opens: writing without reading is hoarding.
//   searchHitRate  fraction of searches that returned at least one result.
//                  Falling means the index and the queries have drifted apart.
//   integrity      how many writes needed review or were rejected
//   uniqueRecalled distinct entries read — a system that reads the same three
//                  entries forever is not a memory, it is a favourite list.
export function aggregate(events) {
  const a = {
    events: events.length,
    writes: 0,
    recalls: 0,
    searches: 0,
    searchesWithHits: 0,
    integrityAccept: 0,
    integrityReview: 0,
    integrityReject: 0,
    guardsBlocked: 0,
    chainFailures: 0,
    forgetEvents: 0,
    demotedEntries: 0,
    parkedEntries: 0,
    curateSuggestions: 0,
    predictFired: 0,
    predictFiredSinceSilence: 0,
    firstSilentT: null,
    predictScores: [],
    predictFloor: null,
    predictSilent: 0,
    predictSilentBest: [],
    predictNearMiss: 0,
    predictGates: {},
    recalledIds: new Set(),
    writtenIds: new Set()
  };
  for (const e of events) {
    switch (e.k) {
      case "write": a.writes++; if (e.id) a.writtenIds.add(e.id); break;
      case "recall": a.recalls++; if (e.id) a.recalledIds.add(e.id); break;
      case "search": a.searches++; if (Number(e.hits) > 0) a.searchesWithHits++; break;
      case "integrity":
        if (e.verdict === "accept") a.integrityAccept++;
        else if (e.verdict === "review") a.integrityReview++;
        else if (e.verdict === "reject") a.integrityReject++;
        break;
      case "guard": if (e.blocked) a.guardsBlocked++; break;
      case "chain": if (e.ok === false) a.chainFailures++; break;
      case "forget":
        a.forgetEvents++;
        if (Number.isFinite(e.demoted)) a.demotedEntries += e.demoted;
        if (Number.isFinite(e.parked)) a.parkedEntries += e.parked;
        break;
      case "curate": a.curateSuggestions++; break;
      case "predict":
        a.predictFired++;
        // Only fires from the same era as the silence log can share a
        // denominator with it. Before 2026-10-31 no event was written for a
        // quiet turn, so a pre-era fire has no counterpart to be counted
        // against: mixing them reported a 0.95 fire rate on 2026-11-01 when the
        // windowed truth was 0.095. Events arrive oldest first, so firstSilentT
        // is already set by the time any in-era fire is seen.
        if (a.firstSilentT && typeof e.t === "string" && e.t >= a.firstSilentT) {
          a.predictFiredSinceSilence++;
        }
        if (Number.isFinite(e.topScore)) a.predictScores.push(e.topScore);
        if (Number.isFinite(e.floor)) a.predictFloor = e.floor;
        break;
      // Kept out of predictScores on purpose: that array feeds the "median
      // just above the floor" reading, which means something only when every
      // number in it was allowed to speak.
      case "predict-silent":
        a.predictSilent++;
        if (a.firstSilentT === null && typeof e.t === "string") a.firstSilentT = e.t;
        if (Number.isFinite(e.bestAbs)) a.predictSilentBest.push(e.bestAbs);
        // Near-miss is judged against the floor THIS event was scored with, not
        // against whatever floor the log happens to end on. The floor moved from
        // 0.47 to 0.46 on 2026-11-01, and a single global bar quietly re-scores
        // every past turn against a rule it never saw — the same era-mixing
        // mistake the fire rate had. Each event carries its own floor, so use it.
        if (Number.isFinite(e.bestAbs) && Number.isFinite(e.floor)
            && e.bestAbs > 0 && e.bestAbs >= e.floor) {
          a.predictNearMiss++;
        }
        if (typeof e.gate === "string" && e.gate.length <= 32) {
          a.predictGates[e.gate] = (a.predictGates[e.gate] || 0) + 1;
        }
        if (Number.isFinite(e.floor)) a.predictFloor = e.floor;
        break;
    }
  }
  // A silent turn whose gate refuses before scoring (too-short, framing-only)
  // reports bestAbs 0. Those zeros are not "scored very low", they are "never
  // scored", and folding them into a median describes the wrong population.
  const scoredBest = a.predictSilentBest.filter((x) => x > 0);
  const pct = (n, d) => (d === 0 ? null : Number((n / d).toFixed(3)));
  const median = (xs) => {
    const s = [...xs].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Number(((s[m - 1] + s[m]) / 2).toFixed(3));
  };
  return {
    events: a.events,
    writes: a.writes,
    recalls: a.recalls,
    searches: a.searches,
    recallRatio: pct(a.recalls, a.writes),
    searchHitRate: pct(a.searchesWithHits, a.searches),
    distinctRecalled: a.recalledIds.size,
    distinctWritten: a.writtenIds.size,
    integrity: {
      accept: a.integrityAccept,
      review: a.integrityReview,
      reject: a.integrityReject
    },
    guardsBlocked: a.guardsBlocked,
    chainFailures: a.chainFailures,
    forgetEvents: a.forgetEvents,
    demotedEntries: a.demotedEntries,
    parkedEntries: a.parkedEntries,
    curateSuggestions: a.curateSuggestions,
    predictFired: a.predictFired,
    // Only fires carry a topScore (nothing was shown otherwise), so this is
    // the distribution of ACCEPTED matches, not of all turns. It answers
    // "when it speaks, how far above the bar is it?" — a median just over the
    // floor means the threshold is doing all the work and the margin is luck.
    predictTopScore: a.predictScores.length
      ? { median: median(a.predictScores), max: Math.max(...a.predictScores), n: a.predictScores.length }
      : null,
    predictFloor: a.predictFloor,
    predictSilent: a.predictSilent,
    predictFiredSinceSilence: a.predictFiredSinceSilence,
    // The denominator the log never had — but only INSIDE one era. Fires from
    // before predict-silent existed are counted in predictFired and left out of
    // this ratio on purpose (see the predict branch). Null until a silent event
    // exists, because until then there is no denominator at all.
    predictFireRate: pct(
      a.predictFiredSinceSilence,
      a.predictFiredSinceSilence + a.predictSilent
    ),
    // Silent turns that had a candidate at all. A turn killed before scoring
    // (too-short, framing-only) never had anything to lose, so it must not sit
    // in the denominator of any "how tight is the bar" number.
    predictSilentScored: a.predictSilentBest.filter((s) => s > 0).length,
    // Counted per event in the loop above, against each event's own floor: a
    // single global bar would re-score every past turn against a threshold it
    // was never judged by. bestAbs 0 means no candidate existed, so it can never
    // be a near-miss, not even under a floor of 0.
    predictNearMiss: Number.isFinite(a.predictFloor) ? a.predictNearMiss : null,
    // Median over the turns that HAD a candidate, with the total and the scored
    // count both reported so the two populations stay separable. Math.max(...)
    // is avoided deliberately: it throws RangeError past roughly 120k arguments
    // and the log cap allows ~58k lines today — safe now, a landmine if the cap
    // is ever raised.
    predictSilentBest: a.predictSilentBest.length
      ? {
          median: scoredBest.length ? median(scoredBest) : null,
          max: a.predictSilentBest.reduce((m, x) => (x > m ? x : m), 0),
          n: a.predictSilentBest.length,
          scored: scoredBest.length
        }
      : null,
    predictGates: a.predictGates
  };
}

// Interpretation, in words, because a number with no reading is not a metric.
// Deliberately blunt: it names the problem rather than scoring it.
export function diagnose(summary) {
  const notes = [];
  if (summary.events === 0) {
    notes.push("no events yet — nothing to measure");
    return notes;
  }
  if (summary.recallRatio !== null && summary.recallRatio < 0.2) {
    notes.push("recalls per write is low: entries are being stored faster than they are read back. Either the manual is outgrowing its usefulness, or the write criteria are too loose.");
  }
  if (summary.searchHitRate !== null && summary.searchHitRate < 0.5) {
    notes.push("most searches return nothing: the index and the questions being asked have drifted apart.");
  }
  if (summary.distinctRecalled > 0 && summary.recalls > 0
      && summary.distinctRecalled / Math.max(1, summary.recalls) < 0.3) {
    notes.push("the same few entries are recalled over and over: that is a favourite list, not a memory. Look for what is never reached.");
  }
  if (summary.integrity.reject > 0) {
    notes.push(`${summary.integrity.reject} write(s) were rejected by the integrity screen — worth checking whether those were genuinely bad or the screen is too aggressive.`);
  }
  if (summary.chainFailures > 0) {
    notes.push("the hash chain failed verification at least once: something changed outside the write path.");
  }
  if (summary.recalls > 0 && summary.writes > 0 && summary.forgetEvents === 0) {
    notes.push("nothing has been demoted yet: either the manual is young or the decay thresholds never fire.");
  }
  // Fires alone have no denominator, which is how 1,203 fires at floor 0.535
  // were logged with no way to re-tune it. Silence is recorded separately now,
  // so a fire rate is computable — but only over turns the hook actually
  // scored, and the pre-step hook runs per STEP, not per turn, so a turn with
  // twenty tool calls counts twenty times. Read this as "share of scored steps
  // that spoke", never as "how often the user asks something worth recalling".
  // Precision still cannot come from here; it needs a labelled replay
  // (a replay run), which is the only place with truth attached.
  if (summary.predictFired > 0 && !summary.predictSilent) {
    notes.push(`predictive recall has fired ${summary.predictFired} time(s) but no silent turns are logged at all: this log predates predict-silent, so there is no fire rate yet. Read predictFired as a count, not a rate.`);
  }
  if (summary.predictFired > 0) {
    if (summary.predictFired < 3) {
      notes.push(`predictive recall has only fired ${summary.predictFired} time(s) — not enough data to judge the threshold yet.`);
    }
    if (summary.predictTopScore && summary.predictFloor !== null) {
      const margin = Number((summary.predictTopScore.median - summary.predictFloor).toFixed(3));
      if (margin < 0.03) {
        notes.push(`the median prediction sits only ${margin} above the floor (${summary.predictFloor}): most fires are marginal matches. Raise predict.floor and accept fewer fires, rather than tuning the ranker against noise.`);
      }
    }
  }
  // The question silence was logged to answer. A near-miss is a quiet turn
  // whose strongest candidate scored AT OR ABOVE the bar: the floor let it
  // through and something downstream said no. Those are threshold losses in
  // name only — lowering the floor cannot recover a single one.
  // The two rows that used to sit here ("怎么备份" 0.589, "手册怎么加条目"
  // 0.525) were hand-typed probes, not corpus turns — removed 2026-10-31 after a
  // substring check found them in none of the 395 stored turns and none of the
  // 70 labels. Do not reintroduce them as evidence.
  // First real reading, 2026-11-01 12:51 (window since predict-silent went
  // live): 5 of 75 scored silent turns were near-misses, 0.489-0.534, four at
  // thin-entry and one at thin-turn. They carry no label, so correctness is
  // unknown; the labelled replay says those gates only ever refused noise.
  // Treat the count as "worth reading one at a time", not as proven loss.
  // Reads numbers aggregate() already computed. diagnose() gets the summary,
  // not the events, so it cannot re-derive anything from raw scores — and the
  // first version of this line called .filter() on {median,max,n} and threw on
  // every summary containing a silent event, which is writeSummary()'s own path.
  if (Number.isFinite(summary.predictFloor) && summary.predictNearMiss > 0) {
    const scored = summary.predictSilentScored || summary.predictNearMiss;
    notes.push(`${summary.predictNearMiss} of ${scored} silent observation(s) had a strongest candidate at or above the floor (${summary.predictFloor}) — the threshold was not what stopped them. Do not lower predict.floor to chase these; read predictGates for what refused.`);
  }
  // No obvious problem, but not proof of health either: silence dominates this
  // log by design, and a healthy-looking fire rate is not the same as a useful
  // prediction — that needs the labelled replay.
  if (notes.length === 0) notes.push("no obvious problem in the numbers. That is not proof of usefulness — only that nothing is measurably wrong.");
  return notes;
}

// writeSummary(root) -> { path, summary, notes }
// Snapshot for a human (or a later agent) to read without parsing the log.
export function writeSummary(root) {
  const summary = aggregate(readEvents(root));
  const notes = diagnose(summary);
  const body = { generatedAt: new Date().toISOString(), summary, notes };
  try {
    ensureDir(root);
    fs.writeFileSync(summaryPath(root), JSON.stringify(body, null, 2) + "\n", "utf8");
  } catch { /* best effort */ }
  return { path: summaryPath(root), ...body };
}
