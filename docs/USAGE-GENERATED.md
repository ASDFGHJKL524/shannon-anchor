# shannon-anchor 使用说明（自动生成部分）

> 这份由 `tools/gen_usage.mjs` 从代码生成：模块行取自每个文件头注释，工具行取自注册的 tool 名。
> 加模块 = 在文件头写一句用途，重跑生成器。任务视角的用法见 `docs/USAGE.md`（手写）。
> 手册根目录：`~/.dsh/shannon-anchor`

## 工具（15）

| 工具 | 补充说明 |
|---|---|
| `memory_list` | |
| `memory_search` | |
| `memory_recall` | |
| `memory_write` | |
| `memory_rewrite` | |
| `memory_curate` | |
| `memory_distill` | |
| `memory_review` | |
| `memory_config` | |
| `memory_forget` | |
| `memory_redundancy` | |
| `memory_metrics` | |
| `voice_case` | |
| `persona_recall` | |
| `persona_status` | |

## 模块（29）

| 文件 | 用途（取自文件头注释） |
|---|---|
| `bootstrap.js` | bootstrap: the first time the system grows. |
| `config.js` | config layer: user-private customization. |
| `core-guard.js` | core-guard — 核心区写入白名单（dry-run 阶段）。 |
| `curate.js` | curate: the shape layer (self-stacking, phase 1). |
| `distill.js` | distill engine: automatic accumulation. |
| `embedding.js` | embedding backends: make retrieval pluggable for real. |
| `entries.js` | entry schema + provenance. |
| `eviction.js` | the ledger for everything that leaves a queue. |
| `experience-autofill.js` | experience-autofill — 规则表的自我补全 |
| `experience-router.js` | experience-router — 任务 → 经验 的路由（纯函数层）。 |
| `focus.js` | focus half (migrated from dsh-focus-mode, 2026-11-01 P2). |
| `forget.js` | forgetting: three tiers, decay, never destroy. |
| `guard.js` | the guard gates: write-guard and delete-guard. |
| `hash_chain.js` | hash chain: the only hard gate. |
| `integrity.js` | integrity: judge whether an entry is trustworthy BEFORE it |
| `judge.js` | judge layer: System-One-style decisions, local, no LLM. |
| `loop-guard.js` | loop-guard — 思维链复读检测与止损。 |
| `manual_store.js` | manual store: index + numbered entry files on disk. |
| `metrics.js` | metrics: measure whether the memory system is actually working. |
| `persona.js` | persona: 人格判例库（运行时读取） |
| `predict.js` | predictive recall: surface the entries the CURRENT turn needs, |
| `queue.js` | bounded queue with slot reservation (Phase 4). |
| `redundancy.js` | redundancy: 只读的冗余检测（2026-11-03）。 |
| `retrieval.js` | retrieval: find entries without loading them all. |
| `review.js` | the write-after review queue (plan §2A, plugin side only). |
| `session-id.js` | 当前会话的标识（2026-11-02）。 |
| `tokenize.js` | tokenizer: the shared text-cutting logic. |
| `triggers.js` | task triggers: a mechanical bell that rings only when the |
| `voice.js` | voice: the case library for HOW 助手 talks. |
