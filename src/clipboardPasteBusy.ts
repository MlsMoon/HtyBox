/** 剪贴板图片落盘 busy 总线：terminalEngine（非 React）与 WorkflowBar / toast 共用。 */

type Listener = (count: number) => void;

let count = 0;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(count);
}

/** 开始一次落盘；返回当前并发数。 */
export function beginClipboardPasteBusy(): number {
  count += 1;
  emit();
  return count;
}

/** 结束一次落盘（须与 begin 成对，建议 finally）。 */
export function endClipboardPasteBusy(): number {
  count = Math.max(0, count - 1);
  emit();
  return count;
}

/** 订阅计数变化；返回取消订阅。立即回调一次当前值。 */
export function subscribeClipboardPasteBusy(listener: Listener): () => void {
  listeners.add(listener);
  listener(count);
  return () => {
    listeners.delete(listener);
  };
}
