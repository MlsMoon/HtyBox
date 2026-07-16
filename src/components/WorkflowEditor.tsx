import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addWorkflow,
  updateWorkflow,
  validateWorkflow,
  emptyStage,
  emptySegment,
  type Workflow,
  type WorkflowStage,
  type StageSegment,
  type StageKind,
} from "../workflows";
import { listManagedSkills, type ManagedSkill } from "../catalog";
import SearchBox from "./ui/SearchBox";
import { useMaskDismiss } from "./ui/maskDismiss";
import { searchScore } from "../search";
import { useSettings } from "../settings";
import {
  DEFAULT_SKILL_ROOT,
  loadSkillRoots,
  resolveActiveSkillRoot,
} from "../skillRoots";

// 工作流编辑弹窗（新建/编辑共用，仿 TeamEditor 的居中自定义弹窗）：名称/描述 + 阶段列表
// （增删/拖拽排序/类型切换/注入文本或人工指引/自动回车）+「多选 Skill 追加拼接」
// （勾选多项 → 空格追加到阶段 text 末尾，不覆盖）。校验失败内联提示，不用浏览器对话框。

/** 把若干 invoke 按空格追加到已有文本末尾；过滤空串；末尾已空白则不再重复加空格。 */
function appendInvokes(existing: string, invokes: string[]): string {
  const parts = invokes.map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return existing;
  const joined = parts.join(" ");
  if (!existing) return joined;
  if (/\s$/.test(existing)) return existing + joined;
  return existing + " " + joined;
}

/** Skill 多选插入：搜索框 + 限高滚动 + 勾选 + 确认插入（skill 可达数十上百）。
 *  统一搜索规则（search.ts）；Enter=确认已选，无已选时勾选并确认列表首项；Esc/外击关闭不写入。 */
function SkillPicker({
  x,
  y,
  skills,
  onConfirm,
  onClose,
}: {
  x: number;
  y: number;
  skills: ManagedSkill[];
  onConfirm: (invokes: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  /** 已选 skill 的 dir（过滤搜索时仍保留） */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
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

  const list = skills
    .map((s) => ({ s, score: searchScore(query, s.invoke, s.name, s.description) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);

  const toggle = (dir: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const confirm = (dirs: Set<string>) => {
    if (dirs.size === 0) return;
    const byDir = new Map(skills.map((s) => [s.dir, s.invoke] as const));
    const invokes = [...dirs].map((d) => byDir.get(d)).filter((x): x is string => !!x);
    if (invokes.length === 0) return;
    onConfirm(invokes);
    onClose();
  };

  const n = selected.size;

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 130 }}
      className="flex w-[320px] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-xl"
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (n >= 1) {
          confirm(selected);
          return;
        }
        if (list.length > 0) {
          // 与旧「Enter 选首项」兼容：无已选时勾选首项并插入
          confirm(new Set([list[0].s.dir]));
        }
      }}
    >
      <div className="border-b border-[var(--border-soft)] p-2">
        <SearchBox value={query} onChange={setQuery} placeholder="搜索已上架 Skill…" autoFocus />
      </div>
      <div className="max-h-[300px] overflow-y-auto py-1">
        {list.map(({ s }) => {
          const on = selected.has(s.dir);
          return (
            <button
              key={s.dir}
              type="button"
              onClick={() => toggle(s.dir)}
              title={s.description ? `${s.name} — ${s.description}` : s.name}
              className={
                "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11.5px] text-[var(--accent-text)] hover:bg-[var(--surface)] " +
                (on ? "bg-[var(--accent-soft)]" : "")
              }
            >
              <span
                className={
                  "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] leading-none " +
                  (on
                    ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                    : "border-[var(--border)] bg-[var(--bg)] text-transparent")
                }
                aria-hidden
              >
                ✓
              </span>
              <span className="min-w-0 truncate">{s.invoke}</span>
            </button>
          );
        })}
        {list.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-[var(--text-3)]">
            {skills.length ? "无匹配" : "当前工作区无已上架 Skill"}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border-soft)] px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[9px] text-[var(--text-3)]">
          已选 {n} · 勾选后点插入 · Esc 关闭
        </span>
        <button
          type="button"
          disabled={n === 0}
          onClick={() => confirm(selected)}
          className={
            "shrink-0 rounded-md px-2.5 py-1 text-[10.5px] font-semibold " +
            (n === 0
              ? "cursor-not-allowed bg-[var(--surface-hover)] text-[var(--text-3)]"
              : "bg-[var(--accent)] text-white hover:opacity-85")
          }
        >
          插入 {n} 项
        </button>
      </div>
    </div>,
    document.body,
  );
}

