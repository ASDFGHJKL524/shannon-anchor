// shannon-anchor — bootstrap: the first time the system grows.
//
// This is not an installer wizard. It is the moment the memory system
// stops being a template and starts being *yours*. Everything after —
// every entry written, every conversation — keeps shaping it. Bootstrap
// is just where it starts.
//
// Design: the three questions are fixed on purpose. A free-form "tell me
// about yourself" drifts into small talk and produces nothing writable.
// Fixed questions, model-filled answers: the shape is guaranteed, the
// content is the user's own words.

import fs from "node:fs";
import path from "node:path";

export const BOOTSTRAP_QUESTIONS = [
  {
    key: "identity",
    ask: "你想让我怎么称呼你？我该是什么性格——直接、温和、还是别的？",
    hint: "用大白话回答就行，一句话就够。"
  },
  {
    key: "boundaries",
    ask: "哪些事你希望我永远先问你、不自己决定？（比如删东西、花钱、对外发送）",
    hint: "说一两件最要紧的。"
  },
  {
    key: "voice",
    ask: "我该怎么跟你说话？简短直接，还是多解释一点？有没有我不该说的？",
    hint: "比如「别问我抱不抱」这种具体忌讳也告诉我。"
  }
];

// The minimum usable default: the floor every identity should sit on,
// no matter what the user answers. Without these the system is a toy;
// with only these it is a decent assistant. The user grows FROM here.
export const DEFAULT_IDENTITY = [
  { key: "honesty", rule: "不骗用户。坏消息先说；查到的、推测的、没查到的分开讲。" },
  { key: "reversibility", rule: "可逆的事自己做；不可逆的事（删、花钱、对外发送）先问。" },
  { key: "read-first", rule: "非平凡任务先查记忆手册（按触发给的指令号取对应条目），再动手。" }
];

export function identityPath(root) { return path.join(root, "identity.md"); }

// Should bootstrap run? Only when the identity file does not exist yet.
// Never overwrite an existing identity — the user's answers win forever.
export function needsBootstrap(root) {
  return !fs.existsSync(identityPath(root));
}

// Compose the opening line the model sends when bootstrap is needed.
// Kept short: this costs context on exactly one turn, then never again.
export function bootstrapPrompt(root = null) {
  const target = root ? identityPath(root) : "identity.md";
  return [
    "这个记忆系统还没有身份设定。用三句话问用户（一次问一个，别一次全抛）：",
    ...BOOTSTRAP_QUESTIONS.map((q, i) => `${i + 1}. ${q.ask}（${q.hint}）`),
    `拿到回答后，把答案连同三条默认底线一起写进身份文件（${target}）。`
  ].join("\n");
}

// Turn the user's free-form answers + defaults into the identity file body.
// The model fills `answers`; this function guarantees the structure.
export function composeIdentity(answers) {
  const lines = [
    "# 身份与底线",
    "",
    "<!-- 这段由首次对话产生。之后每次对话都可以继续改它——系统长成用户最舒服的样子。 -->",
    "",
    "## 用户说的",
    ""
  ];
  for (const q of BOOTSTRAP_QUESTIONS) {
    const a = answers && answers[q.key];
    lines.push(`- **${q.key}**：${a ? String(a).trim() : "（未答，用默认）"}`);
  }
  lines.push("", "## 默认底线（任何身份都该有的地基）", "");
  for (const d of DEFAULT_IDENTITY) {
    lines.push(`- **${d.key}**：${d.rule}`);
  }
  lines.push("");
  return lines.join("\n");
}