// shannon-anchor — plugin entry (host half)
//
// It does not evolve the model. It makes every appearance of the model
// stand on the shoulders of all past experience.
//
// Registers, in order:
//   1. tools: memory_recall / memory_list / memory_write / memory_curate (manual retrieval + guarded write + shape layer)
//   2. tools/pre-execute interception: delete/write actions hit the guard first
//   3. host.promptSection(): dynamic "go check the manual" hints
//
// All state lives in files under cfg.manualRoot; this process holds no
// private data. The guard is a *soft-hard* gate: routed writes are logged
// and baseline-audited; unrouted direct writes are caught at the next
// self-check (see hash_chain.js). It is not a hard gate against the agent
// itself — the hash chain is the only hard gate, and it too only proves
// "something changed", not "this change was wrong".
//
// Design red lines (kept from the field-tested system this distills):
//   - history only grows: superseded entries are marked, never deleted
//   - nothing is written without provenance (source + created)
//   - the guard never silently overwrites: baselines are explicit
//   - "half solution" is stated in docs, never dressed up as "solved"

// defineTool comes from the DSH host. Importing it eagerly makes this
// module untestable outside DSH (ERR_MODULE_NOT_FOUND on any bare node
// run) — so the dependency is injected. In DSH it resolves to the real
// defineTool; in tests callers pass a stub. This is the host-coupling
// seam the design doc calls for: one import, one injection point, the
// rest of apply() runs anywhere.
let defineTool;
try {
  ({ defineTool } = await import("@deepseek-ai/dsh-tools"));
} catch {
  defineTool = null; // host absent: tests inject their own via apply(opts)
}
import fs from "node:fs";
import { search, haystackOf } from "./retrieval.js";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// 包根目录：focus 的 engine 和状态文件都在包里（与旧 dsh-focus-mode 一致）。
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import { loadManual, readEntry, indexOf, writeIndex, loadManualWithBodies, manualDir, manualStamp } from "./manual_store.js";
import { computeChain, verifyChain } from "./hash_chain.js";
import { parseEntry, nextFreeNumber } from "./entries.js";
import { guardedWrite, guardedDelete, scanContent } from "./guard.js";
import { DEFAULT_TRIGGERS, matchTriggers, composeInjection } from "./triggers.js";
import { needsBootstrap, bootstrapPrompt, identityPath } from "./bootstrap.js";
import { statsPath, sweep, markLowFrequency, listForgotten, recallForgotten, countUsage, DEMOTE_DAYS } from "./forget.js";
import { scan as scanRedundancy, formatSummary as formatRedundancySummary, formatReport as formatRedundancyReport } from "./redundancy.js";
import { loadConfig, setKey, applyProposal, listProposals, LOCKED_KEYS } from "./config.js";
import { createScheduler, queueTurn, pendingTurns, clearPending, turnPreview, expireTurns } from "./distill.js";
import { suggest, linkEntry, appendToEntry, promoteEntry, candidates, unlinkEntry, demoteEntry, rewriteEntry, tagEntry, retitleEntry, markWrongEntry, markLocalJudged, clearLocalJudged, BAND_SIMILAR } from "./curate.js";
import { checkIntegrity, blocksWrite, needsReview } from "./integrity.js";
import { makeEmbedder } from "./embedding.js";
import { record as recordMetrics, readEvents, aggregate, diagnose, writeSummary, textId } from "./metrics.js";
import { personaRecall, personaStatus, renderCase, packDir } from "./persona.js";
import { buildSection as buildPrediction } from "./predict.js";
import { captureFromMessages, listPending, listCases, confirmPending, dropPending, voicePrompt, expirePending } from "./voice.js";
import { evictionStats } from "./eviction.js";
import { queueReview, reserveReview, commitReview, releaseReview, listReview, decideReview, reviewStats, reviewPrompt } from "./review.js";
import { judgeEntry, renderVerdict } from "./localjudge.js";
import { resolveHost, writeHostReport } from "./host.js";
import { moduleCatalog, summaryText } from "./usage-index.js";
import { stats as queueStats } from "./queue.js";
import { installLoopGuard } from "./loop-guard.js";
import { installCoreGuard } from "./core-guard.js";
import { installFocus } from "./focus.js";
import { loadRules, loadRulesHot, matchByKeywords, lastUserText, renderHint, judgeCommand51 } from "./experience-router.js";
import { recordMiss, maybeAutofill } from "./experience-autofill.js";
import { currentSessionId, shortSessionId } from "./session-id.js";

// Destructive-command patterns, matched against ANY tool's args. This is
// the "judge the action, not the knife" list: a generic shell tool running
// any of these against the manual root is blocked (and quarantined only when
// the caller declared the target itself).
// The sanctioned delete script's own name is deliberately NOT in this list.
// Matching it hijacked the script's own invocations: the guard quarantined a
// path it had merely extracted from the command text and then refused to run
// the command, so a file vanished that nobody was deleting (2026-10-19, twice:
// entry #128 disappeared mid-diagnosis, a cleanup batch lost its 2nd target).
// `--purge` stays — that flag really destroys, and blocking it is the point.
const DESTRUCTIVE_RE = /remove-item|\brmdir\b|\bdel\b|\brm\s+-|unlinksync|fs\.unlink|\bunlink\s|--purge|shutil\.rmtree|os\.remove/i;

// argsText: whatever shape exec.args arrives in, get searchable text.
// Never throws — an interceptor that crashes would be worse than one that
// misses.
function argsText(args) {
  try {
    if (typeof args === "string") return args;
    return JSON.stringify(args ?? {});
  } catch {
    return String(args ?? "");
  }
}

// extractPathFromCommand: pull a filesystem path out of a shell command.
// Handles quoted and unquoted Windows/posix paths. Returns null when it
// cannot pin one — "cannot tell" is a valid and safe answer; the caller
// refuses rather than guessing.
function extractPathFromCommand(cmd) {
  if (!cmd) return null;
  // quoted paths first (they may contain spaces)
  const quoted = /"([A-Za-z]:\\[^"]+|\/[^"]+)"|'([A-Za-z]:\\[^']+|\/[^']+)'/.exec(cmd);
  if (quoted) return quoted[1] || quoted[2];
  // unquoted: run of non-space chars that looks like a path
  const bare = /(?:^|\s)([A-Za-z]:\\[^\s"']+|\/[^\s"']+)/.exec(cmd);
  if (bare) return bare[1].replace(/[),;]+$/, "");
  return null;
}

// auditGuard: append one line per guard decision (quarantine OR refusal).
//
// Why this exists: the logger writes to the host console, which is not
// persisted. On 2026-10-19 a file was quarantined and the ONLY evidence left
// was a manifest saying reason "no reason given" — no tool name, no command
// text, no args. Working out which call did it took half an hour of guessing
// and produced two wrong theories (first "curate changed the section", then
// "a read-only call matched a destructive keyword").
//
// A guard that cannot explain itself after the fact is a guard you cannot
// debug. This file is append-only, stores tool + args + target + batch, and
// never throws: a failure to log must not become a failure to protect.
function auditGuard(root, rec) {
  try {
    const dir = path.join(root, "guard");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "audit.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...rec, args: argsText(rec.args).slice(0, 400) }) + "\n", "utf8");
  } catch { /* audit is best-effort; the guard already acted */ }
}

export const name = "shannon-anchor";
export const inject = ["tools", "systemPrompt"];

// The host's SECTION_ORDERS table has no slot for a third-party memory
// plugin; use explicit finite orders. Bootstrap/trigger sit after team
// policy and before PTC; the resident hint sits after file references
// and before the first tool guide.
const SECTION_ORDER = {
  identity: 645,
  // 核心区告警排在身份之后：真出事的时候，先让模型看到这一条。
  coreAlert: 646,
  // 经验提醒紧跟其后：动手前先知道这条任务踩过什么坑。
  experience: 647,
  bootstrap: 650,
  // 用法速查紧跟初始化：先知道每个部分怎么调，再谈这一轮要做什么。
  usage: 655,
  trigger: 660,
  voice: 943,
  review: 944,
  distill: 945,
  hint: 950
};

// 核心区看门狗把告警写在这里（~/.dsh/core-guard/state/last-alert.json）。
// 有新告警就在系统提示里提一句——不弹窗，不打扰（默认无感运行）。
const CORE_ALERT_FILE = path.join(os.homedir(), ".dsh", "core-guard", "state", "last-alert.json");

function readCoreAlert(root) {
  try {
    if (!fs.existsSync(CORE_ALERT_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(CORE_ALERT_FILE, "utf8"));
    if (!raw || typeof raw.at !== "string") return null;
    // 同一条告警只提一次：记到 guard\alert-seen.json
    const seenPath = path.join(root, "guard", "alert-seen.json");
    let seenAt = null;
    try { seenAt = JSON.parse(fs.readFileSync(seenPath, "utf8")).at; } catch { }
    if (seenAt === raw.at) return null;
    try {
      fs.mkdirSync(path.dirname(seenPath), { recursive: true });
      fs.writeFileSync(seenPath, JSON.stringify({ at: raw.at, seenAt: new Date().toISOString() }), "utf8");
    } catch { }
    return raw;
  } catch {
    return null;
  }
}

// Instruction numbers are stable semantic ids. The resident prompt carries
// only this tiny table; the library holds the entries. A trigger line is
// just "按指令 N", so the table has to be visible for the number to mean
// anything.
//
// v2 (定制版 2026-10-18): the prompt must say which ENTRY NUMBER to recall,
// not which path. The old text said "read the matching 01-rules/N.md", which
// pointed at the wrong file entirely once the migrated manual took numbers
// 1-8 for its own entries. Instruction 5 now reads "recall #95".
const INSTRUCTION_TABLE = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("./instructions.json", import.meta.url), "utf8"));
  } catch {
    return null;
  }
})();

// entryNumbers(instruction) -> [entry numbers] — an instruction may point at
// more than one entry (e.g. instruction 9: the machine-facts table plus the
// current ComfyUI snapshot). entryNumberOf keeps the first for the trigger
// line; the table line lists them all so none is silently dropped.
function entryNumbers(instruction) {
  const rec = INSTRUCTION_TABLE && INSTRUCTION_TABLE.instructions
    ? INSTRUCTION_TABLE.instructions[String(instruction)]
    : null;
  const list = rec && Array.isArray(rec.entries) ? rec.entries : [];
  return list
    .map((e) => (e && Number.isFinite(Number(e.number)) ? Number(e.number) : null))
    .filter((n) => n !== null);
}

// entryNumberOf(instruction) -> entry number, or null when the table does
// not carry one (v1 tables, hand-edited tables).
function entryNumberOf(instruction) {
  const nums = entryNumbers(instruction);
  return nums.length ? nums[0] : null;
}

const INSTRUCTION_NUMBERS = INSTRUCTION_TABLE && INSTRUCTION_TABLE.instructions
  ? Object.entries(INSTRUCTION_TABLE.instructions)
      .map(([n, v]) => {
        const nums = entryNumbers(n);
        return nums.length ? `${n}=${v.desc}(${nums.map((x) => `条目 #${x}`).join("、")})` : `${n}=${v.desc}`;
      }).join("；")
  : "";

// The one line a trigger sends. Old text was "按指令 N" plus a separate
// sentence elsewhere spelling out 01-rules/N.md; that split is what let the
// path go stale. Now the line itself names both numbers.
function triggerLineFor(instruction) {
  const nums = entryNumbers(instruction);
  return nums.length
    ? `按指令 ${instruction}（memory_recall ${nums.join("、")}）`
    : `按指令 ${instruction}`;
}

const DEFAULTS = {
  manualRoot: "~/.dsh/shannon-anchor",
  guardWrites: true,
  guardDeletes: true,
  injectManualHints: true,
  // 定制版（2026-10-18）：identity.md 不只是「bootstrap 跑过了」的标记，
  // 它的正文会被注入系统提示。上游只拿它当存在性开关，内容从不进 prompt，
  // 于是「不骗用户 / 坏消息先说 / 删东西先问」这些底线实际上没生效。
  // 关掉这个开关只是少一段常驻提示，手册检索和两道守卫不受影响。
  injectIdentity: true,
  coldConfirmedDays: 30,
  staleConfirmedDays: 90,
  coldInferredDays: 15,
  staleInferredDays: 45,
  // Predictive recall is OFF by default in the shipped config: a wrong
  // prediction is worse than a missing one (it teaches the reader to skip the
  // section). Watch the `predict` events in memory_metrics before trusting it.
  //
  // floor 0.46 keeps every labelled-good turn firing at 307 entries; 0.47 was
  // re-chosen on 2026-11-01 after corpus growth pushed four of them under it (see
  // predict.js for the table and a labeled check for the measurement). turns 1 is
  // the correction documented at CONTEXT_TURNS — 2 re-poisons a greeting with the
  // previous turn's topic.
  predict: {
    enabled: false,
    floor: 0.46,
    limit: 3,
    turns: 1,
    english: false
  },
  triggers: null, // null = DEFAULT_TRIGGERS; user overrides in cordis.patch.yml
  // voice: the case library for HOW something was said. Capture only queues a
  // candidate; nothing becomes a case until it is confirmed. The 60-line digest
  // is a VIEW cap — the jsonl keeps every case.
  // Off by default: it stores the user's own sentences, so the user turns it on.
  voice: {
    enabled: false,
    maxPending: 8,
    maxLines: 60,
    promptMaxAgeHours: 24
  }
};

