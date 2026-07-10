import { useState } from "react";
import { useMaskDismiss } from "./maskDismiss";

/** M9：通用名称输入弹窗（新建/重命名用）；自定义风格，不用原生 prompt。 */
export default function PromptModal({
  title,
  initial = "",
  confirmText = "确定",
  onConfirm,
  onClose,
}: {
  title: string;
  initial?: string;
  confirmText?: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState(initial);
  const mask = useMaskDismiss(onClose);
  const submit = () => {
    const t = v.trim();
    if (t) onConfirm(t);
  };
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/30" {...mask}>
      <div className="w-[360px] max-w-[90vw] rounded-2xl bg-[var(--elevated)] p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 text-sm font-semibold text-[var(--text)]">{title}</div>
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") onClose();
          }}
          className="w-full rounded-md border border-[var(--border)] px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent-border)]"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface)]">
            取消
          </button>
          <button
            onClick={submit}
            className="rounded-md bg-[var(--accent)] px-3 py-1 text-[12px] font-semibold text-white hover:bg-[var(--accent-text)]"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
