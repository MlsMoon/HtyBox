import type { ReactNode, RefObject } from "react";

const DRAG_MIME = "application/x-htybox-item";

/** CLI 双线输入壳：无圆角、上下陶土直线；无发送按钮（Enter 发送）；无底部小字提示。 */
export default function TermInputShell({
  title,
  rightHint = "输入将发送到该终端",
  stashed = false,
  value,
  onChange,
  onKeyDown,
  onCaret,
  placeholder,
  dragOver,
  setDragOver,
  textareaRef,
  attachments,
  onRemoveAttachment,
  onDropItem,
  rows = 3,
  menu,
}: {
  title: string;
  rightHint?: string;
  /** 当前字段有 LeftCtrl+S 暂存时显示提示条 */
  stashed?: boolean;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCaret?: (text: string, el: HTMLTextAreaElement) => void;
  placeholder?: string;
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  attachments?: string[];
  onRemoveAttachment?: (path: string) => void;
  onDropItem?: (e: React.DragEvent) => void;
  rows?: number;
  menu?: ReactNode;
}) {
  const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

  return (
    <div className="px-3 pb-2 pt-2">
      <div className="flex items-center gap-1.5 pb-1.5 text-[10px] text-[#8c8a82]">
        <span className="text-[var(--accent)]">✎</span>
        <span className="shrink-0 font-semibold text-[#e5e2dc]">{title}</span>
        {stashed && (
          <span
            title="已暂存一段输入 · Left Ctrl+S 恢复 · 发送后也会自动填回"
            className="shrink-0 border border-[#6b4d38] bg-[#3a2a22] px-1.5 py-0.5 text-[9px] font-bold text-[var(--accent)]"
          >
            暂存中
          </span>
        )}
        <span className="ml-auto shrink-0">{rightHint}</span>
      </div>

      <div className={"h-px w-full " + (stashed ? "bg-[var(--accent)] opacity-100" : "bg-[var(--accent)]")} />

      <div
        className={
          "relative py-2 " + (stashed ? "bg-[var(--accent)]/[0.06]" : "")
        }
        onDragOver={(e) => {
          if (!onDropItem || !e.dataTransfer.types.includes(DRAG_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={(e) => {
          setDragOver(false);
          onDropItem?.(e);
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          rows={rows}
          onChange={(e) => {
            onChange(e.target.value);
            onCaret?.(e.target.value, e.target);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => onCaret?.(value, e.currentTarget)}
          onSelect={(e) => onCaret?.(value, e.currentTarget)}
          onClick={(e) => onCaret?.(value, e.currentTarget)}
          placeholder={placeholder}
          className={
            "w-full resize-none border-0 bg-transparent px-1 py-1 text-[12px] leading-relaxed text-[#e5e2dc] outline-none placeholder:text-[#8c8a82]/60 " +
            (dragOver ? "bg-[var(--accent)]/10 ring-2 ring-[var(--accent)]/40" : "")
          }
        />
        {menu && <div className="mt-1">{menu}</div>}
      </div>

      <div className="h-px w-full bg-[var(--accent)]" />

      {attachments && attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
          {attachments.map((p) => (
            <span
              key={p}
              title={p}
              className="flex items-center gap-1 bg-[#3a3631] px-2 py-0.5 text-[9.5px] font-semibold text-[var(--accent)]"
            >
              📷 {baseName(p)}
              {onRemoveAttachment && (
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(p)}
                  title="移除并删除该临时图片文件"
                  className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center text-[9px] leading-none text-[#8c8a82] hover:bg-[#4a453e] hover:text-[#e5e2dc]"
                >
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export { DRAG_MIME };
