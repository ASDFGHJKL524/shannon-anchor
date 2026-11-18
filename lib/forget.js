
// shannon-anchor — forgetting: three tiers, decay, never destroy.
//
// Design settled with the user:
//   - usage count lives in a SIDECAR file (stats.json), never in the
//     entry filename. Renaming an entry would move its hash and wake the
//     whole chain; a sidecar keeps content hashes stable.
//   - count DECAYS instead of resetting: count = count*0.7 + hits.
//     A hard daily reset cannot tell "hot" from "not used yet today".
//   - decaying is gradual (7/30/90 days of non-reference), never a
//     one-day drop. Low-frequency is not worthless: a "back up the
//     password" lesson used once a year is precious.
//   - entries may be marked low-frequency; they never auto-demote.
//   - forgetting is NOT deletion: tier 3 entries move to forgotten/,
//     leave the index, but keep their bytes and can be recalled.
//     Real destruction still goes through the delete guard.

import fs from "node:fs";
import path from "node:path";

export const DEMOTE_DAYS = { tier1_to_2: 7, tier2_to_3: 30, tier3_to_forgotten: 90 };
export const DECAY = 0.7;

export function statsPath(root) { return path.join(root, "stats.json"); }

function loadStats(root) {
  const p = statsPath(root);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return {}; }
}

function saveStats(root, stats) {
  fs.mkdirSync(path.dirname(statsPath(root)), { recursive: true });
  fs.writeFileSync(statsPath(root), JSON.stringify(stats, null, 2) + "\n", "utf8");
}

// countUsage: record that entry `num` was referenced today.
// Decay first, then add today's hits — so a long silence can never be
// undone by one lucky reference, and a hot entry stays hot.
//
// opts.sessionId（2026-11-02）：记录「这条经验在哪些对话里被用过」。
// 全局 count 会被历史稀释（一条很有用的经验，三个月不用也会冷掉），
// 而「本对话刚用过」是当下最相关的信号。分开存，检索时各用各的。
export function countUsage(root, num, opts = {}) {
  const stats = loadStats(root);
  const key = String(num);
  const today = new Date().toISOString().slice(0, 10);
  const cur = stats[key] || { count: 0, lastUsed: null, tier: 1, lowFreq: false, hitsToday: 0, hitsDay: null };
  if (cur.hitsDay !== today) { cur.hitsToday = 0; cur.hitsDay = today; }
  cur.count = cur.count * DECAY + 1;
  cur.hitsToday = (cur.hitsToday || 0) + 1;
  cur.lastUsed = today;
  // 2026-11-02: lastUsed 只到日期，召回排序没法区分「刚查过」和「昨天查过」。
  // 加一个精确时间戳，供 retrieval 的时间窗加权用（近似「本对话刚用过」）。
  const now = new Date().toISOString();
  cur.lastUsedAt = now;
  if (opts.sessionId) {
    cur.sessions = cur.sessions && typeof cur.sessions === "object" ? cur.sessions : {};
    const sid = String(opts.sessionId);
    const s = cur.sessions[sid] || { count: 0 };
    s.count = (s.count || 0) + 1;
    s.lastAt = now;
    cur.sessions[sid] = s;
    // 只留最近 20 个会话：无尽增长会让 stats.json 越来越肥，而更早的会话
    // 对「本对话用没用过」这个判断毫无贡献。
    const keys = Object.keys(cur.sessions);
    if (keys.length > 20) {
      keys
        .sort((a, b) => String(cur.sessions[b].lastAt || "").localeCompare(String(cur.sessions[a].lastAt || "")))
        .slice(20)
        .forEach((k) => delete cur.sessions[k]);
    }
  }
  if (cur.tier > 1) cur.tier = 1; // being referenced again un-demotes
  stats[key] = cur;
  saveStats(root, stats);
  return cur;
}

function daysSince(iso) {
  if (!iso) return Infinity;
  const then = new Date(iso + "T00:00:00").getTime();
  if (!Number.isFinite(then)) return Infinity;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

// sweep(root, manual, opts) -> { demoted, forgotten }
// Call once a day. Never deletes bytes; only moves tiers and, at the
// last tier, moves files into forgotten/ (still restorable).
export function sweep(root, manual, opts = {}) {
  const base = { ...DEMOTE_DAYS, ...(opts.thresholds || {}) };
  const byConfidence = opts.byConfidence || {};
  const stats = loadStats(root);
  const demoted = [];
  const forgotten = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const entry of manual.entries) {
    const key = String(entry.number);
    const s = stats[key] || { count: 0, lastUsed: null, tier: 1, lowFreq: false };
    if (s.lowFreq) continue; // low-frequency protection
    let idle = daysSince(s.lastUsed);
    if (idle === Infinity && entry.lastUsed) idle = daysSince(entry.lastUsed);
    if (idle === Infinity && entry.created) idle = daysSince(entry.created);
    let tier = s.tier || 1;
    // entries.js declares a slower clock for human-confirmed facts. Applying
    // only the inferred thresholds made the confirmed config keys dead.
    const th = { ...base, ...(byConfidence[entry.confidence] || {}) };
    if (idle >= th.tier3_to_forgotten && tier >= 3) {
      const moved = moveToForgotten(root, entry);
      if (moved) { forgotten.push({ number: entry.number, idle }); s.tier = 4; continue; }
    }
    if (idle >= th.tier2_to_3 && tier >= 2) { tier = 3; }
    else if (idle >= th.tier1_to_2 && tier >= 1) { tier = 2; }
    if (tier !== (s.tier || 1)) {
      demoted.push({ number: entry.number, from: s.tier || 1, to: tier, idle });
      s.tier = tier;
    }
    stats[key] = s;
  }
  stats._swept = today;
  saveStats(root, stats);
  return { demoted, forgotten };
}

// moveToForgotten: bytes survive, index no longer sees them.
export function moveToForgotten(root, entry) {
  try {
    const src = path.join(root, "manual", entry.path);
    if (!fs.existsSync(src)) return false;
    const dir = path.join(root, "forgotten");
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(src, path.join(dir, entry.path.replace(/[\\/]/g, "_")));
    return true;
  } catch {
    return false;
  }
}

export function listForgotten(root) {
  const dir = path.join(root, "forgotten");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

// recallForgotten: bring an entry back to tier 1. Its bytes never left.
export function recallForgotten(root, fileName, targetRel) {
  const src = path.join(root, "forgotten", fileName);
  const dst = path.join(root, "manual", targetRel);
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  const stats = loadStats(root);
  const m = /_(\d+)\.md$/.exec(fileName);
  if (m) {
    stats[m[1]] = { ...(stats[m[1]] || {}), tier: 1, lastUsed: new Date().toISOString().slice(0, 10), count: 1 };
    saveStats(root, stats);
  }
  return true;
}

export function tierOf(stats, num) {
  return (stats[String(num)] || {}).tier || 1;
}

export function markLowFrequency(root, num, lowFreq = true) {
  const stats = loadStats(root);
  const key = String(num);
  stats[key] = { ...(stats[key] || { count: 0, lastUsed: null, tier: 1 }), lowFreq };
  saveStats(root, stats);
  return stats[key];
}
