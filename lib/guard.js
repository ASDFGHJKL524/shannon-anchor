// shannon-anchor — the guard gates: write-guard and delete-guard.
//
// Write guard (soft-hard gate):
//   1. content is scanned for secret / injection patterns (scanner below)
//   2. metadata dates are refused if in the future (no force flag on purpose)
//   3. write + manifest update happen together; failure restores the original
//   Routed writes are logged and baseline-audited. An unrouted direct write
//   is caught at the next hash-chain self-check — "must leave a trace",
//   never "silently OK".
//
// Delete guard (three red lines, each from a real failure):
//   1. no wildcards — every target is named, never pattern-matched
//      (a "clean temp files" glob can silently remove dozens of unrecoverable files)
//   2. two-phase — preview first, apply with a token
//   3. quarantine, not destroy — deletes are reversible moves; permanent
//      destruction is a separate command with its own confirmation
//
// Neither gate is a hard gate against the agent itself. It can still write
// past them. Their value: everything routed through them is logged and
// reversible, and everything not routed leaves a trace at the next check.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---- content scanner (friction layer, not a security boundary) ----
// Catches copy-pasted secrets and obvious injection phrasing. It does NOT
// catch a determined attacker. Using it as cover ("I scanned it") is the
// same error as "this looks fine, record it".

const SECRET_PATTERNS = [
  [/\b(sk|pk|rk|ak)_[A-Za-z0-9_-]{16,}/, "api-key-shaped token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key block"],
  [/(password|passwd|pwd)\s*[:=]\s*["'][^"'\s]{6,}/i, "inline password"],
];

const INJECTION_PATTERNS = [
  [/\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i, "override-instruction phrasing"],
  [/\bdo\s+not\s+(tell|inform|mention)\s+(the\s+)?(user|human|operator)/i, "conceal-from-user phrasing"],
  [/\b(this|it)\s+is\s+(a\s+)?(standard|mandated|required)\s+(procedure|process|flow)/i, "authority-claim phrasing"],
];

export function scanContent(text) {
  for (const [re, why] of SECRET_PATTERNS) {
    if (re.test(text)) return { blocked: true, reason: `secret pattern: ${why}` };
  }
  for (const [re, why] of INJECTION_PATTERNS) {
    if (re.test(text)) return { blocked: true, reason: `injection pattern: ${why}` };
  }
  return { blocked: false };
}

// ---- write guard ----

function sha(data) { return crypto.createHash("sha256").update(data).digest("hex"); }

import { isFuture } from './entries.js';

export function guardedWrite(root, entry, { guard }) {
  // Metadata dates are recorded-at moments. A future one is a typo (or a
  // lie) and corrupts every decay computation downstream. Refused on
  // write, no force flag on purpose.
  if (isFuture(entry.created)) {
    throw new Error(`metadata date is in the future: ${entry.created} (no force flag by design)`);
  }
  const dir = path.join(root, "manual");
  const target = path.join(dir, entry.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const content = entry.lines.join("\n");
  const existed = fs.existsSync(target);
  const original = existed ? fs.readFileSync(target) : null;
  const tmp = target + ".write-tmp";
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, target);
    if (guard) {
      const manifest = path.join(root, "memory.json");
      let m = {};
      if (fs.existsSync(manifest)) {
        try { m = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { m = {}; }
      }
      m[entry.path] = {
        number: entry.number, sha256: sha(content),
        bytes: Buffer.byteLength(content, "utf8"),
        source: entry.source, created: entry.created,
        confidence: entry.confidence
      };
      fs.writeFileSync(manifest, JSON.stringify(m, null, 2), "utf8");
    }
    return { path: entry.path, bytes: Buffer.byteLength(content, "utf8") };
  } catch (e) {
    try {
      if (existed && original) fs.writeFileSync(target, original);
      else if (fs.existsSync(target)) fs.unlinkSync(target);
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch { /* best effort restore */ }
    throw e;
  }
}

// ---- delete guard ----
// preview returns a token; apply requires the same target list + reason + token.
// Tokens are deterministic on (targets + reason) so a stale preview can be
// matched; they expire (tokens are also one-shot).

const QUARANTINE = "_quarantine";
const tokens = new Map(); // token -> { targets, reason, created }

function normalize(p) { return path.resolve(p); }

export function guardedDeletePreview(root, targets, reason) {
  if (!reason || !reason.trim()) return { ok: false, reason: "reason required: say why before deleting" };
  const resolved = targets.map(normalize);
  for (const t of resolved) {
    if (t === path.parse(t).root) return { ok: false, reason: `refusing root: ${t}` };
    if (!fs.existsSync(t)) return { ok: false, reason: `does not exist: ${t}` };
    if (!t.startsWith(normalize(root))) return { ok: false, reason: `outside manual root: ${t}` };
  }
  if (resolved.length > 10) return { ok: false, reason: `too many targets (${resolved.length} > 10): split into smaller batches` };
  const token = crypto.createHash("sha256").update(resolved.join("|") + reason).digest("hex").slice(0, 12);
  tokens.set(token, { targets: resolved, reason, created: Date.now() });
  return { ok: true, token, count: resolved.length, bytes: targets.reduce((a, t) => a + safeSize(t), 0) };
}

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

export function guardedDeleteApply(root, targets, reason, token) {
  const rec = tokens.get(token);
  if (!rec) return { ok: false, reason: "unknown or used token — run a fresh preview" };
  if (Date.now() - rec.created > 30 * 60_000) {
    tokens.delete(token);
    return { ok: false, reason: "token expired (>30 min) — preview again" };
  }
  if (rec.reason !== reason || rec.targets.join("|") !== targets.map(normalize).join("|")) {
    return { ok: false, reason: "token does not match this target list + reason" };
  }
  tokens.delete(token); // one-shot

  const qroot = path.join(root, QUARANTINE);
  const batch = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + token;
  const dest = path.join(qroot, batch);
  fs.mkdirSync(path.join(dest, "files"), { recursive: true });

  const items = [];
  rec.targets.forEach((t, i) => {
    const name = path.basename(t).replace(/[^\w.\-]/g, "_").slice(0, 60) || "item";
    const to = path.join(dest, "files", `${String(i + 1).padStart(3, "0")}-${name}`);
    try {
      fs.renameSync(t, to);
      items.push({ original: t, quarantined: path.relative(dest, to), bytes: safeSize(to) });
    } catch (e) {
      items.push({ original: t, error: String(e.message || e) });
    }
  });
  fs.writeFileSync(path.join(dest, "manifest.json"),
    JSON.stringify({ batch, created: new Date().toISOString(), reason, items }, null, 2), "utf8");
  return { ok: true, batch, dest, items };
}

// convenience: single-call delete that must be previewed first
export function guardedDelete(root, target, reason) {
  const prev = guardedDeletePreview(root, [target], reason);
  if (!prev.ok) return prev;
  return guardedDeleteApply(root, [target], reason, prev.token);
}