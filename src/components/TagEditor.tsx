import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TAG_COLORS, tagDot, type TagColorKey } from "../tagColors";
import type { AgentKind } from "../profiles";
import {
  useSessionTags,
  useVocab,
  sessionKey,
  createTag,
  addTag,
  removeTag,
  toggleTag,
  deleteTag,
  updateTag,
  countSessionsWithTag,
  type Tag,
} from "../sessionTags";
import ContextMenu, { MENU_SEP } from "./ui/ContextMenu";
import ConfirmModal from "./ui/ConfirmModal";

/** 注入式标签编辑模型：Session / Skill 各绑自己的 store，UI 共用。 */
export interface TagEditorModel {
  tags: Tag[];
  vocab: Tag[];
  subjectName?: string;
  /** 区块标题，如「该会话标签」/「该 skill 标签」 */
  entityLabel: string;
  /** 新建区右侧 hint，如「回车即打到当前会话」 */
  applyHint: string;
  /** 删除确认里的单位，如「个会话」/「个 skill」 */
  removeUnit: string;
  createTag: (name: string, color?: TagColorKey) => Tag;
  addTag: (tagId: string) => void;
  removeTag: (tagId: string) => void;
  toggleTag: (tagId: string) => void;
  updateTag: (tagId: string, patch: { name?: string; color?: TagColorKey }) => boolean;
  deleteTag: (tagId: string) => void;
  countWithTag: (tagId: string) => number;
}