export default function WorkflowEditor({
  scope,
  initial,
  isNew,
  projectDir,
  onClose,
}: {
  /** 模板库作用域 = 工作区 id（按工作区独立存储） */
  scope: string;
  initial: Workflow;
  isNew: boolean;
  projectDir: string;
  onClose: () => void;
}) {
  const [wf, setWf] = useState<Workflow>(() => ({
    ...initial,
    stages: initial.stages.map((s) => ({ ...s })),
  }));
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [skillMenu, setSkillMenu] = useState<{ x: number; y: number; stageId: string; segId: string } | null>(null);
  // 拖拽排序（SkillTemplateModal 同款 dragIdx 模式）：行内有输入框，故 draggable 仅在
  // 按住 ⠿ 手柄（armed）时开启，避免输入框里拖选文字触发整行拖拽
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  // 片段级拖拽（scoped 到某阶段内）：armed key = `${stageId}:${idx}`
  const [segDrag, setSegDrag] = useState<{ stage: string; from: number } | null>(null);
  const [segOver, setSegOver] = useState<{ stage: string; idx: number } | null>(null);
  const [segArmed, setSegArmed] = useState<string | null>(null);
  const mask = useMaskDismiss(onClose);
  const { skillRoots: globalRoots } = useSettings();

  useEffect(() => {
    let alive = true;
    const cands = loadSkillRoots(projectDir);
    resolveActiveSkillRoot(projectDir, cands)
      .then((r) => listManagedSkills(projectDir, r.active || DEFAULT_SKILL_ROOT))
      .then((list) => {
        if (alive) setSkills(list.filter((s) => s.enabled));
      })
      .catch(() => {
        /* 无 skills 目录等 → 插入功能自然为空 */
      });
    return () => {
      alive = false;
    };
  }, [projectDir, globalRoots]);

  const patchStage = (id: string, patch: Partial<WorkflowStage>) =>
    setWf((w) => ({ ...w, stages: w.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const reorderStage = (from: number, to: number) =>
    setWf((w) => {
      if (from === to || from < 0 || to < 0 || from >= w.stages.length || to >= w.stages.length) return w;
      const stages = [...w.stages];
      const [moved] = stages.splice(from, 1);
      stages.splice(to, 0, moved);
      return { ...w, stages };
    });
  const removeStage = (id: string) =>
    setWf((w) => ({ ...w, stages: w.stages.filter((s) => s.id !== id) }));

  const patchSegment = (stageId: string, segId: string, patch: Partial<StageSegment>) =>
    setWf((w) => ({
      ...w,
      stages: w.stages.map((s) =>
        s.id === stageId
          ? { ...s, segments: s.segments.map((seg) => (seg.id === segId ? { ...seg, ...patch } : seg)) }
          : s,
      ),
    }));
  const addSegment = (stageId: string, kind: StageKind) =>
    setWf((w) => ({
      ...w,
      stages: w.stages.map((s) => (s.id === stageId ? { ...s, segments: [...s.segments, emptySegment(kind)] } : s)),
    }));
  const removeSegment = (stageId: string, segId: string) =>
    setWf((w) => ({
      ...w,
      stages: w.stages.map((s) =>
        s.id === stageId
          ? { ...s, segments: s.segments.length > 1 ? s.segments.filter((seg) => seg.id !== segId) : s.segments }
          : s,
      ),
    }));
  const reorderSegment = (stageId: string, from: number, to: number) =>
    setWf((w) => ({
      ...w,
      stages: w.stages.map((s) => {
        if (s.id !== stageId) return s;
        if (from === to || from < 0 || to < 0 || from >= s.segments.length || to >= s.segments.length) return s;
        const segs = [...s.segments];
        const [m] = segs.splice(from, 1);
        segs.splice(to, 0, m);
        return { ...s, segments: segs };
      }),
    }));

  const save = () => {
    const err = validateWorkflow(wf);
    if (err) {
      setError(err);
      return;
    }
    if (isNew) addWorkflow(scope, wf);
    else updateWorkflow(scope, wf);
    onClose();
  };

  const inputCls =
    "rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-[12px] text-[var(--text)] outline-none transition-colors focus:border-[var(--accent-border)]";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30" {...mask}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86vh] w-[860px] max-w-[94vw] flex-col rounded-2xl bg-[var(--elevated)] p-5 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-[var(--text)]">{isNew ? "新建工作流" : "编辑工作流"}</h2>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-[var(--text-2)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            ✕
          </button>
        </div>
        {/* 名称 / 描述 */}
        <div className="mb-3 flex gap-3">
          <label className="flex w-[280px] flex-col gap-1 text-[11px] text-[var(--text-2)]">
            名称
            <input
              value={wf.name}
              onChange={(e) => setWf({ ...wf, name: e.target.value })}
              placeholder="如：常规开发流"
              className={inputCls}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-[var(--text-2)]">
            描述
            <input
              value={wf.description ?? ""}
              onChange={(e) => setWf({ ...wf, description: e.target.value })}
              placeholder="一句话说明这个流程"
              className={inputCls}
            />
          </label>
        </div>
        {/* 阶段列表 */}
        <div className="flex items-center gap-2 pb-1.5">
          <span className="text-[12px] font-bold text-[var(--text)]">阶段序列</span>
          <span className="text-[10px] text-[var(--text-3)]">{wf.stages.length} 个阶段 · 按住 ⠿ 拖拽排序</span>
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {wf.stages.map((s, i) => (
            <div
              key={s.id}
              draggable={armed === i}
              onDragStart={(e) => {
                setDragIdx(i);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragIdx !== null && overIdx !== i) setOverIdx(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx !== null) reorderStage(dragIdx, i);
                setDragIdx(null);
                setOverIdx(null);
                setArmed(null);
              }}
              onDragEnd={() => {
                setDragIdx(null);
                setOverIdx(null);
                setArmed(null);
              }}
              className={
                "flex flex-col rounded-lg border bg-[var(--surface)] px-2 py-2 transition-colors " +
                (dragIdx === i ? "opacity-40 " : "") +
                (overIdx === i && dragIdx !== null && dragIdx !== i
                  ? "border-[var(--accent-border)]"
                  : "border-[var(--border-soft)]")
              }
            >
              {/* 阶段头：拖拽手柄 + 序号 + 名称 + 自动⏎ + 删阶段 */}
              <div className="flex items-center gap-2">
                <div
                  onMouseDown={() => setArmed(i)}
                  onMouseUp={() => setArmed(null)}
                  title="拖拽排序阶段"
                  className="flex h-[28px] w-9 shrink-0 cursor-grab items-center justify-center gap-0.5 text-[var(--text-faint)]"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
                    <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
                    <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
                  </svg>
                  <span className="text-[10px] text-[var(--text-3)]">{i + 1}</span>
                </div>
                <input
                  value={s.name}
                  onChange={(e) => patchStage(s.id, { name: e.target.value })}
                  placeholder="阶段名"
                  className={inputCls + " h-[28px] w-[160px] shrink-0"}
                />
                <div className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-3)]">
                  {s.segments.length} 片段 · 人工填写（执行可粘图）/ 注入固定，按序拼接
                </div>
                <label
                  title="注入后自动回车执行；关闭则等你补参数后自己回车"
                  className="flex shrink-0 cursor-pointer items-center gap-1 text-[10px] text-[var(--text-2)]"
                >
                  <input
                    type="checkbox"
                    checked={s.pressEnter}
                    onChange={(e) => patchStage(s.id, { pressEnter: e.target.checked })}
                    className="accent-[var(--accent)]"
                  />
                  自动⏎
                </label>
                <button
                  type="button"
                  onClick={() => removeStage(s.id)}
                  title="删除此阶段"
                  className="shrink-0 rounded px-1 text-[12px] text-[var(--danger)] hover:bg-[var(--surface-hover)]"
                >
                  ✕
                </button>
              </div>
              {/* 片段子列表（人工/注入，可拖拽排序） */}
              <div className="mt-1.5 space-y-1 pl-9">
                {s.segments.map((seg, si) => (
                  <div
                    key={seg.id}
                    draggable={segArmed === `${s.id}:${si}`}
                    onDragStart={(e) => {
                      setSegDrag({ stage: s.id, from: si });
                      e.dataTransfer.effectAllowed = "move";
                      e.stopPropagation();
                    }}
                    onDragOver={(e) => {
                      if (segDrag?.stage !== s.id) return;
                      e.preventDefault();
                      e.stopPropagation();
                      if (segOver?.idx !== si) setSegOver({ stage: s.id, idx: si });
                    }}
                    onDrop={(e) => {
                      if (segDrag?.stage === s.id) {
                        e.preventDefault();
                        e.stopPropagation();
                        reorderSegment(s.id, segDrag.from, si);
                      }
                      setSegDrag(null);
                      setSegOver(null);
                      setSegArmed(null);
                    }}
                    onDragEnd={() => {
                      setSegDrag(null);
                      setSegOver(null);
                      setSegArmed(null);
                    }}
                    className={
                      "flex items-center gap-1.5 rounded-md border bg-[var(--bg)] px-1.5 py-1 transition-colors " +
                      (segDrag?.stage === s.id && segDrag.from === si ? "opacity-40 " : "") +
                      (segOver?.stage === s.id && segOver.idx === si && segDrag && segDrag.from !== si
                        ? "border-[var(--accent-border)]"
                        : "border-[var(--border-soft)]")
                    }
                  >
                    <div
                      onMouseDown={() => setSegArmed(`${s.id}:${si}`)}
                      onMouseUp={() => setSegArmed(null)}
                      title="拖拽排序片段"
                      className="flex h-[26px] w-4 shrink-0 cursor-grab items-center justify-center text-[var(--text-faint)]"
                    >
                      <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
                        <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
                        <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
                      </svg>
                    </div>
                    <div className="flex h-[26px] shrink-0 items-center gap-0.5 rounded-md bg-[var(--surface-hover)] p-0.5">
                      {(["manual", "inject"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => patchSegment(s.id, seg.id, { kind: k })}
                          className={
                            "rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors " +
                            (seg.kind === k
                              ? "bg-[var(--accent)] text-white"
                              : "text-[var(--text-2)] hover:text-[var(--text)]")
                          }
                        >
                          {k === "inject" ? "注入" : "人工"}
                        </button>
                      ))}
                    </div>
                    <input
                      value={seg.text}
                      onChange={(e) => patchSegment(s.id, seg.id, { text: e.target.value })}
                      placeholder={
                        seg.kind === "inject" ? "注入命令/引用，如 /plan-create" : "给用户的指引/占位，如：描述需求（执行时可粘图）"
                      }
                      className={inputCls + " h-[26px] min-w-0 flex-1 " + (seg.kind === "inject" ? "font-mono text-[var(--accent-text)]" : "")}
                    />
                    {seg.kind === "inject" && (
                      <button
                        type="button"
                        onClick={(e) => {
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setSkillMenu({ x: r.left, y: r.bottom + 4, stageId: s.id, segId: seg.id });
                        }}
                        title="勾选多个已上架 Skill，追加拼接到该注入片段末尾"
                        className="shrink-0 rounded-md border border-[var(--border)] px-1.5 py-1 text-[9.5px] text-[var(--accent-text)] hover:border-[var(--accent-border)]"
                      >
                        Skill▾
                      </button>
                    )}
                    {s.segments.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeSegment(s.id, seg.id)}
                        title="删除此片段"
                        className="shrink-0 rounded px-1 text-[11px] text-[var(--danger)] hover:bg-[var(--surface-hover)]"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => addSegment(s.id, "manual")}
                    className="rounded-md border border-dashed border-[var(--accent-border)] px-2 py-1 text-[10px] text-[var(--accent-text)] hover:bg-[var(--accent-soft)]"
                  >
                    ＋ 人工片段
                  </button>
                  <button
                    type="button"
                    onClick={() => addSegment(s.id, "inject")}
                    className="rounded-md border border-dashed border-[var(--accent-border)] px-2 py-1 text-[10px] text-[var(--accent-text)] hover:bg-[var(--accent-soft)]"
                  >
                    ＋ 注入片段
                  </button>
                </div>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setWf((w) => ({ ...w, stages: [...w.stages, emptyStage()] }))}
            className="w-full rounded-lg border border-dashed border-[var(--accent-border)] py-2 text-[11px] text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-soft)]"
          >
            ＋ 添加阶段
          </button>
        </div>
        {/* 校验提示 + 底部按钮 */}
        <div className="mt-3 flex items-center gap-3 border-t border-[var(--border-soft)] pt-3">
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--danger)]">{error ?? ""}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-hover)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-[12px] font-semibold text-white hover:opacity-85"
          >
            保存
          </button>
        </div>
        {skillMenu && (
          <SkillPicker
            x={skillMenu.x}
            y={skillMenu.y}
            skills={skills}
            onConfirm={(invokes) => {
              const { stageId, segId } = skillMenu;
              setWf((w) => ({
                ...w,
                stages: w.stages.map((st) =>
                  st.id === stageId
                    ? {
                        ...st,
                        segments: st.segments.map((seg) =>
                          seg.id === segId ? { ...seg, text: appendInvokes(seg.text, invokes) } : seg,
                        ),
                      }
                    : st,
                ),
              }));
            }}
            onClose={() => setSkillMenu(null)}
          />
        )}
      </div>
    </div>
  );
}
