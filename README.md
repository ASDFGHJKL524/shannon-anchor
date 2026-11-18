# 香农的锚 · shannon-anchor

> **It does not evolve the model. It makes every appearance of the model stand on the shoulders of all past experience.**
> 它不进化模型，它让模型每次出场时，都站在过去所有经验的肩膀上。聪明的是那些文件，不是模型。

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用的持久记忆 + 护栏插件。名字中之所以有香农，是因为它做的这几件事本来就长在信息论里——遗忘的半衰期、冗余扫描、常驻层的字数上限、蒸馏压缩；至于锚，是它对使用者的承诺——模型每次调用都是新起的进程，但它可以让记忆连上，于是每次出场的还是同一个人。

记忆层本身与模型无关（纯文本 + 文件 + 哈希）。DSH 的挂载点只在 DSH 上验证过。

**装上是空的。** 手册从一两条探针条目开始长。

## 能力表

| 能力 | 机制 | 状态 |
|---|---|---|
| 按需取手册 | `memory_list` / `memory_recall` | ✅ |
| **按意思搜** | `memory_search` — BM25 + 256 维特征哈希向量，中文二元组 | ✅ |
| 带出处的写入 | `memory_write` → 扫描 + 审计 + 基线，一个事务 | ✅ |
| **判动作的拦截** | `tools/pre-execute` 按工具名**和**命令内容把删除形状的调用送进删除守卫 | ✅ |
| **核心区白名单** | `core-guard` — 手册/人设/记忆库只认 `memory_*` 与白名单命令 | ✅ |
| **预测性召回** | `predict` — 回合前猜条目，命中才注入，默认关 | ✅ |
| **三类有界队列** | `review` / `distill` / `voice`，背压 + 原子预留 | ✅ |
| **三层遗忘** | 衰减使用计数、7/30/90 天降级、`forgotten/` 可召回、低频条目豁免 | ✅ |
| **淘汰账本** | 离开队列的东西留一行证据，有界 | ✅ |
| **经验路由** | 任务形状 → 经验条目号，机械触发 | ✅ |
| **人格判例库** | `persona_recall` / `persona_status`，按维度检索 | ✅ |
| **语感判例** | `voice_case` — 从纠正里抓候选，确认或丢弃 | ✅ |
| **冗余扫描** | `memory_redundancy` — 只读报告，不删不改 | ✅ |
| **循环检测** | `loop-guard` — 重复片段打断 | ✅ |
| **专注模式** | `focus_mode` — 冻结/恢复后台进程，`engine/` 下的 PowerShell | ✅ |
| 对话式身份 | 固定三问 bootstrap，从不覆盖已有身份 | ✅ |
| 身份进提示 | `identity.md` 正文作为常驻提示段，每次渲染重读 | ✅ |
| 写入前形状检查 | `memory_curate suggest` — 近似重复查询，只建议不拦 | ✅ |
| 链接 / 合并 / 转正 | 只追加的元数据标记，原文永不改写，可回退 | ✅ |
| 用户私有配置 | `default` ← `user` 深合并，锁定键：AI 提议，人决定 | ✅ |
| 哈希链自检 | `computeChain` / `verifyChain` | ✅ |

## 安装

```
dsh plugin --profile web add github:ASDFGHJKL524/shannon-anchor
```

所有路径和阈值都在 `cordis.patch.yml` 的 `config` 里：改补丁，不改代码。

默认 `manualRoot` 是 `~/.dsh/shannon-anchor`。想代码和数据放一起就指到别处——整个目录拷走就能在新机器上复原。

## 配置

`conf/default.json` 是出厂默认，**不要改它**（升级会覆盖）。要改就写 `conf/user.json`，深合并覆盖。

锁定键（`guardWrites` / `guardDeletes`）只能由人应用：AI 可以 `memory_config action=propose` 提议，人 `action=apply` 才生效。每次改动都留 before/after 快照。

## 目录结构