/** 6 色点选择行（新建区与原位编辑行共用；带选中环 + ✓）。 */
function ColorDots({ value, onPick }: { value: TagColorKey; onPick: (c: TagColorKey) => void }) {
  return (
    <>
      {TAG_COLORS.map((c) => (
        <button
          key={c.key}
          onClick={() => onPick(c.key)}
          title={c.label}
          className="relative h-4 w-4 rounded-full"
          style={{ backgroundColor: c.dot, boxShadow: value === c.key ? "0 0 0 2px var(--elevated), 0 0 0 3.5px var(--accent)" : "none" }}
        >
          {value === c.key && (
            <svg className="absolute inset-0 m-auto h-2.5 w-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </button>
      ))}
    </>
  );
}

/** 通用标签编辑 popover（portal；数据由 model 注入）。 */
export function TagEditor({
  x,
  y,
  onClose,
  model,
}: {
  x: number;
  y: number;
  onClose: () => void;
  model: TagEditorModel;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [draft, setDraft] = useState("");
  const [newColor, setNewColor] = useState<TagColorKey>("blue");
  const [menu, setMenu] = useState<{ x: number; y: number; tag: Tag } | null>(null);
  const [confirmDel, setConfirmDel] = useState<Tag | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; color: TagColorKey; clash: boolean } | null>(null);
  const editRowRef = useRef<HTMLDivElement>(null);
  const commitEdit = () => {
    if (!editing) return;
    if (model.updateTag(editing.id, { name: editing.name })) setEditing(null);
    else setEditing({ ...editing, clash: true });
  };
  const guardRef = useRef(false);
  guardRef.current = !!(menu || confirmDel);
  const { tags, vocab } = model;
  const has = (id: string) => tags.some((t) => t.id === id);

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
      if (guardRef.current) return;
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !guardRef.current) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const submitNew = () => {
    const n = draft.trim();
    if (!n) return;
    const tag = model.createTag(n, newColor);
    model.addTag(tag.id);
    setDraft("");
  };

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 120 }}
      className="w-[300px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--elevated)] shadow-xl"
      onMouseDown={(e) => {
        if (editing && !editRowRef.current?.contains(e.target as Node)) commitEdit();
      }}
    >
      <div className="flex items-center gap-2 border-b border-[var(--border-soft)] px-3.5 py-2.5">
        <span className="text-[14px] font-bold text-[var(--text)]">标签</span>
        {model.subjectName && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-3)]">· {model.subjectName}</span>
        )}
        <button
          onClick={onClose}
          className="ml-auto shrink-0 text-[13px] leading-none text-[var(--text-3)] hover:text-[var(--text)]"
        >
          ✕
        </button>
      </div>
      {tags.length > 0 && (
        <div className="border-b border-[var(--border-soft)] px-3.5 py-2.5">
          <div className="mb-1.5 text-[10px] font-bold tracking-wide text-[var(--text-2)]">{model.entityLabel}</div>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[10.5px] font-semibold"
                style={{ color: tagDot(t.color), borderColor: tagDot(t.color) + "66", backgroundColor: tagDot(t.color) + "22" }}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tagDot(t.color) }} />
                {t.name}
                <button onClick={() => model.removeTag(t.id)} title="移除" className="ml-0.5 leading-none hover:opacity-60">
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="border-b border-[var(--border-soft)] px-3.5 py-2.5">
        <div className="mb-1.5 text-[10px] font-bold tracking-wide text-[var(--text-2)]">全部标签 · 点选增删</div>
        {vocab.length === 0 ? (
          <div className="text-[11px] text-[var(--text-3)]">还没有标签，下面新建一个 ↓</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {vocab.map((t) => {
              if (editing?.id === t.id) {
                return (
                  <div key={t.id} ref={editRowRef} className="flex w-full flex-wrap items-center gap-2 rounded-md border border-[var(--accent-border)] bg-[var(--surface)] px-2 py-1.5">
                    <input
                      autoFocus
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value, clash: false })}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitEdit();
                        else if (e.key === "Escape") setEditing(null);
                      }}
                      className={
                        "min-w-0 flex-1 rounded border bg-[var(--elevated)] px-1.5 py-0.5 text-[11px] text-[var(--text)] outline-none " +
                        (editing.clash ? "border-[var(--danger)]" : "border-[var(--border)]")
                      }
                    />
                    <ColorDots
                      value={editing.color}
                      onPick={(c) => {
                        if (model.updateTag(editing.id, { color: c })) setEditing({ ...editing, color: c });
                      }}
                    />
                    {editing.clash && (
                      <div className="w-full text-[9.5px] text-[var(--danger)]">名称不能为空或与已有标签重名</div>
                    )}
                  </div>
                );
              }
              const on = has(t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => model.toggleTag(t.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, tag: t });
                  }}
                  className={
                    "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] transition-colors " +
                    (on
                      ? "border-[var(--accent-border)] bg-[var(--accent)]/10 text-[var(--text)]"
                      : "border-[var(--border)] bg-[var(--elevated)] text-[var(--text-2)] hover:bg-[var(--surface)]")
                  }
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tagDot(t.color) }} />
                  {t.name}
                  {on && (
                    <svg className="h-3 w-3 text-[var(--accent-text)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-3.5 py-2.5">
        <div className="mb-1.5 text-[10px] font-bold tracking-wide text-[var(--text-2)]">新建标签</div>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") submitNew();
            else if (e.key === "Escape") onClose();
          }}
          placeholder="为新标签起名，回车创建…"
          className="w-full rounded-md border border-[var(--accent-border)] bg-[var(--elevated)] px-2.5 py-1.5 text-[11.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
        />
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[10px] font-bold tracking-wide text-[var(--text-2)]">颜色</span>
          <ColorDots value={newColor} onPick={setNewColor} />
          <span className="ml-auto text-[9.5px] text-[var(--text-3)]">{model.applyHint}</span>
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ id: "edit", label: "编辑标签" }, MENU_SEP, { id: "delete", label: "删除标签", danger: true }]}
          onAction={(id) => {
            if (id === "edit") setEditing({ id: menu.tag.id, name: menu.tag.name, color: menu.tag.color, clash: false });
            else if (id === "delete") setConfirmDel(menu.tag);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {confirmDel && (
        <ConfirmModal
          title={`删除标签“${confirmDel.name}”？`}
          message={`将同时从 ${model.countWithTag(confirmDel.id)} ${model.removeUnit}移除，不可恢复。`}
          zIndex={130}
          onConfirm={() => {
            model.deleteTag(confirmDel.id);
            if (editing?.id === confirmDel.id) setEditing(null);
          }}
          onClose={() => setConfirmDel(null)}
        />
      )}
    </div>,
    document.body,
  );
}

/** Session 入口：原 props 形态，内部绑 sessionTags。SessionPanel / TerminalDock 共用。 */
export default function SessionTagEditor({
  x,
  y,
  agentKind,
  sessionId,
  sessionName,
  onClose,
}: {
  x: number;
  y: number;
  agentKind: Exclude<AgentKind, "shell">;
  sessionId: string;
  sessionName?: string;
  onClose: () => void;
}) {
  const key = sessionKey(agentKind, sessionId);
  const tags = useSessionTags(agentKind, sessionId);
  const vocab = useVocab();
  const model: TagEditorModel = {
    tags,
    vocab,
    subjectName: sessionName,
    entityLabel: "该会话标签",
    applyHint: "回车即打到当前会话",
    removeUnit: "个会话",
    createTag,
    addTag: (tagId) => addTag(key, tagId),
    removeTag: (tagId) => removeTag(key, tagId),
    toggleTag: (tagId) => toggleTag(key, tagId),
    updateTag,
    deleteTag,
    countWithTag: countSessionsWithTag,
  };
  return <TagEditor x={x} y={y} onClose={onClose} model={model} />;
}
