// shannon-anchor — predictive recall tests. The hard requirement is silence:
// a predictor that fires on every turn is worse than none, because it teaches
// the reader to skip the section that carries the real hit.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  messageText, currentContext, predict, renderPrediction, buildSection,
  framesOnly, expandDestructive, stripMetadata, MAX_SUGGESTIONS, SUGGEST_FLOOR
} from "../lib/predict.js";

const ENTRIES = [
  {
    number: 1,
    title: "delete goes through the guard",
    path: "01-rules/1.md",
    body: "Deleting anything under the manual root must go through the delete guard, which moves the file to quarantine instead of destroying it."
  },
  {
    number: 2,
    title: "G drive is exFAT and has no permissions",
    path: "03-machine/2.md",
    body: "The G drive is formatted exFAT: no ownership records, no NTFS hard links, and weak permission protection. Do not treat an unblocked write as authorization."
  },
  {
    number: 3,
    title: "backup password lives off the drive",
    path: "02-method/3.md",
    body: "Backup archives and their passwords must be stored separately, and the password must never appear in a script or in the archive itself."
  },
  {
    number: 4,
    title: "the manual index is generated, never hand-edited",
    path: "03-machine/4.md",
    body: "The index is rebuilt from the entry files. Editing it by hand makes recall miss entries."
  }
];

// ---- message shape handling ----

test("messageText reads the host's content-block shape", () => {
  assert.equal(messageText({ role: "user", content: [{ type: "text", text: "hello" }] }), "hello");
});

test("messageText handles several blocks and ignores non-text ones", () => {
  const m = { role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] };
  assert.equal(messageText(m), "a\nb");
});

test("messageText degrades on every unexpected shape", () => {
  for (const m of [null, undefined, {}, { content: null }, { content: 42 }, { content: [] }, "plain", { text: "x" }]) {
    assert.equal(typeof messageText(m), "string", `shape ${JSON.stringify(m)} must not throw`);
  }
});

// ---- context extraction ----

test("currentContext takes only user turns, newest last", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "first question about the G drive" }] },
    { role: "assistant", content: [{ type: "text", text: "an answer about exFAT permissions" }] },
    { role: "user", content: [{ type: "text", text: "second question about deleting files" }] }
  ];
  const ctx = currentContext(messages, { turns: 2 });
  assert.match(ctx, /G drive/);
  assert.match(ctx, /deleting files/);
  assert.ok(!/an answer about/.test(ctx), "assistant prose is not the user's intent");
});

test("currentContext excludes tool results even when they are large", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "what is in this folder" }] },
    { role: "tool", content: [{ type: "text", text: "delete guard quarantine backup password exFAT" }] }
  ];
  const ctx = currentContext(messages);
  assert.ok(!/quarantine/.test(ctx), "tool output must not drive prediction");
});

test("currentContext on an empty or malformed list is empty, not a crash", () => {
  for (const m of [[], null, undefined, "nope", [null, {}, { content: [] }]]) {
    assert.equal(currentContext(m), "");
  }
});

// ---- host injection is not user intent ----
//
// Measured 2026-10-25 on the live manual: a lone skill-catalog reminder fired
// three entries, and the same reminder in front of a real question scored the
// reminder's vocabulary instead of the question's. The reminder is host
// machinery; only the question should reach the scorer.
const REMINDER = `<system-reminder>
The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:

<available_skills>
- \`office\`: Create, edit, inspect, or convert Office documents.
</available_skills>
</system-reminder>`;

test("a system-reminder block is stripped out of the context", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: `${REMINDER}\n帮我把这个语音合成调一下` }] }];
  const ctx = currentContext(messages);
  assert.match(ctx, /语音合成/);
  assert.ok(!/system-reminder|skill catalog|available_skills/.test(ctx), `injection survived: ${ctx}`);
});

test("a turn that is only host injection stays silent", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: REMINDER }] }];
  assert.equal(currentContext(messages), "");
  assert.equal(buildSection(messages, ENTRIES).text, "");
});

test("runtime-context metadata lines are not user intent", () => {
  const messages = [{
    role: "user",
    content: [{ type: "text", text: 'Current working directory: "~/.dsh"\nCurrent DSH file policy: read-only.\n\n我要删掉手册里的文件' }]
  }];
  const ctx = currentContext(messages);
  assert.match(ctx, /删掉手册/);
  assert.ok(!/read-only|working directory/.test(ctx), `metadata survived: ${ctx}`);
});

test("an unclosed reminder consumes the rest of the message", () => {
  const messages = [{
    role: "user",
    content: [{ type: "text", text: '帮我看一下这个报错\n<system-reminder>\nCurrent runtime context. This snapshot supersedes earlier ones.\nCurrent working directory: "~/.dsh"' }]
  }];
  const ctx = currentContext(messages);
  assert.match(ctx, /报错/);
  assert.ok(!/runtime context|working directory/.test(ctx), `tail survived: ${ctx}`);
});

test("the runtime approval notice alone is not user intent", () => {
  const messages = [{
    role: "user",
    content: [{ type: "text", text: "Approval prompts are disabled in this session: actions that require approval are rejected automatically \u2014 do not request sandbox escalation (do not set `sandbox_permissions`)." }]
  }];
  assert.equal(currentContext(messages), "");
  assert.equal(buildSection(messages, ENTRIES).text, "");
});

// Some user-role messages are host machinery end to end: a finished background
// job, a schedule batch, a goal-complete notice. Measured 2026-10-30 on 325
// stored turns: these were among the HIGHEST-scoring predictions on the real
// manual ("background job pwsh-..." sat at 0.84), so dropping only their first
// line is not enough — they must contribute nothing at all.
test("host notifications in the user role carry no intent", () => {
  const cases = [
    'background job pwsh-41e1858b04c64364 (pwsh: $ErrorActionPreference = "Continue")\noutput...',
    "started background job pwsh-abcd1234 (pwsh: node test.mjs)",
    "[SCHEDULE REMINDER BATCH] This is a scheduled message from the user reminders_json: [...]",
    "Time sampled while preparing turn 10, step 30: 2026-10-30T23:12:59+08:00",
    '<goal_complete> Objective: "按系统优化方案执行" The goal is marked complete.'
  ];
  for (const text of cases) {
    const ctx = currentContext([{ role: "user", content: [{ type: "text", text }] }]);
    assert.equal(ctx, "", `host noise survived: ${ctx}`);
    assert.equal(buildSection([{ role: "user", content: [{ type: "text", text }] }], ENTRIES).text, "");
  }
});

