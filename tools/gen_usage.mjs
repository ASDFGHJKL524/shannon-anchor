// 从代码生成"使用说明的自动部分"：模块行取自 lib/*.js 头注释，工具行取自注册处。
// 用法：node tools/gen_usage.mjs [manualRoot]
// 加模块 = 在文件头写一句 // 用途，重跑一次；不写注释的模块会被点名。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { moduleCatalog, usageDoc } from "../lib/usage-index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, "..");
const LIB = path.join(PLUGIN, "lib");

const root = process.argv[2] || "<ROOT>";

const indexSrc = fs.readFileSync(path.join(LIB, "index.js"), "utf8");
const tools = [...indexSrc.matchAll(/^\s+name:\s*"([a-z_]+)"/gm)].map((m) => m[1]);
const modules = moduleCatalog(LIB);

const doc = usageDoc({ tools, modules, root });
const out = path.join(PLUGIN, "docs", "USAGE-GENERATED.md");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, doc, "utf8");

const undocumented = modules.filter((m) => !m.documented).map((m) => m.name);
console.log(`工具 ${tools.length} 个：${tools.join("、")}`);
console.log(`模块 ${modules.length} 个，未写用途注释 ${undocumented.length} 个${undocumented.length ? "：" + undocumented.join("、") : ""}`);
console.log(`写到 ${out}`);
