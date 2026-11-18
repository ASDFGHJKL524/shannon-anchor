// shannon-anchor — entry schema + provenance.
//
// Every entry carries: number, title, body, source (why it exists),
// created (date), confidence (user-confirmed | agent-inferred).
// No source, no entry — "no provenance" means "not worth remembering".
//
// Half-life is tracked on two dates (last-named / last-useful); the gap
// between them is the noise signal. Decay thresholds are weighted by
// confidence: self-judged entries rot faster than human-confirmed ones,
// because they are more likely wrong and have no business aging the same.
// The numbers live in the config (coldConfirmedDays / staleConfirmedDays /
// coldInferredDays / staleInferredDays) and are applied by forget.sweep().

// 定制版（2026-10-18）改了这一条。
//
// 原实现返回「最小未用编号」。上游空库那样没问题，但定制版的 manual 是
// 助手的 76 条旧经验整体迁入的，编号里有一个**历史空缺：40**。
// 旧手册规矩写死「编号永远不重排；40 空缺是历史，不许补」
// （manual\10-rules\06-经验库规矩.md）。
// 用最小未用号分配，第 78 条之后的下一次写入就会落进 40 —— 正好违反它。
//
// 所以这里改成 max+1，并显式跳过保留号。编号只增不减，空缺永久留着：
// 它本身就是「这里曾经有过一条、后来没了」的痕迹。
const RESERVED_NUMBERS = new Set([40]);

export function nextFreeNumber(manual) {
  const used = new Set(manual.entries.map((e) => e.number));
  let n = 0;
  for (const num of used) if (num > n) n = num;
  n += 1;
  while (used.has(n) || RESERVED_NUMBERS.has(n)) n += 1;
  return n;
}

export function parseEntry({ number, title, body, source, created, confidence, tags }) {
  if (!title || !title.trim()) throw new Error("entry needs a title");
  if (!body || !body.trim()) throw new Error("entry needs a body");
  if (!source || !source.trim()) throw new Error("entry needs provenance (source)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(created)) throw new Error("created must be YYYY-MM-DD");

  const conf = confidence || "agent-inferred";
  // 规矩（条目 #98/#71）：新条目默认是候选不是事实。agent-inferred 写入
  // 必须带候选标记，真按它做对一件事才转正（人工去标记 + 更新 last-used）。
  // 以前这行只在迁移时手写过，工具写入路径不生成——规矩和实现分家。
  const candidateLine = conf === "agent-inferred"
    ? [`<!-- 候选: ${created} | 待验证 -->`]
    : [];
  // 场景标签（2026-11-03）：3-8 个触发词，覆盖"以后会怎么问起这件事"。
  // 检索时和标题同权重——标题和标签都回答"这条讲什么"，正文回答"具体怎么做"。
  // 没有标签的条目照常工作，只是"用词不同但场景相同"的查询命中不了。
  const tagList = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const tagLine = tagList.length ? [`<!-- tags: ${tagList.join(",")} -->`] : [];
  const lines = [
    `### ${number}. ${title.trim()}`,
    "",
    `<!-- source: ${source.trim()} -->`,
    `<!-- created: ${created} -->`,
    `<!-- confidence: ${conf} -->`,
    ...candidateLine,
    ...tagLine,
    `<!-- half-life: ${created} (named) -->`,
    `<!-- last-used: ${created} -->`,
    "",
    body.trim().replace(/\r\n/g, "\n"),
    ""
  ];
  const rel = pickSection(body);
  return { number, title: title.trim(), source, created, confidence, tags: tagList, lines, path: `${rel}/${number}.md` };
}

function pickSection(body) {
  const t = body.toLowerCase();
  if (/\b(rule|never|always|must|red line)\b/.test(t)) return "01-rules";
  if (/\b(method|step|procedure|workflow)\b/.test(t)) return "02-method";
  if (/\b(this machine|version|path|config)\b/.test(t)) return "03-machine";
  return "04-experience";
}

export function isFuture(dateStr) {
  // Metadata dates are "recorded at" moments. A future one means a typo
  // (or a lie) and corrupts every decay computation downstream.
  // TODAY IS NOT THE FUTURE. The earlier rule (end-of-today + 60s grace)
  // flagged every entry written before midnight on its own date - i.e.
  // every entry ever written. Real bug, caught by a wiring test.
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr === today) return false;
  return dateStr > today;
}
