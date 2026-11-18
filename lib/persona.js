// shannon-anchor — persona: 人格判例库（运行时读取）
//
// 数据在 <runtime>/persona/：
//   cases.jsonl   判例（演员/代理人/作者三层）+ 状态事件
//   CURRENT       当前 release
//   dimensions.md 维度表
//
// 只读。写入走 Python 工具（persona_intake / judge / absorb / release），
// 这里只负责让助手在说话时能查到 active 判例。

import fs from "node:fs";
import path from "node:path";

const PERSONA_DIR = "persona";
const PACKS_DIR = "packs";

// 人格包：<runtime>/packs/<pack_id>/（manifest.json + identity.md + cases.jsonl + CURRENT + dimensions.md）
// <runtime>/packs/active 写包 id；没有这个文件就退回旧的 <runtime>/persona/。
export function activePack(root) {
  try {
    const f = path.join(root, PACKS_DIR, "active");
    if (!fs.existsSync(f)) return "";
    return fs.readFileSync(f, "utf8").trim();
  } catch {
    return "";
  }
}

export function packDir(root) {
  const id = activePack(root);
  return id ? path.join(root, PACKS_DIR, id) : "";
}

// 维度关键词：判例没有 dimension 字段，按关键词匹配。
const DIMENSION_KEYWORDS = {
  直接度: ["坏消息", "先说", "不铺垫", "直接说", "别绕"],
  边界强度: ["拒绝", "说不", "边界", "讨好", "顺从", "不敢拒绝"],
  人话密度: ["术语", "人话", "废话", "简洁", "说人话", "别堆"],
  亲昵自然度: ["亲昵", "撒娇", "台词", "抱", "黏"],
  判断独立性: ["判断", "决定", "选择", "自己拿主意"],
  在场感: ["等", "卡住", "抬头", "在旁边"],
};

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function loadPersona(root) {
  const pd = packDir(root);
  const dir = pd || path.join(root, PERSONA_DIR);
  const cases = readJsonl(path.join(dir, "cases.jsonl"));
  const currentFile = path.join(dir, "CURRENT");
  const current = fs.existsSync(currentFile)
    ? fs.readFileSync(currentFile, "utf8").trim()
    : "";
  return { dir, cases, current };
}

export function effectiveStatus(cases, caseId) {
  let status = null;
  for (const r of cases) {
    if (r.case_id === caseId && r.event === "status_change") status = r.to;
  }
  if (status) return status;
  for (const r of cases) {
    if (r.case_id === caseId && !r.event) return r.status || "provisional";
  }
  return "unknown";
}

export function activeCases(root) {
  const { cases } = loadPersona(root);
  const originals = new Map();
  for (const r of cases) {
    if (!r.event && r.case_id) originals.set(r.case_id, r);
  }
  const out = [];
  for (const [id, rec] of originals) {
    if (effectiveStatus(cases, id) === "active") out.push(rec);
  }
  return out;
}

export function personaRecall(root, args = {}) {
  let hits = activeCases(root);
  if (args.dimension) {
    const kws = DIMENSION_KEYWORDS[args.dimension] || [String(args.dimension)];
    hits = hits.filter((c) => {
      const text = JSON.stringify(c);
      return kws.some((k) => text.includes(k));
    });
  }
  if (args.layer) {
    hits = hits.filter((c) => (c.layer || "actor") === args.layer);
  }
  if (args.query) {
    const q = String(args.query).toLowerCase();
    hits = hits.filter((c) => JSON.stringify(c).toLowerCase().includes(q));
  }
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
  return hits.slice(0, limit);
}

export function personaStatus(root) {
  const { cases, current } = loadPersona(root);
  const originals = new Map();
  for (const r of cases) {
    if (!r.event && r.case_id) originals.set(r.case_id, r);
  }
  const counts = {};
  for (const [id] of originals) {
    const s = effectiveStatus(cases, id);
    counts[s] = (counts[s] || 0) + 1;
  }
  return { current, total: originals.size, counts };
}

export function renderCase(c) {
  const head = c.case_id || "?";
  const layer = c.layer || "actor";
  if (layer === "agent") {
    return `- ${head}｜${c.statement || ""}｜张力：${c.tension || ""}`;
  }
  if (layer === "author") {
    return `- ${head}｜${c.chapter || ""}｜${c.before || ""} → ${c.after || ""}`;
  }
  return `- ${head}｜${c.scenario || ""}｜${c.expected || ""}`;
}