```
shannon-anchor/
  lib/
    index.js         插件入口 + 15 个工具 + 拦截 + 提示段
    manual_store.js  索引生成（分层感知）、superseded 判定
    entries.js       条目 schema、出处、编号分配
    guard.js         写入守卫 + 删除守卫（两段式、隔离区）
    core-guard.js    核心区写入白名单
    hash_chain.js    哈希链
    judge.js         System-One 式判定（noul / choice / score），本地，不调 LLM
    triggers.js      任务触发 → 指令号
    bootstrap.js     对话式身份
    config.js        用户私有配置（锁定键）
    distill.js       蒸馏引擎 + 判据漏斗
    forget.js        三层遗忘
    eviction.js      淘汰账本
    retrieval.js     BM25 + 特征哈希向量检索
    tokenize.js      共享分词器（中文二元组）
    curate.js        形状层：suggest / link / merge / promote / revert
    predict.js       预测性召回
    experience-router.js  任务 → 经验
    experience-autofill.js 未命中记录与自动补全
    persona.js       人格判例库
    voice.js         语感判例
    review.js        写后复查队列
    queue.js         有界队列
    loop-guard.js    循环检测
    redundancy.js    冗余扫描
    metrics.js       指标与诊断
    integrity.js     完整性判定
    embedding.js     向量后端接缝（预留，未接进检索）
    focus.js         专注模式
    session-id.js    会话标识
    instructions.json  指令号 → 条目号映射
  conf/
    default.json     出厂默认
    experience-rules.json  经验路由规则
  engine/            专注模式的 PowerShell 引擎
  test/              480 条验收测试
  tools/             诊断与评估脚本（开发用）
  docs/              设计说明
```

## 测试

```
node test/run.mjs
```

480 条验收测试。闸门必须真咬人（扫描、出处、未来日期、禁通配符删除、两段式令牌、哈希链检测）；判定必须说「未定」而不是瞎猜；漏斗必须筛；遗忘必须不销毁；shell 删手册必须被拦；链接标记必须只追加且可回退；转正的候选必须掉标记。

## 诚实的半成品

写在前面，因为一个藏起自己边界的记忆系统比没有更糟：

1. **哈希链防外人，不防 agent 自己。** agent 改自己的文件，哈希跟着内容一起动，照样报「通过」。真闸门需要 agent 写不到的 manifest——代价是它再也不能自己记东西。
2. **拦截是有开关的闸门。** `guardDeletes: false` 就关了；完全绕过宿主的模型够不着。它去掉的是最省事的绕过——一条删手册路径的 shell 命令不再能从只查工具名的检查里溜过去。
3. **注入不是强制。** 提示或召回的条目进了上下文，模型仍可能不理。唯一的硬约束是 deny 级钩子。
4. **这是行为持久化，不是能力进化。** 模型没学过的推理方式还是不会；手册只是提醒它用已有的方式。
5. **相似度阈值没标定。** `suggest` 的 0.75 / 0.45 是起点，没有数据支撑。建议是输入不是判决；每次 `suggest` 都记一行影子日志，留给以后标定。
6. **`distill.mode=turn` 需要配合的 agent。** 队列只记录「这一轮值得蒸馏」，写条目仍是 agent 自己的动作。不自动写，也不自动清。
7. **`embedding` 是死接线。** 非本地后端（openai / command）的配置只会打一条 warn，不影响检索——检索走的是同步本地哈希向量。留着当接缝，没接。
8. **验证过的是测试套件，不是一支舰队。** 480 条测试覆盖引擎和宿主挂载，不等于在别人机器上跑了一年。

## 设计红线

- 历史只增：被取代的条目打标记，永不解除链接。
- 没出处就没有条目：每次写入 `source` 必填。
- 守卫从不静默覆盖；基线是显式的、有审计的。
- 未来日期的元数据写入时拒绝——没有强制开关，这是设计。
- 删除是可逆地移进隔离区，永不销毁。
- 编号只增：空缺就是空缺，永不回填。
- **宁可拒绝也不猜**：破坏性命令的目标解析不出来就拦下并说明原因——扫一遍从来不是答案。

## License

MIT
