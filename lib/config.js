
// shannon-anchor — config layer: user-private customization.
//
// Three files, one merge rule, one audit trail:
//   conf/default.json   shipped defaults (upgrade-only; users do not touch)
//   conf/user.json      private overrides (the ONLY place users and AI write)
//   conf/history.jsonl  append-only change log (who, when, old->new, why)
//
// Merge: default <- user, deep. Users write only the keys they mean to
// change — three keys means three lines, not a copy of fifty defaults.
//
// The one hard line: LOCKED_KEYS. The user may always change them by hand
// (it is their system), but the AI may NEVER set them silently — it can
// only propose and wait. Turning off a guard via the AI is exactly the
// move that removes its own audit; that is the whole reason for the lock.
//
// Fail-closed choices, deliberate:
//   - a broken user.json FAILS LOUD with the line number. Silently falling
//     back to defaults is worse: the user believes the change took.
//   - a type mismatch adopts the user value but records "type-mismatch".
//     Never silent.
//   - every apply writes a before/after snapshot; rollback is mechanical.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The shipped defaults live with the CODE, not in the user's data root:
// a plugin upgrade replaces them in place, and a data directory copied
// from another install can never poison the config with a stale copy
// (the 2026-10-18 incident: runtime/conf/default.json carried an old
// manualRoot and memory_config displayed it as truth).
const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Keys the AI may propose but never apply on its own. This list is itself
// configuration-of-configuration: changing it changes who can change what,
// so it stays human-only by policy (enforced by never exposing it to the
// AI-facing tool).
export const LOCKED_KEYS = new Set([
  "guardWrites",
  "guardDeletes",
]);

export function confDir(root) { return path.join(root, "conf"); }
export function defaultPath() { return path.join(PKG_ROOT, "conf", "default.json"); }
export function userPath(root) { return path.join(confDir(root), "user.json"); }
export function historyPath(root) { return path.join(confDir(root), "history.jsonl"); }
export function proposalsPath(root) { return path.join(confDir(root), "proposals.jsonl"); }

function readJson(p) {
  // strip a Windows-editor BOM before parsing; JSON.parse chokes on it
  return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
}

function readJsonOrNull(p, label) {
  if (!fs.existsSync(p)) return null;
  try {
    return readJson(p);
  } catch (e) {
    // fail loud, with the line the parser choked on
    let line = "?";
    const m = /position (\d+)/.exec(String(e.message));
    if (m) {
      const upto = fs.readFileSync(p, "utf8").slice(0, Number(m[1]));
      line = String(upto.split("\n").length);
    }
    throw new Error(`config: ${label} is not valid JSON (near line ${line}): ${e.message}`);
  }
}

// loadConfig(root) -> { config, user, sources, mismatches }
// root is the DATA root: user.json / history / proposals live there.
// default.json always comes from the plugin package (see PKG_ROOT).
// sources: per-key "default" | "user" | "merged" (top-level keys only)
//
// `config` is the merged VIEW — what memory_config should display. `user` is
// the raw override file. Callers that layer configuration must use `user`,
// never `config`: applying the merged view on top of an already-supplied
// config re-imposes every shipped default and silently discards the caller's
// values (2026-10-25: a test passed predict.enabled=true and prediction never
// switched on, because default.json's false came back through the merge).
export function loadConfig(root) {
  const def = readJsonOrNull(defaultPath(), "conf/default.json");
  if (def === null) throw new Error(`config: ${defaultPath()} missing — plugin is broken, not the user`);
  const user = readJsonOrNull(userPath(root), "conf/user.json") || {};
  const mismatches = [];
  const merged = deepMergeCollect(def, user, "", mismatches);
  const sources = {};
  for (const k of Object.keys(merged)) sources[k] = k in user ? "user" : "default";
  return { config: merged, user, sources, mismatches };
}

function deepMergeCollect(base, over, trail, mismatches) {
  if (over === null || typeof over !== "object" || Array.isArray(over)) return over;
  if (base === null || typeof base !== "object" || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const at = trail ? `${trail}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v) &&
        base[k] !== null && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMergeCollect(base[k], v, at, mismatches);
    } else {
      if (base[k] !== undefined && typeof base[k] !== typeof v) {
        mismatches.push({ key: at, was: base[k], now: v });
      }
      out[k] = v;
    }
  }
  return out;
}

// ---- audited writes ----

function logHistory(root, rec) {
  const p = historyPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec });
  fs.appendFileSync(p, line + "\n", "utf8");
}

function snapshotBefore(root, key) {
  const dir = path.join(confDir(root), "history");
  fs.mkdirSync(dir, { recursive: true });
  const p = userPath(root);
  const before = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(dir, `${stamp}-before-${key.replace(/[^\w.-]/g, "_")}.json`), before, "utf8");
}

// setKey(root, key, value, actor, reason) -> { ok, applied, needsApproval }
// actor: "user" | "ai". Locked keys: user applies directly, AI proposes only.
export function setKey(root, key, value, actor, reason) {
  if (!reason || !reason.trim()) return { ok: false, error: "reason required" };
  const locked = LOCKED_KEYS.has(key);
  if (locked && actor === "ai") {
    const proposal = {
      id: "prop-" + Date.now().toString(36),
      ts: new Date().toISOString(), key, value, reason,
      status: "pending"
    };
    const pp = proposalsPath(root);
    fs.mkdirSync(path.dirname(pp), { recursive: true });
    fs.appendFileSync(pp, JSON.stringify(proposal) + "\n", "utf8");
    logHistory(root, { kind: "proposal", key, value, actor, reason, id: proposal.id });
    return { ok: true, applied: false, needsApproval: true, id: proposal.id };
  }
  snapshotBefore(root, key);
  const p = userPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let user = {};
  try { user = readJson(p); } catch { user = {}; }
  const was = user[key];
  user[key] = value;
  fs.writeFileSync(p, JSON.stringify(user, null, 2) + "\n", "utf8");
  logHistory(root, { kind: "apply", key, was, now: value, actor, reason });
  return { ok: true, applied: true, needsApproval: false };
}

// applyProposal(root, id, actor) — only a human applies a proposal.
export function applyProposal(root, id, actor) {
  if (actor !== "user") return { ok: false, error: "proposals are applied by the user only" };
  const pp = proposalsPath(root);
  if (!fs.existsSync(pp)) return { ok: false, error: "no proposals" };
  const lines = fs.readFileSync(pp, "utf8").split("\n").filter(Boolean);
  let found = null;
  const rest = [];
  for (const l of lines) {
    const r = JSON.parse(l);
    if (r.id === id && r.status === "pending") found = r;
    else rest.push(l);
  }
  if (!found) return { ok: false, error: `no pending proposal ${id}` };
  const r = setKey(root, found.key, found.value, "user", `apply proposal ${id}: ${found.reason}`);
  fs.writeFileSync(pp, rest.length ? rest.join("\n") + "\n" : "", "utf8");
  return r;
}

export function listProposals(root) {
  const pp = proposalsPath(root);
  if (!fs.existsSync(pp)) return [];
  return fs.readFileSync(pp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}