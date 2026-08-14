// 性能诊断 HUD(终端性能主题群 plan-1):可开关的角标浮层,直更 DOM 不过 React。
//
// 观测维度(全部 bool 短路,开关关闭时 hot path 零开销):
//   IPC 输出:msg/s、KB/s(terminalEngine onmessage 打点)
//   渲染负担:term.write 单次耗时均值/峰值、write 调用/s
//   主线程健康:长任务(PerformanceObserver longtask)计数/最长、FPS(rAF 采样)
//   会话风暴:重扫次数/耗时(SessionPanel load + TerminalDock refreshNativeLabels 打点)
//
// 设计纪律:开关默认关(「偶用能力默认关」);HUD 1s 直更 DOM 文本,不与终端渲染争主线程;
// 探针只观测不改行为(不动 Channel 消息流/term.write 时序)。plan-2/3 复用同一打点做验收对照。

interface Counters {
  ipcMsgs: number; // 本窗口期 IPC 消息数
  ipcBytes: number; // 本窗口期 IPC 字节数
  writes: number; // 本窗口期 term.write 次数
  writeMs: number; // 本窗口期 write 累计耗时
  writeMax: number; // 本窗口期 write 单次峰值
  rescans: number; // 累计会话重扫次数
  rescanMs: number; // 累计重扫耗时
  rescanMax: number; // 重扫单次峰值
  longtasks: number; // 累计长任务数
  longtaskMax: number; // 长任务最长值
}

const c: Counters = {
  ipcMsgs: 0, ipcBytes: 0, writes: 0, writeMs: 0, writeMax: 0,
  rescans: 0, rescanMs: 0, rescanMax: 0, longtasks: 0, longtaskMax: 0,
};

let hudEl: HTMLDivElement | null = null;
let fps = 0; // 最近 1s 的 rAF 帧数
let frames = 0; // 当前窗口累计帧
let running = false;
let longtaskObs: PerformanceObserver | null = null;

/** 打点:收到一条终端输出 IPC 消息(字节数=消息体长度)。hot path,开关关时调用方须先短路。 */
export function perfIpcMsg(bytes: number): void {
  c.ipcMsgs += 1;
  c.ipcBytes += bytes;
}

/** 打点:term.write 单次耗时(ms)。hot path,调用方须先短路。 */
export function perfWrite(ms: number): void {
  c.writes += 1;
  c.writeMs += ms;
  if (ms > c.writeMax) c.writeMax = ms;
}

/** 打点:一次会话重扫(SessionPanel load / refreshNativeLabels)耗时(ms)。 */
export function perfRescan(ms: number): void {
  c.rescans += 1;
  c.rescanMs += ms;
  if (ms > c.rescanMax) c.rescanMax = ms;
}

// ---------------- 浮层与启停 ----------------

function fmtKb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;
}

function render(): void {
  if (!hudEl) return;
  const avgWrite = c.writes > 0 ? c.writeMs / c.writes : 0;
  const avgRescan = c.rescans > 0 ? c.rescanMs / c.rescans : 0;
  hudEl.textContent =
    `IPC ${c.ipcMsgs}/s ${fmtKb(c.ipcBytes)}/s | write ${c.writes}/s avg${avgWrite.toFixed(1)}ms max${c.writeMax.toFixed(0)}ms | ` +
    `FPS ${fps} | 长任务 ${c.longtasks} max${c.longtaskMax.toFixed(0)}ms | 重扫 ${c.rescans} avg${avgRescan.toFixed(1)}ms max${c.rescanMax.toFixed(0)}ms`;
}

function rafTick(): void {
  if (!running) return;
  frames += 1;
  requestAnimationFrame(rafTick);
}

function secTick(): void {
  fps = frames;
  frames = 0;
  render();
  // 窗口期计数清零(累计型保留:长任务/重扫是低频,看总量与峰值更有用)
  c.ipcMsgs = 0; c.ipcBytes = 0; c.writes = 0; c.writeMs = 0; c.writeMax = 0;
}

let secTimer: number | undefined;

/** 启动 HUD(设置开启/启动时按设置调用)。幂等。 */
export function startPerfHud(): void {
  if (running) return;
  running = true;
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:95;pointer-events:none;" +
    "font:11px/1.4 monospace;color:var(--text-2);background:var(--elevated);" +
    "border:1px solid var(--accent-border);border-radius:6px;padding:3px 8px;opacity:.92;white-space:pre";
  document.body.appendChild(el);
  hudEl = el;
  try {
    longtaskObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        c.longtasks += 1;
        if (e.duration > c.longtaskMax) c.longtaskMax = e.duration;
      }
    });
    longtaskObs.observe({ entryTypes: ["longtask"] });
  } catch {
    longtaskObs = null; // WebView2 不支持 longtask → 静默降级,其余指标照常
  }
  requestAnimationFrame(rafTick);
  secTimer = window.setInterval(secTick, 1000);
}

/** 停止 HUD(设置关闭时调用):移除 DOM、断 observer、停循环。幂等。 */
export function stopPerfHud(): void {
  if (!running) return;
  running = false;
  if (secTimer !== undefined) window.clearInterval(secTimer);
  secTimer = undefined;
  longtaskObs?.disconnect();
  longtaskObs = null;
  hudEl?.remove();
  hudEl = null;
}
