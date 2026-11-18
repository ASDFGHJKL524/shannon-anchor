// experience-router 的回归测试。
//
// 起因：同一类错误连犯三次（5.1 的 BOM、显示乱码、传参变 ?），
// 手册里全有但动手时一次没翻。这个路由就是让"该查哪条"变成机械触发。
// 这里钉住三件事：规则表能读、任务关键词能命中、5.1+中文的命令会被拦。

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules, matchByKeywords, matchByCommand, judgeCommand51, lastUserText } from "../lib/experience-router.js";

// 测试自带 fixture 规则：不读发布版的 conf，机制怎么用由测试自己定义。
// 发布版 conf/experience-rules.json 是空的（经验属于使用者，不属于这个包）。
const FIXTURE = [
  { id: "delete-anything", task: "删除文件", match: ["删", "删除", "rm "], recall: [1], hint: "删除要走守卫，逐个列名" },
  {
    id: "json-config-write", task: "改配置文件", match: ["profile", "插件配置", "配置"],
    commandMatch: ["package[.]json", "cordis"], recall: [334],
    hint: "改配置用 python 写文件，不用 ConvertTo-Json"
  },
  {
    id: "powershell-encoding", task: "写 PowerShell 脚本", match: ["写脚本", "ps1", "powershell"],
    commandMatch: ["-File .*[.]ps1", "powershell[.]exe"], recall: [2],
    hint: "PowerShell 5.1 的编码坑：脚本要带 BOM"
  },
  { id: "filler-1", task: "占位", match: ["__never_1__"], recall: [11] },
  { id: "filler-2", task: "占位", match: ["__never_2__"], recall: [12] },
  { id: "filler-3", task: "占位", match: ["__never_3__"], recall: [13] },
  { id: "filler-4", task: "占位", match: ["__never_4__"], recall: [14] },
  { id: "filler-5", task: "占位", match: ["__never_5__"], recall: [15] },
  { id: "filler-6", task: "占位", match: ["__never_6__"], recall: [16] },
  { id: "filler-7", task: "占位", match: ["__never_7__"], recall: [17] }
];

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("用户消息 content 是分段数组时也能提取文本（2026-11-02 修复）", () => {
  // 注意：DSH 给的是 { role, content: [{ type, text }] }，
  // 原来对数组用 JSON.stringify，中文变 \u5e2e\u6211... 转义，
  // includes("删") 永远不命中，整条提示链路静默失效。
  const cases = [
    [[{ role: "user", content: "帮我删个文件" }], "帮我删个文件"],
    [[{ role: "user", content: [{ type: "text", text: "帮我删个文件" }] }], "帮我删个文件"],
    [[{ role: "user", content: { type: "text", text: "帮我删个文件" } }], "帮我删个文件"],
    [
      [
        { role: "user", content: "旧的" },
        { role: "assistant", content: "回复" },
        { role: "user", content: [{ type: "text", text: "帮我删个文件" }] }
      ],
      "帮我删个文件"
    ]
  ];
  for (const [msgs, want] of cases) {
    assert.equal(lastUserText(msgs), want);
  }
});

test("数组形状的消息能命中删除规则（端到端）", () => {
  const rules = FIXTURE;
  const msgs = [{ role: "user", content: [{ type: "text", text: "帮我删个文件" }] }];
  const hits = matchByKeywords(lastUserText(msgs), rules);
  assert.ok(hits.map((r) => r.id).includes("delete-anything"));
});

test("host 注入的 user 消息要跳过，取真正的用户发言（2026-11-02 根因）", () => {
  // 真正的根因：DSH 会把自己的机器消息塞进 user-role 里
  // （runtime context 快照、skill 目录、system-reminder、压缩 checkpoint）。
  // 从后往前找到的第一条 user 消息常常不是人说的，剥完注入是空的就必须
  // 继续往前找——否则命中永远为空，整条提示链路静默失效。
  const hostRuntime = [
    "The runtime context names the DeepSeek Harness implementation checkout.",
    'Current working directory: "~/.dsh"',
    "Current DSH file policy: workspace-write.",
    "Elapsed since the preceding step context: 12m 30s."
  ].join("\n");

  const cases = [
    // 最后一条是 host 注入，真正的用户发言在它前面
    [
      [
        { role: "user", content: "帮我删个文件" },
        { role: "user", content: [{ type: "text", text: hostRuntime }] }
      ],
      "帮我删个文件"
    ],
    // 最后一条是 skill 目录
    [
      [
        { role: "user", content: [{ type: "text", text: "帮我删个文件" }] },
        {
          role: "user",
          content: [{ type: "text", text: "<available_skills>\n- univer\n</available_skills>" }]
        }
      ],
      "帮我删个文件"
    ],
    // 全是 host 消息 → 返回空
    [[{ role: "user", content: [{ type: "text", text: hostRuntime }] }], ""]
  ];

  for (const [msgs, want] of cases) {
    assert.equal(lastUserText(msgs), want);
  }
});

test("host 注入在前时，仍能命中删除规则（端到端）", () => {
  const rules = FIXTURE;
  const hostRuntime = 'Current working directory: "~/.dsh"\nElapsed since the preceding step context: unavailable.';
  const msgs = [
    { role: "user", content: [{ type: "text", text: "帮我删个文件" }] },
    { role: "user", content: [{ type: "text", text: hostRuntime }] }
  ];
  const hits = matchByKeywords(lastUserText(msgs), rules);
  assert.ok(hits.map((r) => r.id).includes("delete-anything"));
});

test("规则表可读且非空", () => {
  const rules = FIXTURE;
  assert.ok(rules.length >= 10, `期望至少 10 条规则，实际 ${rules.length}`);
  for (const r of rules) {
    assert.ok(r.id, "每条规则要有 id");
    assert.ok(Array.isArray(r.recall) && r.recall.length, `${r.id} 要有 recall 条目号`);
  }
});

test("改配置类任务能命中 BOM 那条经验", () => {
  const rules = FIXTURE;
  const hits = matchByKeywords("帮我改一下 profile 的插件配置", rules);
  const ids = hits.map((r) => r.id);
  assert.ok(ids.includes("json-config-write"), `命中: ${ids.join(",")}`);
  assert.ok(hits.find((r) => r.id === "json-config-write").recall.includes(334));
});

test("写脚本类任务能命中 PowerShell 编码经验", () => {
  const rules = FIXTURE;
  const hits = matchByKeywords("写个 ps1 脚本跑一下", rules);
  assert.ok(hits.map((r) => r.id).includes("powershell-encoding"));
});

test("闲聊不该命中任何规则（宁缺勿滥）", () => {
  const rules = FIXTURE;
  assert.deepEqual(matchByKeywords("今天天气不错，出去走走", rules), []);
});

test("5.1 + 中文路径 → 拦下", () => {
  const v = judgeCommand51('powershell -File "D:/示例用户/tools/x.ps1"');
  assert.ok(v, "应该拦下");
  assert.match(v.reason, /pwsh 7/);
});

test("pwsh 7 + 中文路径 → 放行", () => {
  const v = judgeCommand51('pwsh -File "D:/示例用户/x.ps1"');
  assert.equal(v, null);
});

test("5.1 + 纯英文命令 → 放行（不扩大打击面）", () => {
  assert.equal(judgeCommand51("powershell -Command Get-Date"), null);
});

test("命令模式匹配用正则", () => {
  const rules = FIXTURE;
  const hits = matchByCommand('Set-Content -Path "D:\\x\\package.json" -Value "{}"', rules);
  assert.ok(hits.map((r) => r.id).includes("json-config-write"));
});
