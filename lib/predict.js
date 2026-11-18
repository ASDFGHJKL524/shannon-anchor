// shannon-anchor — predictive recall: surface the entries the CURRENT turn needs,
// before anyone remembers to search.
//
// Why this exists: every other recall path in this system is pull-based. The
// model has to know it should look, and a hint tells it to look. That fails in
// the exact case memory matters most: the model does not know it has forgotten
// something. Prediction flips it to push — read the turn's own words, find the
// entries that bear on it, and put their NUMBERS in the prompt.
//
// What it deliberately does NOT do: inject entry text. The whole design rests
// on the index being cheap and the library being expensive (see the hint
// section: "Browsing the index costs context proportional to the library
// size"). Injecting bodies would undo that. So prediction emits numbers and
// one-line titles only, and the model decides whether to recall.
//
// Cost model: this runs on every step, so it must be cheap and quiet.
//   - no match -> empty string, zero prompt cost
//   - match    -> at most MAX_SUGGESTIONS lines
//   - scoring  -> reuses retrieval.js's BM25 + hash vector; no new machinery
//
// The hard part is not finding candidates, it is NOT being annoying. A
// prediction system that fires on every turn is worse than none: it trains the
// reader to ignore the section, and then the real hit is invisible too. So the
// thresholds here are deliberately conservative, and the module reports its own
// hit rate through metrics so the thresholds can be tuned with evidence.

import { search } from "./retrieval.js";
import { tokenize, tokenizeList } from "./tokenize.js";

// How many entries to name. Three is a suggestion; ten is a wall.
export const MAX_SUGGESTIONS = 3;

// Minimum score to say anything at all.
//
// Measured on a labeled corpus:
// 292 entries, 413 distinct real user turns from the distill archive, 70 labels.
// Of the 41 fires: 23 labelled good, 4 noise, 3 ctx, 1 miss, 10 unlabelled.
// HISTORY, because this number has been re-chosen three times and the reason
// each time was different. The old 0.68 was on a scale that never compared
// (0.535 fired on 73%); the coverage factor changed the scale once; and the
// 272-entry table that justified 0.47 stopped reproducing (the same floor fired
// 41 turns, not 63).
//
// CURRENT BASIS (2026-11-01, 307-entry live corpus, uniform coverage — see
// retrieval.js for that change and a labeled check to re-run this):
//
//   floor  labelled "good" fired (of 28)   labelled noise fired (of 30)
//   0.44             28                            7
//   0.45             28                            6
//   0.46             28                            5   <- chosen
//   0.47             27                            4
//   0.48             26                            4
//   0.50             23                            1
//   0.52             19                            1
//
// The decision rule is not "maximise good minus noise" — that is flat here
// (net 21-23 from 0.42 to 0.48), which means the floor is a blunt instrument and
// ranking is where the real precision lives. The rule is: **the floor must not
// refuse a labelled-good turn.** At 0.46 every one of the 28 fires with the
// expected entry on top; at 0.47 one is refused (i23 -> #31 at 0.463). That is
// also what makes a labeled check a usable signal: green means no known
// good turn is being thrown away, red means drift has started to cost recall.
// One kept-good costs one extra noise fire (5 instead of 4) — accepted, because
// a wrong hint is one line while a refused good turn is a lost recall path.
//
// WHY THIS NEEDED RE-CHOOSING ON 2026-11-01: 4 of the 28 good turns fired at 284
// entries and had gone quiet at 307, with the correct entry still on top
// (0.484->0.436, 0.479->0.442, 0.527->0.468, 0.522->0.425). That is drift, not
// ranking. Cause: the coverage factor was idf-weighted, and idf moves with both
// corpus size and document frequency, so adding entries moved every absolute
// score. Fixed in retrieval.js by counting coverage in tokens; drift fell from 4
// turns to 1 (that one, i23, is why the floor moved to 0.46).
//
// WHAT IS ESTABLISHED ABOUT THE GATES, so it is not re-litigated:
// - The thin-evidence gates are not eating good turns. On the labels they refused
//   only turns marked noise. The two strings that once "proved" otherwise
//   (怎么备份 / 手册怎么加条目) were hand-typed probes, absent from all 395 stored
//   turns and all 70 labels — never evidence.
// - Near-misses are real but usually correct refusals. First reading 2026-11-01
//   5 of 75 scored silent turns reached the floor. A near-miss probe
//   recovers the words by timestamp where it can: 专注模式启动了吗 -> #176,
//   没有重启 -> #238, 病毒不能打开它们用吗 -> #260 were all wrong entries the
//   gate correctly refused; 再次重启 -> #15 is borderline; one had no recoverable
//   turn. Do not lower the floor to chase a near-miss — read it first.
// - Do not trust any number here without a corpus fingerprint. This comment
//   carried a table that silently stopped being true; that is what labelcheck
//   exists to catch.
export const SUGGEST_FLOOR = 0.46;