// ---- the core: does it find the right entry ----

// SCORES ARE CORPUS-SIZE DEPENDENT.
//
// The production floor (SUGGEST_FLOOR = 0.47) was measured against the 272-entry
// real manual; it has moved three times (0.18 -> 0.535 on 103 entries,
// 0.535 -> 0.68 on 325 turns, 0.68 -> 0.47 after the coverage factor changed the
// scale). BM25's idf depends on how many documents a term appears in,
// so the same query against a 4-entry fixture scores much lower (0.34 vs 0.72).
// These tests therefore pass an explicit floor: they check the MECHANISM
// (does the right entry rank first, does an unrelated one stay silent), not the
// tuned constant. The constant itself is verified against the live manual by
// a threshold probe.
const TEST_FLOOR = 0.25;

test("a question about deleting surfaces the delete guard", () => {
  const r = predict(ENTRIES, "I need to delete some files from the manual folder, is that safe?", { floor: TEST_FLOOR });
  assert.ok(r.fired, "should fire");
  assert.equal(r.suggestions[0].number, 1, `got ${JSON.stringify(r.suggestions)}`);
});

test("a question about the G drive surfaces the exFAT entry", () => {
  const r = predict(ENTRIES, "can I just write to the G drive without asking?", { floor: TEST_FLOOR });
  assert.ok(r.fired);
  assert.equal(r.suggestions[0].number, 2);
});

test("a question about backup passwords surfaces the backup entry", () => {
  const r = predict(ENTRIES, "where should I keep the backup password?", { floor: TEST_FLOOR });
  assert.ok(r.fired);
  assert.equal(r.suggestions[0].number, 3);
});

test("a Chinese question still finds the right entry", () => {
  const zh = [
    { number: 10, title: "删除要走守卫", path: "01-rules/10.md", body: "删除手册目录下的文件必须走删除守卫，进隔离区而不是直接销毁。" },
    { number: 11, title: "G 盘没有权限保护", path: "03-machine/11.md", body: "G 盘是 exFAT，没有属主记录，写入没被拦不等于有授权。" }
  ];
  const r = predict(zh, "我要删除手册里的文件，安全吗", { floor: TEST_FLOOR });
  assert.ok(r.fired, "Chinese context must fire too");
  assert.equal(r.suggestions[0].number, 10);
});

test("the metadata header does not count as content", () => {
  // A body whose prose is about backups but whose header is full of unrelated
  // paths and dates. The header must not create a match on its own.
  const noisy = [{
    number: 20,
    title: "backup handling",
    path: "02-method/20.md",
    body: "<!-- source: manual\\01-rules\\7.md + 8.md + 9.md -->\n<!-- created: 2026-10-17 -->\n<!-- confidence: user-confirmed -->\n备份和密码要分开放，不要放在同一块盘上。"
  }];
  const r = predict(noisy, "where do the passwords go", { floor: 0.01 });
  // whatever it scores, the suggestion must be about backups, not about paths
  if (r.fired) assert.equal(r.suggestions[0].number, 20);
});

// ---- the harder requirement: silence ----

test("an unrelated question fires nothing", () => {
  const r = predict(ENTRIES, "what is the weather in Tokyo tomorrow", { floor: TEST_FLOOR });
  assert.equal(r.fired, false, `fired on unrelated input: ${JSON.stringify(r.suggestions)}`);
});

test("a tiny context is ignored entirely", () => {
  for (const ctx of ["", "ok", "继续", "yes", "嗯"]) {
    const r = predict(ENTRIES, ctx, { floor: TEST_FLOOR });
    assert.equal(r.fired, false, `fired on "${ctx}"`);
  }
});

// The frame cut is a SILENCE gate, never a scoring transform: it may decide not
// to speak, it may not change what an accepted question is scored against.
test("framesOnly separates framing from topic", () => {
  for (const s of ["这个怎么办", "随便聊聊", "你看着办吧", "我们继续吧", "这个再说吧", "今天辛苦了", "你先看看"]) {
    assert.equal(framesOnly(s), true, `should be framing only: ${s}`);
  }
  for (const s of ["怎么备份", "这个文件怎么办", "G 盘怎么用", "为什么 pip 装不上", "什么是 exFAT"]) {
    assert.equal(framesOnly(s), false, `carries a topic: ${s}`);
  }
});

test("a content-free follow-up stays silent even when entries would match", () => {
  // Chinese fixture whose body is dense with 怎么办 wording: the old path would
  // score it and fire. With no topic in the question there is nothing to point
  // at, and a pointer here is the noise that trains the reader to skip.
  const zh = [{
    number: 30, title: "出错怎么办", path: "02-method/30.md",
    body: "报错怎么办：先看日志，再查手册，不要直接改配置。"
  }];
  for (const ctx of ["这个怎么办", "随便聊聊", "你看着办吧"]) {
    const r = predict(zh, ctx, { floor: 0.01 });
    assert.equal(r.fired, false, `fired on content-free "${ctx}"`);
  }
});

test("a short real question is not silenced by the frame gate", () => {
  const zh = [{
    number: 31, title: "备份与自保", path: "02-method/31.md",
    body: "备份防的是失去，不是复建；包和密码分开放。"
  }];
  const r = predict(zh, "怎么备份", { floor: 0.01 });
  assert.ok(r.fired, "short but topical must still fire");
  assert.equal(r.suggestions[0].number, 31);
});

test("destructive wording expands to the guard vocabulary", () => {
  for (const q of ["删掉手册里的文件", "怎么删文件", "清理一下临时文件", "把旧文件格式化", "覆盖已有文件"]) {
    const out = expandDestructive(q);
    assert.match(out, /删除/, `not expanded: ${q}`);
    assert.match(out, /不可逆/, `not expanded: ${q}`);
  }
  // 覆盖 as coverage is not an overwrite: this one must pass through untouched.
  assert.equal(expandDestructive("这个方案覆盖了三种情况"), "这个方案覆盖了三种情况");
  assert.equal(expandDestructive("怎么备份"), "怎么备份");
});

