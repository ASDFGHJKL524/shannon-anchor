// loop-guard — 思维链复读检测与止损。
//
// 问题：reasoning 模型偶尔卡在“下一步做什么”的采样上，反复输出
// “做。好。执行。”这类短句，跟原任务脱节。它不是幻觉（没有编造事实），
// 是重复退化；客户端拿不到 frequency_penalty 这类刹车参数，只能止损。
//
// 做法：订阅 agent/assistant-stream，把 thinking chunk 攒进滑动窗口，
// 用 n-gram 重复率判断；命中后 cancel 当前生成，再 followup 一句
// “原任务继续”，让模型重新起头。每个 turn 最多触发 maxRetries 次。
//
// 边界（明说）：
//   - 只止损，不治本。模型自己停不下来时，这是唯一能做的。
//   - 阈值保守：宁可漏一次，不误杀正常长思考。
//   - 只处理根 agent，子 agent 的流不碰（否则一次复读会连锁取消）。
//   - 流是展示数据，不是历史；这里不写任何记忆。

import fs from "node:fs";
import path from "node:path";

export const DEFAULTS = {
  enabled: true,
  // 滑动窗口（字符）。太短会把正常重复（列表、代码）当复读。
  windowChars: 200,
  // n-gram 长度。8 个中文字符足够区分“正常重复”和“卡死”。
  ngram: 8,
  // 同一 n-gram 在窗口内出现多少次算复读。
  repeatThreshold: 3,
  // 每个 turn 最多止损几次。
  maxRetries: 2,
  // 两次止损之间的最小间隔（毫秒），防止连环取消。
  cooldownMs: 8000,
  // 命中后发给模型的话。
  retryPrompt: "思维链重复了，已中断。原任务继续：直接给下一步动作或结论，不要重复列执行步骤。",
  // 日志目录（相对 manualRoot）。
  logDir: "guard"
};

function resolveCfg(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  cfg.windowChars = Math.floor(num(cfg.windowChars, DEFAULTS.windowChars, 60, 2000));
  cfg.ngram = Math.floor(num(cfg.ngram, DEFAULTS.ngram, 4, 32));
  cfg.repeatThreshold = Math.floor(num(cfg.repeatThreshold, DEFAULTS.repeatThreshold, 2, 10));
  cfg.maxRetries = Math.floor(num(cfg.maxRetries, DEFAULTS.maxRetries, 0, 5));
  cfg.cooldownMs = Math.floor(num(cfg.cooldownMs, DEFAULTS.cooldownMs, 1000, 120000));
  cfg.enabled = cfg.enabled !== false;
  if (typeof cfg.retryPrompt !== "string" || !cfg.retryPrompt.trim()) cfg.retryPrompt = DEFAULTS.retryPrompt;
  return cfg;
}

// 从 chunk 里取 thinking 文本。宿主把 reasoning 包成 {type:'thinking', thinking}
// 或 {type:'reasoning', text}，两种都认；普通正文 chunk 不参与检测。
export function thinkingTextOf(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const t = String(chunk.type || "");
  if (t === "thinking" || t === "reasoning") {
    if (typeof chunk.thinking === "string") return chunk.thinking;
    if (typeof chunk.text === "string") return chunk.text;
    if (typeof chunk.reasoning === "string") return chunk.reasoning;
  }
  return "";
}

// 去掉代码块和表格：它们天然重复，不该算复读。
export function stripNoise(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/[ \t]+/g, " ");
}

// 返回命中的 n-gram 与次数；没命中返回 null。
//
// 窗口不足时用现有长度，不直接放弃：短句循环（“做。好。执行。”）在
// 140 字时就已经卡死了，等攒满 200 字才判等于放过它。
export function detectLoop(text, cfg) {
  const clean = stripNoise(text);
  const n = cfg.ngram;
  if (clean.length < n * cfg.repeatThreshold) return null;
  const win = clean.slice(-cfg.windowChars);
  const counts = new Map();
  for (let i = 0; i + n <= win.length; i++) {
    const g = win.slice(i, i + n);
    if (/^[\s。，、；：！？.,;:!?]+$/.test(g)) continue; // 纯标点不算
    const c = (counts.get(g) || 0) + 1;
    counts.set(g, c);
    if (c >= cfg.repeatThreshold) return { gram: g, count: c, window: win };
  }
  return null;
}

