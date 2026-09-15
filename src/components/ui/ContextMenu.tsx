import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
}
export const MENU_SEP = "sep" as const;

/** 通用自定义右键菜单：传入坐标 + items，点项 → onAction(id) 后关闭。
 *  定位边界回弹、外部点击 / Esc 关闭、portal 到 body（与 FileContextMenu 同款交互）。 */
export default function ContextMenu({
  x,
  y,
  items,
  onAction,
  onClose,
}: {
  x: number;
  y: number;
  items: (MenuItem | typeof MENU_SEP)[];
  onAction: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: x + r.width > window.innerWidth ? Math.max(4, window.innerWidth - r.width - 4) : x,
      top: y + r.height > window.innerHeight ? Math.max(4, window.innerHeight - r.height - 4) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      data-hty-overlay
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 120 }}
      className="min-w-[170px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--elevated)] py-1 shadow-xl"
    >
      {items.map((it, i) =>
        it === MENU_SEP ? (
          <div key={`s${i}`} className="my-1 border-t border-[var(--border-soft)]" />
        ) : (
          <button
            key={it.id}
            onClick={() => {
              onAction(it.id);
              onClose();
            }}
            className={
              "block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface)] " +
              (it.danger ? "text-[var(--danger)]" : "text-[var(--text-deep)]")
            }
          >
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