test("a synonym for delete still reaches the guard entry", () => {
  const zh = [
    {
      number: 40, title: "删除与不可逆操作的边界", path: "01-rules/40.md",
      body: "删、挪、覆盖之前先列目标。删除走删除守卫，进隔离区可还原；撤不了的操作标准提高一档。"
    },
    {
      number: 41, title: "任务触发·先查手册", path: "02-method/41.md",
      body: "动手前先查手册，按指令号取条目，不要凭记忆。"
    }
  ];
  // 删掉 and 删除 share no bigram; without the expansion this query ranks the
  // generic "check the manual" entry first.
  const r = predict(zh, "我要删掉手册里的文件", { floor: 0.1 });
  assert.ok(r.fired);
  assert.equal(r.suggestions[0].number, 40);
});

// The old bar was "3 distinct tokens", but that count included 怎么/什么/哪儿.
// Once the tokenizer strips them (2026-10-30), 3 tokens means "one topic plus
// two question words" and real short questions died at the gate ("怎么备份" is
// one topic token and a complete question). Zero topic is the line that
// matters; a single topic word is a topic, and SUGGEST_FLOOR decides the rest.
test("a context made only of stop words is ignored", () => {
  const r = predict(ENTRIES, "怎么样 什么 为什么", { floor: TEST_FLOOR });
  assert.equal(r.fired, false, "question words carry no topic");
});

test("one topic word still reaches the scorer", () => {
  const r = predict(ENTRIES, "delete delete delete", { floor: TEST_FLOOR });
  assert.equal(r.fired, true, "the floor, not the token count, is the gate");
});

test("an empty manual never fires", () => {
  const r = predict([], "I need to delete some files from the manual folder");
  assert.equal(r.fired, false);
  assert.equal(r.considered, 0);
});

test("at most MAX_SUGGESTIONS entries are named", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    number: 100 + i,
    title: `delete guard note ${i}`,
    path: `01-rules/${100 + i}.md`,
    body: "Deleting files under the manual root must go through the delete guard."
  }));
  const r = predict(many, "I want to delete files from the manual folder", { floor: TEST_FLOOR });
  assert.ok(r.suggestions.length <= MAX_SUGGESTIONS, `got ${r.suggestions.length}`);
});

test("suggestions never carry entry bodies", () => {
  const r = predict(ENTRIES, "I need to delete some files from the manual folder", { floor: TEST_FLOOR });
  for (const s of r.suggestions) {
    assert.ok(!("body" in s), "a suggestion is a pointer, not a copy");
    assert.ok(typeof s.number === "number");
    assert.ok(typeof s.title === "string");
  }
});

test("the floor is a real threshold: lowering it lets more through", () => {
  const ctx = "delete files from the manual folder";
  const strict = predict(ENTRIES, ctx, { floor: 0.9 });
  const loose = predict(ENTRIES, ctx, { floor: 0.01 });
  assert.ok(loose.suggestions.length >= strict.suggestions.length);
});

// ---- self-quotation: the query meeting its own worked example ----
//
// The 2026-10-19 incident. The manual records its lessons by QUOTING the
// queries that taught them. Typing one of those queries then makes the
// quoting entry match itself perfectly — no threshold can separate it from
// a genuine hit, because one side is not relevance at all. An hour was lost
// chasing it as a tokenizer problem, then a length problem, then a floor
// problem. The filter is the fix; these tests keep it.
test("an entry quoting the query verbatim does not predict itself", () => {
  const quoting = [{
    number: 30,
    title: "calibration notes",
    path: "02-method/30.md",
    // the exact string the user types, used as a worked example
    body: "实测：用户说「今天天气怎么样」，预测模块照样越线触发。这说明标定工具会自己骗自己。"
  }];
  const r = predict(quoting, "今天天气怎么样", { floor: 0.01 });
  assert.equal(r.fired, false, `self-quoting entry must stay silent: ${JSON.stringify(r.suggestions)}`);
  assert.deepEqual(r.selfQuoted, [30], "the filter must report what it suppressed");
});

test("the filter does not suppress genuine topical matches", () => {
  // Same words, but the entry is ABOUT the topic, not quoting the question.
  // It must still fire — the filter is for self-quotation, not for overlap.
  // v9 requires a one-token turn to NAME the entry, and this turn tokenizes to
  // 天气 alone; an English-only title would make it indistinguishable from a
  // passing body mention, so the fixture title carries the topic word.
  const topical = [{
    number: 31,
    title: "天气类查询不是手册主题",
    path: "04-experience/31.md",
    body: "天气类查询与记忆手册无关，任何关于气温、下雨、晴雨的提问都不该触发条目建议，这是标定时用来验证静默的反面样本。"
  }];
  const r = predict(topical, "今天天气怎么样", { floor: 0.01 });
  assert.ok(r.fired, "a topical entry about the subject must still fire");
  assert.equal(r.suggestions[0].number, 31);
  assert.deepEqual(r.selfQuoted, [], "nothing should be suppressed here");
});

test("a turn that is mostly a quote of earlier speech is self-quotation", () => {
  // The user repeats a sentence the entry recorded as a quotation. The body
  // does not contain the turn verbatim (the turn carries a leading comma), so
  // the full-string rule alone would let the quoting entry fire on itself.
  const quoting = [{
    number: 34,
    title: "voice notes",
    path: "02-method/34.md",
    body: "经验：记下一次纠正「下次不要在我没说的情况下使用其他的api」。"
  }];
  const r = predict(quoting, "，下次不要在我没说的情况下使用其他的api", { floor: 0.01 });
  assert.equal(r.fired, false, `fragment self-quote must stay silent: ${JSON.stringify(r.suggestions)}`);
  assert.deepEqual(r.selfQuoted, [34]);
});

test("a lone CJK character is not a second piece of evidence", () => {
  // Live #73: 测试 once in the prose, 查 once elsewhere, so the query
  // 「测试挂了怎么查」 looked like two mentions and surfaced the delete guard.
  const entries = [{
    number: 53, title: "守卫脚本", path: "04-experience/53.md",
    body: "测试只跑了一遍。\n查到问题就改。"
  }];
  const r = predict(entries, "测试挂了怎么查", { floor: 0.01 });
  assert.equal(r.fired, false, `a single 查 rescued a passing 测试 mention: ${JSON.stringify(r.suggestions)}`);
});

