import type { Terminal } from "@xterm/xterm";
import { getSettings } from "./settings";

/**
 * 终端中键自动滚动（浏览器式）——按下鼠标中键出现滚轮锚点，鼠标离锚点越远滚得越快。
 *
 * 交互与 Chromium 对齐（双模式）：
 * · 按住拖动：按住中键移动即滚动，松开停止；
 * · 短按粘滞：按下后未离开死区就松开 → 锚点驻留、移动鼠标持续滚动，
 *   任意鼠标键 / 滚轮 / 按键 / 窗口失焦退出。
 *
 * 让位原则（不与 TUI 抢中键）：
 * · mouseTrackingMode !== "none"（vim/htop 等接管鼠标）→ 完全放行，中键归应用；
 * · alternate buffer（无 scrollback 可滚）→ 放行。
 *
 * 滚动只走公开 API scrollLines（行级）；WebView2 无浏览器 UI 层的原生 autoscroll，
 * 且 Chromium 原生行为尊重 mousedown preventDefault → 即便未来引入也不会双重滚动。
 * 会话全局单例（鼠标只有一个）；锚点 overlay 挂 document.body，不动 xterm DOM。
 */

/** 锚点死区半径（px）：范围内不滚动，光标显示 all-scroll */
const DEAD_ZONE = 10;
/** 速度系数：出死区后每 px 偏移贡献的行速（行/秒）。偏移 50px ≈ 20 行/s */
const RATE = 0.5;
/** 行速上限（行/秒）：防极端偏移一瞬滚穿 scrollback */
const MAX_RATE = 100;

/** 锚点图标（仿 Chromium：圆底 + 上下箭头 + 中心点），按终端固定暖深底配色（--term-* 不随主题翻转） */
const OVERLAY_SVG = `<svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg">
  <circle cx="15" cy="15" r="13.5" fill="rgba(31,30,29,0.88)" stroke="#4a453e" stroke-width="1"/>
  <path d="M15 5.5 L19 10.5 H11 Z" fill="#e5e2dc"/>
  <path d="M15 24.5 L11 19.5 H19 Z" fill="#e5e2dc"/>
  <circle cx="15" cy="15" r="2" fill="#d97757"/>
</svg>`;

let overlayEl: HTMLDivElement | null = null;

/** 单例锚点 overlay：fixed 定位、穿透点击；会话结束仅隐藏、DOM 常驻复用 */
function ensureOverlay(): HTMLDivElement {
  if (overlayEl) return overlayEl;
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.zIndex = "90"; // 低于弹窗(z-100)；滚动会话短暂，不与全局遮罩共存
  el.style.pointerEvents = "none";
  el.style.transform = "translate(-50%, -50%)";
  el.style.display = "none";
  el.innerHTML = OVERLAY_SVG;
  document.body.appendChild(el);
  overlayEl = el;
  return el;
}

const CURSOR_CLASSES = [
  "htybox-mscroll-idle",
  "htybox-mscroll-up",
  "htybox-mscroll-down",
] as const;

/** 全局光标三态（死区内 all-scroll / 向上 n-resize / 向下 s-resize），null=恢复默认 */
function setCursorClass(cls: (typeof CURSOR_CLASSES)[number] | null): void {
  for (const c of CURSOR_CLASSES)
    document.body.classList.toggle(c, c === cls);
}

interface Session {
  term: Terminal;
  anchorY: number;
  curY: number;
  moved: boolean; // 是否曾离开死区：决定 mouseup 是结束（拖动模式）还是转粘滞
  sticky: boolean; // 粘滞模式：松开后仍持续滚动，直到显式退出
  raf: number;
  acc: number; // 累计的小数行（每帧行数非整，攒够 ±1 行才 scrollLines）
  lastTs: number; // 上一帧 rAF 时间戳，0 = 首帧（首帧只记时不滚动）
  detach: () => void; // 移除本会话挂在 window 上的全部监听
}

let session: Session | null = null;

/** 会话单出口：撤 rAF / 撤 window 监听 / 隐藏锚点 / 恢复光标。所有退出路径统一走这里 */
function endSession(): void {
  if (!session) return;
  cancelAnimationFrame(session.raf);
  session.detach();
  session = null;
  if (overlayEl) overlayEl.style.display = "none";
  setCursorClass(null);
}

