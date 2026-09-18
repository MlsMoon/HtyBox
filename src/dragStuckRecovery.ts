import { invoke } from "@tauri-apps/api/core";
import { diag } from "./dragDropDiag";
import { createDragStuckWatch } from "./dragStuckWatch";

/**
 * 拖拽卡死守卫接线(决策 4=C):判定见 `dragStuckWatch.ts`。
 * 拖拽事件到达即节流采样鼠标主键的物理状态；判定卡死 → 注入 Esc(系统拖拽的标准取消键)解除；
 * 注入若无效(仍在卡死)→ 浮层提示用户手动按 Esc。
 *
 * 始终启用(它服务「拖拽不卡死」这条需求本身)；「拖放诊断日志」开关只决定是否留日志。
 * 注入 Esc 而非补鼠标抬起：后者会在光标处产生一次真实 drop(可能误移动文件)，Esc 是纯取消语义。
 */

/** 拖拽事件心跳采样间隔(ms)：拖拽期间 dragover 每秒数十次，按此节流查按键状态 */
const SAMPLE_MS = 250;
/** 提示浮层自动消失(ms) */
const PROMPT_TTL_MS = 8000;

let installed = false;
let supported = true; // 平台无法查询主键状态(非 Windows)→ 永久停用
let sampling = false; // 上一次查询未回来则跳过本次(不排队)
let lastSampleAt = 0;
const watch = createDragStuckWatch();

let promptEl: HTMLDivElement | null = null;
let promptTimer: number | undefined;

function showPrompt(): void {
  if (!promptEl) {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:120;pointer-events:none;" +
      "font:12px/1.5 var(--app-font);color:var(--accent-text);background:var(--elevated);" +
      "border:1px solid var(--accent-border);border-radius:8px;padding:6px 12px;box-shadow:0 2px 10px rgba(0,0,0,.18)";
    el.textContent = "拖拽状态卡住了，按 Esc 键解除";
    document.body.appendChild(el);
    promptEl = el;
  }
  promptEl.style.display = "block";
  if (promptTimer !== undefined) clearTimeout(promptTimer);
  promptTimer = window.setTimeout(hidePrompt, PROMPT_TTL_MS);
}

function hidePrompt(): void {
  if (promptTimer !== undefined) {
    clearTimeout(promptTimer);
    promptTimer = undefined;
  }
  if (promptEl) promptEl.style.display = "none";
}

function onDragEvent(e: DragEvent): void {
  if (!supported || sampling) return;
  const now = performance.now();
  if (now - lastSampleAt < SAMPLE_MS) return;
  lastSampleAt = now;
  sampling = true;
  const buttons = e.buttons; // 与权威来源一并记录：日后若证实可靠，可省掉这条 IPC
  invoke<boolean | null>("primary_mouse_button_down")
    .then((down) => {
      if (down === null) {
        supported = false;
        return;
      }
      const action = watch.sample(down, performance.now());
      if (action === "none") return;
      diag("drag-stuck", { action, buttons, eventType: e.type });
      if (action === "cancel") {
        void invoke<boolean>("send_escape_key").then((sent) => diag("drag-stuck-esc", { sent }));
      } else {
        showPrompt();
      }
    })
    .catch(() => {})
    .finally(() => {
      sampling = false;
    });
}

function onDragBoundary(): void {
  watch.reset();
  hidePrompt();
}

/** 应用启动时安装一次(幂等)。 */
export function installDragStuckRecovery(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("dragover", onDragEvent, true);
  document.addEventListener("dragenter", onDragEvent, true);
  document.addEventListener("dragstart", onDragBoundary, true);
  document.addEventListener("dragend", onDragBoundary, true);
  document.addEventListener("drop", onDragBoundary, true);
}