// Turns of history to read. ONE by default, and that is a correction, not a
// starting guess.
//
// The original value was 2, on the theory that the previous turn helps with
// "continue with that". It does — and it also poisons every greeting. Measured
// A short greeting right after a turn about memory used to fire an unrelated rule:
// prediction matched entries about memory criteria (#96, #97, #74) because the
// previous user message was still in the context window. A greeting produced
// three confident, irrelevant suggestions.
//
// The trade is real: with 1, "继续刚才那个" carries no topic and predicts
// nothing. That is the correct failure — silence — because the model can still
// ask, whereas noise actively teaches the reader to ignore this section.
// Set `predict.turns` to 2+ if your workflow really is "continue with that".
export const CONTEXT_TURNS = 1;

// ---- the one frame rule that survived measurement ----
//
// Cutting the question frame BEFORE SCORING was tried and rejected (2026-10-25,
// 26 probes against the live 179-entry manual). It silenced real questions
// (「怎么备份」 0.623 -> nothing, because "备份" is the only token left and the
// context gate wants three) and it moved 「G 盘能不能直接写」 off #91 — the
// deletion/irreversibility rule that is exactly the right answer.
//
// The same cut used ONLY as a silence gate — "after removing the frame, not one
// token is left" — lost no real query and silenced six content-free messages
// (这个怎么办 / 随便聊聊 / 你看着办吧 / 今天辛苦了 / 我们继续吧 / 这个再说吧).
// The gate is separate from scoring on purpose: removes words from the decision
// whether to speak, never from the decision what to say.
//
// Fixed lexicon, like the stop lists: a phrase belongs here only if it can
// never name a topic. Adding to it needs a probe, not a hunch.
const FRAME_PHRASES = [
  "帮我看看", "可不可以", "随便聊聊", "看着办", "怎么办", "怎么样", "能不能",
  "会不会", "要不要", "有没有", "是不是", "为什么", "这个", "那个", "这些",
  "那些", "这样", "那样", "什么", "怎么", "怎样", "帮我", "看看", "随便",
  "聊聊", "你好", "谢谢", "辛苦", "请问", "我们", "继续", "再说", "先看看"
];
const FRAME_MAX = Math.max(...FRAME_PHRASES.map((p) => p.length));
const FRAME_SET = new Set(FRAME_PHRASES);

// True when the text is nothing but conversational framing. Longest match
// first, so 「怎么办」 is removed whole instead of leaving 「怎」 and 「么」.
export function framesOnly(text) {
  const s = String(text || "");
  let rest = "";
  for (let i = 0; i < s.length; ) {
    let hit = 0;
    for (let len = Math.min(FRAME_MAX, s.length - i); len >= 2; len--) {
      if (FRAME_SET.has(s.slice(i, i + len))) { hit = len; break; }
    }
    if (hit) i += hit;
    else { rest += s[i]; i++; }
  }
  return tokenize(rest).size === 0;
}

// ---- destructive intent carries the guard entry with it ----
//
// 删掉 / 删了 / 删文件 / 清理 all name the act, but bigram tokenization keeps
// them apart from the entry title 「删除与不可逆操作的边界」. Measured
// 2026-10-25 against the live 179-entry manual: #91 was outside the top TWENTY
// for 我要删掉手册里的文件, 怎么删文件, 这个文件能删吗, 删掉之前要问吗 and
// 删了还能恢复吗 — every three-slot prediction was filled by unrelated method
// entries. Appending 删除 alone rescued two of the five; adding 不可逆 as well
// put #91 in the top three for all five (ranks 3, 2, 1, 1, 1).
//
// The trigger is narrow on purpose. Bare 覆盖 fired #91 at 0.709 on
// 「这个方案覆盖了三种情况」, which is coverage, not overwriting; 覆盖 counts
// only when an object follows within four characters (覆盖文件, 覆盖已有, 覆盖旧).
//
// This expands the QUERY only, never the entry text, and only for the
// prediction path — memory_search still sees exactly what was typed.
const DESTRUCTIVE_RE = /删|清[理除空]|格式化|移除|挪|覆盖(?=[^，。！？\s]{0,4}(?:文件|已有|旧|原|数据|写入|保存))/;

export function expandDestructive(text) {
  const s = String(text || "");
  if (!DESTRUCTIVE_RE.test(s)) return s;
  let out = s;
  if (!out.includes("删除")) out += " 删除";
  if (!out.includes("不可逆")) out += " 不可逆";
  return out;
}

// Text extraction from a host message. The host shape is
// { role, content: [{ type, text }] } — but a plugin must never crash on a
// shape it did not expect, so every branch degrades to "".
export function messageText(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  if (typeof message.text === "string") return message.text;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === "string") { parts.push(block); continue; }
    if (typeof block.text === "string") { parts.push(block.text); continue; }
    // tool results and other block types are not the user's intent
  }
  return parts.join("\n");
}

