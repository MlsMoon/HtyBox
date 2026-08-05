// 无工作流时每终端「自由输入」展开态（模块级瞬态，不进 wsState）。
type Listener = () => void;
const listeners = new Set<Listener>();
const openByTerm = new Map<string, boolean>();

function emit(): void {
  listeners.forEach((f) => f());
}

export function onFreeInputChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function isFreeInputOpen(termId: string): boolean {
  return openByTerm.get(termId) === true;
}

export function setFreeInputOpen(termId: string, open: boolean): void {
  const prev = openByTerm.get(termId) === true;
  if (prev === open) return;
  if (open) openByTerm.set(termId, true);
  else openByTerm.delete(termId);
  emit();
}

export function toggleFreeInput(termId: string): boolean {
  const next = !isFreeInputOpen(termId);
  setFreeInputOpen(termId, next);
  return next;
}

/** 终端关闭时清态，避免 Map 泄漏。 */
export function clearFreeInput(termId: string): void {
  if (!openByTerm.has(termId)) return;
  openByTerm.delete(termId);
  emit();
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
