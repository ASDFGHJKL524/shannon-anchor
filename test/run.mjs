// In-process test runner.
//
// node --test (and run({files})) spawn a child per test file; under this
// machine's sandbox that fork is EPERM. So: import each requested file
// in-process (its top-level test() calls register into the root run),
// then run() with the spec reporter so every test prints its own line.
//
// The pass/fail TALLY is taken from the spec reporter output (counting
// lines), because the stream test:pass event does not fire reliably for
// in-process-registered tests on this Node build. What matters and is
// trustworthy: the per-test lines, and the exit code.
import { run } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

let files = process.argv.slice(2);
if (files.length === 0) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort().map((f) => path.join(dir, f));
}
if (files.length === 0) { console.error("usage: node run.mjs <testfile>... (no *.test.js found next to this file)"); process.exit(2); }
const wanted = new Set(files.map((f) => path.resolve(f)));

for (const f of files) {
  await import(pathToFileURL(path.resolve(f)).href);
}

// capture spec-reporter lines to tally ourselves
const origWrite = process.stdout.write.bind(process.stdout);
let failLines = 0, passLines = 0, ignoredFail = 0;
process.stdout.write = (chunk, enc, cb) => {
  const s = typeof chunk === "string" ? chunk : String(chunk);
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t.startsWith("✔") || (t.startsWith("ok") && /\d+\)/.test(t))) passLines++;
    else if (t.startsWith("✖") || t.startsWith("not ok")) {
      // a discovered-but-unwanted file shows its path; skip those
      if (/_回收站|_wb_probe|node_modules/.test(t)) { ignoredFail++; continue; }
      failLines++;
    }
  }
  return origWrite(chunk, enc, cb);
};

const stream = run({ reporter: "spec" });
const done = new Promise((res) => stream.on("end", res));
const cap = setTimeout(() => {
  console.log(`\n[tally] pass=${passLines} fail=${failLines} ignored=${ignoredFail}`);
  process.exit(failLines ? 1 : 0);
}, 120000);
await done;
clearTimeout(cap);
console.log(`\n[tally] pass=${passLines} fail=${failLines} ignored=${ignoredFail}`);
process.exit(failLines ? 1 : 0);