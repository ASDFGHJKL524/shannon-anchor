// usage-index.js — 使用说明的生成源（2026-11-17）。
//
// 动机：插件内部各个部分怎么调用，作者自己也记不得。所以要有说明；
// 但说明一旦写死，下次加模块就过期。这里把它做成生成式：
//   - 模块清单从 lib/*.js 的头注释读（每个文件第一行 // 就是它的用途）
//   - 工具清单从注册处传进来
// 加一个新模块，只要文件头写一句用途，它自动出现在清单和文档里。
//
// 常驻的那份只放任务速查 + 计数，不放全表（全表太长，占的是每一轮的上下文）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SKIP = new Set(["index.js", "usage-index.js", "localjudge.js", "host.js"]);

function purposeOf(text) {
  // 文件是 CRLF：按 "\n" 切完行尾会留 \r，而 .+ 不匹配 \r，正则会整条失配。
  for (const ln of text.split(/\r?\n/).slice(0, 8)) {
    const m = /^\s*\/\/\s*(.+)$/.exec(ln);
    if (!m) {
      if (ln.trim() && !ln.trim().startsWith("//")) break;
      continue;
    }
    let t = m[1].trim();
    if (!t || t.length < 4) continue;
    t = t.replace(/^shannon-anchor\s*[—–-]\s*/, "").replace(/^[a-z-]+\.js\s*[—–-]\s*/, "");
    return t;
  }
  return "";
}

// 每个模块一行：名字 + 用途 + 是否是新加的（新文件没写注释就会被点名）。
export function moduleCatalog(dir = HERE) {
  const out = [];
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".js") || SKIP.has(f)) continue;
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const purpose = purposeOf(text);
    out.push({
      name: f.replace(/\.js$/, ""),
      file: f,
      purpose: purpose || "(未写用途注释)",
      documented: Boolean(purpose)
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// 常驻段：只放"要干什么 → 找哪个工具"，细节仍走 memory_recall。
export const USAGE_LINES = [
  "## 插件用法速查（细节走 memory_search / docs/USAGE.md）",
  "写 memory_write（必带 source；过写入守卫→完整性→复查队列）",
  "找 memory_search / memory_list / memory_recall；predict 每步自动只给编号",
  "改 memory_curate：suggest / link / merge / promote / tag / wrong / retitle / verified",
  "判 memory_review：judge 本地判卷+五道校验，confirm 落裁决；队列满 6 拒写；wrong=内容错会真标到条目",
  "守 删除走两段式（预演拿令牌再 apply）；核心区只认 memory_* 工具；工作区外写入走审批",
  "忘 hot→warm→cold→parked，按「多久没召回」降级，检索漏会把有用的误判成废物",
  "量 memory_metrics / memory_redundancy　　人 persona_recall / voice_case"
];

export function summaryText({ tools = [], modules = [] } = {}) {
  const undocumented = modules.filter((m) => !m.documented).map((m) => m.name);
  const tail = [
    `工具 ${tools.length} 个 / 模块 ${modules.length} 个。完整清单：docs/USAGE.md`,
    undocumented.length
      ? `未写用途注释的模块：${undocumented.join("、")} —— 加模块时在文件头写一句，清单自动收录。`
      : ""
  ].filter(Boolean);
  return [...USAGE_LINES, ...tail].join("\n");
}

// 完整文档：任务速查 + 工具表 + 模块表。gen_usage.mjs 调它。
export function usageDoc({ tools = [], modules = [], root = "<ROOT>" } = {}) {
  const toolRows = tools.length
    ? tools.map((t) => `| \`${t}\` | |`).join("\n")
    : "| （未采集） | |";
  const moduleRows = modules
    .map((m) => `| \`${m.file}\` | ${m.purpose} |`)
    .join("\n");
  return `# shannon-anchor 使用说明（自动生成部分）

> 这份由 \`tools/gen_usage.mjs\` 从代码生成：模块行取自每个文件头注释，工具行取自注册的 tool 名。
> 加模块 = 在文件头写一句用途，重跑生成器。任务视角的用法见 \`docs/USAGE.md\`（手写）。
> 手册根目录：\`${root}\`

## 工具（${tools.length}）

| 工具 | 补充说明 |
|---|---|
${toolRows}

## 模块（${modules.length}）

| 文件 | 用途（取自文件头注释） |
|---|---|
${moduleRows}
`;
}