// 每个 agent 一份状态：窗口文本、本 turn 已止损次数、上次止损时间。
export function createLoopGuard({ root, cfg: rawCfg, logger, now = () => Date.now() }) {
  const cfg = resolveCfg(rawCfg);
  const states = new Map();
  const logFile = path.join(root, cfg.logDir, "loop-guard.jsonl");

  function stateOf(agentId) {
    let s = states.get(agentId);
    if (!s) {
      // lastFire = -Infinity：从未触发过就不该受冷却限制。
      // 用 0 会让“模拟时钟”场景里的首轮命中被误挡。
      s = { buf: "", retries: 0, lastFire: -Infinity, turn: null };
      states.set(agentId, s);
    }
    return s;
  }

  function log(rec) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify({ at: new Date(now()).toISOString(), ...rec }) + "\n", "utf8");
    } catch { /* 日志失败不能影响止损 */ }
  }

  // 返回 { fired, gram, count } 或 null。
  //
  // 判据是“窗口里出现 ≥3 次”。真实流是逐 chunk 喂的，窗口会继续增长，
  // 命中次数随之上升；测试和一次性喂入要按同样节奏分片，否则测的是
  // “刚好够线”。另外：命中后清空窗口，下一轮要重新攒够 3 次才会再触发，
  // 这是有意的——连续两次误判比漏一次更糟。
  //
  // 窗口是“最近 windowChars 字”，所以一次喂入超过窗口长度的文本时，
  // 前面的内容会被挤掉；调用方按 chunk 喂即可，不必自己切。
  //
  // 命中判定用“窗口内出现次数”，不是“连续出现”：真实复读里常夹着
  // 换行和标点，连续匹配会漏。代价是正常文本里同一短语出现 3 次也会
  // 命中——所以阈值取 8 字，且只在 thinking 里判，正文不参与。
  //
  // 注意：窗口是 200 字，而 140 字的循环只够命中一次。真实流里窗口
  // 会持续增长，所以第二次命中要等窗口再攒够；测试用 feedText 按
  // chunk 喂，并喂两遍循环来模拟“窗口继续增长”。
  function feed(agentId, text, turn) {
    if (!cfg.enabled) return null;
    const s = stateOf(agentId);
    if (turn !== undefined && turn !== null && turn !== s.turn) {
      s.turn = turn;
      s.retries = 0;
      s.buf = "";
    }
    s.buf = (s.buf + text).slice(-cfg.windowChars * 2);
    const hit = detectLoop(s.buf, cfg);
    if (!hit) return null;
    const t = now();
    if (s.retries >= cfg.maxRetries) return null;
    if (t - s.lastFire < cfg.cooldownMs) return null;
    s.retries += 1;
    s.lastFire = t;
    s.buf = "";
    log({ agent: agentId, turn: s.turn, gram: hit.gram, count: hit.count, retry: s.retries });
    return { fired: true, gram: hit.gram, count: hit.count, retry: s.retries };
  }

  // 测试与调试用：直接喂一段文本，按 chunk 切分，模拟真实流。
  // 真实宿主不需要它——installLoopGuard 已经按 chunk 喂了。
  function feedText(agentId, text, turn, chunkSize = 20) {
    const chunks = String(text).match(new RegExp(`[\\s\\S]{1,${chunkSize}}`, "g")) || [];
    let last = null;
    for (const c of chunks) {
      const r = feed(agentId, c, turn);
      if (r) last = r;
    }
    return last;
  }

  function reset(agentId) {
    states.delete(agentId);
  }

  return { cfg, feed, feedText, reset, logFile, states };
}

// 把 guard 接到宿主事件上。独立 try/catch：订阅失败只记日志，
// 不拖垮 shannon-anchor 的其他模块。
export function installLoopGuard(ctx, { root, cfg, logger }) {
  const guard = createLoopGuard({ root, cfg, logger });
  if (!guard.cfg.enabled) {
    logger?.info?.("shannon-anchor: loop-guard disabled");
    return guard;
  }
  try {
    ctx.on("agent/assistant-stream", ({ agent, frame }) => {
      try {
        if (!frame || frame.type !== "chunk") return;
        // 只处理根 agent：子 agent 的复读不该连锁取消父会话。
        const parent = agent?.header?.parentSession;
        if (parent !== undefined) return;
        const text = thinkingTextOf(frame.chunk);
        if (!text) return;
        const sid = String(agent?.session?.id || agent?.id || "");
        if (!sid) return;
        const hit = guard.feed(sid, text, frame.turn);
        if (!hit) return;
        logger?.info?.(`shannon-anchor: loop-guard fired (gram=${hit.gram}, count=${hit.count}, retry=${hit.retry})`);
        try {
          agent.cancel({ kind: "plugin" }, { keepInbox: true });
        } catch (e) {
          logger?.warn?.(`shannon-anchor: loop-guard cancel failed: ${String(e?.message || e)}`);
          return;
        }
        try {
          agent.followup({
            content: [{ type: "text", text: guard.cfg.retryPrompt }],
            source: { kind: "shannon-anchor-loop-guard" }
          });
        } catch (e) {
          logger?.warn?.(`shannon-anchor: loop-guard followup failed: ${String(e?.message || e)}`);
        }
      } catch (e) {
        logger?.warn?.(`shannon-anchor: loop-guard stream handler failed: ${String(e?.message || e)}`);
      }
    }, { global: true });
  } catch (e) {
    logger?.warn?.(`shannon-anchor: loop-guard subscribe failed: ${String(e?.message || e)}`);
  }
  return guard;
}
