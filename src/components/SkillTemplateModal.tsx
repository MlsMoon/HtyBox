import { useState } from "react";
import type { ManagedSkill } from "../catalog";
import { saveTemplates, emptyTemplate, type SkillTemplate } from "../skillTemplates";
import { searchMatch } from "../search";
import { useMaskDismiss } from "./ui/maskDismiss";

/** M8-C：Skill 模板管理模态。左列模板增删改、右列勾选该模板要上架的 skill（按 dir）。 */
export default function SkillTemplateModal({
  projectDir,
  skills,
  templates,
  onClose,
  onChange,
}: {
  projectDir: string;
  skills: ManagedSkill[];
  templates: SkillTemplate[];
  onClose: () => void;
  onChange: (list: SkillTemplate[]) => void;
}) {
  const [list, setList] = useState<SkillTemplate[]>(templates);
  const [selId, setSelId] = useState<string | null>(templates[0]?.id ?? null);
  const [q, setQ] = useState("");
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const mask = useMaskDismiss(onClose);
  const sel = list.find((t) => t.id === selId) ?? null;

  const persist = (next: SkillTemplate[]) => {
    setList(next);
    saveTemplates(projectDir, next);
    onChange(next);
  };
  // 拖拽重排：列表数组顺序即展示顺序（切换弹窗也按此序）
  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    persist(next);
  };
  const addTpl = () => {
    const t = emptyTemplate();
    t.name = "新模板";
    persist([...list, t]);
    setSelId(t.id);
  };
  const delTpl = (id: string) => {
    const next = list.filter((t) => t.id !== id);
    persist(next);
    if (selId === id) setSelId(next[0]?.id ?? null);
  };
  const renameTpl = (id: string, name: string) =>
    persist(list.map((t) => (t.id === id ? { ...t, name } : t)));
  const toggleDir = (dir: string) => {
    if (!sel) return;
    const dirs = sel.skillDirs.includes(dir)
      ? sel.skillDirs.filter((d) => d !== dir)
      : [...sel.skillDirs, dir];
    persist(list.map((t) => (t.id === sel.id ? { ...t, skillDirs: dirs } : t)));
  };

  // 搜索过滤（名称/目录）；全选·全不选只作用于当前过滤结果，便于批量快速编辑
  const filtered = q.trim()
    ? skills.filter((s) => searchMatch(q, s.name, s.dir))
    : skills;
  const setSelDirs = (dirs: string[]) => {
    if (sel) persist(list.map((t) => (t.id === sel.id ? { ...t, skillDirs: dirs } : t)));
  };
  const selectAllFiltered = () => {
    if (!sel) return;
    setSelDirs(Array.from(new Set([...sel.skillDirs, ...filtered.map((s) => s.dir)])));
  };
  const deselectAllFiltered = () => {
    if (!sel) return;
    const fset = new Set(filtered.map((s) => s.dir));
    setSelDirs(sel.skillDirs.filter((d) => !fset.has(d)));
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30" {...mask}>
      <div className="flex h-[70vh] w-[680px] max-w-[92vw] flex-col overflow-hidden rounded-2xl bg-[var(--elevated)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <span className="text-sm font-semibold text-[var(--text)]">管理 Skill 模板</span>
          <button onClick={onClose} className="rounded px-2 text-[var(--text-3)] hover:text-[var(--text)]">✕</button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-48 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg)]">
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
              {list.length === 0 && <div className="px-1 pt-4 text-center text-[11px] text-[var(--text-3)]">还没有模板</div>}
              {list.map((t, i) => (
                <div
                  key={t.id}
                  draggable
                  onDragStart={(e) => {
                    setDragIdx(i);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIdx !== null) reorder(dragIdx, i);
                    setDragIdx(null);
                  }}
                  onDragEnd={() => setDragIdx(null)}
                  onClick={() => setSelId(t.id)}
                  className={
                    "flex cursor-grab items-center gap-1 rounded-lg px-2 py-1.5 " +
                    (selId === t.id ? "bg-[var(--surface-hover)]" : "hover:bg-[var(--surface-soft)]") +
                    (dragIdx === i ? " opacity-40" : "")
                  }
                >
                  <svg className="h-3 w-3 shrink-0 text-[var(--text-faint)]" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="6" r="1.4" />
                    <circle cx="15" cy="6" r="1.4" />
                    <circle cx="9" cy="12" r="1.4" />
                    <circle cx="15" cy="12" r="1.4" />
                    <circle cx="9" cy="18" r="1.4" />
                    <circle cx="15" cy="18" r="1.4" />
                  </svg>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)]">{t.name || "（未命名）"}</span>
                  <span className="shrink-0 text-[10px] text-[var(--text-3)]">{t.skillDirs.length}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      delTpl(t.id);
                    }}
                    title="删除模板"
                    className="shrink-0 text-[11px] text-[var(--text-faint)] hover:text-[var(--danger)]"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button onClick={addTpl} className="m-2 rounded-lg border border-dashed border-[var(--accent-border)] px-2 py-1.5 text-[12px] font-semibold text-[var(--accent-text)] hover:bg-[var(--accent-soft)]">+ 新建模板</button>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {!sel ? (
              <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-3)]">选择或新建一个模板</div>
            ) : (
              <>
                <div className="space-y-2 border-b border-[var(--border)] px-3 py-2">
                  <input value={sel.name} onChange={(e) => renameTpl(sel.id, e.target.value)} placeholder="模板名" className="w-full rounded-md border border-[var(--border)] px-2 py-1 text-[13px] outline-none focus:border-[var(--accent-border)]" />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 skill（名称/目录）…" className="w-full rounded-md border border-[var(--border)] px-2 py-1 text-[12px] outline-none focus:border-[var(--accent-border)]" />
                  <div className="flex items-center gap-1.5">
                    <button onClick={selectAllFiltered} className="rounded-md bg-[var(--surface-hover)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-2)] hover:bg-[var(--border-soft)] hover:text-[var(--text)]">全选{q ? "（命中项）" : ""}</button>
                    <button onClick={deselectAllFiltered} className="rounded-md bg-[var(--surface-hover)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-2)] hover:bg-[var(--border-soft)] hover:text-[var(--text)]">全不选{q ? "（命中项）" : ""}</button>
                    <span className="ml-auto text-[10.5px] text-[var(--text-3)]">已选 {sel.skillDirs.length}/{skills.length}{q ? ` · 命中 ${filtered.length}` : ""}</span>
                  </div>
                </div>
                <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
                  {filtered.length === 0 && <div className="px-1 pt-4 text-center text-[11px] text-[var(--text-3)]">{skills.length === 0 ? "本工作区没有 skill" : "无匹配"}</div>}
                  {filtered.map((s) => (
                    <label key={s.dir} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-[var(--surface)]">
                      <input type="checkbox" checked={sel.skillDirs.includes(s.dir)} onChange={() => toggleDir(s.dir)} className="accent-[var(--accent)]" />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-deep)]">{s.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-[var(--text-3)]">{s.dir}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
