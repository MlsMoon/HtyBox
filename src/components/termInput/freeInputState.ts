// 无工作流时「自由输入」展开态：全局记忆开关（settings.termFreeInputOpen），
// 打开/关闭后所有终端会话共用同一默认（持久化 localStorage）。
import { getSettings, setSetting } from "../../settings";

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((f) => f());
}

export function onFreeInputChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 是否展开（全局记忆；termId 仅保留 API 兼容，不再按终端分叉）。 */
export function isFreeInputOpen(_termId?: string): boolean {
  return getSettings().termFreeInputOpen;
}

/** 开/关并写入全局设置（之后所有会话默认跟此值）。 */
export function setFreeInputOpen(_termId: string, open: boolean): void {
  if (getSettings().termFreeInputOpen === open) return;
  setSetting("termFreeInputOpen", open);
  emit();
}

export function toggleFreeInput(termId: string): boolean {
  const next = !isFreeInputOpen(termId);
  setFreeInputOpen(termId, next);
  return next;
}

/** 终端关闭：全局记忆不随单终端清理（no-op，保留调用点兼容）。 */
export function clearFreeInput(_termId: string): void {
  /* 全局开关不按终端清 */
}

/** Ctrl+Shift+I：通知对应终端的 WorkflowBar 展开/聚焦内置输入。 */
type HotkeyListener = (termId: string) => void;
const hotkeyListeners = new Set<HotkeyListener>();

export function onTermInputHotkey(fn: HotkeyListener): () => void {
  hotkeyListeners.add(fn);
  return () => {
    hotkeyListeners.delete(fn);
  };
}

export function emitTermInputHotkey(termId: string): void {
  hotkeyListeners.forEach((f) => f(termId));
}
