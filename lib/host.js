// host.js — 宿主接口适配层（2026-11-17）。
//
// 为什么要有这一层：插件没有 engines.dsh / peerDependencies，DSH 升级不会拦它，
// 也不会保护它。接口一旦改名，原来那些 ctx.tools.register / ctx.systemPrompt.section
// 就直接炸掉或静默失效，而失败点散在 index.js 十几处，没法统一应对。
//
// 这里只做一件能力范围内的事：**接口改名或换位置**时挨个试候选名，探中哪个记下来。
// 做不到的事说清楚：参数形状变了（{name,order,text} → {id,priority,render}）、
// 事件语义变了（next() 不再放行、payload 换字段），这里一概猜不出来，只能报告缺什么，
// 让人去改。自动去改自己的代码是另一种事故：改坏了没人验证，比报错更难查。
//
// 所有适配必须留痕：只要有一条走了候选路径或者彻底没找到，就写 runtime/host-report.json。
// 静默适配比不兼容更危险——插件用错分支跑起来，日志一片正常，提示没注入也没人知道。
import fs from "node:fs";
import path from "node:path";

// 按 DSH 现在的名字排第一位，后面是"如果哪天改名，最可能叫什么"。
const CANDIDATES = {
  tools: ["tools.register", "tool.register", "tools.add", "tools.define"],
  prompt: ["systemPrompt.section", "prompt.section", "prompts.section", "systemPrompt.add", "prompts.add"],
  event: ["on", "event.on", "events.on", "hook", "hooks.on"],
  logger: ["logger", "log", "console"]
};

// 报错给人看，用可读名而不是内部 key——"缺少 tools"不如"缺少 ctx.tools.register()"好查。
const LABELS = {
  tools: "ctx.tools.register()（工具注册）",
  prompt: "ctx.systemPrompt.section()（提示注入）",
  event: "ctx.on()（事件钩子）",
  logger: "ctx.logger（日志）"
};

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

// 取方法并绑定到它的 owner：ctx.tools.register 的 this 必须是 ctx.tools，
// 直接拿函数引用会在某些实现里丢掉 this。
function pickCallable(ctx, label, paths) {
  for (const p of paths) {
    const parts = p.split(".");
    const name = parts.pop();
    const owner = parts.length ? getPath(ctx, parts.join(".")) : ctx;
    const fn = owner && owner[name];
    if (typeof fn === "function") {
      return { fn: fn.bind(owner), path: p };
    }
  }
  return { fn: null, path: null, missing: LABELS[label] || label };
}

function pickLogger(ctx) {
  for (const p of CANDIDATES.logger) {
    const v = getPath(ctx, p);
    if (v && typeof v.info === "function") return { logger: v, path: p };
  }
  const noop = () => {};
  return { logger: { info: noop, warn: noop, error: noop, debug: noop }, path: null, missing: LABELS.logger };
}

export function resolveHost(ctx, opts = {}) {
  const report = {
    at: new Date().toISOString(),
    dsh: process.env.DSH_VERSION || null,
    picked: {},
    missing: [],
    degraded: false
  };

  const tools = pickCallable(ctx, "tools", CANDIDATES.tools);
  const prompt = pickCallable(ctx, "prompt", CANDIDATES.prompt);
  const event = pickCallable(ctx, "event", CANDIDATES.event);
  const log = pickLogger(ctx);

  for (const [key, r] of [["tools", tools], ["prompt", prompt], ["event", event], ["logger", log]]) {
    if (r.path) report.picked[key] = r.path;
    if (r.missing) report.missing.push(r.missing);
  }
  report.degraded = report.missing.length > 0;

  if (report.degraded) {
    const msg = `shannon-anchor: 与当前 DSH 不兼容，缺少 ${report.missing.join("、")}。插件不会正常工作；升级 DSH 后请重跑 test/ 下的回归。`;
    try {
      log.logger.error(msg);
    } catch {
      console.error(msg);
    }
    if (opts.strictHost === true) throw new Error(msg);
  } else {
    // 只有"走了非原生路径"才值得说一声——说明 DSH 改过名，但这次命中了候选。
    const nonNative = Object.entries(report.picked).filter(([k, v]) => CANDIDATES[k] && CANDIDATES[k][0] !== v);
    if (nonNative.length) {
      log.logger.warn(
        `shannon-anchor: 已自动适配宿主接口 ${nonNative.map(([k, v]) => `${k}=${v}`).join("，")}（原生路径不可用）`
      );
    }
  }

  return {
    report,
    logger: log.logger,
    registerTool: tools.fn || (() => {}),
    // promptSection 缺失时给 no-op：提示注入没了是降级，不该让整个 apply 炸掉。
    promptSection: prompt.fn || (() => {}),
    on: event.fn || (() => {})
  };
}

// 只在出过问题时落盘：正常启动不写，免得每次开机都多一个文件要清理。
export function writeHostReport(root, report) {
  if (!report || (!report.degraded && !hasAdapted(report))) return { ok: false, reason: "nothing to report" };
  try {
    const dir = path.join(root, "runtime");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "host-report.json");
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

export function hasAdapted(report) {
  if (!report || !report.picked) return false;
  return Object.entries(report.picked).some(([k, v]) => CANDIDATES[k] && CANDIDATES[k][0] !== v);
}

export { CANDIDATES };
