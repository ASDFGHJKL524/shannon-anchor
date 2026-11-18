// 当前会话的标识（2026-11-02）。
//
// 为什么要它：热度机制要能区分「这条经验是这轮对话刚用过的」和「上周用过」。
// 只有日期粒度的 lastUsed 分不出来，session 维度才分得出来。
//
// 从哪拿：DSH 把每个会话存成
//   ~/.dsh/sessions/<workspace-key>/<session-id>/
// 其中 <session-id> 目录的 mtime 会随对话实时更新（2026-11-02 实测：对话进行中
// 该目录 mtime 与当前时间相差不到 1 分钟）。父级 workspace 目录的 mtime 不动，
// 所以必须扫到第二层。
//
// 局限（写在明处）：多会话并发时，"最近更新的目录"可能不是发起本次调用的会话。
// 单会话场景准确；并发场景会串一点。等确认了 host 是否在 input.agent 里给
// sessionId，再换成权威来源。宁可先说清楚它不精确，不假装精确。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IGNORE = new Set([".tokens.json", "index.json"]);

// 扫两层，返回 mtime 最新的会话目录名。拿不到就返回 null（调用方按「无会话」处理）。
export function currentSessionId(home = os.homedir()) {
  const base = path.join(home, ".dsh", "sessions");
  let best = null;
  try {
    for (const ws of fs.readdirSync(base, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      const wsPath = path.join(base, ws.name);
      let entries;
      try {
        entries = fs.readdirSync(wsPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (IGNORE.has(e.name)) continue;
        const p = path.join(wsPath, e.name);
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { id: e.name, mtimeMs: st.mtimeMs };
        }
      }
    }
  } catch {
    return null;
  }
  return best ? best.id : null;
}

// 把目录名规整成短 id（去掉 session- 前缀，够用即可；统计里只做相等比较）。
export function shortSessionId(id) {
  if (!id) return null;
  const s = String(id);
  return s.startsWith("session-") ? s.slice(8) : s;
}