test("a single passing mention is not evidence", () => {
  // 回来 and 多了 each appear once in their entry's own prose. A chat turn
  // that happens to share one of them is overlap, not a question about it.
  const zh = [
    {
      number: 50, title: "插件会覆盖回来", path: "04-experience/50.md",
      body: "插件跑着的时候配置是输出，重启后内存值会覆盖文件。"
    },
    {
      number: 51, title: "日志", path: "04-experience/51.md",
      body: "记录写多了会乱，按日期分册。"
    }
  ];
  for (const ctx of ["我回来啦", "咖啡喝多了"]) {
    const r = predict(zh, ctx, { floor: 0.01 });
    assert.equal(r.fired, false, `thin match fired on "${ctx}": ${JSON.stringify(r.suggestions)}`);
  }
  const real = predict(zh, "插件配置怎么改", { floor: 0.01 });
  assert.ok(real.fired, "two matching topic tokens must still fire");
  assert.equal(real.suggestions[0].number, 50);
});

test("provenance comments are stripped wherever they sit", () => {
  const body = "prose only\n<!-- last-used: 2026-10-30 | 测试输出均在本机可复核 -->";
  assert.equal(stripMetadata(body), "prose only");
});

test("a trailing provenance comment is not a second mention", () => {
  // The live #73 hole: 测试 appeared once in the prose and once in the
  // trailing provenance comment, so tf=2 defeated the thin gate and
  // "测试挂了怎么查" surfaced the delete guard at 0.394.
  const entries = [{
    number: 52, title: "日志", path: "04-experience/52.md",
    body: "测试跑一遍就够了。\n<!-- last-used: 2026-10-30 | 测试输出均在本机可复核 -->"
  }];
  const r = predict(entries, "测试挂了怎么查", { floor: 0.01 });
  assert.equal(r.fired, false, `trailing metadata rescued a thin match: ${JSON.stringify(r.suggestions)}`);
});

test("a suppressed entry does not hide the genuine hit behind it", () => {
  // The real answer must survive the filter: prediction is not a one-entry
  // race, so removing the quoter has to let the next-best candidate through.
  const mixed = [
    {
      number: 32,
      title: "calibration notes",
      path: "02-method/32.md",
      body: "实测：备份密码放哪儿 这句话被手册引用后，查询会命中引用它的条目而不是真正讲备份的那条。"
    },
    {
      number: 33,
      title: "backup password lives off the drive",
      path: "02-method/33.md",
      body: "备份包与密码必须分开放，密码不能进脚本、不能进备份包本身。"
    }
  ];
  const r = predict(mixed, "备份密码放哪儿", { floor: 0.01 });
  assert.ok(r.fired);
  assert.equal(r.suggestions[0].number, 33, `got ${JSON.stringify(r.suggestions)}`);
  assert.ok(r.selfQuoted.includes(32));
});

// ---- turn-level evidence: no candidate above one mention ----
//
// thinEvidence judges ONE entry. Measured 2026-10-31 on the live manual, the
// live gate also let whole turns through when no candidate carried a single
// standalone token: 「那，什么是欺骗，什么是话术呢？」 surfaced #270 at 0.476.
// The entry matched on the lone 那 in 「那 6 次请求」 — a one-character token
// that thinEvidence deliberately does not count, so its matched list came out
// empty and the gate read that as "not thin". The turn gate asks whether any
// candidate gives more than one piece of evidence before the section is shown.
test("a turn whose candidates all have one mention stays silent", () => {
  const entries = [{
    number: 55, title: "额度与外部接口", path: "04-experience/55.md",
    body: "这类调用属于「花钱/对外」那一栏，不归我自作主张。那 6 次请求也要算成本。"
  }];
  const r = predict(entries, "那，什么是欺骗，什么是话术呢？", { floor: 0.01 });
  assert.equal(r.fired, false, "a lone 那 in prose must not fire: " + JSON.stringify(r.suggestions));
});

test("a thin candidate neither kills a real hit nor joins its list", () => {
  const entries = [
    {
      number: 56, title: "晚饭", path: "04-experience/56.md",
      body: "晚饭后喝了三杯，多了会睡不着。"
    },
    {
      number: 57, title: "咖啡因", path: "04-experience/57.md",
      body: "咖啡因摄入过多会失眠；喝多了半夜就醒。"
    }
  ];
  const r = predict(entries, "咖啡喝多了", { floor: 0.01 });
  assert.ok(r.fired, "the strong entry must still fire: " + JSON.stringify(r.suggestions));
  assert.deepEqual(r.suggestions.map((s) => s.number), [57], "the single mention must not join the list");
});

test("the one-token exemption survives the turn-level gate", () => {
  // 「exfat」 is one token and still a complete question. The up-front gate
  // needs four characters, so the fixture uses a Latin token; both thin
  // predicates exempt any query shorter than two tokens, and that exemption
  // is what lets the floor decide. The body spells it exFAT so the verbatim
  // self-quotation check (case-sensitive) stays out of the way.
  const entries = [{
    number: 58, title: "G drive is exFAT", path: "03-machine/58.md",
    body: "The G drive is formatted exFAT: no ownership records, no NTFS hard links."
  }];
  const r = predict(entries, "exfat", { floor: 0.01 });
  assert.ok(r.fired, "a one-token question is decided by the floor: " + JSON.stringify(r.suggestions));
  assert.equal(r.suggestions[0].number, 58);
});

// ---- rendering ----

test("renderPrediction is empty when nothing fired", () => {
  assert.equal(renderPrediction({ fired: false, suggestions: [] }), "");
  assert.equal(renderPrediction(null), "");
});

