import { useRef, useState, type ReactNode, type MouseEvent } from "react";
import { createPortal } from "react-dom";

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

/**
 * 列表卡片：只显示名称（单行）。开启「悬浮提示」时鼠标停留 ~0.5s 弹出详情浮层
 * （portal 到 body、fixed 定位卡片右侧、放不下翻左、pointer-events-none）；卡片可拖拽注入。
 * 传 favorite 时右侧显示爱心按钮（收藏开关），不影响拖拽。
 * 可选 chips（名称下方）/ onContextMenu（右键菜单由调用方处理）。
 */
export default function InfoCard({
  name,
  preview,
  hoverEnabled,
  onDragStart,
  favorite,
  trailing,
  dimmed,
  chips,
  onContextMenu,
}: {
  name: string;
  preview: ReactNode;
  hoverEnabled: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  favorite?: { active: boolean; onToggle: () => void };
  /** 名称右侧、收藏心形左侧的动作槽（如上架/下架按钮） */
  trailing?: ReactNode;
  /** 置灰（下架 skill 视觉弱化） */
  dimmed?: boolean;
  /** 名称下方的附加行（如标签 chips）；无则保持单行布局 */
  chips?: ReactNode;
  onContextMenu?: (e: MouseEvent<HTMLDivElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    if (!hoverEnabled) return;
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const W = 340;
      const left =
        r.right + 8 + W > window.innerWidth
          ? Math.max(8, r.left - W - 8)
          : r.right + 8;
      const top = Math.max(8, Math.min(r.top, window.innerHeight - 200));
      setBox({ top, left });
    }, 500);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    setBox(null);
  };

  const actions = (
    <>
      {trailing}
      {favorite && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            hide();
            favorite.onToggle();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title={favorite.active ? "取消收藏" : "收藏"}
          className={
            "shrink-0 transition-colors " +
            (favorite.active
              ? "text-[var(--accent)]"
              : "text-[var(--text-faint)] hover:text-[var(--accent)]")
          }
        >
          <HeartIcon filled={favorite.active} />
        </button>
      )}
    </>
  );

  return (
    <>
      <div
        ref={ref}
        draggable={!!onDragStart}
        onDragStart={
          onDragStart
            ? (e) => {
                hide();
                onDragStart(e);
              }
            : undefined
        }
        onMouseEnter={show}
        onMouseLeave={hide}
        onMouseDown={hide}
        onContextMenu={onContextMenu}
        className={
          "flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 transition-colors hover:border-[var(--accent-border)] hover:bg-[var(--surface-soft)] " +
          (onDragStart ? "cursor-grab active:cursor-grabbing " : "") +
          (dimmed ? "opacity-55" : "")
        }
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-[var(--text)]">{name}</div>
          {chips}
        </div>
        <div className="flex shrink-0 items-center gap-2 self-center">{actions}</div>
      </div>
      {box &&
        createPortal(
          <div
            style={{ position: "fixed", top: box.top, left: box.left, width: 340, zIndex: 60 }}
            className="pointer-events-none rounded-xl border border-[var(--border)] bg-[var(--elevated)] px-3.5 py-3 shadow-lg"
          >
            {preview}
          </div>,
          document.body,
        )}
    </>
  );
}