// identityText: the identity file's own words, verbatim, for the prompt.
// Never throws — a broken identity file must not stop the plugin from
// loading; it degrades to "no identity text" and says so in the log.
function identityText(root) {
  try {
    const pd = packDir(root);
    const p = pd ? path.join(pd, "identity.md") : identityPath(root);
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

function loadStatsSafe(root) {
  try {
    const p = statsPath(root);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function resolveRoot(root) {
  if (!root) root = DEFAULTS.manualRoot;
  if (root.startsWith("~")) root = path.join(os.homedir(), root.slice(1));
  return path.resolve(root);
}

// layerConfig(base, over): one level of deep merge for object-valued keys.
// Arrays and scalars replace wholesale (a triggers list is a list, not a
// bag of keys to patch). Used for DEFAULTS <- apply() config <- user.json,
// so a caller may set one key of predict without losing the other three.
function layerConfig(base, over) {
  const out = { ...base };
  if (!over || typeof over !== "object" || Array.isArray(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined || v === null) continue;
    const b = base[k];
    if (v && typeof v === "object" && !Array.isArray(v) &&
        b && typeof b === "object" && !Array.isArray(b)) {
      out[k] = { ...b, ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

// apply(ctx, config, opts?) — opts.defineTool lets a test (or another
// host adapter) inject the tool factory. Without it and without a host,
// a passthrough stub is used: the tool still registers, execute() is
// reachable, schema validation is skipped. Good enough to exercise
// wiring; the real validation lives in the host.
function passthroughDefineTool(def) {
  return { ...def, __passthrough: true };
}

// normalizeTool: the host-absent fallback must still emit a real JSON Schema.
// The shorthand `parameters: { field: { type, required, description } }` only
// becomes valid JSON Schema once the host's defineTool reshapes it. Passed
// through raw, the wire request carries `parameters` with no top-level
// `type: "object"` (and per-property `required: false`, also illegal), so the
// official API rejects every turn at step 1:
//   HTTP 400 INVALID_REQUEST — "Invalid schema for function 'memory_config'".
function normalizeTool(def) {
  const p = def && def.parameters;
  if (!p || typeof p !== "object" || p.type === "object" || p.properties) {
    return def;
  }
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(p)) {
    const { required: isReq, ...rest } = v || {};
    properties[k] = { type: "string", ...rest };
    if (isReq === true) required.push(k);
  }
  const parameters = { type: "object", properties };
  if (required.length) parameters.required = required;
  return { ...def, parameters, __normalized: true };
}

// ---- hash chain wiring ----
// computeChain/verifyChain existed but were never called: chain.txt was
// never written and the "hard gate" was dead code. The chain covers every
// .md under manual/ (not just parseable entries — a corrupted file is
// exactly what it must catch) plus the state files.
function chainSections(root) {
  const files = [];
  const mdir = path.join(root, "manual");
  if (fs.existsSync(mdir)) {
    for (const sec of fs.readdirSync(mdir).sort()) {
      const d = path.join(mdir, sec);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d).sort()) {
        if (f.endsWith(".md")) files.push(path.join(d, f));
      }
    }
  }
  const sections = [{ name: "manual", files }];
  const state = [];
  for (const f of ["memory.json", "identity.md"]) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) state.push(p);
  }
  if (state.length) sections.push({ name: "state", files: state });
  return sections;
}

function refreshChain(root, logger) {
  try {
    computeChain(root, chainSections(root));
  } catch (e) {
    // This was a log line and nothing else: the hard gate the whole system leans
    // on could drift with no counter moving. The "chain" kind already exists and
    // aggregate() counts ok:false as chainFailures, so one row makes the failure
    // visible to memory_metrics instead of only to whoever read the console.
    recordMetrics(root, "chain", { ok: false, stage: "refresh" });
    logger.warn(`shannon-anchor: hash chain refresh failed: ${String(e.message || e)}`);
  }
}

// Prediction reads every entry body, and loading that corpus costs ~18 ms of
// stat/read syscalls on the live 179-entry manual — before EVERY model step.
// Within one turn the corpus does not change, so keep it between steps and
// revalidate with manualStamp() instead of the full walk. The age cap bounds
// how long an unrouted edit (one that bypasses chain.txt) can stay invisible
// to prediction; every entry-reading TOOL still goes to the files directly.
//
// Keyed by root as well: two apply() instances (tests, a sandbox copy) must
// never score each other's library.
const PREDICT_CORPUS_TTL = 60_000;
let predictCorpus = null;

function predictionEntries(root) {
  const stamp = manualStamp(root);
  const at = Date.now();
  if (
    predictCorpus &&
    predictCorpus.root === root &&
    predictCorpus.stamp === stamp &&
    at - predictCorpus.at < PREDICT_CORPUS_TTL
  ) {
    return predictCorpus.entries;
  }
  const manual = loadManual(root);
  const entries = manual.entries.length ? loadManualWithBodies(manual).entries : [];
  predictCorpus = { root, stamp, at, entries };
  return entries;
}

export function apply(ctx, config, opts = {}) {
  // 宿主适配层（lib/host.js，2026-11-17）：接口按候选名探测。改名能自动接上；
  // 缺了什么会点名报出来，并写 runtime/host-report.json 留痕。参数形状和事件语义
  // 的变化它挡不住——那种只能靠 test/ 的回归和人去改。默认不抛：一个降级的插件
  // 好过整个 DSH 起不来；strictHost 给测试用。
  const host = resolveHost(ctx, opts);

  const DT = opts.defineTool || defineTool || normalizeTool;
  // 工具名收集起来给用法速查用：加一个工具，速查里的计数和文档自动跟上。
  const registeredTools = [];
  const tool = (def) => {
    if (def && def.name) registeredTools.push(def.name);
    return host.registerTool(DT(def));
  };
  // Shallow replacement of a nested block would drop its sibling defaults:
  // { predict: { enabled: true } } must not erase floor/limit/turns.
  const cfg = layerConfig(DEFAULTS, config);
  const rules = Array.isArray(cfg.triggers) && cfg.triggers.length ? cfg.triggers : DEFAULT_TRIGGERS;
  const root = resolveRoot(cfg.manualRoot);
  fs.mkdirSync(root, { recursive: true });
  writeHostReport(root, host.report);

  const logger = host.logger;
  logger.info(`shannon-anchor: manual root = ${root}`);

  // ---- user config overrides the shipped defaults ----
  // conf/default.json <- conf/user.json is the user's tuning surface. A
  // broken file fails loud upstream (config.js) but a missing one is fine:
  // the plugin still runs on DEFAULTS.
  //
  // Precedence is DEFAULTS <- apply() config <- user.json, and this must use
  // loadConfig().user (the raw override file), never .config: .config is the
  // merged VIEW, and layering it here would put every shipped default back on
  // top of the caller's values — the host config and every test would be
  // silently ignored. user.json still wins, because memory_config writes it.
  let userCfg = null;
  try {
    userCfg = loadConfig(root).user;
  } catch (e) {
    logger.warn(`shannon-anchor: config load failed, running on defaults: ${String(e.message || e)}`);
  }

  // ---- embedding backend: memory_search's semantic half ----
  // retrieval.js stays synchronous (predict.js runs on every model step and
  // cannot await), but memory_search precomputes vectors with this embedder and
  // hands them to search(). Predictions keep the local hash vector on purpose.
  const embeddingCfg = { ...(cfg.embedding || {}), ...(userCfg?.embedding || {}) };
  const embedder = makeEmbedder(embeddingCfg);
  if (embedder.name !== "local") {
    logger.info(`shannon-anchor: embedding backend = ${embedder.name} (${embeddingCfg.model || embeddingCfg.command || "?"}) — memory_search uses it, predict stays local`);
  }
  if (embedder.stats.fallbacks > 0) {
    logger.warn(`shannon-anchor: embedding config ignored — ${embeddingCfg.backend} is not a known backend, using local`);
  }
  // 0.3 in retrieval.js is calibrated for 256-dim character-hash NOISE: two
  // texts sharing zero tokens still land near 0.08–0.3. Real embeddings put
  // unrelated text around 0.2–0.4 and related text around 0.5+, so reusing 0.3
  // would let topical noise through. 0.4 is a starting point, not measured on
  // this corpus yet — lower it if genuine paraphrases go missing.
  const SEMANTIC_COSINE_FLOOR = 0.4;

  // Integrity thresholds resolve the same way: shipped default <- user.json.
  const integrityCfg = { ...(cfg.integrity || {}), ...(userCfg?.integrity || {}) };

  // ---- predictive recall: push instead of pull ----
  // Every other recall path waits for the model to decide it should look.
  // That fails exactly when memory matters most: the model does not know it has
  // forgotten something. This reads the CURRENT turn's own words and names the
  // entries that bear on it, so the number is already in front of it.
  //
  // It names entries; it never injects their text (that would undo the index /
  // library cost split). And it is silent by default: a predictor that fires
  // every turn trains the reader to skip the section, which costs more than
  // never predicting at all.
  //
  // Off unless enabled: a wrong prediction is more annoying than a missing one,
  // and silence is the correct failure mode.
  const predictCfg = { ...(cfg.predict || {}), ...(userCfg?.predict || {}) };
  const predictOn = predictCfg.enabled === true;

  // ---- voice cases: how something was said ----
  // Same transcript cache, different question: distillation asks what is worth
  // remembering; this asks which of the user's corrections was about wording.
  // Capture runs at turn end and only queues a candidate — nothing enters the
  // library until the agent confirms it. Off unless the user turns it on: the
  // record keeps the user's own sentences verbatim.
  const voiceCfg = { ...(cfg.voice || {}), ...(userCfg?.voice || {}) };
  const voiceOn = voiceCfg.enabled === true;

  // ---- experience-router: task → manual entry ----
  // Off unless enabled. 2026-11-02: three same-root mistakes in one night
  // (5.1 BOM, mojibake read, mojibake argv) — every one was already in the
  // manual, none was looked up. A soft rule that depends on remembering to
  // check is not a gate; this makes the lookup mechanical.
  const experienceCfg = { ...(cfg.experience || {}), ...(userCfg?.experience || {}) };

  // Observe mode (plan §2C): time-based expiry records what it WOULD have done
  // and changes nothing. Cap eviction is unaffected — see lib/eviction.js for
  // why that one still happens.
  const evictCfg = { ...(cfg.evict || {}), ...(userCfg?.evict || {}) };
  const observeOn = evictCfg.observe === true;

  // The after-write review queue (plan §2A). Queueing is cheap; the prompt block
  // is switchable on its own so it can be silenced without losing the ledger.
  const reviewCfg = { ...(cfg.review || {}), ...(userCfg?.review || {}) };
  const reviewOn = reviewCfg.enabled !== false;
  const reviewInject = reviewCfg.inject !== false;

  // ---- loop-guard: 思维链复读止损 ----
  // 订阅 agent/assistant-stream，检测 thinking 里的 n-gram 循环，命中后
  // cancel + followup。默认开；阈值保守，宁可漏一次不误杀。
  const loopCfg = { ...(cfg.loopGuard || {}), ...(userCfg?.loopGuard || {}) };
  try {
    installLoopGuard(ctx, { root, cfg: loopCfg, logger });
  } catch (e) {
    logger.warn(`shannon-anchor: loop-guard install failed: ${String(e.message || e)}`);
  }

  // ---- core-guard: 核心区写入白名单（dry-run） ----
  // 注意：必须注册在删除守卫的 tools/pre-execute 监听之后。
  // 宿主按注册顺序链式调用；测试桩按数组下标取处理器，顺序错了
  // 会把删除守卫的断言打乱（2026-11-01 全量测试 10 项失败的原因）。
  // 具体安装在文件后半段（删除守卫之后）。
  const coreCfg = { ...(cfg.coreGuard || {}), ...(userCfg?.coreGuard || {}) };
  if (!Array.isArray(coreCfg.paths) || coreCfg.paths.length === 0) {
    coreCfg.paths = [root];
  }

  // The host hands the current messages to agent/pre-step; this cache is how
  // the prompt section (which is rendered separately) gets to see them.
  let lastMessages = null;
  let lastPrediction = null;
  // Metrics count DECISIONS, not steps. A turn with ten tool calls asks the
  // same question ten times; recording each step would inflate predictFired
  // and make the noise ratio meaningless. One record per distinct prediction.
  let lastMetricPrediction = null;

  // ---- forgetting: one sweep per day ----
  // The tiers only move when something asks them to. Without this call the
  // forgetting engine is a rule set nobody executes (the exact failure mode
  // this system exists to avoid). Sweeping is cheap: it reads stats.json and
  // compares dates. It never deletes bytes; at worst it parks an entry in
  // forgotten/ where it can be recalled.
  try {
    const stats = loadStatsSafe(root);
    const last = stats && stats._swept;
    const today = new Date().toISOString().slice(0, 10);
    if (last !== today) {
      const manual = loadManual(root);
      const res = sweep(root, manual, {
        byConfidence: {
          "user-confirmed": {
            tier1_to_2: userCfg?.coldConfirmedDays ?? cfg.coldConfirmedDays,
            tier2_to_3: userCfg?.staleConfirmedDays ?? cfg.staleConfirmedDays
          },
          "agent-inferred": {
            tier1_to_2: userCfg?.coldInferredDays ?? cfg.coldInferredDays,
            tier2_to_3: userCfg?.staleInferredDays ?? cfg.staleInferredDays
          }
        }
      });
      if (res.demoted.length || res.forgotten.length) {
        // The sweep used to move tiers without telling anyone. On the live
        // manual 16 entries sat in tier 2 while memory_metrics reported
        // "0 forget events — nothing has been demoted yet". A measurement that
        // misses the event it claims to count is worse than no measurement.
        recordMetrics(root, "forget", {
          demoted: res.demoted.length,
          parked: res.forgotten.length,
          toWarm: res.demoted.filter((d) => d.to === 2).length,
          toCold: res.demoted.filter((d) => d.to === 3).length
        });
        logger.info(`shannon-anchor: forgetting sweep — demoted ${res.demoted.length}, forgotten ${res.forgotten.length}`);
      }
    }
  } catch (e) {
    logger.warn(`shannon-anchor: forgetting sweep skipped: ${String(e.message || e)}`);
  }

  // ---- candidate window: candidates that outlived the 45-day rule ----
  // Rule #98/#71: not promoted in 45 days -> candidate elimination, ask the
  // user. This only REPORTS; nothing is removed automatically.
  try {
    const manual = loadManual(root);
    const staleDays = userCfg?.staleInferredDays ?? cfg.staleInferredDays ?? 45;
    const all = candidates(manual, { days: staleDays });
    const stale = all.filter((c) => c.stale);
    if (stale.length) {
      logger.warn(`shannon-anchor: ${stale.length} candidate(s) older than ${staleDays} days: ${stale.map((c) => `#${c.number}(${c.days}d)`).join(", ")}`);
    }
    const promoteHeat = userCfg?.candidatePromoteHeat ?? cfg.candidatePromoteHeat ?? 3;
    const hot = all.filter((c) => !c.stale && c.heat >= promoteHeat);
    if (hot.length) {
      logger.info(`shannon-anchor: ${hot.length} candidate(s) hot enough to promote (heat >= ${promoteHeat}): ${hot.map((c) => `#${c.number}(heat ${c.heat})`).join(", ")}`);
    }
    const autoPromote = (userCfg?.candidateAutoPromote ?? cfg.candidateAutoPromote) === true;
    if (autoPromote && hot.length) {
      const promoted = [];
      for (const c of hot) {
        // evidence starts with "auto:" so the head shows the machine did it
        const r = promoteEntry(root, c.number, { evidence: `auto: heat ${c.heat} >= ${promoteHeat} at boot` });
        if (r.ok) promoted.push(c.number);
        else logger.warn(`shannon-anchor: auto-promote #${c.number} skipped: ${r.reason}`);
      }
      if (promoted.length) {
        logger.info(`shannon-anchor: auto-promoted ${promoted.length} candidate(s): ${promoted.map((n) => `#${n}`).join(", ")}`);
      }
    }
  } catch (e) {
    logger.warn(`shannon-anchor: candidate window check skipped: ${String(e.message || e)}`);
  }

  // ---- hash chain: verify the baseline, then re-anchor ----
  // Verify reports drift that happened while the plugin was not running
  // (direct file edits, restore operations, a delete that skipped the
  // guard). Re-anchoring afterwards is deliberate: the chain proves
  // "something changed since the last look", it cannot judge the change.
  try {
    const v = verifyChain(root);
    if (!v.ok && v.problems && v.problems.length) {
      logger.warn(`shannon-anchor: hash chain problems (${v.problems.length}): ${v.problems.slice(0, 5).join("; ")}${v.problems.length > 5 ? "; ..." : ""}`);
    }
  } catch (e) {
    logger.warn(`shannon-anchor: hash chain verify skipped: ${String(e.message || e)}`);
  }
  refreshChain(root, logger);

  // ---- bootstrap: the first time the system grows ----
  // Only when identity.md does not exist. The section is registered once;
  // its text resolves to "" as soon as the identity file lands, so the
  // prompt cost disappears without a restart. Never overwrite what the
  // user has built.
  if (needsBootstrap(root)) {
    logger.info("shannon-anchor: no identity yet — bootstrap prompt enabled");
  }
  try {
    host.promptSection({
      name: "shannon-anchor-bootstrap",
      order: SECTION_ORDER.bootstrap,
      interpolate: false,
      text: () => (needsBootstrap(root) ? bootstrapPrompt(root) : "")
    });
  } catch (e) {
    logger.warn(`shannon-anchor: bootstrap injection failed: ${String(e.message || e)}`);
  }

  // ---- usage: 每个部分怎么调用，常驻 ----
  // 动机：工具四十多个、
  // 模块三十几个，调用方式和边界散在手册里，每次都要靠回忆拼。这一节常驻，只放
  // "要干什么 → 找哪个工具"，细节仍走 memory_recall。
  // 模块清单在启动时从各文件头注释扫一次（不是每次渲染）：加模块写清头注释，重启即收录。
  const moduleList = moduleCatalog();
  try {
    host.promptSection({
      name: "shannon-anchor-usage",
      order: SECTION_ORDER.usage,
      interpolate: false,
      text: () => summaryText({ tools: registeredTools, modules: moduleList })
    });
  } catch (e) {
    logger.warn(`shannon-anchor: usage injection failed: ${String(e.message || e)}`);
  }

  // ---- identity: the persona, in the prompt ----
  // 2026-11-15 起人格住在人格包里（<runtime>/packs/<active>/identity.md），
  // 底线和操作规矩在全局 AGENTS.md；这里只注入人格，不重复底线。
  // 没有 active 包时退回旧的 <runtime>/identity.md。
  //
  // It reads the file on every render (not once at boot) so switching packs
  // or editing identity.md takes effect without a restart, same as bootstrap.
  // The prompt cost is bounded by the file, which the user owns.
  if (cfg.injectIdentity) {
    try {
      host.promptSection({
        name: "shannon-anchor-identity",
        order: SECTION_ORDER.identity,
        interpolate: false,
        text: () => {
          const t = identityText(root);
          if (!t) return "";
          return ["# 人格（来自人格包）", "", t, "",
            "人格来自人格包；底线和操作规矩在全局常驻文件里。两处冲突时以用户当次说的为准。"].join("\n");
        }
      });
    } catch (e) {
      logger.warn(`shannon-anchor: identity injection failed: ${String(e.message || e)}`);
    }
  }

  // ---- tools ----

  tool({
    name: "memory_list",
    description: "List the persistent memory manual index (numbered entries, one-line summaries, section paths). Use this first to locate an entry number before memory_recall.",
    parameters: {
      section: { type: "string", description: 'Optional section filter: "01-rules", "02-method", "03-machine", "04-experience". Omit for all.' },
      tiers: { type: "string", description: 'Tier filter: "1" (default, active only; retired entries hidden) or "all" (include warm/cold and retired entries).' },
      detail: { type: "boolean", description: "Return path/tier/heat columns. Default returns number + title only, which is enough to pick an entry to recall." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || "empty" }]
    },
    execute: async (args) => {
      const manual = loadManual(root);
      const tiers = args.tiers === "all" ? "all" : "1";
      const text = indexOf(manual, { section: args.section || null, tiers, stats: loadStatsSafe(root), compact: args.detail !== true });
      return { text, count: manual.entries.length };
    }
  });

  // ---- memory_search: find entries by meaning, not by browsing ----
  // Browsing the index costs context proportional to the library size.
  // Search costs proportional to what you asked for. As the library grows,
  // search is the difference between a usable system and a wall of text.
  tool({
    name: "memory_search",
    description: "Search the persistent memory manual by keywords or meaning (BM25 + embeddings when an embedding backend is configured, local feature-hash vector otherwise; Chinese bigram aware). Use this BEFORE memory_list when the library is large, or when you know WHAT you need but not which entry holds it. Returns ranked entry numbers with match reasons; then memory_recall the one you want.",
    parameters: {
      query: { type: "string", required: true, description: "What you are looking for, e.g. '删除 备份 密码' or 'G drive write permission'." },
      limit: { type: "number", description: "Max results (default 8)." },
      includeCold: { type: "boolean", description: "Also return cold-tier (demoted) entries. Default true — cold entries are ranked lower but never hidden." },
      includeSuperseded: { type: "boolean", description: "Also search retired entries (superseded / merged_into). Default false: a retired conclusion is wrong advice, not just weak evidence." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || "no match" }]
    },
    execute: async (args) => {
      const manual = loadManual(root);
      // Bodies are where the topic words usually live; retrieval indexes them
      // now. With metadata only, "删除守卫怎么用" cannot reach rule #91 — its
      // title says 删除与不可逆操作的边界 and 守卫 appears in the body alone.
      // One body load per search call (manual_store caches each file by stat).
      const corpus = manual.entries.length ? loadManualWithBodies(manual) : manual;
      const stats = loadStatsSafe(root);
      const includeSuperseded = args.includeSuperseded === true;
      // Semantic path. The embedder caches per text (LRU 2000), so only the
      // first search after a restart pays for the whole corpus; later calls
      // embed the query plus whatever changed. A failed batch degrades the
      // WHOLE call to local vectors — never a ranking that mixes two spaces.
      let queryVector;
      let docVectors;
      let degraded = false;
      if (embedder.semantic && corpus.entries.length > 0 && args.query.trim()) {
        const callsBefore = embedder.stats.calls;
        const started = Date.now();
        const batch = await embedder.embedBatch([args.query, ...corpus.entries.map(haystackOf)]);
        const embedded = embedder.stats.calls - callsBefore;
        if (embedded >= 20) logger.info(`shannon-anchor: embedded ${embedded} text(s) in ${Date.now() - started} ms`);
        degraded = batch.degraded;
        if (!degraded) {
          queryVector = batch.vectors[0];
          docVectors = batch.vectors.slice(1);
        }
      }
      const all = search(corpus.entries, args.query, {
        limit: args.limit || 8,
        minScore: args.includeCold === false ? 0.15 : 0.05,
        stats,
        includeSuperseded,
        queryVector,
        docVectors,
        // 本对话用过的条目排前面（2026-11-02 分对话热度）。
        sessionId: currentSid,
        cosineFloor: embedder.semantic && !degraded ? SEMANTIC_COSINE_FLOOR : undefined
      });
      const degradedNote = degraded
        ? `\n\n> Semantic backend failed (${embedder.stats.lastError}); this search used the local hash vector.`
        : "";
      recordMetrics(root, "search", { hits: all.length, q: args.query, embedding: embedder.name, degraded });
      const retired = includeSuperseded ? 0 : manual.entries.filter((e) => e.superseded).length;
      const retiredNote = retired
        ? `\n${retired} retired entries are not searched. Pass includeSuperseded: true to see them — lineage only, do not act on them.`
        : "";
      if (all.length === 0) {
        return { text: `no match for "${args.query}". Try broader words, or memory_list to browse.${retiredNote}${degradedNote}`, count: 0 };
      }
      // Dates belong in the row: a high-scoring entry written months ago and
      // never read is a hypothesis, while one recalled yesterday is current
      // practice. Without a date the reader cannot tell the two apart.
      const lastUsedOf = (entry) => {
        const s = stats && stats[String(entry.number)];
        return (s && s.lastUsed) || entry.lastUsed || "—";
      };
      const lines = all.map((r) =>
        `| ${r.entry.number} | ${r.entry.superseded ? "~superseded~ " : ""}${r.entry.wrong ? "~wrong~ " : ""}${r.entry.title} | ${r.tier === 1 ? "hot" : r.tier === 2 ? "warm" : r.tier === 3 ? "cold" : "forgotten"} | ${r.entry.created || "—"} | ${lastUsedOf(r.entry)} | ${r.score.toFixed(3)} | ${r.why} | \`${r.entry.path}\` |`);
      const engine = embedder.semantic && !degraded ? ` · embeddings: ${embeddingCfg.model || embedder.name}` : "";
      const text = [
        `Matches for "${args.query}" (ranked, best first${engine}):`,
        "",
        "| # | summary | tier | written | last used | score | via | path |",
        "|---|---|---|---|---|---|---|---|",
        ...lines,
        "",
        `Use memory_recall <n> for the full text of any row above.${degradedNote}`
      ].join("\n");
      return { text, count: all.length, top: all[0].entry.number };
    }
  });

  tool({
    name: "memory_recall",
    description: "Retrieve the FULL original text of one persistent-memory entry by its number. Use it whenever you need the detail behind an index line, instead of guessing from the summary.",
    parameters: {
      number: { type: "number", required: true, description: "The entry number from the manual index." },
      full: { type: "boolean", description: "Return the full body. Default truncates at 1500 chars to save tokens; pass true when the detail matters." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || String(value.error || "not found") }]
    },
    execute: async (args) => {
      const manual = loadManual(root);
      const entry = readEntry(manual, Number(args.number));
      if (!entry) return { error: `no entry #${args.number}. Run memory_list to see what exists.` };
      recordMetrics(root, "recall", { id: textId(`${entry.title}\n${entry.body}`), number: entry.number });
      // Capture state BEFORE this recall: countUsage() resets the tier to hot,
      // so reading it afterwards would always print "hot" and tell the reader
      // nothing about how settled or stale the entry was.
      const before = (loadStatsSafe(root) || {})[String(entry.number)] || {};
      const beforeTier = before.tier || 1;
      const tierName = beforeTier === 1 ? "hot" : beforeTier === 2 ? "warm" : beforeTier === 3 ? "cold" : "forgotten";
      const lastUsedBefore = before.lastUsed || entry.lastUsed || "never";
      // Being referenced is the ONLY signal the forgetting engine has;
      // without this the tiers never update. Counted after a successful hit.
      let cur = null;
      try { cur = countUsage(root, entry.number, { sessionId: currentSid }); } catch { /* stats are best-effort */ }
      let note = "";
      // A retired entry can still be recalled by number (people cite old ids),
      // so the body must arrive with its status attached. Without this the
      // caller reads a conclusion that has already been replaced as current.
      let retiredNote = "";
      if (entry.superseded) {
        const succ = entry.supersededBy ? `#${entry.supersededBy}` : "更新的条目";
        retiredNote = `\n\n[已作废] 这条已被 ${succ} 取代（${entry.linkKind}）。以下正文只是历史记录，不要照着做${entry.supersededBy ? `；现行做法请 memory_recall ${entry.supersededBy}` : ""}。`;
      }
      // wrong（2026-11-03）：被推翻的结论。和 superseded 不同——superseded 是
      // "有更新版本"，wrong 是"这条本身错了"。正文保留只为追溯，不要照着做。
      let wrongNote = "";
      if (entry.wrong) {
        wrongNote = `\n\n[已推翻] 这条结论被标记为错误${entry.wrongReason ? `（${entry.wrongReason}）` : ""}。不要照着做；正文保留只为追溯。`;
      }
      // A distilled draft sitting next to the entry changes how it should be
      // read: the draft is the short form, the entry is the full record. Say
      // so on every recall — otherwise the draft is invisible and the entry
      // keeps costing its full length. The draft is never auto-loaded: it is
      // a proposal until someone promotes it (see tools/distill_entry.mjs).
      let draftNote = "";
      try {
        const draftPath = path.join(manualDir(root), entry.path + ".draft");
        if (fs.existsSync(draftPath)) {
          const dBytes = fs.statSync(draftPath).size;
          draftNote = `\n\n[有蒸馏草稿] 同目录存在 ${entry.path}.draft（${dBytes} B，本条目 ${entry.bytes} B）。草稿是最简可用表述，本文件是完整记录；确认草稿够用后再决定是否替换，未确认前以本文件为准。`;
        }
      } catch (e) {
        // Swallowing this silently cost five wrong guesses on 2026-10-19
        // (manualDir was not imported; the empty catch hid it and every
        // theory about caching/config looked equally plausible). A failure
        // here is cosmetic, but it must leave a trace someone can find.
        logger.warn(`shannon-anchor: draft lookup failed for #${entry.number}: ${String(e.message || e)}`);
      }
      if (/<!--\s*候选:/.test(entry.body)) {
        const heat = cur ? Math.round((cur.count || 0) * 10) / 10 : 0;
        const promoteHeat = userCfg?.candidatePromoteHeat ?? cfg.candidatePromoteHeat ?? 3;
        const auto = (userCfg?.candidateAutoPromote ?? cfg.candidateAutoPromote) === true;
        if (auto && heat >= promoteHeat) {
          const pr = promoteEntry(root, entry.number, { evidence: `auto: heat ${heat} >= ${promoteHeat} at recall` });
          if (pr.ok) {
            refreshChain(root, logger);
            note = `\n\n[候选 → 自动转正] 热度 ${heat} 越过阈值 ${promoteHeat}，已写 promoted (auto)。`;
          } else {
            note = `\n\n[候选 · 热度 ${heat}] 自动转正被拒：${pr.reason}`;
          }
        } else {
          note = `\n\n[候选 · 热度 ${heat}] 这条还没转正。按它做对一次就 memory_curate promote（带证据）；45 天没转正进淘汰审查。`;
        }
      }
      // 本地判卷的条目带 <!-- 待复核 --> 标记（2026-11-17）：裁决来自本机小模型，
      // 还没人核对过内容。recall 是天然的核查时机——读到正文的人正好能判断它对不对，
      // 所以标记在这里露出来，摘除动作就是确认。
      if (/<!--\s*待复核:/.test(entry.body)) {
        const m = /<!--\s*待复核:\s*(.+?)\s*-->/.exec(entry.body);
        note += `\n\n[待复核] 这条的裁决来自本地模型（${m ? m[1] : "未知"}），还没有人核对过内容。核对正文：对得上就 memory_curate action=verified target=${entry.number} 摘掉标记；不对就改它或 markWrong。`;
      }
      // The body used to arrive with no title, date or status: a reader could
      // not tell an entry written yesterday from one written last month, nor
      // whether it was cold or current. One header line fixes that cheaply.
      const header = `#${entry.number} · ${entry.title}\nwritten ${entry.created || "unknown"} · last used ${lastUsedBefore} · ${tierName}${entry.superseded ? " · retired" : ""}${entry.wrong ? " · wrong" : ""}\n\n`;
      // Token 瘦身（2026-11-03）：默认截断 1500 字。大部分条目够用，
      // 要看全文加 full: true。截断必须显式说明，否则读者以为这就是全文。
      const RECALL_LIMIT = 1500;
      const bodyText = args.full === true || entry.body.length <= RECALL_LIMIT
        ? entry.body
        : entry.body.slice(0, RECALL_LIMIT) + `\n\n[已截断：全文 ${entry.body.length} 字。要看全文加 full: true]`;
      return { text: header + bodyText + retiredNote + wrongNote + note + draftNote, title: entry.title, path: entry.path, draft: draftNote ? true : false, superseded: entry.superseded === true, wrong: entry.wrong === true, truncated: bodyText !== entry.body };
    }
  });

  tool({
    name: "memory_write",
    description: "Write a new numbered entry into the persistent memory manual. Goes through the write guard: content is scanned (secret/injection patterns), provenance is required, and the hash-chain baseline is updated in one transaction. Use for durable, reusable experience — not for one-off scratch notes.",
    parameters: {
      title: { type: "string", required: true, description: "Entry title, e.g. 'G drive writes are mine to handle'." },
      body: { type: "string", required: true, description: "Entry body: what was found, why it matters, what to do next time." },
      source: { type: "string", required: true, description: "Where this came from: a task, a measurement, a person's words. Required — no source, no write." },
      confidence: { type: "string", description: 'user-confirmed | agent-inferred (default agent-inferred).' },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "3-8 场景触发词，覆盖'以后会怎么问起这件事'。例：游戏 卡顿 性能 显卡。标签和标题同权重参与检索，让'用词不同但场景相同'的查询也能命中。"
      }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || String(value.error || "failed") }]
    },
    execute: async (args) => {
      if (cfg.guardWrites) {
        const scan = scanContent(args.body);
        if (scan.blocked) {
          return { error: `write guard blocked: ${scan.reason}` };
        }
      }
      const manual = loadManual(root);

      // Integrity screen: the write guard answers "is this safe to store"; this
      // answers "should this be believed". Runs before anything is written.
      //   accept -> proceed silently
      //   review -> proceed, but the response carries the reasons
      //   reject -> do not write; the caller sees why
      // The thresholds are unmeasured starting points (see integrity.js), so a
      // rejection is reported with its signals rather than hidden.
      let integrity = null;
      try {
        integrity = checkIntegrity(
          { title: args.title, body: args.body, source: args.source },
          {
            entries: manual.entries,
            similarity: integrityCfg.similarity,
            thresholds: {
              review: integrityCfg.reviewThreshold,
              reject: integrityCfg.rejectThreshold
            }
          }
        );
        recordMetrics(root, "integrity", {
          verdict: integrity.verdict,
          risk: integrity.risk,
          signals: integrity.signals.map((s) => s.kind)
        });
        if (blocksWrite(integrity)) {
          return {
            error: `integrity screen rejected this write: ${integrity.reason}`,
            integrity
          };
        }
      } catch (e) {
        logger.warn(`shannon-anchor: integrity screen skipped: ${String(e.message || e)}`);
      }
      // Advisory shape check: does this look like something already in the
      // manual? It never blocks — the write proceeds — but the response
      // carries the evidence, so "new entry vs merge/link" is decided with
      // it in view instead of after a duplicate already exists.
      let similar = null;
      try {
        const adv = suggest(`${args.title}\n${args.body}`, manual);
        if (adv && adv.action === "drop") {
          similar = { action: "drop", hint: `identical to an existing entry: ${adv.reason}`, rows: [] };
        } else {
          const near = (adv.top || []).filter((t) => t.score >= BAND_SIMILAR).slice(0, 3);
          if (near.length) similar = { action: adv.action, hint: adv.hint || "", rows: near };
        }
      } catch (e) {
        logger.warn(`shannon-anchor: write advisory skipped: ${String(e.message || e)}`);
      }
      const num = nextFreeNumber(manual);
      const date = new Date().toISOString().slice(0, 10);
      const conf = args.confidence === "user-confirmed" ? "user-confirmed" : "agent-inferred";
      const entry = parseEntry({
        number: num,
        title: args.title.trim(),
        body: args.body.trim(),
        source: args.source.trim(),
        created: date,
        confidence: conf,
        tags: Array.isArray(args.tags) ? args.tags : []
      });
      // Phase 4: review is required post-processing. Reserve the slot before the
      // write; a full queue refuses the write instead of writing and dropping
      // the review on the floor.
      let reviewSlot = null;
      if (reviewOn) {
        const slot = reserveReview(root, {
          number: num,
          title: entry.title,
          body: entry.body,
          source: entry.source
        }, { maxPending: reviewCfg.maxPending });
        if (!slot.ok) {
          return { error: `review queue full (${slot.outstanding}/${slot.max}); decide the pending reviews first (memory_review action=list)` };
        }
        reviewSlot = slot.queue_id;
      }
      try {
        const written = guardedWrite(root, entry, { guard: cfg.guardWrites });
        if (reviewSlot) {
          try { commitReview(root, reviewSlot); } catch (e) {
            logger.warn(`shannon-anchor: review commit failed: ${String(e.message || e)}`);
          }
        }
        refreshChain(root, logger);
        recordMetrics(root, "write", { id: textId(`${entry.title}\n${entry.body}`), number: num });
        logger.info(`shannon-anchor: wrote entry #${num} (${written.bytes} B)`);
        const advice = similar
          ? "\n\n写前形状检查（仅供参考，不阻断）：" + (similar.hint || "") +
            (similar.rows.length ? "\n" + similar.rows.map((r) => `- #${r.number} ${r.title} — ${r.score}`).join("\n") : "")
          : "";
        // A review verdict still wrote the entry; say so, with the reasons.
        // Silence here would make the screen invisible until it rejects.
        const warn = integrity && needsReview(integrity)
          ? `\n\n完整性筛查（已写入，但请复核）：${integrity.reason}`
          : "";
        // 写入后检索相关条目（2026-11-03）：把 top 5 摆给调用者看，不自动判断
        // 冲突——判断交给人。检索用混合（BM25+向量），和 memory_search 同一套。
        // 排除刚写入的这条自己，否则它永远排第一。
        let related = null;
        try {
          const fresh = loadManual(root);
          const corpus = fresh.entries.length ? loadManualWithBodies(fresh) : fresh;
          const hits = search(corpus.entries.filter((e) => e.number !== num), `${args.title} ${args.body}`, { limit: 5, minScore: 0.05 });
          if (hits.length) {
            related = hits.map((r) => ({ number: r.entry.number, title: r.entry.title, score: Number(r.score.toFixed(3)) }));
          }
        } catch (e) {
          logger.warn(`shannon-anchor: post-write related lookup skipped: ${String(e.message || e)}`);
        }
        const relatedNote = related && related.length
          ? "\n\n相关条目（自己判断有没有冲突/重复，不自动改）：\n" + related.map((r) => `- #${r.number} ${r.title} — ${r.score}`).join("\n")
          : "";
        return { text: `entry #${num} written: ${entry.path}${advice}${warn}${relatedNote}`, number: num, path: entry.path, similar, related, integrity };
      } catch (e) {
        if (reviewSlot) {
          try { releaseReview(root, reviewSlot); } catch { /* best-effort */ }
        }
        return { error: `write failed: ${String(e.message || e)}` };
      }
    }
  });


  // ---- memory_rewrite: promote a distilled draft over its entry ----
  // The only sanctioned overwrite path in an append-only system. It exists
  // because #128 grew to 13 KB through merges: compression needs replacement,
  // and replacement needs backup + validation + audit, which rewriteEntry wraps.
  tool({
    name: "memory_rewrite",
    description: "Replace an entry's file with its distilled draft (<n>.md.draft, generated by tools/distill_entry.mjs). The original is backed up under <root>/backup first, the manifest and hash chain are refreshed, and the draft is consumed. Refuses when no draft exists, the draft is not shorter, or its first line does not carry the same entry number. Evidence is required.",
    parameters: {
      number: { type: "number", required: true, description: "Entry number whose draft should be promoted." },
      evidence: { type: "string", required: true, description: "What was checked against the original before replacing it." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || String(value.error || "failed") }]
    },
    execute: async (args) => {
      if (cfg.guardWrites) {
        // Scan the draft BEFORE it can overwrite anything: the draft is a
        // file on disk that never passed the write guard when it was created.
        try {
          const manual = loadManual(root);
          const hit = manual.entries.find((e) => e.number === Number(args.number));
          if (hit) {
            const dp = path.join(manualDir(root), hit.path + ".draft");
            if (fs.existsSync(dp)) {
              const scan = scanContent(fs.readFileSync(dp, "utf8"));
              if (scan.blocked) return { error: `write guard blocked the draft: ${scan.reason}` };
            }
          }
        } catch (e) {
          return { error: `draft scan failed: ${String(e.message || e)}` };
        }
      }
      const res = rewriteEntry(root, args.number, { evidence: args.evidence });
      if (!res.ok) return { error: res.reason };
      refreshChain(root, logger);
      recordMetrics(root, "rewrite", { number: Number(args.number) });
      logger.info(`shannon-anchor: rewrote ${res.path} (${res.bytes} B, backup ${res.backup})`);
      return {
        text: `#${args.number} rewritten from its draft: ${res.path} is now ${res.bytes} B. Original backed up at ${res.backup}. Draft consumed, chain refreshed.`,
        ...res
      };
    }
  });


  // ---- memory_curate: shape layer (self-stacking, phase 1) ----
  // suggest = read-only recommendation. link = the only phase-1 write: one
  // metadata marker in the target entry's head; prose is never touched.
  tool({
    name: "memory_curate",
    description: "Shape layer for a write decision. action=suggest (default, READ-ONLY): given candidate text, returns a table of the most similar entries with scores and a suggested action (merge / supersede / conflict / new). action=link: records a human decision as a metadata marker (superseded_by | merged_into) on the target entry — never edits prose, requires evidence. action=merge: appends the candidate text to the target entry as a dated block (the merge write path; original prose untouched). action=promote: removes the 候选 marker and sets last-used to today after the entry proved itself; evidence required. action=unlink: reverts the last link marker with a link_reverted marker (append-only, reason required). action=demote: revokes a promotion by appending a demoted note plus a fresh 候选 line (reason required). action=wrong: marks an entry as refuted — retrieval down-weights it and injection skips it; reason required. action=retitle: rewrites only the title line (body untouched) for entries whose body was corrected but whose title still states the old conclusion; evidence required. All write actions refresh the hash chain. Thresholds are unmeasured starting points; treat suggestions as input to judgment, not verdicts.",
    parameters: {
      action: { type: "string", description: "suggest (default) | link | merge | promote | tag | wrong | retitle | verified" },
      text: { type: "string", description: "Candidate text to judge (suggest) or to append (merge)." },
      target: { type: "number", description: "Entry number (link / merge / promote / tag / verified)." },
      newNumber: { type: "number", description: "The entry it points to (link)." },
      kind: { type: "string", description: "superseded_by (default) | merged_into (link)." },
      tags: { type: "array", items: { type: "string" }, description: "场景标签（tag）：3-8 个触发词，覆盖'以后会怎么问起这件事'。已有标签会被替换。" },
      evidence: { type: "string", description: "Why the two are related (link) / how it proved itself (promote) / block source (merge) / why the old title is stale (retitle)" },
      title: { type: "string", description: "retitle 时的新标题（只改标题行，正文不动）" }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || JSON.stringify(value, null, 2) }]
    },
    execute: async (args) => {
      try {
        if (!args.action || args.action === "suggest") {
          const manual = loadManual(root);
          const r = suggest(args.text, manual);
          if (r.action === "reject") return { error: r.reason };
          return { ...r, text: r.table ? [r.hint, "", r.table].join("\n") : (r.reason || "no suggestion") };
        }
        if (args.action === "link") {
          const r = linkEntry(root, {
            target: args.target,
            newNumber: args.newNumber,
            kind: args.kind,
            evidence: args.evidence
          });
          if (!r.ok) return { error: r.reason };
          refreshChain(root, logger);
          logger.info(`shannon-anchor: linked #${args.target} -> #${args.newNumber} (${r.marker})`);
          return { ...r, text: `#${args.target} marked ${r.marker} — ${r.path}` };
        }
        if (args.action === "merge") {
          const r = appendToEntry(root, args.target, args.text, { source: args.evidence });
          if (!r.ok) return { error: r.reason };
          refreshChain(root, logger);
          logger.info(`shannon-anchor: merged into #${args.target} (${r.bytes} B)`);
          return { ...r, text: `merged into #${args.target} — ${r.path} (${r.bytes} B)` };
        }
        if (args.action === "retitle") {
          const r = retitleEntry(root, args.target, { title: args.title, evidence: args.evidence });
          if (!r.ok) return { error: r.reason };
          refreshChain(root, logger);
          logger.info(`shannon-anchor: retitled #${args.target}`);
          return { ...r, text: `#${args.target} 标题已改为「${r.title}」— ${r.path}（原文件备份 ${r.backup}）` };
        }
        if (args.action === "verified") {
          const r = clearLocalJudged(root, args.target, { by: args.evidence || "agent" });
          if (!r.ok) return { error: r.reason };
          refreshChain(root, logger);
          logger.info(`shannon-anchor: 摘除 #${args.target} 的待复核标记`);
          return { ...r, text: `#${args.target} 已复核，待复核标记已摘除 — ${r.path}` };
        }
        if (args.action === "tag") {
          const r = tagEntry(root, args.target, args.tags);
          if (!r.ok) return { error: r.reason };
          refreshChain(root, logger);
          logger.info(`shannon-anchor: tagged #${args.target} (${r.tags.join(",")})`);
          return { ...r, text: `#${args.target} tagged: ${r.tags.join(", ")} — ${r.path}` };
        }
        if (args.action === "promote") {
          const r = promoteEntry(root, args.target, { evidence: args.evidence });
          if (!r.ok) return { error: r.reason };
          refreshChain(root, logger);
          logger.info(`shannon-anchor: promoted #${args.target}`);
          return { ...r, text: `#${args.target} promoted (${r.promoted}) — candidate marker removed` };
        }
        if (args.action === "unlink") {
          const r = unlinkEntry(root, { number: args.target, reason: args.evidence });
          if (!r.ok) return { error: r.reason };
          refreshChain(root, logger);
          logger.info(`shannon-anchor: reverted link on #${args.target}`);
          return { ...r, text: `#${args.target} link reverted (${r.marker}) — ${r.path}` };
        }
        if (args.action === "demote") {
          const r = demoteEntry(root, { number: args.target, reason: args.evidence });
          if (!r.ok) return { error: r.reason };
          refreshChain(root, logger);
          logger.info(`shannon-anchor: demoted #${args.target}`);
          return { ...r, text: `#${args.target} demoted (${r.demoted}) — candidate marker restored` };
        }
        if (args.action === "wrong") {
          const r = markWrongEntry(root, { number: args.target, reason: args.evidence });
          if (!r.ok) return { error: r.reason };
          refreshChain(root, logger);
          logger.info(`shannon-anchor: marked #${args.target} wrong`);
          return { ...r, text: `#${args.target} marked wrong (${r.marker}) — ${r.path}` };
        }
        return { error: `unknown action: ${args.action}` };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    }
  });


  // ---- memory_distill: end-of-turn queue (mode=turn) ----
  // The queue holds previews, not transcripts: the transcript is the
  // agent's own context on the following turn. Clearing archives the batch.
  tool({
    name: "memory_distill",
    description: "Inspect or clear the end-of-turn distillation queue (enabled with distill.mode=turn). action=status lists waiting turns; action=skip clears the batch after judging it worthless; action=done clears it after writing entries. Clearing archives the batch to distill/cleared.jsonl — nothing is dropped silently. reason is required for skip/done.",
    parameters: {
      action: { type: "string", required: true, description: "status | skip | done | evicted" },
      reason: { type: "string", description: "Why the batch is cleared (required for skip/done)." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || JSON.stringify(value, null, 2) }]
    },
    execute: async (args) => {
      try {
        if (args.action === "status") {
          // No timer: the plugin has no reliable background, and a scheduler that
          // silently stops running is worse than no scheduler at all.
          try {
            expireTurns(root, Date.now(), {
              expireDays: evictCfg.distillExpireDays,
              observe: observeOn
            });
          } catch { /* a failed sweep must not break status */ }
          const items = pendingTurns(root);
          const queue = queueStats(root, "distill");
          if (!items.length) return { text: "no queued turns", count: 0, queue };
          const rows = items.map((x, i) => `- ${i + 1}. ${x.ts} · ${x.chars} chars · ${x.preview.replace(/\s+/g, " ").slice(0, 120)}`);
          return {
            text: ["Queued turns (preview only; the transcript is your own context):", "", ...rows].join("\n"),
            count: items.length,
            queue
          };
        }
        if (args.action === "evicted") {
          const st = evictionStats(root);
          const lines = [
            `voice evicted ${st.voice.n} ${JSON.stringify(st.voice.byReason)}`,
            `distill evicted ${st.distill.n} ${JSON.stringify(st.distill.byReason)}`,
            `observe ${st.observe.n} ${JSON.stringify(st.observe.byWhat)}`
          ];
          const last = st.voice.last || st.distill.last || st.observe.last;
          if (last) lines.push(`last: ${JSON.stringify(last)}`);
          return { text: lines.join("\n"), stats: st };
        }
        if (args.action === "skip" || args.action === "done") {
          if (!args.reason || !args.reason.trim()) return { error: "reason required: say why the batch is cleared" };
          const r = clearPending(root, { reason: args.reason.trim(), kind: args.action });
          return { text: `cleared ${r.cleared} queued turn(s) (${args.action})`, cleared: r.cleared };
        }
        return { error: `unknown action: ${args.action}` };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    }
  });


  // ---- memory_review: the after-write verdict path (plan §2A) ----
  //
  // The verdict is advisory. Nothing here deletes, merges or edits an entry —
  // the agent that wrote it executes the decision, and the reviewer never
  // touches manual/. A resolution step with write access would be a second,
  // unaudited write path.
  tool({
    name: "memory_review",
    description: "写后复查队列：列出待复查的写入、落裁决、看账。裁决只是建议，不会删改手册条目。复查者应当是不带本场对话上下文的另一个会话。",
    parameters: {
      action: { type: "string", required: true, description: "list | judge | confirm | stats" },
      id: { type: "string", description: "待复查 id（confirm 必填；judge 用它定位）" },
      number: { type: "number", description: "judge 时按条目号定位，id 与 number 二选一" },
      verdict: { type: "string", description: "keep | merge | drop | wrong（confirm 必填）。drop=不值得留；wrong=内容错了，会真的标到条目上" },
      into: { type: "number", description: "verdict=merge 时合并进哪一条（条目号）" },
      reason: { type: "string", description: "一句理由，记进 decided.jsonl" },
      regret: { type: "boolean", description: "事后发现这条其实该留，用于统计误拦" },
      local: { type: "boolean", description: "confirm 时给条目打「待复核」标记：裁决来自本地模型，等 recall 时人工核对过再摘" }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || JSON.stringify(value, null, 2) }]
    },
    execute: async (args) => {
      try {
        if (args.action === "list") {
          const items = listReview(root);
          if (!items.length) return { text: "no pending reviews", count: 0 };
          const rows = items.map((x) => `- ${x.id}｜#${x.number} ${x.title}｜${x.at}`);
          return {
            text: ["Pending reviews (title only; read the entry with memory_recall):", "", ...rows].join("\n"),
            count: items.length
          };
        }
        if (args.action === "stats") {
          const st = reviewStats(root);
          const queue = queueStats(root, "review");
          const merged = { ...st, queue };
          return { text: JSON.stringify(merged, null, 2), stats: merged };
        }
        if (args.action === "judge") {
          const items = listReview(root);
          const target = args.id
            ? items.find((x) => x.id === args.id)
            : Number.isInteger(args.number)
              ? items.find((x) => x.number === args.number)
              : null;
          if (!target) {
            return { error: `待复查队列里没有 ${args.id || (Number.isInteger(args.number) ? "#" + args.number : "该条目")}。先 memory_review list。` };
          }
          const r = await judgeEntry(root, target.number);
          return { text: renderVerdict(r), judge: r, review_id: target.id };
        }
        if (args.action === "confirm") {
          const r = decideReview(root, {
            id: args.id,
            verdict: args.verdict,
            into: Number.isInteger(args.into) ? args.into : null,
            reason: args.reason || "",
            regret: args.regret === true
          });
          if (!r.ok) return { error: r.error };
          const line = r.verdict === "merge" ? `merge -> #${r.into}` : r.verdict;
          // wrong：不只是记账，还要真把条目隔离（检索降权、注入跳过、正文保留追溯）。
          // 记账和改条目是两件事，标失败必须说出来，不能记了账当没发生。
          let wrongMark = "";
          if (r.verdict === "wrong") {
            const w = markWrongEntry(root, { number: r.number, reason: args.reason });
            if (w.ok) {
              wrongMark = "｜已标 wrong（检索降权、不再注入）";
              try { refreshChain(root, logger); } catch { /* 链刷新失败不挡裁决 */ }
            } else {
              wrongMark = `｜标 wrong 失败：${w.reason}`;
            }
          }
          // local=true：这个裁决是本地模型给的，条目要带待复核标记，等 recall 时核对。
          let mark = "";
          if (args.local === true) {
            const m = markLocalJudged(root, r.number, { verdict: r.verdict, into: r.into });
            if (m.ok) {
              mark = "｜已打待复核标记";
              try { refreshChain(root, logger); } catch { /* 链刷新失败不挡裁决 */ }
            } else {
              mark = `｜打标记失败：${m.reason}`;
            }
          }
          return { text: `${r.id} #${r.number}: ${line}${r.regret ? "（记为误拦）" : ""}${wrongMark}${mark}`, decision: r };
        }
        return { error: `unknown action: ${args.action}` };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    }
  });

  // ---- memory_config: the AI-facing tuning path ----
  tool({
    name: "memory_config",
    description: "Read or tune this memory system's configuration. Locked keys (guardWrites, guardDeletes) can only be PROPOSED by you and applied by the user; thresholds and paths you may set directly. Every change requires a reason and is logged.",
    parameters: {
      action: { type: "string", required: true, description: "read | set | propose | apply | list-proposals" },
      key: { type: "string", description: "Config key, e.g. coldInferredDays or manualRoot." },
      value: { type: "string", description: "New value as JSON (string/number/boolean/array/object)." },
      reason: { type: "string", description: "Why this change. Required for set/propose." },
      id: { type: "string", description: "Proposal id (for apply)." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || JSON.stringify(value, null, 2) }]
    },
    execute: async (args) => {
      try {
        if (args.action === "read") {
          const { config, sources } = loadConfig(root);
          const keyInfo = args.key ? { key: args.key, value: config[args.key], source: sources[args.key], locked: LOCKED_KEYS.has(args.key) } : null;
          return { text: JSON.stringify({ config, sources, ...(keyInfo ? { requested: keyInfo } : {}) }, null, 2), config, sources };
        }
        if (args.action === "list-proposals") {
          const list = listProposals(root);
          return { text: list.length ? JSON.stringify(list, null, 2) : "no pending proposals", proposals: list };
        }
        if (args.action === "apply") {
          const r = applyProposal(root, args.id, "user");
          return r.ok ? { text: `proposal ${args.id} applied` } : { error: r.error };
        }
        if (args.action === "set" || args.action === "propose") {
          if (!args.key) return { error: "key required" };
          let value;
          try { value = args.value === undefined ? null : JSON.parse(args.value); }
          catch { return { error: "value must be valid JSON" }; }
          const r = setKey(root, args.key, value, "ai", args.reason || "");
          if (!r.ok) return { error: r.error };
          if (r.needsApproval) {
            return { text: `locked key — proposal ${r.id} created. The user must apply it; it is NOT in effect yet.`, needsApproval: true, id: r.id };
          }
          return { text: `set ${args.key} applied`, key: args.key, value };
        }
        return { error: `unknown action: ${args.action}` };
      } catch (e) {
        return { error: `config failed: ${String(e.message || e)}` };
      }
    }
  });

  // ---- memory_forget: make the tier system visible and steerable ----
  //
  // The three-tier engine runs on its own (daily sweep at boot), but a
  // model that cannot SEE the tiers cannot use them: it will not know an
  // entry is cold, cannot mark a seasonal lesson as low-frequency, and
  // cannot bring back something the sweep parked. This tool is that window.
  //
  // Deliberately NOT a delete: "forget" here means tier movement and
  // parking in forgotten/. Real destruction still goes through the delete
  // guard, which is a separate, deliberate act.
  tool({
    name: "memory_forget",
    description: "Inspect or steer the three-tier forgetting system. Actions: 'status' (tiers + idle days for every entry), 'mark' (flag an entry as low-frequency so it is never auto-demoted — use for seasonal/rare lessons), 'unmark', 'forgotten' (list parked entries), 'candidates' (list entries still in the 候选 window, flagging those past 45 days), 'recall' (bring a parked entry back to tier 1). This does NOT delete anything; use the delete guard for that.",
    parameters: {
      action: { type: "string", required: true, description: "status | mark | unmark | forgotten | candidates | recall" },
      number: { type: "number", description: "Entry number (for mark / unmark / recall)." },
      file: { type: "string", description: "Forgotten file name (for recall), as shown by action=forgotten." },
      detail: { type: "boolean", description: "For action=status: return the per-entry table. Default returns tier counts and idle buckets only, which is what you usually need." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || JSON.stringify(value, null, 2) }]
    },
    execute: async (args) => {
      try {
        const stats = loadStatsSafe(root) || {};
        if (args.action === "status") {
          const manual = loadManual(root);
          if (manual.entries.length === 0) return { text: "the manual is empty — nothing to track" };
          // Token 瘦身（2026-11-03）：默认只给统计。317 行全表约 5k token，
          // 摘要约 100 字。要看逐条明细加 detail: true。
          if (args.detail !== true) {
            const tierCount = { 1: 0, 2: 0, 3: 0, 4: 0 };
            let retired = 0, idle30 = 0, idle60 = 0, noDate = 0;
            for (const e of manual.entries) {
              if (e.superseded) { retired++; continue; }
              const s = stats[String(e.number)] || {};
              const tier = s.tier || 1;
              tierCount[tier] = (tierCount[tier] || 0) + 1;
              if (!s.lastUsed) { noDate++; continue; }
              const idle = Math.floor((Date.now() - new Date(s.lastUsed + "T00:00:00").getTime()) / 86400000);
              if (idle > 30) idle30++;
              if (idle > 60) idle60++;
            }
            const text = [
              `手册 ${manual.entries.length} 条：hot ${tierCount[1]} / warm ${tierCount[2]} / cold ${tierCount[3]} / retired ${retired}`,
              `idle > 30 天：${idle30} 条；> 60 天：${idle60} 条；无使用记录：${noDate} 条`,
              `（要看逐条明细加 detail: true）`
            ].join("\n");
            return { text, count: manual.entries.length };
          }
          const rows = manual.entries.map((e) => {
            const s = stats[String(e.number)] || {};
            const tier = s.tier || 1;
            const idle = s.lastUsed
              ? Math.max(0, Math.floor((Date.now() - new Date(s.lastUsed + "T00:00:00").getTime()) / 86400000))
              : "?";
            // Heat records how often an entry was READ, not whether it is still
            // true: a retired entry keeps the tier its old usage earned, so it
            // showed up as "hot" forever. State wins over heat here.
            const tierName = e.superseded
              ? `retired -> #${e.supersededBy ?? "?"}`
              : tier === 1 ? "hot" : tier === 2 ? "warm" : tier === 3 ? "cold" : "forgotten";
            return `| ${e.number} | ${e.title} | ${tierName} | ${idle} | ${s.count === undefined ? "-" : Math.round(s.count * 10) / 10} | ${s.lowFreq ? "yes" : ""} |`;
          });
          const retiredCount = manual.entries.filter((e) => e.superseded).length;
          // The footer must quote the thresholds the sweep actually runs with.
          // Hardcoding 7/30/90 while conf says 15/45 told the model a rule the
          // engine does not follow.
          const coldDays = userCfg?.coldInferredDays ?? cfg.coldInferredDays;
          const staleDays = userCfg?.staleInferredDays ?? cfg.staleInferredDays;
          const confColdDays = userCfg?.coldConfirmedDays ?? cfg.coldConfirmedDays;
          const confStaleDays = userCfg?.staleConfirmedDays ?? cfg.staleConfirmedDays;
          const text = [
            "| # | summary | tier | idle days | heat | low-freq |",
            "|---|---|---|---|---|---|",
            ...rows,
            "",
            `Tiers move on their own: agent-inferred ${coldDays} days idle -> warm, ${staleDays} -> cold; user-confirmed ${confColdDays} -> warm, ${confStaleDays} -> cold; ${DEMOTE_DAYS.tier3_to_forgotten} days at cold -> forgotten (parked, recallable).`,
            ...(retiredCount
              ? [`${retiredCount} retired entries are listed for lineage only: they are hidden from search and from the default index.`]
              : []),
            "Mark a seasonal lesson with action=mark so it never auto-demotes."
          ].join("\n");
          return { text, count: manual.entries.length };
        }
        if (args.action === "mark" || args.action === "unmark") {
          if (!args.number) return { error: "number required" };
          const s = markLowFrequency(root, Number(args.number), args.action === "mark");
          return { text: `entry #${args.number} low-frequency = ${s.lowFreq}` };
        }
        if (args.action === "candidates") {
          const manual = loadManual(root);
          const list = candidates(manual, { days: 45 });
          if (!list.length) {
            return { text: "no candidate entries — everything is either proven or human-confirmed", count: 0 };
          }
          const rows = list.map((c) => `| ${c.number} | ${c.title} | ${c.since} | ${c.days} | ${c.heat} | ${c.stale ? "⚠ 超期" : ""} |`);
          return {
            text: [
              "| # | candidate | since | days | heat | note |",
              "|---|---|---|---|---|---|",
              ...rows,
              "",
              "heat = recall 次数累积（遗忘系统的计数）；matching mentions keep a candidate warm.",
              "45-day rule: promote (memory_curate promote) or ask the user. Nothing is removed automatically."
            ].join("\n"),
            count: list.length
          };
        }
        if (args.action === "forgotten") {
          const list = listForgotten(root);
          return {
            text: list.length
              ? ["Parked entries (bytes intact, recallable):", "", ...list.map((f) => `- \`${f}\``), "", "Use action=recall with file=<name> to bring one back."].join("\n")
              : "nothing is parked in forgotten/"
          };
        }
        if (args.action === "recall") {
          if (!args.file) return { error: "file required (see action=forgotten)" };
          // flattened name looks like "04-experience_1.md"; restore the path
          const m = /^(.+)_(\d+)\.md$/.exec(args.file);
          if (!m) return { error: "unrecognised forgotten file name" };
          const rel = `${m[1].replace(/_/g, "/")}/${m[2]}.md`;
          const ok = recallForgotten(root, args.file, rel);
          return ok
            ? { text: `recalled \`${args.file}\` back to ${rel} (tier 1)` }
            : { error: `could not recall ${args.file}` };
        }
        return { error: `unknown action: ${args.action}` };
      } catch (e) {
        return { error: `forget failed: ${String(e.message || e)}` };
      }
    }
  });

  // ---- memory_metrics: measure whether the memory is actually working ----
  // Tests prove the code does what the tests say. They prove nothing about
  // whether the memory is useful. These numbers are the answer to "is this
  // getting better or worse" that is not a feeling.
  //
  // ---- memory_redundancy: 只读的冗余扫描（2026-11-03）----
  // 检测是 L1（只读），决策权在用户。不删、不合并、不改任何条目。
  tool({
    name: "memory_redundancy",
    description: "只读的冗余扫描。记忆：重复条目（标题+标签余弦 ≥0.85）、过时条目（标题含前提词+超30天）、从未召回（无使用记录+超60天）、候选过期（超45天）。数据：runtime 各目录大小、大日志。提示：常驻段落说明。不删不改，报告写文件，决策交给人。",
    parameters: {
      action: { type: "string", description: "scan（默认，跑一次扫描）| report（读上次报告）" },
      detail: { type: "boolean", description: "返回完整报告而不是摘要。" }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || String(value.error || "failed") }]
    },
    execute: async (args) => {
      try {
        const reportsDir = path.join(root, "reports");
        if (args.action === "report") {
          if (!fs.existsSync(reportsDir)) return { text: "还没有报告，先跑 action=scan" };
          const files = fs.readdirSync(reportsDir).filter((f) => f.startsWith("redundancy-")).sort();
          if (!files.length) return { text: "还没有报告，先跑 action=scan" };
          const latest = files[files.length - 1];
          return { text: fs.readFileSync(path.join(reportsDir, latest), "utf8"), file: latest };
        }
        const r = scanRedundancy(root, {
          stats: loadStatsSafe(root) || {},
          extraPaths: [path.join(root, "..", "_tmp"), path.join(root, "..", "shannon-anchor", "backup")]
        });
        fs.mkdirSync(reportsDir, { recursive: true });
        const stamp = r.at.slice(0, 10).replace(/-/g, "");
        const file = `redundancy-${stamp}.md`;
        fs.writeFileSync(path.join(reportsDir, file), formatRedundancyReport(r), "utf8");
        const text = args.detail === true
          ? formatRedundancyReport(r)
          : formatRedundancySummary(r) + `\n详情：reports/${file}`;
        return { text, file, at: r.at };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    }
  });

  // The log holds no prose: event kinds, numbers and 12-char text hashes only.
  // That is deliberate — it must be safe to paste into an issue.
  tool({
    name: "memory_metrics",
    description: "Measure whether the memory system is working, not just whether it runs. action=summary (default) returns write/recall counts, recallRatio (recalls per write — low means entries are being hoarded faster than read), searchHitRate, integrity verdict counts, guard blocks and chain failures, plus a plain-language diagnosis. action=events returns the raw append-only log tail. action=reset is NOT provided on purpose: the log is append-only and rotates itself at 4 MB. Numbers are honest but coarse — thresholds in the diagnosis are starting points, not measurements.",
    parameters: {
      action: { type: "string", description: "summary (default) | events" },
      limit: { type: "number", description: "For action=events: how many recent lines to return (default 50)." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || String(value.error || "failed") }]
    },
    execute: async (args) => {
      try {
        if (args.action === "events") {
          const events = readEvents(root, { limit: args.limit || 50 });
          if (!events.length) return { text: "the metrics log is empty — nothing has happened yet", count: 0 };
          const rows = events.map((e) => {
            const fields = Object.entries(e)
              .filter(([k]) => k !== "t" && k !== "k")
              .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`)
              .join(" ");
            return `${e.t}  ${e.k.padEnd(10)}  ${fields}`;
          });
          return { text: ["Recent events (oldest first):", "", ...rows].join("\n"), count: events.length };
        }
        const snap = writeSummary(root);
        const s = snap.summary;
        const pctText = (v) => (v === null ? "n/a" : String(v));
        const text = [
          `Metrics snapshot (${snap.generatedAt})`,
          "",
          "| measure | value |",
          "|---|---|",
          `| events logged | ${s.events} |`,
          `| writes | ${s.writes} (${s.distinctWritten} distinct) |`,
          `| recalls | ${s.recalls} (${s.distinctRecalled} distinct) |`,
          `| recallRatio (recalls/write) | ${pctText(s.recallRatio)} |`,
          `| searches | ${s.searches} |`,
          `| searchHitRate | ${pctText(s.searchHitRate)} |`,
          `| integrity accept/review/reject | ${s.integrity.accept}/${s.integrity.review}/${s.integrity.reject} |`,
          `| guard blocks | ${s.guardsBlocked} |`,
          `| chain failures | ${s.chainFailures} |`,
          `| forget sweeps (entries demoted / parked) | ${s.forgetEvents} (${s.demotedEntries} / ${s.parkedEntries}) |`,
          `| curate suggestions | ${s.curateSuggestions} |`,
          ...(s.predictFired > 0
            ? [
                `| predictions fired | ${s.predictFired} |`,
                `| predict top score (median / max) | ${s.predictTopScore ? `${s.predictTopScore.median} / ${s.predictTopScore.max} (${s.predictTopScore.n} logged)` : "not logged yet"} |`,
                `| predict floor in force | ${s.predictFloor ?? "not logged"} |`
              ]
            : []),
          "",
          "Reading:",
          ...snap.notes.map((n) => `- ${n}`),
          "",
          `Full snapshot written to \`${snap.path}\`.`
        ].join("\n");
        return { text, summary: s, notes: snap.notes };
      } catch (e) {
        return { error: `metrics failed: ${String(e.message || e)}` };
      }
    }
  });

  // ---- voice_case: decide what a correction was actually about ----
  // The library is not a rulebook. It holds the exact sentence the user
  // objected to and, when known, the words they would have used instead.
  // Capture only queues a candidate; this is the confirmation step, so an
  // ambiguous "不对" never becomes a permanent rule. Registered only when the
  // channel is on, matching the prompt section that names it.
  if (voiceOn) {
    tool({
      name: "voice_case",
      description: "Review voice/tone candidates captured from the user's own corrections, then confirm or drop them. action=list shows pending candidates and recent cases; action=confirm turns a pending candidate into a case (id + what required; human is the better wording, optional); action=drop discards a pending candidate. Confirm only corrections about HOW something was said, never a factual disagreement.",
      parameters: {
        action: { type: "string", required: true, description: "confirm | drop | list" },
        id: { type: "string", description: "Pending id (p-xxxxxxxx) for confirm/drop" },
        what: { type: "string", description: "confirm: 这句哪儿不对，具体到用词/结构/立场，不写感想" },
        human: { type: "string", description: "confirm: 人怎么说（更好的说法原话，可空）" },
        reason: { type: "string", description: "drop: 一句为什么不是语感案例（留痕到 dropped.jsonl，可空）" }
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (args, value) => [{ type: "text", text: value.text || String(value.error || "failed") }]
      },
      execute: async (args) => {
        const line = (s, n = 100) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
        try {
          if (args.action === "list") {
            const pending = listPending(root);
            const cases = listCases(root, { limit: 10 });
            const out = [`待判的候选（${pending.length}）`];
            if (!pending.length) out.push("- （空）");
            for (const p of pending) {
              out.push(`- ${p.id}｜你说「${line(p.user)}」${p.assistant ? `｜我当时说「${line(p.assistant)}」` : ""}`);
            }
            out.push("", `已记下的案例（最近 ${cases.length} 条）`);
            if (!cases.length) out.push("- （空）");
            for (const c of cases) {
              const rec = (c.recurrences || []).slice(-3);
              out.push(`- ${c.id}·${c.created}${rec.length ? ` 复发 ${rec.map((d) => d.slice(5)).join(" ")}` : ""}｜原话「${line(c.original)}」｜哪不对：${line(c.what)}${c.human ? `｜人怎么说：${line(c.human)}` : ""}`);
            }
            return { text: out.join("\n"), pending: pending.length, cases: cases.length };
          }
          if (args.action === "confirm") {
            if (!args.id) return { error: "id required (voice_case action=list shows pending ids)" };
            const r = confirmPending(root, args.id, {
              what: args.what,
              human: args.human,
              maxLines: voiceCfg.maxLines
            });
            if (!r.ok) return { error: r.error };
            return {
              text: `${r.recurrence ? "同一毛病再次出现，已在原案例上补日期" : "已记下语感案例"} ${r.id}；案例库摘要 ${r.lines} 行：${r.path}`,
              id: r.id,
              recurrence: r.recurrence === true,
              lines: r.lines,
              path: r.path
            };
          }
          if (args.action === "drop") {
            if (!args.id) return { error: "id required (voice_case action=list shows pending ids)" };
            const r = dropPending(root, args.id, args.reason || "");
            if (!r.ok) return { error: r.error };
            return { text: `已丢弃候选 ${r.id}`, id: r.id };
          }
          return { error: `unknown action: ${args.action}` };
        } catch (e) {
          return { error: `voice_case failed: ${String(e.message || e)}` };
        }
      }
    });
  }

  let triggerLine = null;

  // ---- persona_recall / persona_status: 人格判例库（只读） ----
  // 数据在 <runtime>/persona/，写入走 Python 工具（intake/judge/absorb/release）。
  // 这里只负责让助手在说话时能查到 active 判例。
  tool({
    name: "persona_recall",
    description: "查人格判例库的 active 判例。按维度、层或关键词过滤。人格训练模块的运行时入口。",
    parameters: {
      dimension: { type: "string", description: "维度名，如 边界强度、人话密度" },
      layer: { type: "string", description: "actor | agent | author" },
      query: { type: "string", description: "关键词" },
      limit: { type: "number", description: "最多返回几条，默认 10" }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || String(value.error || "failed") }]
    },
    execute: async (args) => {
      try {
        const hits = personaRecall(root, args);
        if (!hits.length) return { text: "没有匹配的 active 判例。", count: 0 };
        return { text: hits.map(renderCase).join("\n"), count: hits.length };
      } catch (e) {
        return { error: `persona_recall failed: ${String(e.message || e)}` };
      }
    }
  });

  tool({
    name: "persona_status",
    description: "人格判例库状态：当前 release、判例总数、各状态分布。",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: value.text || String(value.error || "failed") }]
    },
    execute: async () => {
      try {
        const s = personaStatus(root);
        const parts = Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join("，");
        return { text: `CURRENT ${s.current || "（无）"}｜共 ${s.total} 条｜${parts}`, ...s };
      } catch (e) {
        return { error: `persona_status failed: ${String(e.message || e)}` };
      }
    }
  });

  host.on("tools/pre-execute", async (exec, next) => {
    const tool = exec && exec.name;
    // The host's ToolExecution carries parsed args as `arguments`
    // (documented: pre-execute cannot rewrite exec.arguments). `args` is
    // kept as a fallback for the test harness shape.
    const callArgs = (exec && (exec.arguments ?? exec.args)) || {};
    // The guard intercepts delete-shaped intent by NAME *and by CONTENT*.
    //
    // Why both: name-only matching was bypassable — a model could call the
    // generic `pwsh` tool with "Remove-Item manual/01-rules/1.md" in the
    // command and the name regex would not match, so the guard never saw
    // it. Claude's PreToolUse works on the same principle: judge the ACTION
    // (the args), not the knife (the tool name).
    //
    // Still not an unconditional denial: cfg.guardDeletes being off disables
    // it, and a model writing past the host entirely is out of reach. What
    // this removes is the trivial bypass.
    if (cfg.guardDeletes && tool) {
      const isDeleteTool = /(^|_)(delete|remove)$/.test(tool);
      // Content-scan only tools that actually EXECUTE commands. A write/edit
      // whose payload merely CONTAINS the text "Remove-Item ..." is data,
      // not an action — scanning it blocks authoring tests and docs.
      const isShellTool = /pwsh|powershell|bash|shell|cmd|terminal|exec|run/i.test(tool);
      const isDeleteCommand = isShellTool && DESTRUCTIVE_RE.test(argsText(callArgs));
      // Only delete-shaped actions enter the guard. A read-only tool (grep,
      // glob, read) may legitimately carry a `path` inside the manual;
      // treating any such path as a delete target quarantined the very file
      // the model was trying to read.
      if (isDeleteTool || isDeleteCommand) {
        // Content-matched deletes may arrive without an explicit target arg
        // (a shell command). Quarantining the whole root would be wrong and
        // also fails (renaming a non-empty dir into its own subtree). So:
        // pull the path OUT of the command when possible; if we cannot tell
        // what is being deleted, refuse rather than guess.
        let target = callArgs.path || callArgs.target;
        const explicitTarget = !!target;
        if (!target && isDeleteCommand) {
          target = extractPathFromCommand(argsText(callArgs));
        }
        const resolved = target ? path.resolve(target) : null;
        // Boundary, not prefix: "...\manual-backup" is not inside "...\manual".
        const insideRoot = !!(resolved && (resolved === root || resolved.startsWith(root + path.sep)));
        const mentionsRoot = argsText(callArgs)
          .replace(/\\\\/g, "\\")
          .replace(/\\/g, "/")
          .includes(root.replace(/\\/g, "/"))
          // a command may reference the manual by its path UNDER the root
          // ("rm -rf manual/*") without spelling the root out
          // de-escape JSON quotes first: `manual\"` (a string ending in the
          // word manual) must not read as a path separator
          || /\bmanual[\\/]/.test(argsText(callArgs).replace(/\\"/g, '"'));
        if (insideRoot || mentionsRoot) {
          // The root itself is not a deletable target: quarantining the whole
          // library in one move is exactly the "clean temp files" accident
          // this system exists to prevent. Refuse it by name.
          if (resolved === root) {
            logger.info(`shannon-anchor: refused a delete targeting the whole manual root`);
            auditGuard(root, { tool, byName: isDeleteTool, byContent: isDeleteCommand, args: callArgs, target: resolved, batch: null, moved: 0, denied: "whole-root" });
            return { kind: "deny", reason: "refusing to delete the entire memory manual in one move — name the specific entry file instead" };
          }
          if (!insideRoot) {
            // The command touches the manual but we cannot pin a single
            // target (a glob, a variable, a directory sweep). Guessing would
            // move more than the model asked for. Refuse and say why.
            logger.info(`shannon-anchor: destructive command touches the manual but no single target could be resolved`);
            auditGuard(root, { tool, byName: isDeleteTool, byContent: isDeleteCommand, args: callArgs, target: resolved, batch: null, moved: 0, denied: "unresolved-target" });
            return { kind: "deny", reason: "destructive command touches the memory manual but the exact path could not be resolved — name the path explicitly (args.path) so it can go through the delete guard" };
          }
          if (!explicitTarget) {
            // The target was scraped out of command text — a guess about what
            // the command WOULD delete. Twice on 2026-10-19 the guard acted on
            // such a guess: it quarantined a file nobody was deleting and then
            // refused the command, so a file vanished with no one able to say
            // why (entry #128 mid-diagnosis; a cleanup batch's 2nd target).
            // The guard blocks guesses; it never acts on them.
            logger.info(`shannon-anchor: destructive command touches the manual but its target came from command text — blocking without acting`);
            auditGuard(root, {
              tool, byName: isDeleteTool, byContent: isDeleteCommand,
              args: callArgs, target: resolved, batch: null, moved: 0, denied: "scraped-target"
            });
            return {
              kind: "deny",
              reason: "destructive command touches the memory manual but its target was inferred from command text, not declared — nothing was moved and the command was not executed. Use the sanctioned delete script, or a delete tool with an explicit path argument."
            };
          }
          logger.info(`shannon-anchor: routing destructive call through guard (tool=${tool}, byName=${isDeleteTool}, byContent=${isDeleteCommand})`);
          const ok = guardedDelete(root, resolved, callArgs.reason || `no reason declared (tool=${tool}; see guard/audit.jsonl)`);
          if (!ok.ok) {
            return { kind: "deny", reason: ok.reason };
          }
          const moved = Array.isArray(ok.items) ? ok.items.filter((i) => !i.error).length : 0;
          logger.info(`shannon-anchor: delete quarantined (${moved} item(s)) -> ${ok.dest}`);
          if (moved > 0) refreshChain(root, logger);
          auditGuard(root, {
            tool, byName: isDeleteTool, byContent: isDeleteCommand,
            args: callArgs, target: resolved, batch: ok.batch || null, moved
          });
          return {
            kind: "deny",
            reason: `delete routed through the guard: ${moved} item(s) quarantined at ${ok.dest}; the original command was not executed.`
          };
        }
      }
    }
    // ---- task trigger: ring the bell only when the manual has opinions ----
    // Watches what the model is about to CALL (not what it is thinking),
    // and on a hit sends one short line pointing at the standing rule.
    // Silent by default; a hit costs one ~40-char line, nothing more.
    if (cfg.injectManualHints) {
      const hits = matchTriggers(tool, callArgs, rules);
      const line = composeInjection(hits.map((h) => ({ ...h, line: triggerLineFor(h.instruction) })));
      if (line) {
        triggerLine = line;
        logger.info(`shannon-anchor: trigger ${hits.map((h) => h.id).join(",")} -> ${line}`);
      }
    }
    return next();
  });

  // core-guard 的安装点：必须在删除守卫的 pre-execute 监听之后，
  // 否则会改变处理器顺序，打乱依赖下标的测试与既有行为。
  try {
    installCoreGuard(ctx, { root, cfg: coreCfg, logger });
  } catch (e) {
    logger.warn(`shannon-anchor: core-guard install failed: ${String(e.message || e)}`);
  }

  // ---- focus：专注模式（2026-11-01 P2 从 dsh-focus-mode 迁入）----
  // 只在 Windows 注册；默认开启。engine 在包内，状态也写包内 engine/state。
  // 旧包 dsh-focus-mode 必须同时从 profile 的 bundles 移除（focus_mode 会重名）。
  if (process.platform === "win32") {
    const focusCfg = { ...(cfg.focus || {}), ...(userCfg?.focus || {}) };
    if (focusCfg.enabled !== false) {
      try {
        installFocus(ctx, { root: PKG_ROOT, cfg: focusCfg, logger });
      } catch (e) {
        logger.warn(`shannon-anchor: focus install failed: ${String(e.message || e)}`);
      }
    }

    // ---- 核心区看门狗（P3）----
    // DSH 是开机自启的，看门狗挂在它后面就够了，不用单独做开机项。
    // 看门狗自己有单实例锁（Global\TianqueCoreWatch），重复启动会自己退出，
    // 所以这里不做"是否在跑"的检查，spawn 一下最省事。
    // detached + unref：让看门狗脱离插件进程，DSH 重启时旧的自然结束。
    try {
      const pwsh7 = process.env.SHANNON_ANCHOR_PWSH || "pwsh";
      const watchScript = path.join(os.homedir(), ".dsh", "core-guard", "core-watch.ps1");
      if (fs.existsSync(pwsh7) && fs.existsSync(watchScript)) {
        const child = spawn(
          pwsh7,
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", watchScript],
          { detached: true, stdio: "ignore", windowsHide: true }
        );
        child.unref();
        logger.info?.(`shannon-anchor: core-watch spawned (pid ${child.pid})`);
      }
    } catch (e) {
      logger.warn(`shannon-anchor: core-watch spawn failed: ${String(e.message || e)}`);
    }
  }

  // ---- experience-router：任务 → 经验（2026-11-02）----
  // 默认关：experience.enabled 必须显式打开（写进 runtime/conf/user.json）。
  // 不新增监听器 —— 挂到下面已有的那个 pre-step 上，否则会破坏测试里
  // "默认配置不挂 pre-step" 的契约，也让宿主多跑一遍回调。
  // 规则表是数据（conf/experience-rules.json），热加载：改完不用重启。
  const experienceOn = experienceCfg.enabled === true;
  // 当前会话 id（2026-11-02）：热度要区分「本对话用过」和「很久以前用过」。
  // 每个 pre-step 刷新一次（扫目录很便宜），recall 时用它记账。
  let currentSid = null;
  // 诊断（2026-11-02）：提示链路静默失败查了很久，留一个只在"真命中"时写一行
  // 的轻量探针，能直接回答"渲染那一刻到底有没有提示"。正常工作时几乎不产日志。
  const expDebug = (rec) => {
    try {
      const dir = path.join(root, "guard");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "experience-debug.jsonl"),
        JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n",
        "utf8"
      );
    } catch { /* 诊断不能影响主流程 */ }
  };
  // 提示**不走 systemPrompt.section**（2026-11-02 实测结论）。
  //
  // 试过注册一整段 section，provider 确实被调用、也算出了文本（诊断日志里有
  // render 记录、hintLen 非零），但那段文字从来没有进过模型上下文。空文本会被
  // renderPrompt 过滤，而本插件的文本非空，所以问题不在过滤，在这条通道本身。
  //
  // 改用 agent/pre-step 的 decision.messages 注入（见下面的监听器）——那是
  // DSH 官方插件 dsh-agent-instructions 用的通道，decision 是 authoritative 的。
  if (!experienceOn) {
    expDebug({ ev: "section-skipped", reason: "experienceOn=false" });
  }

  if (cfg.injectManualHints) {
    try {
      host.promptSection({
        name: "shannon-anchor-trigger",
        order: SECTION_ORDER.trigger,
        interpolate: false,
        text: () => triggerLine || ""
      });
    } catch (e) {
      logger.warn(`shannon-anchor: trigger section unavailable: ${String(e.message || e)}`);
    }
  }

  // ---- distillation: the automatic-accumulation engine finally ticks ----
  //
  // Why turn-stopping: the turn has already been answered, so a slow or
  // failed distillation can never delay or break the reply. The scheduler
  // debounces, so a burst of turns costs one summarization, not N.
  //
  // The summarizer is INJECTED through opts (the host owns the LLM). In
  // DSH it would be wired to ctx.llm.stream with reasoning disabled — the
  // documented trap is that leaving reasoning on blows the output-token
  // budget and the merge silently stops. When no summarizer is provided
  // (tests, or a host that does not expose an LLM) the scheduler is
  // created but inert, and says so once instead of pretending.
  const distillCfg = { ...(cfg.distill || {}), ...(userCfg?.distill || {}) };
  let scheduler = null;
  try {
    scheduler = createScheduler(root, {
      enabled: distillCfg.enabled === true,          // off unless asked for
      debounceMs: distillCfg.debounceMs ?? 600000,
      summarize: opts.summarize || null
    });
    if (distillCfg.enabled && !opts.summarize) {
      logger.warn("shannon-anchor: distill is enabled but no summarize() was injected — it will not accumulate");
    }
  } catch (e) {
    logger.warn(`shannon-anchor: distill scheduler not created: ${String(e.message || e)}`);
  }

  // mode: "turn" = the agent distills the previous turn itself (no LLM
  // handle needed); "llm" = the original summarize()-based pipeline;
  // "off" = no automatic accumulation.
  const distillMode = distillCfg.mode === "turn" ? "turn" : distillCfg.enabled === true ? "llm" : "off";

  host.on("agent/turn-stopping", async (payload) => {
    // The trigger line belongs to the step(s) after the hit; a new turn
    // starts clean. Clear it before any early return so a subagent turn
    // cannot leave a stale line behind.
    triggerLine = null;
    // Only root agents contribute: subagents would multiply both the LLM
    // cost and the voice captures by the fan-out factor.
    const agent = payload && payload.agent;
    const isRoot = !agent || agent.header?.parentSession === undefined;
    if (!isRoot) return;

    // Voice capture is independent of distillation: it must run even when
    // automatic distillation is off. It only queues a candidate; confirming
    // it is a separate, explicit tool call.
    if (voiceOn && Array.isArray(lastMessages) && lastMessages.length) {
      try {
        const cap = captureFromMessages(root, lastMessages, {
          maxPending: voiceCfg.maxPending,
          maxLines: voiceCfg.maxLines,
          observe: observeOn
        });
        if (cap.captured) {
          logger.info(`shannon-anchor: voice candidate ${cap.id}${cap.recurrence ? " (recurrence)" : ""}`);
        }
      } catch (e) {
        // Background bookkeeping: a failed capture must not surface as an error.
        logger.warn(`shannon-anchor: voice capture failed: ${String(e.message || e)}`);
      }
    }

    if (distillMode === "off") {
      // With distill off nothing else reads the cache, so drop it here rather
      // than leaving a stale transcript for the next turn's capture.
      if (voiceOn) lastMessages = null;
      return;
    }
    try {
      // The host emits { turn: number, signal }: no transcript. A string
      // turn would be a caller-supplied text (kept for other hosts/tests).
      // In turn mode the pre-step cache supplies a preview label; it is not
      // the record and never reaches the LLM pipeline.
      const payloadTurn = payload?.turn;
      const turnNo = typeof payloadTurn === "number" ? payloadTurn : null;
      const text = typeof payloadTurn === "string"
        ? payloadTurn
        : distillMode === "turn" && turnNo !== null ? turnPreview(lastMessages) : "";
      if (turnNo !== null) lastMessages = null;
      if (distillMode === "turn") {
        const q = queueTurn(root, { text, turn: turnNo }, { maxPending: distillCfg.maxPending ?? 20 });
        if (!q.queued) logger.info(`shannon-anchor: turn not queued for distillation (${q.reason})`);
        return;
      }
      if (!scheduler) return;
      const r = scheduler.schedule(text);
      if (r && r.scheduled === false && r.reason) {
        logger.info(`shannon-anchor: distillation skipped (${r.reason})`);
      }
    } catch (e) {
      // A failed distillation must never surface to the user as an error:
      // the answer was already given, this is background bookkeeping.
      logger.warn(`shannon-anchor: distillation scheduling failed: ${String(e.message || e)}`);
    }
  });

  // ---- dynamic system-prompt injection ----

  // Prediction section. Registered only when enabled, and returns "" unless
  // this step actually produced a hit — so the prompt cost is zero on every
  // turn that has nothing to say.
  if (predictOn) {
    try {
      host.promptSection({
        name: "shannon-anchor-predict",
        order: SECTION_ORDER.trigger, // next to the trigger line: both are hints
        interpolate: false,
        text: () => (lastPrediction && lastPrediction.text) || ""
      });
    } catch (e) {
      logger.warn(`shannon-anchor: predict section unavailable: ${String(e.message || e)}`);
    }
  }

  // agent/pre-step is the one hook that sees the messages about to enter the
  // model's context. Prediction runs here live; mode=turn only needs the last
  // messages of the turn so turn-stopping can store a readable preview — the
  // host payload there is { turn }, never the transcript.
  //
  // It must never delay or fail the step: both uses are bookkeeping. Everything
  // is wrapped, and next() is always called. Subagent steps are ignored so
  // their messages cannot overwrite the root conversation.
  if (predictOn || distillMode === "turn" || voiceOn || experienceOn) {
    host.on("agent/pre-step", async (input, next) => {
      let decision = await next();
      try {
        const agent = input && input.agent;
        const isRoot = !agent || agent.header?.parentSession === undefined;
        const messages = decision && decision.messages;
        if (isRoot && Array.isArray(messages) && messages.length) {
          lastMessages = messages;
          // 会话 id 每轮刷新一次：DSH 的会话目录 mtime 实时更新，扫两层拿到最新的
          // 那个就是当前会话。拿不到就保持 null（记账时按"无会话"处理）。
          currentSid = shortSessionId(currentSessionId());
          // 任务关键词 → 手册条目：提示本身在 section 的 text provider 里现算
          // （见 shannon-anchor-experience 的注释：缓存版本永远赶不上组装时机）。
          // 这里只留一条诊断，记录 pre-step 看到了什么，便于和 render 记录对照。
          if (experienceOn) {
            const rules = loadRulesHot(PKG_ROOT);
            const userText = lastUserText(messages);
            const hits = rules.length ? matchByKeywords(userText, rules) : [];
            const hint = hits.length ? renderHint(hits) : "";
            if (hint) {
              expDebug({
                ev: "pre-step",
                rules: rules.length,
                msgCount: messages.length,
                userText: userText.slice(0, 80),
                hits: hits.map((r) => r.id)
              });
              // **走 decision.messages 注入**，这是 DSH 的正规通道。
              //
              // 2026-11-02 教训：先前用 systemPrompt.section 注册一整段提示，
              // provider 确实被调用、也算出了文本（诊断日志有 render 记录），
              // 但那段文字从来没进过模型上下文。官方插件 dsh-agent-instructions
              // 的做法是：把消息插到"最后一条被本轮 claim 的消息"之后，返回
              // {...decision, messages}。decision 是 authoritative 的，改它就生效。
              const lastClaimedIndex = messages.findLastIndex((m) => decision.messages.includes(m));
              const insertAt = lastClaimedIndex >= 0 ? lastClaimedIndex + 1 : decision.messages.length;
              const hintMsg = {
                id: randomUUID(),
                role: "user",
                content: [{ type: "text", text: hint }],
                source: { kind: "shannon-anchor-experience" }
              };
              decision = {
                ...decision,
                messages: decision.messages.toSpliced(insertAt, 0, hintMsg)
              };
            } else if (userText) {
              // 没命中：记一笔，攒够阈值后自动补词（自我补全）。
              // 补的词必须来自手册条目的 tags，有出处；写前备份，热加载生效。
              recordMiss(root, userText);
              const auto = maybeAutofill(root, rules);
              if (auto) {
                expDebug({ ev: "autofill", fills: auto.fills, pruned: auto.pruned, backup: auto.backup });
              }
            }
          }
          if (predictOn) {
            // Prediction scores the whole library, so it needs bodies; the
            // index only carries metadata by design (see manual_store.js).
            // predictionEntries() keeps that corpus across the steps of a turn.
            const entries = predictionEntries(root);
            if (entries.length) {
              const out = buildPrediction(messages, entries, {
                floor: predictCfg.floor,
                limit: predictCfg.limit,
                turns: predictCfg.turns,
                english: predictCfg.english === true
              });
              lastPrediction = out.result.fired ? out : null;
              // Silent turns are logged too, under their own kind. The gate was
              // `out.result.fired &&`, which made the log a record of positive
              // cases only: it could never say whether the floor is too tight,
              // because a denominator needs the misses.
              // Dedup keeps its mechanism: buildSection caches one result object
              // per (corpus, opts, context) and this hook runs on EVERY step, so
              // object identity is what collapses twenty tool steps of one turn
              // into one observation.
              if (out !== lastMetricPrediction) {
                lastMetricPrediction = out;
                if (out.result.fired) {
                  recordMetrics(root, "predict", {
                    hits: out.result.suggestions.length,
                    top: out.result.suggestions[0] && out.result.suggestions[0].number,
                    // Absolute scores, comparable across turns. Without them the
                    // log can only say "it fired", which is how 1,203 fires at
                    // floor 0.535 were discovered with no way to re-tune it.
                    topScore: out.result.suggestions[0] ? out.result.suggestions[0].score : 0,
                    scores: out.result.suggestions.map((s) => s.score),
                    floor: predictCfg.floor
                  });
                } else {
                  // Numbers, a gate name and an entry id — no title, no context.
                  // The context here is the user's own words; the log is meant
                  // to be safe to paste anywhere.
                  recordMetrics(root, "predict-silent", {
                    hits: 0,
                    gate: out.result.gate || "unknown",
                    best: out.result.bestNumber ?? 0,
                    bestAbs: out.result.bestAbs ?? 0,
                    floor: predictCfg.floor
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        lastPrediction = null;
        logger.warn(`shannon-anchor: pre-step hook skipped: ${String(e.message || e)}`);
      }
      return decision;
    });
  }

  if (cfg.injectManualHints) {
    try {
      host.promptSection({
        name: "shannon-anchor-hint",
        order: SECTION_ORDER.hint,
        interpolate: false,
        text: [
          "有持久记忆手册：非平凡任务先 memory_list 或 memory_search 找条目，再 memory_recall 取全文；做完有可复用经验就 memory_write（必须带 source）。手册是唯一可靠的跨会话经验来源，不要凭印象。",
          "断言本机能力（联网、下载、跑模型、文件存在）前先实测；没实测标「未验证」，单次失败不等于全局不可用。",
          "人格判例库：说话前可以 persona_recall 查 active 判例（按维度或关键词），persona_status 看当前 release 和判例数。判例是「我认的判断」，不是「用户喜欢的答案」。",
          INSTRUCTION_NUMBERS
            ? `指令表：${INSTRUCTION_NUMBERS}。触发行说「按指令 N」时，按括号里的条目号 memory_recall 取全文再动手。`
            : ""
        ].filter(Boolean).join(" ")
      });
    } catch (e) {
      logger.warn(`shannon-anchor: systemPrompt.section unavailable: ${String(e.message || e)}`);
    }
  }

  // 核心区告警：看门狗发现篡改就写文件，这里把它带进系统提示。
  // 无感运行的一部分——不弹窗，下一轮对话自然看到。
  try {
    host.promptSection({
      name: "shannon-anchor-core-alert",
      order: SECTION_ORDER.coreAlert,
      interpolate: false,
      text: () => {
        const a = readCoreAlert(root);
        if (!a) return "";
        const paths = Array.isArray(a.paths) ? a.paths.join("；") : "";
        const why = a.reason === "decoy-touched" ? "诱饵文件被碰（正常流程永远不会写它）" : String(a.reason || "核心区被改动");
        return `⚠ 核心区告警（${a.at}）：${why}。${a.detail || ""}${paths ? ` 涉及：${paths}` : ""} 先查 logs/core-alert.jsonl 和 logs/core-watch.jsonl，确认是不是正常写入；不是就走回退流程。`;
      }
    });
  } catch (e) {
    logger.warn(`shannon-anchor: core-alert section unavailable: ${String(e.message || e)}`);
  }

  if (distillMode === "turn") {
    try {
      host.promptSection({
        name: "shannon-anchor-distill",
        order: SECTION_ORDER.distill,
        interpolate: false,
        text: () => {
          const items = pendingTurns(root);
          if (!items.length) return "";
          // Name the most recent turn: a bare count does not tell the reader
          // which conversation it is meant to revisit.
          const last = items[items.length - 1];
          const recent = last && last.preview
            ? `，最近一条：${String(last.preview).replace(/\s+/g, " ").slice(0, 120)}`
            : "";
          return `shannon-anchor: 上一批回合（${items.length} 条${recent}）还没蒸馏。若其中确有值得记的经验，用 memory_write 写成条目；写完或判定无价值后，调 memory_distill action=skip（reason 写一句为什么）清队列。不要为凑数而写。`;
        }
      });
    } catch (e) {
      logger.warn(`shannon-anchor: distill prompt section unavailable: ${String(e.message || e)}`);
    }
  }

  // The voice section rides at the end, above the resident hint. It renders
  // only while there is something to decide or a case fresh enough to keep in
  // view; an empty queue costs zero prompt space on every other turn.
  if (voiceOn) {
    try {
      host.promptSection({
        name: "shannon-anchor-voice",
        order: SECTION_ORDER.voice,
        interpolate: false,
        text: () => {
          // Same reasoning as the distill sweep: expiry is decided when the queue
          // is next read, not by a timer that may never fire.
          try {
            expirePending(root, Date.now(), {
              expireDays: evictCfg.voiceExpireDays,
              observe: observeOn
            });
          } catch { /* bookkeeping never breaks the prompt */ }
          return voicePrompt(root, { maxAgeHours: voiceCfg.promptMaxAgeHours });
        }
      });
    } catch (e) {
      logger.warn(`shannon-anchor: voice prompt section unavailable: ${String(e.message || e)}`);
    }
  }

  if (reviewOn && reviewInject) {
    try {
      host.promptSection({
        name: "shannon-anchor-review",
        order: SECTION_ORDER.review,
        interpolate: false,
        text: () => reviewPrompt(root, { maxAgeHours: reviewCfg.promptMaxAgeHours, maxPending: reviewCfg.maxPending })
      });
    } catch (e) {
      logger.warn(`shannon-anchor: review prompt section unavailable: ${String(e.message || e)}`);
    }
  }

  logger.info(`shannon-anchor v0.1.0 loaded: manual retrieval + guarded write + delete routing + hint injection`);
}