test("renderPrediction names numbers and titles, not bodies", () => {
  const r = predict(ENTRIES, "I need to delete some files from the manual folder", { floor: TEST_FLOOR });
  const line = renderPrediction(r);
  assert.match(line, /#1 /);
  assert.ok(!/quarantine instead of destroying/.test(line), "no body text in the prompt");
  assert.ok(line.length < 400, "the section must stay cheap");
});

test("renderPrediction can speak English", () => {
  const r = predict(ENTRIES, "I need to delete some files from the manual folder", { floor: TEST_FLOOR });
  const line = renderPrediction(r, { english: true });
  assert.match(line, /This turn looks related to/);
});

test("a superseded match never fires the prediction", () => {
  const entries = [{ ...ENTRIES[0], superseded: true }];
  const r = predict(entries, "I need to delete some files from the manual folder", { floor: TEST_FLOOR });
  assert.equal(r.fired, false, "no suggestion beats a suggestion that was already replaced");
});

// ---- the one-call wrapper ----

test("buildSection returns text, result and the context it used", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "can I delete files from the manual folder?" }] }];
  const out = buildSection(messages, ENTRIES, { floor: TEST_FLOOR });
  assert.ok(out.text.length > 0);
  assert.ok(out.result.fired);
  assert.match(out.context, /delete files/);
});

test("buildSection is silent on a turn with nothing to say", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "hello there, how are you today" }] }];
  const out = buildSection(messages, ENTRIES);
  assert.equal(out.text, "", "no match means zero prompt cost");
});

test("buildSection never throws on a malformed host payload", () => {
  for (const m of [null, undefined, [], "nope", [{ role: "user" }]]) {
    const out = buildSection(m, ENTRIES);
    assert.equal(typeof out.text, "string");
  }
});

test("exported constants are sane", () => {
  assert.ok(MAX_SUGGESTIONS >= 1 && MAX_SUGGESTIONS <= 5);
  assert.ok(SUGGEST_FLOOR > 0 && SUGGEST_FLOOR < 1);
});

// ---- v5: strip the quotation, do not drop the entry ----

test("v5: an entry that only quotes the turn stays silent", () => {
  const entries = [{
    number: 80, title: "误判记录", path: "04-experience/80.md",
    body: "一次误判：「今天天气怎么样」命中了这个条目。"
  }];
  const r = predict(entries, "今天天气怎么样", { floor: 0.01 });
  assert.equal(r.fired, false, `a pure quotation fired: ${JSON.stringify(r.suggestions)}`);
  assert.deepEqual(r.selfQuoted, [80]);
});

test("v5: an entry whose subject is the turn keeps its own evidence", () => {
  // The live #196 shape: the turn is the lesson itself, the quotation is
  // one line inside the entry. Dropping the entry loses a real hit.
  const entries = [{
    number: 81,
    title: "自主漫游是去网上逛，不是查本机",
    path: "04-experience/81.md",
    body: "自主漫游是去网上逛，不是查本机。\n<!-- last-used: 2026-10-31 -->\n原话：「漫游是去网上啊……随便什么网站」。"
  }];
  const r = predict(entries, "漫游是去网上啊……随便什么网站", { floor: 0.3 });
  assert.ok(r.fired, `the entry lost its own evidence: ${JSON.stringify(r)}`);
  assert.equal(r.suggestions[0].number, 81);
  assert.deepEqual(r.selfQuoted, [81], "the quotation must still be reported");
});

test("v5: a quotation stripped down to nothing stays silent", () => {
  // The #128 shape: the sentence was recorded as a measurement sample.
  // With the sample removed the entry has no evidence left.
  const entries = [{
    number: 82, title: "实测样本", path: "04-experience/82.md",
    body: "实测：先关机吧 是上一轮说过的话，已作为样本记录在这里。\n<!-- source: 2026-10-30 -->"
  }];
  const r = predict(entries, "先关机吧", { floor: 0.01 });
  assert.equal(r.fired, false, `stripped entry still fired: ${JSON.stringify(r.suggestions)}`);
  assert.deepEqual(r.selfQuoted, [82]);
});

// ---- v4b: one word is one piece of evidence ----
//
// The CJK tokenizer emits character bigrams, so a single word yields several
// tokens: 没必要 -> 没必 + 必要, 就这样 -> 就这 + 这样, 给我看看 -> 给我 + 我看
// + 看看. The old gate counted MATCHED TOKENS, so those two-piece bigrams
// looked like two Independent facts and slipped through. Measured on the 395
// stored turns: 那算了，没必要 surfaced the backup entry at 0.560 and
// 可以，就这样 surfaced the delete-guard entry at 0.511, both on one passing
// mention. The fix counts merged character spans (units), not tokens.

const unitCase = (number, title, body) => ({ number, title, path: `04-experience/${number}.md`, body });

test("v4b: two overlapping bigrams of one word are one piece of evidence", () => {
  const entries = [unitCase(
    61,
    "sessions 不进备份 —— 「不想失去」和「能复建」是两件事",
    "sessions 不进备份。不想失去和能复建是两件事，没必要把所有东西都存两份。"
  )];
  const r = predict(entries, "那算了，没必要", { floor: 0.01 });
  assert.equal(r.fired, false, `a one-word passing mention fired: ${JSON.stringify(r.suggestions)}`);
});

test("v4b: 就这 + 这样 is one word, not two", () => {
  const entries = [unitCase(
    78,
    "只读工具的 path 不是删除目标：guard 先判动作类型",
    "先判动作类型，再决定拦不拦。就这样，别再加特判。"
  )];
  const r = predict(entries, "可以，就这样", { floor: 0.01 });
  assert.equal(r.fired, false, `a discourse filler fired: ${JSON.stringify(r.suggestions)}`);
});

test("v4b: a repeated phrase still covers one span, not one per repetition", () => {
  const entries = [unitCase(
    53,
    "跑出来的东西要主动给用户看",
    "跑出来的东西别攒着，给我看看再说。"
  )];
  const r = predict(entries, "给我看看给我看看", { floor: 0.01 });
  assert.equal(r.fired, false, `a repeated filler phrase fired: ${JSON.stringify(r.suggestions)}`);
});

test("v4b: a title match is not a passing mention", () => {
  const entries = [unitCase(
    24,
    "第一种方案优先：合并 master 时基底必须用 master",
    "第一种方案优先，别用全局文件当基底。"
  )];
  const r = predict(entries, "就第一种", { floor: 0.01 });
  assert.ok(r.fired, `the entry's own topic was suppressed: ${JSON.stringify(r)}`);
  assert.equal(r.suggestions[0].number, 24);
});

