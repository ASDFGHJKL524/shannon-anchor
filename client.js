// shannon-anchor — focus chip (browser half).
//
// 会话标题行 utilities 区的一个状态文字，跟「标准模式」「1 个后台任务」同款：
//   专注中 → 绿点「专注 1:24:07」
//   已停止 → 灰点「专注」（点击开启）
// 点一下切换（走 host 的 /plugins/shannon-anchor/focus/toggle，和手动 on/off 同一条路径）。
//
// 改版说明：原来是一个 position:fixed 的胶囊，靠 right:475px 硬猜位置，
// 会压在标签栏上。现在注册进 conversation.session.header.utilities 官方槽位，
// 位置由布局系统分配，不再猜。
//
// Bundle artifact contract（与 dsh-boot-animation 一致）：
//   window.__ModuleLoader__.load({ id, factory })，require 由 shell 模块表提供。
// 本文件不 import 任何东西，因此不需要打包器，wrapper 就是全部构建。

// 2026-11-01 实测：同一个 client bundle 被两个 URL 各执行一次，第二次会抛
// "duplicate factory registration"，把整个 web 启动打挂。
// 注册一次就够；第二次直接跳过。
if (!window.__SHANNON_ANCHOR_FOCUS_CLIENT__) {
window.__SHANNON_ANCHOR_FOCUS_CLIENT__ = true;
window.__ModuleLoader__.load({ id: "shannon-anchor", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require("react");
const h = React.createElement;

const STATE_URL = "/plugins/shannon-anchor/focus/state";
const TOGGLE_URL = "/plugins/shannon-anchor/focus/toggle";
const POLL_MS = 4000;
const TOGGLE_TIMEOUT_MS = 120000;
const NOTICE_MS = 6000;
const SLOT = "conversation.session.header.utilities";
const CHIP_ID = "shannon-anchor-focus-chip";

const pad2 = (n) => String(n).padStart(2, "0");

// 时长：不足 1 小时 mm:ss，超过 1 小时 h:mm:ss。
// 原来超过 1 小时只显示 h:mm，分钟数每分钟才变一次，
// 看起来像卡住了 —— 秒必须一直走。
function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (hh > 0) return hh + ":" + pad2(mm) + ":" + pad2(ss);
  return mm + ":" + pad2(ss);
}

// 后端返回的 text 是一段多行说明，取第一句能读的。
function firstLine(text) {
  const s = String(text || "").split("\n").map((x) => x.trim()).find(Boolean) || "";
  return s.length > 18 ? s.slice(0, 18) + "…" : s;
}

const CSS = [
  "#" + CHIP_ID + "{display:inline-flex;align-items:center;gap:6px;",
  "height:24px;padding:0 8px;margin:0 2px;border:0;border-radius:5px;background:transparent;",
  "font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;",
  "letter-spacing:.01em;white-space:nowrap;cursor:pointer;",
  "color:var(--dsw-alias-text-secondary,rgba(255,255,255,.55));",
  "transition:background .15s,color .15s}",
  "#" + CHIP_ID + ":hover{background:rgba(127,127,127,.14);",
  "color:var(--dsw-alias-text-primary,rgba(255,255,255,.92))}",
  "#" + CHIP_ID + "[data-on=\"1\"]{color:var(--dsw-alias-text-primary,rgba(255,255,255,.92))}",
  "#" + CHIP_ID + "[data-busy=\"1\"]{opacity:.6;cursor:progress}",
  "#" + CHIP_ID + "[data-notice=\"1\"]{color:#e5a13d}",
  "#" + CHIP_ID + " .paf-dot{width:6px;height:6px;border-radius:50%;flex:none;",
  "background:rgba(127,127,127,.6)}",
  "#" + CHIP_ID + "[data-on=\"1\"] .paf-dot{background:#35d0a0;",
  "animation:paf-pulse 1.8s ease-out infinite}",
  "#" + CHIP_ID + " .paf-time{font-variant-numeric:tabular-nums;font-weight:600}",
  "@keyframes paf-pulse{0%{box-shadow:0 0 0 0 rgba(53,208,160,.5)}",
  "70%{box-shadow:0 0 0 6px rgba(53,208,160,0)}100%{box-shadow:0 0 0 0 rgba(53,208,160,0)}}",
].join("");

function FocusChip() {
  const [state, setState] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const res = await fetch(STATE_URL, { cache: "no-store" });
        if (res.ok && alive) setState(await res.json());
      } catch { /* 这一轮失败就保持现状，不清空、不闪 */ }
    };
    void pull();
    const pollTimer = setInterval(pull, POLL_MS);
    const tickTimer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(pollTimer);
      clearInterval(tickTimer);
    };
  }, []);

  // 提示语几秒后自己消失，回到正常状态文案。
  React.useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(""), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const on = Boolean(state && state.active);
  const since = state && state.since ? Date.parse(state.since) : 0;
  const elapsed = on && Number.isFinite(since) && since > 0 ? now - since : 0;
  const frozen = state && typeof state.suspended === "number" ? state.suspended : 0;

  const toggle = async () => {
    if (busy) return;
    const wasOn = on;
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch(TOGGLE_URL, {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(TOGGLE_TIMEOUT_MS),
      });
      if (res.ok) {
        const next = await res.json();
        setState(next);
        // 后端没做到本来的意图时，把原因说在 chip 上，别让点击看起来没发生过。
        if (next && next.text && Boolean(next.active) === wasOn) {
          setNotice(firstLine(next.text) || "切换未生效");
        }
      } else {
        const body = await res.json().catch(() => null);
        setNotice(body && body.error ? firstLine(body.error) : "切换失败");
      }
    } catch (e) {
      setNotice(e && e.name === "TimeoutError" ? "切换超时" : "切换失败");
    }
    setBusy(false);
  };

  const title = busy
    ? "切换中"
    : notice
      ? notice
      : on
        ? "专注 " + fmtDuration(elapsed) + (frozen > 0 ? " · " + frozen + " 个进程已冻结" : "") + " · 点击停止"
        : "点击开启专注模式";

  const label = busy ? "切换中" : notice ? notice : "专注";

  return h("button", {
    id: CHIP_ID,
    type: "button",
    title,
    "data-on": on ? "1" : "0",
    "data-busy": busy ? "1" : "0",
    "data-notice": notice ? "1" : "0",
    onClick: toggle,
  },
    h("span", { className: "paf-dot" }),
    h("span", { className: "paf-label" }, label),
    on && !busy && !notice ? h("span", { className: "paf-time" }, fmtDuration(elapsed)) : null
  );
}

// slots 服务必须先声明依赖，否则 ctx.slots 是 undefined。
exports.inject = ["slots"];

exports.apply = function apply(ctx) {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  // 样式挂在 head 上，随插件卸载一起移除。
  try {
    if (!document.getElementById(CHIP_ID + "-style")) {
      const style = document.createElement("style");
      style.id = CHIP_ID + "-style";
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
      if (ctx && typeof ctx.effect === "function") {
        ctx.effect(() => () => {
          try { style.remove(); } catch { /* ignore */ }
        }, "focus-chip: style");
      }
    }
  } catch { /* 样式失败不拖累注册 */ }

  // 注册进会话标题行的 utilities 槽位；槽位塌陷时自动卸载。
  try {
    if (ctx && ctx.slots && typeof ctx.slots.inject === "function") {
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: "shannon-anchor-focus",
        order: 50,
      }, FocusChip));
    }
  } catch { /* 槽位不可用就静默跳过，不影响页面 */ }
};

return module.exports; } });
}
