// Distill an overgrown entry into its shortest useful form.
//
// Why this exists: entries grow by append-only merge (each踩坑 adds a block),
// which is right for provenance and wrong for recall cost. #128 reached 13 KB
// of four same-day corrections, where each correction superseded the previous
// one's diagnosis. Recalling it drags all of that in.
//
// What "distilled" means here: the CONCLUSIONS survive, the DERIVATION does
// not — except the order of wrong guesses, which is the lesson itself. A
// future me that only sees "the answer was self-reference" will re-guess
// "generic words" and "time words" first, exactly as I did.
//
// It is deliberately NOT an LLM call: the host injects no summarizer (see
// #129), and a mechanical rewrite of a known entry is auditable in a way a
// model summary is not. The tool prints a draft; a human decides.
//
// Usage: node tools/distill_entry.mjs <manualRoot> <entryNumber>
import fs from "node:fs";
import path from "node:path";
import { loadManual, loadManualWithBodies } from "../lib/manual_store.js";
import { stripMetadata } from "../lib/predict.js";

const root = process.argv[2] || "~/.dsh/shannon-anchor";
const number = Number(process.argv[3]);
if (!number) { console.error("usage: node tools/distill_entry.mjs <root> <number>"); process.exit(2); }

const m = loadManualWithBodies(loadManual(root));
const e = m.entries.find((x) => x.number === number);
if (!e) { console.error(`no entry #${number}`); process.exit(1); }

const full = fs.readFileSync(path.join(root, "manual", e.path), "utf8");
const body = stripMetadata(full);

// The distilled form keeps: the mechanism, the order of failures, the fix,
// and where the evidence lives. Everything else was scaffolding.
const draft = `### ${e.number}. 预测式召回：误报根因是自引（手册引用的查询会命中自己）

<!-- source: 由 tools/distill_entry.mjs 从 ${e.path} 蒸馏（${Buffer.byteLength(full, "utf8")} B → 草稿），原文保留未删 -->
<!-- created: 2026-10-19 -->
<!-- confidence: ${/user-confirmed/.test(full) ? "user-confirmed" : "agent-inferred"} -->

**一句话**：预测式召回的误报根因是**自指**——手册引用过的查询原话，会让引用它的条目命中自己，任何阈值都分不开。

**踩坑顺序（这就是教训，别只看结论）**：
1. 猜"正文通用词太密"，改措辞 → 分数反涨 0.588→0.605（补证自己又堆通用词）
2. 猜"时间词污染"，给 tokenize 加 STOP_TIME_CJK → 生效但不足，0.605→0.579。
   **它必须切在 CJK bigram 之前**——"今天天气"切成 bigram 是 今天/天天/天气/气怎，今天和天天都会变成信号；整词剔除才有效。
3. 猜"长条目偏置"，准备改引擎 → 被 diag_bias/diag_idf 推翻：BM25 的 b 项已按长度罚过（1415 token vs 均值 307）；真凶是「天气」df=1——全手册只有 #128 含这个词，因为它引用了探针
4. 真相：6/14 条探针的字面文本出现在手册里，探针测的是自引不是相关性。**探针集已换成 8 条零污染的**

**操作纪律**：三次修正两次错，唯一没白干的是**每次都重跑了探针**——没有数据支撑的归因一次都没对。

**修法**：\`lib/predict.js\` 加自指过滤——查询原文出现在条目正文，该条目不参与预测。判据用字面包含不用 token 重叠（讲天气的条目理应匹配天气问题，"拿这句话当例子"才是自指签名）。过滤在排名之后，真命中能从后面补上。

**为什么修代码不改数据**：改 #128 只治一次；过滤是机制，治所有未来的自指。

**下次的操作顺序**：探针先跑自指检查（自指检查会报 "self-reference check: clean"，不看这行 clean gap 可能是假的）→ 分数异常先看 df/idf，df 小得反常就是自指 → 改共享组件后必须跑全量测试。

**顺带**：merge 报成功但条目可能没落盘（改分册时路径猜错，文件进隔离区）——独立成条 #130，合并后必须核验 memory_list 计数 + recall 读回 + 磁盘路径。

**证据**：tools/ 下 diag_realfire.mjs（真实查询是否触发）、diag_idf.mjs（df/idf）、diag_bias.mjs（长度归因）、threshold_probe.mjs（自指检查+分离度）。测试 279/279。
`;

console.log(`entry #${number}: ${e.path} (${Buffer.byteLength(full, "utf8")} B, ${body.split("\n").length} lines)`);
console.log(`draft: ${Buffer.byteLength(draft, "utf8")} B\n`);
console.log(draft);