test("v4b: an entry that repeats the word keeps its evidence", () => {
  const entries = [unitCase(
    61,
    "sessions 不进备份",
    "没必要把所有东西都存两份。这种场合说没必要，是成本判断。"
  )];
  const r = predict(entries, "那算了，没必要", { floor: 0.01 });
  assert.ok(r.fired, `a genuinely repeated word was suppressed: ${JSON.stringify(r)}`);
  assert.equal(r.suggestions[0].number, 61);
});

test("v4b: a title-only match on a strong token survives the unit gate", () => {
  const entries = [unitCase(
    229,
    "发给用户看的图一律转 JPG，不给 PNG",
    "PNG 只用于透明底这类必须的场景。要给 PNG 时说明理由。"
  )];
  const r = predict(entries, "我要，PNG!", { floor: 0.01 });
  assert.ok(r.fired, `PNG was suppressed: ${JSON.stringify(r)}`);
  assert.equal(r.suggestions[0].number, 229);
});

test("v4b: a one-token question stays exempt from the unit gate", () => {
  const entries = [unitCase(
    58,
    "备份密码放哪儿",
    "密码不放公开记录，备份包和密码分开放。"
  )];
  const r = predict(entries, "怎么备份", { floor: 0.01 });
  assert.ok(r.fired, `the one-token exemption broke: ${JSON.stringify(r)}`);
});

// ---- v6: a repeated word counts only while it is SPECIFIC ----
//
// tf >= 2 alone says "the entry is about this word". On the live 275-entry
// manual that is false for the words the manual is built from: 重启 (df 48),
// 会话 (53), 默认 (47), 手册 (42) repeat inside ordinary entries for ordinary
// reasons, and every fire they rescued in the 395-turn replay was noise or a
// wrong pointer (six losses: 3 noise, 1 ctx, 2 rank; no good fire, no top-1
// change). A repeated word is evidence only when df <= max(9, 5% of entries).
// The title still escapes: a title is the entry's own topic.
//
// The fixtures below need df > 9, so twelve filler entries contain 重启 once.
// Their tf is 1, which the v4b unit gate already silences — only the entry
// under test can fire, before and after.

const ubiquitous = Array.from({ length: 12 }, (_, i) => unitCase(
  900 + i,
  `日常记录 ${i + 1}`,
  "重启只是顺手记下的杂项，跟别的事放在一起。"
));

test("v6: a repeated ubiquitous word no longer rescues a single-token match", () => {
  // The title carries 重启 so the turn-level gate opens; without it this
  // fixture would be silenced by turn thin evidence and never reach the
  // entry-level rule under test.
  const entries = [...ubiquitous, unitCase(
    61,
    "重启之后要核对后台任务",
    "重启插件之前先看后台任务，重启之后核对。"
  )];
  const r = predict(entries, "行，重启吧", { floor: 0.01 });
  assert.equal(r.fired, false, `a ubiquitous repeat fired: ${JSON.stringify(r.suggestions)}`);
});

test("v6: a repeated ubiquitous word in a one-span match is not evidence either", () => {
  // 就重 + 重启 overlap in 那就重启一下, so this lands in the one-unit branch.
  // 重启 repeats in the body; 就重 appears once. The repeat used to carry it.
  const entries = [...ubiquitous, unitCase(
    62,
    "插件更新之后要核对",
    "就重启吧。重启之前先看后台任务。"
  )];
  const r = predict(entries, "那就重启一下", { floor: 0.01 });
  assert.equal(r.fired, false, `a one-span ubiquitous repeat fired: ${JSON.stringify(r.suggestions)}`);
});

test("v6: the ubiquitous-word entry drops out of the list, the specific one stays", () => {
  const entries = [...ubiquitous,
    unitCase(63, "插件更新之后要核对", "重启插件之前先看后台任务，重启之后核对。"),
    unitCase(64, "失败之后先看输出", "失败之后先看输出。失败不是结论，先看日志。")];
  const r = predict(entries, "重启失败", { floor: 0.01 });
  assert.ok(r.fired, `the specific repeated word was suppressed: ${JSON.stringify(r)}`);
  assert.deepEqual(r.suggestions.map((s) => s.number), [64]);
});

test("v6: the cap has a floor — a small library keeps repeated-word evidence", () => {
  // floor(N * 0.05) alone is 0 on a one-entry fixture, which would turn the
  // cap into "no repeat ever counts". df 1 is specific at any size.
  const entries = [unitCase(
    61,
    "重启之后要核对后台任务",
    "重启插件之前先看后台任务，重启之后核对。"
  )];
  const r = predict(entries, "行，重启吧", { floor: 0.01 });
  assert.ok(r.fired, `a specific repeat was suppressed: ${JSON.stringify(r)}`);
  assert.equal(r.suggestions[0].number, 61);
});

// ---- v7: a title that names the same compound outranks a scattered one ----
//
// BM25 scores title words one at a time, so a title carrying both query words
// in different clauses ties with a title that says the compound the turn says:
// 重启一下dsh ranked "DSH 视频预览…装完必须重启" above "本机 DSH 无法自我重启"
// on the live manual. Measured on the same 395 stored turns 2026-10-31:
// promoting titles where two distinct query tokens sit within 12 characters
// fixed exactly that top-1 (t242, labeled rank -> #176) and moved one noise
// top-1. It changed no fire and no good top-1, and the rank key never touches
// the floor — an entry below it stays out. The 12-character window is a
// phrase, not a paragraph: on the live titles the target's two words sat 10
// characters apart and neither decoy fit.
//
// The fillers below contain neither 重启 nor dsh, so those tokens keep a real
// idf and both ranked fixtures clear the production floor.

