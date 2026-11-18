// shannon-anchor — hash chain: the only hard gate.
//
// A manifest of SHA256 over every chained file, plus two independent
// readers. It proves "something changed" — never "this change was wrong".
// That is a half solution and the docs say so: an agent editing its own
// files moves the hash with the content and still reports "pass". A true
// gate needs the manifest somewhere the agent cannot write — at the cost
// of the agent no longer being able to record anything on its own.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function sha256File(p) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex").toUpperCase();
}

export function chainFile(root) { return path.join(root, "chain.txt"); }

// sections: [{ name, files: [absolute paths] }]
export function computeChain(root, sections) {
  const lines = ["shannon-anchor hash chain", ""];
  for (const s of sections) {
    lines.push(`[${s.name}]`);
    for (const f of s.files) {
      if (!fs.existsSync(f)) { lines.push(`MISSING ${f}`); continue; }
      const st = fs.statSync(f);
      lines.push(`${sha256File(f)}  ${st.size}  ${path.relative(root, f)}`);
    }
    lines.push("");
  }
  const text = lines.join("\n") + "\n";
  fs.writeFileSync(chainFile(root), text, "utf8");
  return { text, path: chainFile(root) };
}

export function verifyChain(root) {
  const cf = chainFile(root);
  if (!fs.existsSync(cf)) return { ok: false, reason: "no chain file — run a sync first" };
  const recorded = new Map();
  for (const line of fs.readFileSync(cf, "utf8").split(/\r?\n/)) {
    const m = /^([0-9A-F]{64})\s+(\d+)\s+(.+)$/.exec(line);
    if (m) recorded.set(m[3], { sha: m[1], size: Number(m[2]) });
  }
  const problems = [];
  for (const [rel, rec] of recorded) {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) { problems.push(`missing: ${rel}`); continue; }
    const st = fs.statSync(f);
    if (st.size !== rec.size) problems.push(`size changed: ${rel}`);
    else if (sha256File(f) !== rec.sha) problems.push(`content changed: ${rel}`);
  }
  return { ok: problems.length === 0, problems, checked: recorded.size };
}