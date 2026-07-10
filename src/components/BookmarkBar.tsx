import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ContextMenu, { MENU_SEP } from "./ui/ContextMenu";
import {
  useBookmarks,
  sortedBookmarks,
  addBookmark,
  updateBookmark,
  deleteBookmark,
  insertBookmarkAt,
  moveBookmark,
  toggleImportant,
  displayText,
  copyTextOf,
  injectTextOf,
  colorDot,
  BOOKMARK_COLORS,
  DEFAULT_COLOR,
  type Bookmark,
  type BookmarkColorKey,
  type BookmarkInput,
} from "../bookmarks";

const DRAG_MIME = "application/x-htybox-item";
const BODY_MAX = 4000;
const UNDO_MS = 5000; // 快捷删除的撤销窗口

function BookmarkIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.6l2.9 6 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.5l6.5-.9z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-.8 14a1 1 0 0 1-1 .9H6.8a1 1 0 0 1-1-.9L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** 书签卡片：极简单行大字（标题，无则内容，truncate 省略号）+ 左色条 + 星标；
 *  可拖拽注入(text 载荷)、右键菜单；鼠标移入 ~0.5s 弹浮层(z-[120] 高于 popover)显示完整信息。
 *  自实现 hover 浮层(参考 InfoCard)——因书签 popover 在 z-[61]、需更高层级且要左色条/右键。 */