const unrelated = [
  unitCase(920, "缓存目录放 D 盘", "缓存目录放 D 盘，F 盘留给游戏，别把写入摊到内置盘。"),
  unitCase(921, "发给用户看的图转 JPG", "发给用户看的图一律转 JPG，不给 PNG，除非必须透明底。"),
  unitCase(922, "删除走守卫", "删除任何东西都走删除守卫，不许通配符，选和删分两步。"),
  unitCase(923, "备份密码和备份包分开放", "备份包和密码不能放在同一块盘上，密码不进脚本输出。"),
  unitCase(924, "G 盘是 exFAT", "G 盘没有 ownership，写入没被拦不等于授权。"),
  unitCase(925, "图片预览用浏览器", "图片预览交给浏览器，别为看一眼装整套库。"),
  unitCase(926, "长任务先报耗时", "超过五分钟的活儿先报预计耗时，再起后台任务。"),
  unitCase(927, "手册只走 memory_write", "手册写入只走 memory_write，手改文件会让校验链漂移。")
];

test("v7: adjacent query words in the title win the top slot", () => {
  const entries = [...unrelated,
    unitCase(801, "DSH 视频预览装完必须重启",
      "DSH 视频预览插件装完之后必须重启。重启之前先保存。重启之后 dsh 视频预览才恢复。dsh 重启要等预览进程退出。"),
    unitCase(802, "本机 DSH 无法自我重启",
      "重启 DSH 要手动关闭再打开。")];
  const r = predict(entries, "重启一下dsh");
  assert.ok(r.fired, `the adjacent-title fixture did not fire: ${JSON.stringify(r)}`);
  assert.deepEqual(r.suggestions.map((s) => s.number), [802, 801]);
});

test("v7: the phrase bonus never lifts a candidate over the floor", () => {
  const entries = [...unrelated,
    unitCase(801, "DSH 视频预览装完必须重启",
      "DSH 视频预览插件装完之后必须重启。重启之前先保存。重启之后 dsh 视频预览才恢复。dsh 重启要等预览进程退出。重启失败就看预览日志。dsh 插件更新后重启一次。"),
    unitCase(802, "本机 DSH 无法自我重启", "本机不能自我重启。")];
  const r = predict(entries, "重启一下dsh", { floor: 0.66 });
  assert.deepEqual(r.suggestions.map((s) => s.number), [801]);
});

test("v7: one token, even repeated in the title, gets no phrase bonus", () => {
  const entries = [...unrelated,
    unitCase(805, "重启插件之后核对",
      "重启插件之前先看后台任务，重启之后核对。重启失败先看日志。"),
    unitCase(806, "重启之前先保存，重启之后核对一次", "重启之前先保存。")];
  const r = predict(entries, "重启一下", { floor: 0.01 });
  assert.ok(r.fired, `the one-token fixture did not fire: ${JSON.stringify(r)}`);
  assert.deepEqual(r.suggestions.map((s) => s.number), [805, 806]);
});

// ---- v9: an entry must be named, not merely share a word ----
//
// Measured on the 395 stored turns 2026-10-31. After v4b/v6/v7 the base still
// fired 45 times with 14 noise turns. Reading those fires showed three opening
// holes; closing all three cut noise to 7 and lost no good fire:
//
//   (1) a one-token turn skipped both gates entirely, so 暂停一下 surfaced an
//       entry whose BODY said 暂停. The token now has to be in the title and
//       specific; 怎么备份 (title 备份密码放哪儿) still fires.
//   (2) a discourse connector counted as a second evidence unit: 所以，没办法了
//       cleared the unit gate only because 所以 appears in the entry for its
//       own reasons. Connectors are not evidence.
//   (3) a generic title word opened the gate unconditionally: 手册 (df 44) and
//       会话 (df 54) are what the manual is made of, so they say "this is an
//       entry", not "this entry is about it". A title word must be specific,
//       or the matched title words must form one contiguous run of >= 3
//       characters: 看不到 in #18's title is a word, 看不 + 不到 scattered
//       around are two generic bigrams.

test("v9: a one-token turn must name the entry's title, not just its body", () => {
  const entries = [unitCase(
    163,
    "后台任务别急着重开",
    "暂停一下再继续，暂停期间不要重开。"
  )];
  const r = predict(entries, "暂停一下", { floor: 0.01 });
  assert.equal(r.fired, false, `a one-token body match fired: ${JSON.stringify(r.suggestions)}`);
});

test("v9: a connector does not split one word into two units", () => {
  const entries = [unitCase(
    213,
    "IM 通道改权限只对新会话生效",
    "所以这办法不行。所以先停。"
  )];
  const r = predict(entries, "所以，没办法了？", { floor: 0.01 });
  assert.equal(r.fired, false, `a connector supplied the second unit: ${JSON.stringify(r.suggestions)}`);
});

// 手册 in the fillers pushes df to 13 > the fixture's cap of 9, so the title
// word is generic here just as it is on the live manual (df 44).
const bookish = Array.from({ length: 12 }, (_, i) => unitCase(
  930 + i,
  `日常记录 ${i + 1}`,
  "手册里的杂项先记这里，别处不放。"
));

test("v9: a generic title word does not open the gate on its own", () => {
  const entries = [...bookish, unitCase(
    162,
    "手册总览与入口",
    "手册没有刷新之前先别读。"
  )];
  const r = predict(entries, "记手册没有", { floor: 0.01 });
  assert.equal(r.fired, false, `a generic title word opened the gate: ${JSON.stringify(r.suggestions)}`);
});

// Same cap trick for 看不 / 不到: df 13 each, so neither word is specific.
const blind = Array.from({ length: 12 }, (_, i) => unitCase(
  950 + i,
  `日常记录 ${i + 1}`,
  "看不出来是什么，也找不到原因。"
));

test("v9: a contiguous three-character title phrase still opens the gate", () => {
  const entries = [...blind, unitCase(
    18,
    "插件没动，用户“看不到效果”",
    "看不到效果就先问是不是该重启。"
  )];
  const r = predict(entries, "就是qq看不到", { floor: 0.01 });
  assert.ok(r.fired, `a real title phrase was suppressed: ${JSON.stringify(r)}`);
  assert.deepEqual(r.suggestions.map((s) => s.number), [18]);
});

