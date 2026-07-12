import { type ReactNode } from "react";
import { useMaskDismiss } from "./maskDismiss";

/** M9：危险操作确认弹窗；自定义风格，不用原生 confirm。 */
export default function ConfirmModal({
  title,
  message,
  confirmText = "删除",
  zIndex = 110,
  onConfirm,
  onClose,
}: {
  title: string;
  message?: ReactNode;
  confirmText?: string;
  /** 遮罩层级；在更高层 popover（如 TagEditor z=120）之上弹出时传更大值 */
  zIndex?: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const mask = useMaskDismiss(onClose);
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/30" style={{ zIndex }} {...mask}>
      <div className="w-[360px] max-w-[90vw] rounded-2xl bg-[var(--elevated)] p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-sm font-semibold text-[var(--text)]">{title}</div>
        {message && <div className="mb-3 break-words text-[12px] leading-relaxed text-[var(--text-2)]">{message}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface)]">
            取消
          </button>
          <button
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="rounded-md bg-[var(--danger)] px-3 py-1 text-[12px] font-semibold text-white hover:bg-[var(--danger-hover)]"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