function BookmarkCard({
  b,
  scope,
  onMenu,
  onDragActive,
  dragging,
  mark,
  onSortStart,
  onSortEnd,
  onSortOver,
  onSortDrop,
  onDelete,
}: {
  b: Bookmark;
  scope: string;
  onMenu: (e: React.MouseEvent, b: Bookmark) => void;
  onDragActive: (active: boolean) => void;
  dragging: boolean;
  mark: "before" | "after" | null;
  onSortStart: (id: string) => void;
  onSortEnd: () => void;
  onSortOver: (e: React.DragEvent<HTMLDivElement>, b: Bookmark) => void;
  onSortDrop: (e: React.DragEvent<HTMLDivElement>, b: Bookmark) => void;
  onDelete: (b: Bookmark) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const text = displayText(b);

  const show = () => {
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const W = 300;
      // 默认朝左展开(popover 在右侧)，左侧放不下再朝右回弹
      const left = r.left - W - 10 > 8 ? r.left - W - 10 : Math.max(8, Math.min(r.right + 10, window.innerWidth - W - 8));
      const top = Math.max(8, Math.min(r.top, window.innerHeight - 160));
      setPos({ top, left });
    }, 500);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    setPos(null);
  };

  return (
    <>
      <div
        ref={ref}
        draggable
        onDragStart={(e) => {
          hide();
          e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "text", text: injectTextOf(b) }));
          e.dataTransfer.effectAllowed = "copyMove"; // 拖出注入=copy、列表内排序=move，两手势并存
          onDragActive(true); // 拖拽期间让全屏遮罩穿透，使 drop 能落到终端
          onSortStart(b.id);
        }}
        onDragEnd={() => {
          onDragActive(false);
          onSortEnd();
        }}
        onDragOver={(e) => onSortOver(e, b)}
        onDrop={(e) => onSortDrop(e, b)}
        onContextMenu={(e) => {
          e.preventDefault();
          hide();
          onMenu(e, b);
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onMouseDown={hide}
        className={
          "group relative flex cursor-grab items-center gap-2 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--elevated)] py-2.5 pr-2 pl-3.5 transition-colors hover:border-[var(--accent-border)] hover:bg-[var(--surface-soft)] active:cursor-grabbing" +
          (dragging ? " opacity-40" : "")
        }
        style={
          // 插入位置指示线：上/下缘 2px 高亮，纯样式切换不增删节点（feedback-dragstart-no-dom-mutation）
          mark
            ? { boxShadow: mark === "before" ? "0 -2px 0 0 var(--accent)" : "0 2px 0 0 var(--accent)" }
            : undefined
        }
      >
        <span className="absolute top-0 bottom-0 left-0 w-1" style={{ background: colorDot(b.color) }} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text)]">
          {text || "（空白）"}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            hide();
            onDelete(b);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title="删除书签"
          className="shrink-0 text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--danger)]"
        >
          <TrashIcon />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleImportant(scope, b.id);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title={b.important ? "取消重要" : "标为重要"}
          className={
            "shrink-0 transition-colors " +
            (b.important ? "text-[var(--accent)]" : "text-[var(--text-faint)] hover:text-[var(--accent)]")
          }
        >
          <StarIcon filled={b.important} />
        </button>
      </div>
      {pos &&
        createPortal(
          <div
            style={{ position: "fixed", top: pos.top, left: pos.left, width: 300, zIndex: 120 }}
            className="pointer-events-none rounded-xl border border-[var(--border)] bg-[var(--elevated)] px-3.5 py-3 shadow-lg"
          >
            {b.title.trim() && (
              <div className="text-[13px] font-semibold break-words text-[var(--text)]">{b.title}</div>
            )}
            {b.body.trim() && (
              <div className={(b.title.trim() ? "mt-1 " : "") + "text-[12px] leading-relaxed break-words whitespace-pre-wrap text-[var(--text-2)]"}>
                {b.body}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/** 新建 / 编辑表单（popover 内联）：标题、内容均可空，但两者皆空时禁用保存。 */
function BookmarkEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Bookmark;
  onSave: (input: BookmarkInput) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [color, setColor] = useState<BookmarkColorKey>(initial?.color ?? DEFAULT_COLOR);
  const [important, setImportant] = useState(initial?.important ?? false);
  const canSave = !!(title.trim() || body.trim());
  const submit = () => {
    if (canSave) onSave({ title: title.trim(), body: body.trim(), color, important });
  };

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-[var(--text)]">{initial ? "编辑书签" : "新建书签"}</span>
        <button onClick={onCancel} className="text-[12px] text-[var(--text-3)] hover:text-[var(--text)]">✕</button>
      </div>
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        placeholder="标题（可空）"
        className="w-full rounded-md border border-[var(--border)] bg-[var(--elevated)] px-2.5 py-1.5 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent-border)]"
      />
      <textarea
        value={body}
        maxLength={BODY_MAX}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        placeholder="内容（可空，标题与内容至少填一个）"
        rows={5}
        className="mt-2 w-full resize-none rounded-md border border-[var(--border)] bg-[var(--elevated)] px-2.5 py-1.5 text-[12.5px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent-border)]"
      />
      <div className="mt-3 flex items-center gap-2">
        <span className="w-12 shrink-0 text-[11px] font-semibold text-[var(--text-2)]">颜色</span>
        <div className="flex items-center gap-1.5">
          {BOOKMARK_COLORS.map((c) => (
            <button
              key={c.key}
              onClick={() => setColor(c.key)}
              title={c.label}
              className="flex h-5 w-5 items-center justify-center rounded-full transition-transform hover:scale-110"
              style={{ outline: color === c.key ? "2px solid var(--accent)" : "none", outlineOffset: 2 }}
            >
              <span className="h-3.5 w-3.5 rounded-full" style={{ background: c.dot }} />
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <span className="w-12 shrink-0 text-[11px] font-semibold text-[var(--text-2)]">重要性</span>
        <button
          onClick={() => setImportant((v) => !v)}
          className={
            "flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] font-semibold transition-colors " +
            (important
              ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent-text)]"
              : "border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--surface)]")
          }
        >
          <StarIcon filled={important} />
          {important ? "重要" : "普通"}
        </button>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-md px-3 py-1 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface)]">
          取消
        </button>
        <button
          onClick={submit}
          disabled={!canSave}
          className={
            "rounded-md px-3 py-1 text-[12px] font-semibold text-white transition-colors " +
            (canSave ? "bg-[var(--accent)] hover:bg-[var(--accent-text)]" : "cursor-not-allowed bg-[var(--text-3)]")
          }
        >
          保存
        </button>
      </div>
    </div>
  );
}

/** 顶栏「书签」入口：按钮 + 下拉 popover（按工作区 scope 读写）。 */
export default function BookmarkBar({ scope }: { scope: string }) {
  const [open, setOpen] = useState(false);
  const bookmarks = useBookmarks(scope);
  const sorted = useMemo(() => sortedBookmarks(bookmarks), [bookmarks]);
  const important = useMemo(() => sorted.filter((b) => b.important), [sorted]);
  const rest = useMemo(() => sorted.filter((b) => !b.important), [sorted]);
  const [editing, setEditing] = useState<null | "new" | Bookmark>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; b: Bookmark } | null>(null);
  // 快捷删除 + 撤销（决策 2=B）：直删零弹窗（用户显式豁免危险操作右键纪律，仅书签场景）
  const [undo, setUndo] = useState<{ scope: string; b: Bookmark; index: number } | null>(null);
  const undoTimer = useRef<number | undefined>(undefined);
  // 列表内拖拽排序：dragId=拖拽中的书签、dropMark=插入指示线位置（dragover 阶段读不到 dataTransfer 数据，用 state 记，同 SkillTemplateModal 范式）
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<{ id: string; place: "before" | "after" } | null>(null);
  const maskRef = useRef<HTMLDivElement>(null);

  const clearUndo = () => {
    if (undoTimer.current) {
      window.clearTimeout(undoTimer.current);
      undoTimer.current = undefined;
    }
    setUndo(null);
  };
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

  /** 快捷删除：点击即删、零弹窗；UNDO_MS 内可从 popover 底部撤销条精确复位到原数组位置。 */
  const quickDelete = (b: Bookmark) => {
    const index = bookmarks.findIndex((x) => x.id === b.id);
    if (index < 0) return;
    deleteBookmark(scope, b.id);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    setUndo({ scope, b, index }); // 带 scope：撤销复位不受期间工作区切换影响
    undoTimer.current = window.setTimeout(() => {
      setUndo(null);
      undoTimer.current = undefined;
    }, UNDO_MS);
  };
  const doUndo = () => {
    if (!undo) return;
    insertBookmarkAt(undo.scope, undo.b, undo.index);
    clearUndo();
  };

  const close = () => {
    setOpen(false);
    setEditing(null);
    clearUndo(); // 关闭 popover 即放弃撤销机会（快速功能的边界）
  };

  // 拖拽中的书签（决策 1=B：仅同星标区卡片可作落点）；placeOf 按落点卡片中线判定插入位置
  const dragItem = dragId ? (bookmarks.find((x) => x.id === dragId) ?? null) : null;
  const placeOf = (e: React.DragEvent<HTMLDivElement>): "before" | "after" => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  };

  const card = (b: Bookmark) => (
    <BookmarkCard
      key={b.id}
      b={b}
      scope={scope}
      onMenu={(e, bm) => setMenu({ x: e.clientX, y: e.clientY, b: bm })}
      onDragActive={(active) => {
        if (maskRef.current) maskRef.current.style.pointerEvents = active ? "none" : "auto";
      }}
      dragging={dragId === b.id}
      mark={dropMark?.id === b.id ? dropMark.place : null}
      onSortStart={setDragId}
      onSortEnd={() => {
        setDragId(null);
        setDropMark(null);
      }}
      onSortOver={(e, target) => {
        if (!dragItem || dragItem.id === target.id || dragItem.important !== target.important) return;
        e.preventDefault(); // 声明本卡为合法落点（不 preventDefault 则浏览器禁止 drop）
        e.dataTransfer.dropEffect = "move";
        const place = placeOf(e);
        setDropMark((m) => (m && m.id === target.id && m.place === place ? m : { id: target.id, place }));
      }}
      onSortDrop={(e, target) => {
        if (!dragItem || dragItem.id === target.id || dragItem.important !== target.important) return;
        e.preventDefault();
        e.stopPropagation();
        moveBookmark(scope, dragItem.id, target.id, placeOf(e));
        setDropMark(null); // dragId 由随后的 dragEnd 统一清
      }}
      onDelete={quickDelete}
    />
  );

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="书签：暂存需求 / 想法"
        className={
          "flex h-7 w-7 items-center justify-center rounded-md transition-colors " +
          (open
            ? "bg-[var(--accent)]/14 text-[var(--accent-text)]"
            : "text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)]")
        }
      >
        <BookmarkIcon />
      </button>
      {open && (
        <>
          <div ref={maskRef} className="fixed inset-0 z-[60]" onClick={close} />
          <div className="fixed right-2 top-[46px] z-[61] w-[360px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--elevated)] shadow-2xl">
            {editing ? (
              <BookmarkEditor
                initial={editing === "new" ? undefined : editing}
                onCancel={() => setEditing(null)}
                onSave={(input) => {
                  if (editing === "new") addBookmark(scope, input);
                  else updateBookmark(scope, editing.id, input);
                  setEditing(null);
                }}
              />
            ) : (
              <>
                <div className="flex items-center gap-2 px-3 pt-3 pb-2">
                  <span className="text-[13px] font-semibold text-[var(--text)]">书签</span>
                  {sorted.length > 0 && (
                    <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-px text-[10px] font-semibold text-[var(--accent-text)]">
                      {sorted.length}
                    </span>
                  )}
                  <button
                    onClick={() => setEditing("new")}
                    className="ml-auto rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11.5px] font-semibold text-white transition-colors hover:bg-[var(--accent-text)]"
                  >
                    ＋ 新建
                  </button>
                </div>
                <div className="max-h-[60vh] overflow-y-auto px-3 pb-3">
                  {sorted.length === 0 ? (
                    <div className="px-1 pt-8 pb-6 text-center text-[11.5px] leading-relaxed text-[var(--text-3)]">
                      还没有书签
                      <br />
                      点「＋ 新建」暂存一条需求 / 想法
                    </div>
                  ) : (
                    <>
                      {important.length > 0 && (
                        <>
                          <div className="px-1 pt-1 pb-1.5 text-[10px] font-semibold tracking-wider text-[var(--text-3)] uppercase">
                            重要 · 置顶
                          </div>
                          <div className="space-y-1.5">{important.map(card)}</div>
                          {rest.length > 0 && <div className="my-2.5 border-t border-[var(--border-soft)]" />}
                        </>
                      )}
                      {rest.length > 0 && <div className="space-y-1.5">{rest.map(card)}</div>}
                    </>
                  )}
                </div>
                {undo && (
                  <div className="flex items-center justify-between gap-2 border-t border-[var(--border-soft)] bg-[var(--surface-soft)] px-3 py-2">
                    <span className="min-w-0 truncate text-[11.5px] text-[var(--text-2)]">
                      已删除「{displayText(undo.b) || "（空白）"}」
                    </span>
                    <button
                      onClick={doUndo}
                      className="shrink-0 text-[11.5px] font-semibold text-[var(--accent-text)] hover:underline"
                    >
                      撤销
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { id: "edit", label: "编辑" },
            { id: "copy", label: "复制内容" },
            { id: "important", label: menu.b.important ? "取消重要" : "标为重要" },
            MENU_SEP,
            { id: "delete", label: "删除书签", danger: true },
          ]}
          onAction={(id) => {
            const b = menu.b;
            if (id === "edit") setEditing(b);
            else if (id === "copy") navigator.clipboard.writeText(copyTextOf(b)).catch(() => {});
            else if (id === "important") toggleImportant(scope, b.id);
            else if (id === "delete") quickDelete(b); // 与快捷按钮同路径：直删+撤销（决策 2=B 统一）
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
