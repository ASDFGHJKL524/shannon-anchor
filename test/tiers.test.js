// shannon-anchor — tier-aware index tests.
// The index must make tiers VISIBLE (a cold entry labelled is information;
// invisibly demoted is a trap) and cheap by default (a grown system must
// not blow up context just to list itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexOf } from "../lib/manual_store.js";

const manual = {
  root: "",
  entries: [
    { number: 1, title: "delete boundary", path: "01-rules/1.md", tier: 1, superseded: false },
    { number: 2, title: "backup self-heal", path: "01-rules/2.md", tier: 2, superseded: false },
    { number: 3, title: "long task timebox", path: "02-method/3.md", tier: 3, superseded: false },
    { number: 4, title: "superseded one", path: "04-experience/4.md", tier: 1, superseded: true }
  ]
};
const stats = { "1": { tier: 1, count: 8.4 }, "2": { tier: 2, count: 1.2 }, "3": { tier: 3, count: 0.3 }, "4": { tier: 1, count: 5 } };

test("default view shows active tier-1 only, so listing stays cheap", () => {
  const out = indexOf(manual, { stats });
  assert.match(out, /delete boundary/);
  assert.doesNotMatch(out, /long task timebox/, "cold entry not in the default shelf");
  assert.doesNotMatch(out, /superseded one/, "a retired entry is not advice; it stays off the default shelf");
  assert.match(out, /Showing 1 of 4/);
  assert.match(out, /1 retired .* hidden/, "the hiding is disclosed, not silent");
});

test("tiers=all shows everything, with tier and heat columns", () => {
  const out = indexOf(manual, { stats, tiers: "all" });
  assert.match(out, /long task timebox/);
  assert.match(out, /cold/);
  assert.match(out, /8\.4/, "heat is visible");
  assert.match(out, /Showing 4 of 4/);
});

test("a demoted entry is LABELED, not hidden", () => {
  const out = indexOf(manual, { stats, tiers: "all" });
  const row = out.split("\n").find((l) => l.includes("backup self-heal"));
  assert.match(row, /warm/, "tier-2 is labelled so the model knows to verify");
});

test("superseded entries keep their marker", () => {
  const out = indexOf(manual, { stats, tiers: "all" });
  assert.match(out, /~superseded~/);
});

test("no stats still renders (tier reads as hot, heat as dash)", () => {
  const out = indexOf(manual, { tiers: "all" });
  assert.match(out, /\| hot \|/);
  assert.match(out, /Showing 4 of 4/);
});

test("section filter still works across tiers", () => {
  const out = indexOf(manual, { stats, tiers: "all", section: "01-rules" });
  assert.match(out, /delete boundary/);
  assert.doesNotMatch(out, /long task timebox/);
  assert.match(out, /Showing 2 of 4/, "2 shown out of a 4-entry library; the count is the library size, not the filtered size");
});