/** rAF 循环：行速 = (|偏移| - 死区) × RATE，按帧间隔积分成行数，整数部分滚动 */
function tick(ts: number): void {
  if (!session) return;
  const s = session;
  const dt = s.lastTs ? (ts - s.lastTs) / 1000 : 0;
  s.lastTs = ts;
  const dy = s.curY - s.anchorY;
  const mag = Math.abs(dy) - DEAD_ZONE;
  if (mag > 0 && dt > 0) {
    s.acc += Math.min(mag * RATE, MAX_RATE) * Math.sign(dy) * dt;
    const whole = Math.trunc(s.acc);
    if (whole !== 0) {
      s.acc -= whole;
      s.term.scrollLines(whole);
    }
  }
  setCursorClass(
    mag <= 0
      ? "htybox-mscroll-idle"
      : dy < 0
        ? "htybox-mscroll-up"
        : "htybox-mscroll-down",
  );
  s.raf = requestAnimationFrame(tick);
}

function startSession(term: Terminal, x: number, y: number): void {
  const onMove = (e: MouseEvent) => {
    if (!session) return;
    session.curY = e.clientY;
    if (Math.abs(e.clientY - session.anchorY) > DEAD_ZONE)
      session.moved = true;
  };
  const onUp = () => {
    if (!session) return;
    // Chromium 同款位移判定：拖动过（出过死区）→ 松开即停；从未出死区 → 转粘滞驻留
    if (session.moved) endSession();
    else session.sticky = true;
  };
  const onDown = (e: MouseEvent) => {
    // 会话中任意再按 = 退出。吞掉这次 down：中键→防立即重启新会话；左键→防 xterm 误开选区。
    // click 事件不吞 —— 点击其他 UI 退出滚动的同时照常生效（终端场景滚动区固定，无浏览器
    // "页面在动误点"风险，吞 click 反而造成"第一下点不动"的困惑）
    e.preventDefault();
    e.stopPropagation();
    endSession();
  };
  const onWheel = () => endSession(); // 滚轮退出且照常生效（不吞，衔接手动滚动）
  const onKey = (e: KeyboardEvent) => {
    // 任意按键退出；仅 Esc 吞掉 —— 它的意图是"退出滚动"，不能漏给终端里的 TUI
    // （claude/codex 收到 Esc 会中断正在跑的回合）；其余键放行 = 用户想继续输入
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
    }
    endSession();
  };
  const onBlur = () => endSession();

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("wheel", onWheel, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
  const detach = () => {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("wheel", onWheel, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
  };

  const ov = ensureOverlay();
  ov.style.left = `${x}px`;
  ov.style.top = `${y}px`;
  ov.style.display = "block";
  setCursorClass("htybox-mscroll-idle");

  session = {
    term,
    anchorY: y,
    curY: y,
    moved: false,
    sticky: false,
    raf: 0,
    acc: 0,
    lastTs: 0,
    detach,
  };
  session.raf = requestAnimationFrame(tick);
}

/**
 * 给某终端的 xterm 宿主元素挂中键自动滚动，返回解绑函数（disposeEngine 时调用）。
 * 挂 capture 阶段：先于 xterm 内部监听拿到中键（xterm 对中键仅 Linux 下有 auxclick
 * 粘贴处理，Windows 零占用，拦截无副作用）。
 *
 * 注意会话进行中此 handler 收不到事件 —— window 层的会话 mousedown（capture 更外层）
 * 会先退出会话并 stopPropagation，故走到这里时必无活动会话。
 */
export function attachMiddleScroll(
  term: Terminal,
  host: HTMLElement,
): () => void {
  const onDown = (e: MouseEvent) => {
    if (e.button !== 1) return;
    if (!getSettings().middleClickScroll) return; // 设置关闭 → 完全放行
    if (term.modes.mouseTrackingMode !== "none") return; // TUI 接管鼠标（vim 等）→ 中键归应用
    if (term.buffer.active.type === "alternate") return; // 无 scrollback，滚动无意义 → 放行
    // 拦下这次中键：阻止 Chromium 潜在原生 autoscroll 与默认焦点路径，会话自己接管
    e.preventDefault();
    e.stopPropagation();
    term.focus(); // preventDefault 阻止了默认聚焦，补上与点击终端一致的语义
    startSession(term, e.clientX, e.clientY);
  };
  host.addEventListener("mousedown", onDown, true);
  return () => {
    host.removeEventListener("mousedown", onDown, true);
    // 会话进行中终端被关闭（面板 ✕ / 工作区关闭）→ 立即清场，不留 window 监听与锚点
    if (session && session.term === term) endSession();
  };
}
