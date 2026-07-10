import { useState } from "react";
import { useMaskDismiss } from "./ui/maskDismiss";

/** M9：终端/编辑器区「⋯ 更多操作」菜单——批量关闭标签等通用功能。 */
export default function DockActionsMenu({
  onCloseAll,
  onCloseOthers,
  onCloseSaved,
}: {
  onCloseAll: () => void;
  onCloseOthers: () => void;
  onCloseSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const mask = useMaskDismiss(() => setOpen(false));
  const item = (label: string, onClick: () => void, danger?: boolean) => (
    <button
      onClick={() => {
        onClick();
        setOpen(false);
      }}
      className={
        "block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface)] " +
        (danger ? "text-[var(--danger)]" : "text-[var(--text-deep)]")
      }
    >
      {label}
    </button>
  );

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="更多操作"
        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] hover:text-[var(--text)]"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[60]" {...mask} />
          <div className="absolute right-0 top-full z-[61] mt-1 w-48 rounded-lg border border-[var(--border)] bg-[var(--elevated)] py-1 shadow-xl">
            {item("关闭已保存的编辑器", onCloseSaved)}
            {item("关闭其他标签", onCloseOthers)}
            <div className="my-1 border-t border-[var(--border-soft)]" />
            {item("关闭所有标签", onCloseAll, true)}
          </div>
        </>
      )}
    </div>
  );
}
