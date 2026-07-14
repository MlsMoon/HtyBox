import { useEffect, useState } from "react";
import { subscribeClipboardPasteBusy } from "../clipboardPasteBusy";

/**
 * 右上角非模态提示：剪贴板图片正在后台落盘。
 * 无全窗 mask / pointer-events，不挡用户继续操作（对齐 WakeToasts 栈位）。
 */
export default function PasteBusyToast() {
  const [n, setN] = useState(0);
  useEffect(() => subscribeClipboardPasteBusy(setN), []);
  if (n <= 0) return null;
  const label = n === 1 ? "正在粘贴图片…" : `正在粘贴图片（${n}）…`;
  return (
    <div className="pointer-events-none fixed right-4 top-14 z-[90] flex w-72 flex-col gap-2">
      <div
        className="flex items-center gap-2 rounded-lg border border-[var(--accent-border)] bg-[var(--elevated)] px-3 py-2 shadow-lg"
        role="status"
        aria-live="polite"
      >
        <span
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--accent)] border-t-transparent"
          aria-hidden="true"
        />
        <span className="text-xs text-[var(--text-2)]">{label}</span>
      </div>
    </div>
  );
}