// ---- host injection stripping ----
//
// The host splices its own machinery into user-role messages: system
// reminders, the skill catalog, runtime-context snapshots, compaction
// checkpoints. None of it is the user's intent, and here it is poison.
// Measured 2026-10-25 against the live 179-entry manual:
//
//   - a lone skill-catalog reminder (424 chars, zero user intent) fired
//     three suggestions: #29, #67, #76;
//   - the same reminder in front of a real question scored #67/#29/#76 and
//     pushed the entry the question was actually about out of the list.
//
// It was reaching distill.turnPreview too, where it became the visible
// "最近一条：用户：<system-reminder>..." nudge in the prompt.
//
// Mechanical on purpose: tag blocks first (closed, then unclosed), then
// known host-metadata line prefixes. Over-stripping costs one silent turn;
// under-stripping costs a confident wrong pointer, which is worse. Somebody
// who types a literal "<system-reminder>" is not a case worth protecting.
const INJECTION_TAGS = "system-reminder|available_skills|skill_content|compacted-summary|goal_complete";
const INJECTION_BLOCKS = new RegExp(`<(${INJECTION_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi");
// An opener with no closer: the message was cut before the host block ended,
// so everything from the opener on is still host text.
const INJECTION_UNCLOSED = new RegExp(`<(${INJECTION_TAGS})\\b[^>]*>[\\s\\S]*$`, "i");

const HOST_LINE_RES = [
  /^Current working directory:/i,
  /^Current DSH file policy:/i,
  /^Approval policy:/i,
  /^Approval prompts are disabled\b/i,
  /^Current DeepSeek Harness (?:implementation checkout|Web GUI URL):/i,
  /^Current runtime context\./i,
  /^Tokens prefixed with @ are paths/i,
  /^This is an automatically generated checkpoint/i,
  /^The runtime context names the DeepSeek Harness implementation checkout\./i,
  /^You are interacting with the user through the DeepSeek Harness Web GUI/i,
  /^Elapsed since the preceding step context:/i,
  /^Browser time zone for this request:/i
];

// Some user-role messages are host machinery end to end, not a person talking:
// a finished background job, a scheduled reminder batch, a goal-complete
// notice. Removing only their first line would leave the machine prose behind.
// Measured 2026-10-30 on 548 stored turn previews: these notifications were
// among the highest-scoring predictions ("background job pwsh-..." held 0.84),
// so they were consuming the section on turns with no user intent at all.
const HOST_MESSAGE_RES = [
  /^\[SCHEDULE REMINDER\b/i,
  /^background job [A-Za-z0-9_-]+ /i,
  /^started background job [A-Za-z0-9_-]+ /i,
  /^Time sampled while preparing turn\b/i
];

export function stripInjection(text) {
  let s = String(text || "").replace(INJECTION_BLOCKS, "\n").replace(INJECTION_UNCLOSED, "\n");
  if (!s) return "";
  const head = s.trim();
  if (HOST_MESSAGE_RES.some((re) => re.test(head))) return "";
  // Transcript labels are replay decoration; keep whatever follows them.
  s = s.replace(/^\s*\[(?:系统提示|用户|助手|工具结果|工具调用)\]\s*/gm, "");
  const kept = s.split("\n").filter((line) => !HOST_LINE_RES.some((re) => re.test(line.trim())));
  return kept.join("\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Does this message represent something the user just said?
function isUserish(message) {
  if (!message || typeof message !== "object") return false;
  const role = message.role;
  return role === "user" || role === undefined;
}

// currentContext(messages, opts) -> the text to predict from.
// Takes the last few user messages, newest last. Tool output and assistant
// prose are excluded: they describe what the agent did, not what is being
// asked, and including them makes every step look like the previous step.
export function currentContext(messages, opts = {}) {
  const turns = opts.turns ?? CONTEXT_TURNS;
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const picked = [];
  for (let i = messages.length - 1; i >= 0 && picked.length < turns; i--) {
    const m = messages[i];
    if (!isUserish(m)) continue;
    const t = stripInjection(messageText(m)).trim();
    if (t) picked.push(t);
  }
  return picked.reverse().join("\n");
}

// Strip the metadata header that every entry carries.
//
// An entry file looks like:
//   ### 92. 备份与自保
//   <!-- source: ... manual\02-backup\58.md ... -->
//   <!-- created: 2026-10-17 -->
//   <!-- confidence: user-confirmed -->
//   ...
//   备份防的是「失去」，不是「复建」...
//
// The comments are provenance, not content. They are dense with dates, paths
// and English words that appear in MANY entries, which makes them excellent at
// creating false matches and useless at telling entries apart. Everything up to
// the first line that is not a comment or blank is the actual prose.
export function stripMetadata(body) {
  const lines = String(body || "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("<!--")) { i++; continue; }
    break;
  }
  // Some entries repeat provenance at the END (half-life / last-used /
  // confidence). The header rule left those in the scored text: #73's
  // trailing "脚本、测试输出..." made 测试 appear twice, so the thin-evidence
  // gate did not see a passing mention and "测试挂了怎么查" surfaced the
  // delete guard at 0.394. A standalone comment line is metadata anywhere.
  const kept = lines.slice(i).filter((line) => {
    const t = line.trim();
    return !(t.startsWith("<!--") && t.endsWith("-->"));
  });
  return kept.join("\n").trim();
}

// predict(entries, contextText, opts)
//   -> { suggestions, considered, fired, gate?, bestAbs?, best? }
// suggestions: [{ number, title, score, path }] — never entry bodies.
//
// When it stays quiet it now also reports why. `gate` names the first check
// that refused; `bestAbs`/`best` are the strongest scored candidate from the
// order search returned it, whatever later threw it away. This is telemetry on
// paths that already returned nothing, so no decision changes: the silent
// returns were the only blind spot in the log, and a log of fires alone has no
// denominator — it cannot answer "is the floor too tight?", which is exactly
// the question 1,203 fires at floor 0.535 left unanswered.
export function predict(entries, contextText, opts = {}) {
  const empty = { suggestions: [], considered: 0, fired: false };
  if (!Array.isArray(entries) || entries.length === 0) return { ...empty, gate: "no-entries" };
  const ctx = String(contextText || "").trim();
  // Too short to mean anything: "ok", "继续", "yes". Predicting from these is
  // pure noise, and noise here costs trust in every later prediction.
  //
  // Measured 2026-10-19: a CHARACTER floor is wrong for Chinese. "备份密码放哪儿"
  // is 7 characters and carries a complete question; "删除守卫怎么用" is 7 and
  // "人设文件在哪" is 6. All three were silently discarded by a floor of 8
  // characters, which is an English-sized number. Token count is the honest
  // measure: it counts what the scorer actually uses.
  const minChars = opts.minContextChars ?? 4;
  if (ctx.length < minChars) return { ...empty, gate: "too-short" };
  // A context whose every token was a stop word is the same problem in
  // disguise. The bar is 1, not 3: question words (怎么/什么/哪儿) used to
  // inflate this count, so 3 was really "one topic plus two question words".
  // Once the tokenizer strips them (2026-10-30), 3 silenced real short
  // questions — "怎么备份" is one topic token and a complete question. What
  // must stay silent is zero topic; the SUGGEST_FLOOR decides the rest.
  if (tokenize(ctx).size < (opts.minContextTokens ?? 1)) return { ...empty, gate: "no-topic-token" };
  // Framing with no topic ("这个怎么办"): there is nothing to look up, and a
  // confident pointer here is the noise that teaches the reader to skip the
  // section. Measured cost of this line: zero real queries (see FRAME_PHRASES).
  if (framesOnly(ctx)) return { ...empty, gate: "framing-only" };

  const floor = opts.floor ?? SUGGEST_FLOOR;
  const limit = opts.limit ?? MAX_SUGGESTIONS;

  // The body must be STRIPPED before scoring. Every entry opens with five or
  // six metadata comments (source, created, confidence, half-life, last-used)
  // full of dates and paths. Measured 2026-10-19: with those left in, a real
  // question like "备份密码放哪儿" scored ZERO against the backup entry, while
  // the content-free "帮我看看这个报错" scored 0.503 against an unrelated one —
  // the metadata was drowning the prose it was supposed to describe.
  // search() indexes title and body itself now; this hands it clean body text.
  const haystacked = entries.map((e) => ({
    ...e,
    body: stripMetadata(e.body || "")
  }));
  // Scored with the destructive expansion; the self-quotation test below uses
  // the literal ctx, because it asks whether the entry quotes this user.
  const query = expandDestructive(ctx);
  const ranked = search(haystacked, query, {
    limit: Math.max(limit * 2, 6),
    minScore: 0,
    stats: opts.stats || null,
    absolute: true,
    coverageQuery: ctx
  });

  // ---- self-quotation filter -------------------------------------------
  //
  // A manual that records its own lessons QUOTES the queries that taught
  // them. When the user then types one of those queries, the quoting entry
  // matches itself — perfectly, because the string is identical.
  //
  // Measured 2026-10-19: "今天天气怎么样" scored 0.593 against the entry
  // that used it as a worked example, while every genuine negative sat
  // below 0.53. No threshold separates those, because one side is not
  // relevance at all — it is the query meeting its own quotation.
  //
  // v5 (measured 2026-10-31 on 395 stored turns): dropping the whole entry
  // was one step too blunt. An entry can quote a sentence AND be about it
  // (#196: the turn is the lesson, the quote is one line inside it). The
  // honest test is counterfactual: remove the quotation from that entry's
  // body, rescore, and let the floor decide. Across the 395 turns this
  // changed exactly one outcome — the #196 turn, restored at 0.763 — and
  // moved no other fire and no top-1. The strip runs only on turns that
  // have a quoting candidate: 7 of 395, one entry each, ~30 ms per turn.
  //
  // The test is deliberately literal: the FULL context text appears in the
  // entry's body, or the turn is mostly a quoted span (at least four
  // characters and half the message). Token overlap is not enough (an entry
  // about weather would legitimately match a weather question); verbatim
  // self-quotation is the signature of "I used this sentence as an example".
  const quotedSpans = (text) => {
    const out = [];
    const re = /[「『“"]([^」』”"]{4,})[」』”"]/g;
    let m;
    while ((m = re.exec(text))) out.push(m[1].trim());
    return out;
  };
  const quoteShare = Math.max(4, Math.ceil(ctx.length * 0.5));
  const selfQuoting = new Set();
  for (const r of ranked) {
    const body = r.entry.body || "";
    if (!body) continue;
    if (body.includes(ctx) || quotedSpans(body).some((f) => f.length >= quoteShare && ctx.includes(f))) {
      selfQuoting.add(r.entry.number);
    }
  }
  // Remove the quotation from the quoting entries only, then score again.
  // stats stays out of the second pass: one turn is one observation.
  const stripOwnQuote = (body) => {
    let out = body;
    for (const f of quotedSpans(out)) {
      if (f.length >= quoteShare && ctx.includes(f)) out = out.split(f).join("");
    }
    return out.split(ctx).join("");
  };
  let candidates = ranked;
  if (selfQuoting.size > 0) {
    const stripped = haystacked.map((e) =>
      selfQuoting.has(e.number) ? { ...e, body: stripOwnQuote(e.body) } : e
    );
    candidates = search(stripped, query, {
      limit: Math.max(limit * 2, 6),
      minScore: 0,
      stats: null,
      absolute: true,
      coverageQuery: ctx
    });
  }

  // ---- thin evidence ---------------------------------------------------
  //
  // One matched token that appears ONCE in the entry is a passing mention,
  // not an answer: 回来 in "会覆盖回来", 多了 in "写多了". Measured on the live
  // this rule silenced 我回来啦 (0.511), 咖啡喝多了 (0.496)
  // and 再改一版 (0.295) while every real multi-word question kept at least
  // two matching tokens. The title counts once here, not twice as in the BM25
  // haystack: a title-only match on a generic verb is still one mention.
  //
  // A one-token query used to be exempt here; v9 ended that. 「暂停一下」
  // surfaced an entry whose BODY says 暂停, so a one-token turn now has to
  // NAME the entry — the token must sit in its title and be specific.
  // 「怎么备份」 does NOT fire (measured 2026-10-31): 备份 is #58's title word,
  // but a one-token turn must also clear the thin-evidence gate, and it stops at
  // thin-entry with best #155 @ 0.589. The note here used to claim it still
  // fired; that was never re-checked after the one-token rule was tightened.
  //
  // A lone CJK character does not count as a second piece of evidence. 查
  // appears in almost every entry ("查到", "查一下", "检查"), so 「测试挂了怎么查」
  // matched 测试 once AND 查 once, escaped this gate, and surfaced the delete
  // guard #73 at 0.366. Latin single letters still count: G and D identify
  // drives. Measured 2026-10-31 on the live manual; no probe changed rank
  // except the false positive, because every genuine hit also matched a
  // multi-character token.
  const isStandaloneEvidence = (t) => t.length >= 2 || /[a-z0-9]/i.test(t);

  // Discourse connectors join clauses; they never name the subject. They look
  // like evidence because the manual writes them too: 所以，没办法了 matched
  // 所以 AND 办法, and the two spans cleared the unit gate on a turn that says
  // nothing about the entry. Measured on the 395 stored turns 2026-10-31:
  // excluding this list silenced t302 and t187 and lost no genuine hit.
  const FILLER = new Set(["所以", "但是", "不过", "然后", "而且", "就是", "其实", "还是", "只是", "不是", "这样", "那样", "一个",
    // The assistant's own name is how the user ADDRESSES it, not what the turn
    // is about. It sits in 4 entries, so it looks "specific" to the df gate,
    // and after coverage stopped counting cross-word bigrams it lifted two pure
    // endearment turns over the floor (t11 -> #61 at 0.570, t93 -> #270 at
    // 0.527). Measured on the 395 stored turns 2026-10-31.
    "助手"]);
  const evOk = (t) => isStandaloneEvidence(t) && !FILLER.has(t);
  const literalTokens = [...new Set(tokenizeList(ctx))];
  const lowerCtx = ctx.toLowerCase();

  // Character spans of matched tokens inside the turn. Overlapping spans
  // merge, because the tokenizer's bigrams overlap WITHIN one word: 没必要
  // emits 没必[0,2) + 必要[1,3), which covers [0,3) — one unit.
  // Counting tokens instead let 那算了，没必要 surface the backup entry at
  // 0.560 and 可以，就这样 the delete guard at 0.511, each on a single passing
  // mention. Measured on the 395 stored turns 2026-10-31: counting units
  // silenced 8 fires and lost no genuine hit (see v4b tests).
  const evidenceUnits = (tokens) => {
    const spans = [];
    for (const t of tokens) {
      const needle = t.toLowerCase();
      let from = 0;
      for (;;) {
        const i = lowerCtx.indexOf(needle, from);
        if (i < 0) break;
        spans.push([i, i + t.length]);
        from = i + 1;
      }
    }
    spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const [s, e] of spans) {
      const last = merged[merged.length - 1];
      // Touching spans merge too (s <= last[1]). Strict overlap was measured
      // first and rejected: it recovered exactly one fire in the 395-turn
      // replay — 助手的立场是什么呢 -> #72, whose entry is about citing rules,
      // a wrong pointer — and it split a repeated phrase (给我看看给我看看)
      // into two units, because only the crossing bigram 看给 bridges the
      // repetition and that bigram is not in the entry.
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    return merged;
  };

  // tf >= 2 alone was too easy to satisfy on the live manual: the words the
  // manual is built from (重启 df 48, 会话 53, 默认 47, 手册 42) repeat inside
  // ordinary entries, and every fire their repeat rescued in the 395-turn
  // replay was noise, a context-only match or a wrong pointer (6 losses; no
  // good fire, no top-1 change). A repeat counts only while the word is
  // SPECIFIC: df <= 5% of the corpus, with a floor of 9 so a small fixture
  // does not make every word ubiquitous. df is counted over the same corpus
  // search() indexes (stripped bodies, title and path, superseded included).
  const dfCap = Math.max(9, Math.floor(entries.length * 0.05));
  let corpusDf = null;
  const specific = (t) => {
    if (corpusDf === null) {
      corpusDf = new Map();
      for (const e of haystacked) {
        const head = `${e.title || ""} ${e.path || ""}`;
        const seen = new Set(tokenizeList(`${head} ${head} ${e.body || ""}`));
        for (const x of seen) corpusDf.set(x, (corpusDf.get(x) || 0) + 1);
      }
    }
    return (corpusDf.get(t) || 0) <= dfCap;
  };

  const thinEvidence = (entry) => {
    const titleTokens = new Set();
    const tf = new Map();
    for (const t of tokenizeList(entry.title || "")) {
      titleTokens.add(t);
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    for (const t of tokenizeList(stripMetadata(entry.body || ""))) tf.set(t, (tf.get(t) || 0) + 1);
    // A one-token turn is a complete question only when that token NAMES this
    // entry: 怎么备份 tokenizes to just 备份 and #58's title carries it. 暂停一下
    // must not surface an entry whose body happens to say 暂停, and a lone
    // single character or connector is not a name. Measured on the 395 stored
    // turns 2026-10-31: this silenced t10, t256 and t260 and kept every
    // one-token real question.
    if (literalTokens.length < 2) {
      const t = literalTokens[0];
      return !evOk(t) || !(titleTokens.has(t) && specific(t));
    }
    const matched = literalTokens.filter((t) => tf.has(t) && evOk(t));
    if (matched.length === 0) return false;
    if (matched.length === 1) return !((tf.get(matched[0]) || 0) >= 2 && specific(matched[0]));
    // A title word is the entry's own topic only while it is SPECIFIC, same
    // rule v6 applies to repeats: 手册 sits in 44 entries of the live manual
    // and says "this is an entry", not "this entry is about 手册". A run of
    // >= 3 characters in the title is a word even when its bigrams are not:
    // #18's 看不到 opens, 手册总览 does not. Measured on the same 395 turns:
    // silencing t5 and t255 and keeping t313 lost no good fire.
    const entryTitle = (entry.title || "").toLowerCase();
    const spans = [];
    for (const t of matched) {
      if (!titleTokens.has(t)) continue;
      const needle = t.toLowerCase();
      for (let i = entryTitle.indexOf(needle); i >= 0; i = entryTitle.indexOf(needle, i + 1)) {
        spans.push([i, i + needle.length]);
      }
    }
    spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const [s, e] of spans) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    const titlePhrase = merged.some(([s, e]) => e - s >= 3);
    const titleOpen = (t) => titleTokens.has(t) && (specific(t) || titlePhrase);
    // Two pieces of evidence only if they sit in two different spans of the
    // turn. One span is still a passing mention — unless the entry repeats a
    // SPECIFIC word or its TITLE is about it: 就第一种 against 第一种方案优先 is
    // the entry's own topic, not a coincidence.
    const units = evidenceUnits(matched);
    if (units.length !== 1) return false;
    return !(matched.some((t) => (tf.get(t) || 0) >= 2 && specific(t)) || matched.some(titleOpen));
  };

  // Ubiquitous words can meet in one turn without naming the entry: 插件 +
  // 安装 + 没有 sit in half the manual, and a title that says 插件…重启
  // shares no run of three characters with a turn that says 重启插件 in the
  // other order. A shared run of three characters is a compound the entry
  // really carries (dsh next to its surroundings). Measured on the 395 stored
  // turns 2026-10-31: silencing an all-common match with no shared run of
  // three cut exactly t281 and t364, both noise, and kept every good fire.
  const sharesThreeChars = (text) => {
    const hay = String(text).toLowerCase().replace(/\s+/g, " ");
    const needle = lowerCtx.replace(/\s+/g, " ");
    if (needle.length < 3) return false;
    const grams = new Set();
    for (let i = 0; i + 3 <= needle.length; i++) grams.add(needle.slice(i, i + 3));
    for (let i = 0; i + 3 <= hay.length; i++) if (grams.has(hay.slice(i, i + 3))) return true;
    return false;
  };

  const turnThinEvidenceV10 = (entry) => {
    const titleTokens = new Set(tokenizeList(entry.title || ""));
    // The whole turn is too thin if its only topic word is a body mention, a
    // connector, or a title word the manual uses everywhere. Same one-token
    // rule as thinEvidence: a complete question names the entry.
    if (literalTokens.length < 2) {
      const t = literalTokens[0];
      return !evOk(t) || !(titleTokens.has(t) && specific(t));
    }
    const evidenceTokens = [...new Set(tokenizeList(query))];
    const tf = new Map(); const titleTf = new Map();
    for (const t of tokenizeList(entry.title || "")) { titleTf.set(t, (titleTf.get(t) || 0) + 1); tf.set(t, (tf.get(t) || 0) + 1); }
    for (const t of tokenizeList(stripMetadata(entry.body || ""))) { tf.set(t, (tf.get(t) || 0) + 1); }
    const matched = evidenceTokens.filter((t) => tf.has(t) && evOk(t));
    if (matched.length === 0) return true;
    // Every matched word is one the whole manual uses, and the turn shares no
    // three-character run with this entry: the words coincide, the entry is
    // not what the turn is about.
    if (matched.every((t) => !specific(t)) &&
        !sharesThreeChars(`${entry.title || ""} ${stripMetadata(entry.body || "")}`)) return true;
    if (matched.length !== 1) return false;
    const t = matched[0];
    return !(titleTf.has(t) && specific(t)) || (tf.get(t) || 0) < 2;
  };

  // v12: every matched word is common, none is in the title, and every
  // evidence unit that actually occurs in the entry is common-only. A product
  // name repeated in prose is not a statement about this entry. Measured on
  // the 395 stored turns 2026-10-31: this silenced exactly t102 and moved no
  // other label.
  const commonAnchoredNoTitle = (entry) => {
    if (literalTokens.length < 2) return false;
    const titleTokens = new Set(tokenizeList(entry.title || ""));
    const tf = new Map();
    for (const t of tokenizeList(entry.title || "")) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tokenizeList(stripMetadata(entry.body || ""))) tf.set(t, (tf.get(t) || 0) + 1);
    const evidenceTokens = [...new Set(tokenizeList(query))];
    const matched = evidenceTokens.filter((t) => tf.has(t) && evOk(t));
    if (matched.length === 0) return true;
    if (!matched.every((t) => !specific(t))) return false;
    if (matched.some((t) => titleTokens.has(t))) return false;
    const hay = `${entry.title || ""} ${stripMetadata(entry.body || "")}`
      .toLowerCase().replace(/\s+/g, " ");
    let anchored = 0;
    for (const [s, e] of evidenceUnits(matched)) {
      const text = lowerCtx.slice(s, e).replace(/\s+/g, " ");
      if (!text || hay.indexOf(text) < 0) continue;
      anchored++;
      if (matched.some((t) => text.includes(t.toLowerCase()) && specific(t))) return false;
    }
    return anchored > 0;
  };
  const turnThinEvidence = (entry) => turnThinEvidenceV10(entry) || commonAnchoredNoTitle(entry);

  // Title proximity: BM25 counts title words one by one, so a title that names
  // the query's compound (本机 DSH 无法自我重启 for 重启一下dsh) ties with a
  // title that merely carries both words in different clauses. Only ORDER
  // changes here: the floor is still the absolute score, so no turn starts or
  // stops firing.
  const TITLE_PHRASE_CHARS = 12;
  const TITLE_PHRASE_BONUS = 0.15;
  const phraseTokens = literalTokens.filter(isStandaloneEvidence);
  const titlePhrase = (entry) => {
    const title = (entry.title || "").toLowerCase();
    const occ = [];
    for (const t of phraseTokens) {
      const needle = t.toLowerCase();
      for (let i = title.indexOf(needle); i >= 0; i = title.indexOf(needle, i + 1)) {
        occ.push({ t, s: i, e: i + needle.length });
      }
    }
    for (let a = 0; a < occ.length; a++) {
      for (let b = a + 1; b < occ.length; b++) {
        if (occ[a].t === occ[b].t) continue;
        const s = Math.min(occ[a].s, occ[b].s);
        const e = Math.max(occ[a].e, occ[b].e);
        if (e - s <= TITLE_PHRASE_CHARS) return true;
      }
    }
    return false;
  };
  const rankKey = (r) => (r.abs ?? 0) * (titlePhrase(r.entry) ? 1 + TITLE_PHRASE_BONUS : 1);

  // search() already drops retired entries; this is the last gate before a
  // prompt. A superseded suggestion is worse than no suggestion. wrong 同理：
  // 被推翻的结论不注入，正文只在 recall 时带标记出现。
  const passing = candidates
    .filter((r) => !r.entry.superseded && !r.entry.wrong)
    .filter((r) => (r.abs ?? 0) >= floor)
    .sort((a, b) => rankKey(b) - rankKey(a));
  const relevant = passing.filter((r) => !thinEvidence(r.entry));
  if (relevant.length === 0 || turnThinEvidence(relevant[0].entry)) {
    // Which check refused, and what the best candidate actually scored — the
    // distinction a fire-only log could not make. The two rows that used to sit
    // here ("怎么备份" thin-entry 0.589, "手册怎么加条目" thin-turn 0.525) were
    // hand-typed probes, never corpus turns; removed 2026-10-31 after a
    // substring check found them in none of the stored turns and none of the
    // labels. Do not reintroduce them as evidence.
    // Live window since predict-silent went live (2026-11-01 12:51): of 75
    // silent turns that scored, 5 reached the floor — four thin-entry, one
    // thin-turn, 0.489 to 0.534 — and all five are unlabelled.
    // Provenance warning, kept because the mistake is easy to repeat: a context
    // string assembled by hand is not how the host calls this. A probe that
    // builds its own "用户：" prefix feeds three characters into minContextChars
    // and the tokenizer, and it silently rewrites the answer: "ok" fired,
    // "这个怎么办" looked like a scored miss instead of framing-only. Score
    // through buildSection, or measure nothing.
    // best is taken from the order search RETURNED the candidates, not from
    // what survived: the whole point is to report what was thrown out.
    const scored = candidates.filter((r) => (r.abs ?? 0) > 0);
    const strongest = scored.length
      ? scored.reduce((a, b) => ((b.abs ?? 0) > (a.abs ?? 0) ? b : a))
      : candidates[0];
    const gate = !strongest ? "no-candidates"
      : strongest.entry.superseded ? "superseded"
      : passing.length === 0 ? "floor"
      : relevant.length === 0 ? "thin-entry"
      : "thin-turn";
    return {
      suggestions: [],
      considered: entries.length,
      fired: false,
      gate,
      bestNumber: strongest ? strongest.entry.number : null,
      bestAbs: strongest ? Number((strongest.abs ?? 0).toFixed(3)) : 0,
      bestFloor: Number(floor.toFixed(3)),
      selfQuoted: [...selfQuoting]
    };
  }

  const suggestions = relevant.slice(0, limit).map((r) => {
    // Report the ORIGINAL title, not the augmented haystack.
    const original = entries.find((e) => e.number === r.entry.number) || r.entry;
    return {
      number: original.number,
      title: original.title,
      score: Number((r.abs ?? 0).toFixed(3)),
      path: original.path
    };
  });
  return {
    suggestions,
    considered: entries.length,
    fired: suggestions.length > 0,
    selfQuoted: [...selfQuoting]
  };
}

// renderPrediction(result, opts) -> the prompt line, or "" for nothing.
// Kept to numbers and titles on purpose: the section is a pointer, not a copy.
export function renderPrediction(result, opts = {}) {
  if (!result || !result.fired || !result.suggestions.length) return "";
  const rows = result.suggestions.map((s) => `#${s.number} ${s.title}`);
  const lead = opts.english
    ? "This turn looks related to:"
    : "本轮可能相关：";
  const tail = opts.english
    ? "Call memory_recall on a number if it applies — do not assume."
    : "相关就用 memory_recall 取全文，不确定就忽略。";
  return `${lead} ${rows.join("；")}。${tail}`;
}

function titleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// A cheap identity for the scored corpus. mtime+bytes already change on every
// write; the title hash covers fixtures and cheap paths without mtime. Stats
// are excluded on purpose — callers that pass them skip the cache below.
function corpusKey(entries) {
  let h = entries.length;
  for (const e of entries) {
    h = (Math.imul(h, 31) + (e.number | 0)) | 0;
    h = (Math.imul(h, 31) + (e.bytes || 0)) | 0;
    h = (Math.imul(h, 31) + (e.mtimeMs || 0)) | 0;
    h = (Math.imul(h, 31) + (e.body ? e.body.length : 0)) | 0;
    h = (Math.imul(h, 31) + (e.superseded ? 1 : 0)) | 0;
    h = (Math.imul(h, 31) + titleHash(String(e.title || ""))) | 0;
  }
  return h;
}

// The pre-step hook runs before EVERY model step, and a turn with twenty tool
// calls sees the same user context twenty times. Scoring the manual again is
// pure repeat work — the context string and the corpus are both unchanged.
// Small cache: one entry per live turn, plus a little slack.
const SECTION_CACHE = new Map();
const SECTION_CACHE_MAX = 16;

// buildSection(messages, entries, opts) -> { text, result }
// One call: pull context out of the host's messages, score, render.
// Returns text="" whenever nothing should be said, so the caller can register
// this unconditionally and pay nothing on the turns it stays quiet.
export function buildSection(messages, entries, opts = {}) {
  const ctx = currentContext(messages, opts);
  const cacheable = !opts.stats;
  const key = cacheable
    ? `${corpusKey(entries)}\u0000${opts.floor ?? ""}\u0000${opts.limit ?? ""}\u0000${opts.turns ?? ""}\u0000${opts.english === true}\u0000${opts.minContextChars ?? ""}\u0000${opts.minContextTokens ?? ""}\u0000${ctx}`
    : null;
  if (key) {
    const hit = SECTION_CACHE.get(key);
    if (hit) {
      SECTION_CACHE.delete(key);
      SECTION_CACHE.set(key, hit);
      return hit;
    }
  }
  const result = predict(entries, ctx, opts);
  const text = renderPrediction(result, opts);
  const out = { text, result, context: ctx };
  if (key) {
    if (SECTION_CACHE.size >= SECTION_CACHE_MAX) {
      SECTION_CACHE.delete(SECTION_CACHE.keys().next().value);
    }
    SECTION_CACHE.set(key, out);
  }
  return out;
}
