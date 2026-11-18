# shannon-anchor 使用说明

> 这份回答"每部分怎么调用"，不回答"是什么"。
> 细节用 `memory_search` 在你自己的手册里找。
> `<ROOT>` 指手册根目录（`manualRoot` 配置项）。

## 一、写一条经验

`memory_write(title, body, source)`

- **必带 source**，不带直接拒。
- 过三道闸：写入守卫（注入形态 / 密钥 / 来源）→ 完整性闸门（与既有条目重复、矛盾）→ 写后复查队列。
- 结论式内容要带证据。凡"我做了 X 且成功了"，先验过再写；没验过就写明"未验证"。

## 二、找一条经验

| 工具 | 用途 | 边界 |
|---|---|---|
| `memory_search` | BM25 + 向量检索 | `minScore` 默认 0.05；搜得到 ≠ 排得对 |
| `memory_list` | 索引 | 默认只列 hot/warm；`tiers=all` 才见冷条目和退役条目 |
| `memory_recall` | 取全文 | 默认截断 1500 字；`full:true` 要全文 |
| predict（自动） | 每步打分 | 只给编号 + 一行标题，不注入正文 |


## 三、改、并、撤

`memory_curate` 的八个动作：

| action | 用途 | 边界 |
|---|---|---|
| `suggest` | 只读：候选内容和谁像 | 阈值是起点，不是判决 |
| `link` | 标 superseded_by / merged_into | 只加元数据，不动正文 |
| `merge` | 新内容追加进已有条目 | 原文不动，加日期块 |
| `promote` | 候选 → 转正 | 必须给证据 |
| `tag` | 重设场景标签 | 标签参与检索 |
| `wrong` | 标"这条内容错了" | 检索降权 80%、注入跳过、正文保留追溯 |
| `retitle` | 只改标题行 | 正文已更正但标题停在旧结论时用；必须给证据 |
| `verified` | 摘"待复核"标记 | 摘除动作本身就是确认 |

- 写操作都会刷新哈希链。

## 四、判一条（写后复查）

- 队列容量 **6**；满了**拒收新写入**，不驱逐旧的（驱逐会丢掉证据）。
- `memory_review action=judge`：调本地模型判卷 + 五道脚本校验（格式、标的条目存在、不是合并进自己、相关性、drop 时有无证据）。
- `memory_review action=confirm`：落裁决。带 `local:true` 会给条目打「待复核」标记，recall 时露出，核对过用 `verified` 摘。
- 四种裁决：`keep` / `merge`(+into) / `drop`（不值得留）/ `wrong`（内容错了，**会真的标到条目上**）。

## 五、守卫

| 守卫 | 管什么 | 越界了怎么办 |
|---|---|---|
| 写入守卫 | 注入形态、密钥、来源缺失 | 被拦就停，不换措辞重试 |
| 删除守卫 | 一切删除 | 逐个列名、预演拿令牌、再 apply；进隔离区可还原；不许通配符 |
| 核心区守卫 | `<ROOT>/manual`、身份、配置 | 只有 `memory_*` 工具和 `allowCommands` 里配的命令能写 |


## 六、三类队列（同构）

| 队列 | 容量 | 装什么 |
|---|---|---|
| review | 6 | 写后复查 |
| distill | 20 | 回合蒸馏 |
| voice | 8 | 语感案例 |

共同约定：原子预留槽位、满了拒收、不丢已接受内容、淘汰留痕写 `eviction.jsonl`。


## 七、遗忘与淘汰

- 三层：`hot → warm → cold → parked`（进隔离区，可 recall 回来）。
- **淘汰信号是"多久没被召回"，不是"有没有价值"**——检索漏一次，条目就可能被误判成废物。
- 退役条目（superseded / merged_into）要按状态硬过滤，别等遗忘层。

## 八、度量

| 工具 | 看什么 |
|---|---|
| `memory_metrics` | 写入/召回/检索命中/完整性/守卫拦截/哈希链/淘汰 |
| `memory_redundancy` | 只读扫描：重复、过时、从没召回的条目 |

- 数字只能证明"有没有明显坏掉"，不能证明"有用"。

## 九、人格

- `persona_status` / `persona_recall`：判例库状态与检索（按维度/关键词）。
- `voice_case`：语感案例——**怎么说话**，不是**说什么**。
- 判例库怎么设计，见 README 的「人格判例库」一节。

## 十、宿主与环境

- `lib/host.js`：宿主接口候选名探测。DSH 改名能自动接上；缺了会点名报错并写 `runtime/host-report.json`。参数形状和事件语义的变化它挡不住，靠回归测试。
- `memory_config`：读/调配置。`locked` 的 key 只能提案，用户 apply 才生效。
- 断言本机能力（联网、下载、跑模型）之前先实测，单次失败不等于全局不可用。

## 十一、隐藏层（不用手动调，但要知道它在）

| 模块 | 干什么 |
|---|---|
| `triggers.js` | 任务触发的机械提示 |
| `experience-router.js` | 任务 → 经验的路由 |
| `experience-autofill.js` | 规则表自补 |
| `loop-guard.js` | 思维链复读检测与止损 |
| `focus.js` | 专注模式（冻结后台进程） |
| `bootstrap.js` | 首次初始化 |
| `distill.js` | 回合蒸馏（把对话压成经验） |
| `integrity.js` | 写入前的可信度判断 |
| `judge.js` | 本地无 LLM 的判断层 |
| `eviction.js` | 淘汰台账 |
| `hash_chain.js` | 唯一的硬闸门 |

---

## 附：一句话版本

写走 `memory_write`（必带 source），找走 `search/list/recall`，改走 `curate`，判走 `review`，删走两段式守卫，核心区只认 `memory_*` 工具。细节用 `memory_search` 查你自己的手册。