// ---- v10: ubiquitous words are not evidence unless the entry shares a run --
//
// Measured on the 395 stored turns 2026-10-31. After v9 seven noise fires
// remained; two of them (#237, #287) matched only words the whole manual uses
// — 插件, 安装, 没有 — and shared no three characters in a row with the entry
// they surfaced. A shared run of three characters is what a compound looks
// like: 安装没有 inside an entry is the entry naming what the turn says, while
// a title that says 插件…重启 does not share 重启插件 in the other order.
// Silencing an all-common match with no shared run of three cut exactly those
// two noise fires, both noise, and kept every good fire; no list or top slot
// moved in the replay.
//
// The fillers carry all three words, so each has df 13 > the fixture cap of 9.

const pluginish = Array.from({ length: 12 }, (_, i) => unitCase(
  1000 + i,
  `日常记录 ${i + 1}`,
  "插件更新要记一条。安装包放缓存，没有记录就补上。"
));

test("v10: three ubiquitous words with no shared run are not evidence", () => {
  const entries = [...pluginish, unitCase(
    240,
    "插件重启之前先看安装记录",
    "插件更新后要重启；安装包放缓存；没有记录就先写一条。"
  )];
  const r = predict(entries, "插件，安装没有", { floor: 0.01 });
  assert.equal(r.fired, false, `ubiquitous words opened the gate: ${JSON.stringify(r.suggestions)}`);
});

test("v10: a shared three-character run still opens the gate", () => {
  const entries = [...pluginish, unitCase(
    241,
    "安装没有报错时先重启插件",
    "安装没有报错也要重启插件。"
  )];
  const r = predict(entries, "插件，安装没有", { floor: 0.01 });
  assert.ok(r.fired, `a shared run was suppressed: ${JSON.stringify(r)}`);
  assert.equal(r.suggestions[0].number, 241);
});

// ---- v12: common words must be anchored AND must not name the title ----
//
// Measured on the 395 stored turns 2026-10-31. One noise fire remained where
// the turn and the entry met on common product words, the entry repeated them
// in prose, and none of them was in the title. The shared three-character run
// v10 requires was satisfied by the product name itself. Requiring every
// anchored unit to be common-only AND no matched word in the title cut exactly
// that fire (t102) and moved no other label. The gate also now reads only the
// top relevant candidate; a non-thin runner-up must not reopen a thin top.

const dshish = Array.from({ length: 12 }, (_, i) => unitCase(
  1200 + i,
  `日常记录 ${i + 1}`,
  "dsh 和插件的杂项都记这里。"
));

test("v12: common words anchored in prose but absent from the title are not evidence", () => {
  const entries = [...dshish, unitCase(
    255,
    "Electron 桌面应用起不来",
    "dsh dsh dsh 的事还要插件插件配合一下，再试。"
  )];
  const r = predict(entries, "dsh 插件", { floor: 0.01 });
  assert.equal(r.fired, false, `common prose evidence opened the gate: ${JSON.stringify(r.suggestions)}`);
});

test("v12: a title match on the same common words still opens the gate", () => {
  const entries = [...dshish, unitCase(
    256,
    "DSH 插件的安装记录",
    "dsh dsh dsh 的事还要插件插件配合一下，再试。"
  )];
  const r = predict(entries, "dsh 插件", { floor: 0.01 });
  assert.ok(r.fired, `a title match was suppressed: ${JSON.stringify(r)}`);
  assert.equal(r.suggestions[0].number, 256);
});

const netish = Array.from({ length: 12 }, (_, i) => unitCase(
  1300 + i,
  `日常记录 ${i + 1}`,
  "dsh 和 github 的杂项都记这里。"
));

test("v12: only the top relevant candidate decides whether the turn opens", () => {
  const entries = [
    ...netish,
    unitCase(39, "联网老出问题？两个独立的病", "dsh dsh dsh dsh github github github github"),
    unitCase(255, "DSH 的记录", "github。")
  ];
  const r = predict(entries, "dsh github", { floor: 0.01 });
  assert.equal(r.fired, false, `a non-thin runner-up reopened a thin top: ${JSON.stringify(r.suggestions)}`);
});

test("v12: a non-thin top candidate still opens the turn", () => {
  const entries = [
    ...netish,
    unitCase(39, "联网老出问题？两个独立的病", "dsh dsh dsh dsh github github github github 网络问题。"),
    unitCase(255, "DSH github 的记录", "github 只是提一句。" + "无关的话。".repeat(3))
  ];
  const r = predict(entries, "dsh github", { floor: 0.01 });
  assert.ok(r.fired, `a non-thin top was suppressed: ${JSON.stringify(r)}`);
  assert.ok(r.suggestions.some((s) => s.number === 255), `#255 missing: ${JSON.stringify(r.suggestions)}`);
});

// ---- v13: an address term is not evidence ----
//
// 助手 is how the user ADDRESSES the assistant, not what the turn is about.
// It sits in 4 entries of the live manual, so the df gate calls it specific,
// and after coverage stopped counting cross-word bigrams it was the second unit
// that lifted pure endearment turns over the floor (t11 -> #61 at 0.570,
// t93 -> #270 at 0.527, measured on the 395 stored turns 2026-10-31).
// Filtering it from evidence silences those turns and keeps real questions.
// This fixture reproduces the shape at small scale: 用户 and 助手 each appear
// once in prose and neither title carries them, so 助手 was the only second
// unit separating the turn from a thin one-mention match.
const endearment = [
  { number: 61, title: "sessions 不进备份", path: "02-method/61.md", body: "用户原话：我不想失去助手，所以需要备份。备份包和密码分开放。" },
  { number: 270, title: "没明说，不碰别的 API", path: "01-rules/270.md", body: "用户原话：你又私自用我的其它额度了，助手。配置类任务也不豁免。" },
  { number: 58, title: "备份与自保", path: "01-rules/58.md", body: "备份包和密码分开放，不放在同一块盘上，避免一起坏掉。" }
];

test("v13: addressing the assistant is not topic evidence", () => {
  const r = predict(endearment, "咦，助手很冷静呢，是不在乎用户吗？", { floor: 0.2 });
  assert.equal(r.fired, false, `an endearment turn fired: ${JSON.stringify(r.suggestions)}`);
});

test("v13: a real question in the same fixture still fires", () => {
  const r = predict(endearment, "备份密码放哪块盘上安全", { floor: 0.2 });
  assert.ok(r.fired, `the control question was suppressed: ${JSON.stringify(r)}`);
  assert.equal(r.suggestions[0].number, 58);
});
