import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "./settings";

/**
 * 拖放诊断收集器(设置「拖放诊断日志」,默认关):记录左栏→终端拖放生命周期、终端写入耗时、
 * 渲染帧停顿,批量追加到后端日志(`%APPDATA%\HtyBox\logs\dragdrop-日期.log`);
 * 宿主 UI 线程看门狗与 write_terminal 耗时采样在 Rust 侧(diag.rs)随同一开关启停。
 * 开关关闭时 `diag()` 首行短路,hot path 零开销。
 */

const FLUSH_MS = 500; // 批量落盘间隔
const RENDER_STALL_MS = 200; // 相邻两帧间隙超过此值记「渲染停顿」

let lines: string[] = [];
let flushTimer: number | undefined;
let rafRunning = false;

const warn = (err: unknown) => console.warn("[dragdrop-diag]", err);

/** 记一条诊断(开关关时无操作)。 */
export function diag(kind: string, detail?: Record<string, unknown>): void {
  if (!getSettings().dragDropDiag) return;
  lines.push(`${new Date().toISOString()} ${kind}${detail ? " " + JSON.stringify(detail) : ""}`);
  if (flushTimer === undefined) flushTimer = window.setTimeout(flushLines, FLUSH_MS);
}

/** 当前焦点元素的简短标记(判断 drop 后焦点落点)。 */
export function activeElementTag(): string {
  const ae = document.activeElement;
  return ae ? `${ae.tagName}.${ae.className.toString().slice(0, 40)}` : "none";
}

function flushLines(): void {
  flushTimer = undefined;
  if (!lines.length) return;
  const batch = lines;
  lines = [];
  invoke("append_diag_log", { lines: batch }).catch(warn);
}

/** 随设置启停(App 挂载 + 开关变化时调用):同步 Rust 看门狗;开时监测渲染帧间隙。幂等。 */
export function setDragDropDiagEnabled(on: boolean): void {
  invoke("set_diag_watchdog", { on }).catch(warn);
  if (!on) {
    rafRunning = false;
    flushLines();
    return;
  }
  if (rafRunning) return;
  rafRunning = true;
  let last = performance.now();
  // 页面隐藏期间 rAF 暂停,恢复时的大间隙不是停顿:可见性变化时重置基准
  const onVisibility = () => {
    last = performance.now();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const tick = (now: number) => {
    if (!rafRunning) {
      document.removeEventListener("visibilitychange", onVisibility);
      return;
    }
    if (now - last > RENDER_STALL_MS) diag("render-stall", { ms: Math.round(now - last) });
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
