import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addWorkflow,
  updateWorkflow,
  validateWorkflow,
  emptyStage,
  type Workflow,
  type WorkflowStage,
} from "../workflows";
import { listManagedSkills, type ManagedSkill } from "../catalog";
import SearchBox from "./ui/SearchBox";
import { useMaskDismiss } from "./ui/maskDismiss";
import { searchScore } from "../search";

// 工作流编辑弹窗（新建/编辑共用，仿 TeamEditor 的居中自定义弹窗）：名称/描述 + 阶段列表
// （增删/上移下移/类型切换/注入文本或人工指引/自动回车）+「从 Skill 插入」（当前工作区已上架
// skill 的 invoke 一键填入）。校验失败内联提示，不用浏览器对话框。

/** Skill 插入选择器：搜索框 + 内置滚动列表（skill 可达数十上百，纯菜单会撑爆屏幕——用户反馈）。
 *  统一搜索规则（search.ts）过滤排序；Enter 直选最佳匹配；Esc/外击关闭。 */
function SkillPicker({
  x,
  y,
  skills,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  skills: ManagedSkill[];
  onPick: (invoke: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
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

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 130 }}
      className="flex w-[320px] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-xl"
      onKeyDown={(e) => {
        // Enter 直选最佳匹配（列表首项）
        if (e.key === "Enter" && list.length > 0) {
          e.preventDefault();
          onPick(list[0].s.invoke);
          onClose();
        }
      }}
    >
      <div className="border-b border-[var(--border-soft)] p-2">
        <SearchBox value={query} onChange={setQuery} placeholder="搜索已上架 Skill…" autoFocus />
      </div>
      <div className="max-h-[300px] overflow-y-auto py-1">
        {list.map(({ s }) => (
          <button
            key={s.dir}
            onClick={() => {
              onPick(s.invoke);
              onClose();
            }}
            title={s.description ? `${s.name} — ${s.description}` : s.name}
            className="block w-full truncate px-3 py-1.5 text-left font-mono text-[11.5px] text-[var(--accent-text)] hover:bg-[var(--surface)]"
          >
            {s.invoke}
          </button>
        ))}
        {list.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-[var(--text-3)]">
            {skills.length ? "无匹配" : "当前工作区无已上架 Skill"}
          </div>
        )}
      </div>
      <div className="border-t border-[var(--border-soft)] px-3 py-1 text-[9px] text-[var(--text-3)]">
        {list.length}/{skills.length} · Enter 选首项 · Esc 关闭
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
  const [skillMenu, setSkillMenu] = useState<{ x: number; y: number; stageId: string } | null>(null);
  // 拖拽排序（SkillTemplateModal 同款 dragIdx 模式）：行内有 input，故 draggable 仅在
  // 按住 ⠿ 手柄（armed）时开启，避免输入框里拖选文字触发整行拖拽
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const mask = useMaskDismiss(onClose);

  useEffect(() => {
    let alive = true;
    listManagedSkills(projectDir)
      .then((list) => {
        if (alive) setSkills(list.filter((s) => s.enabled));
      })
      .catch(() => {
        /* 无 .claude/skills 目录等 → 插入功能自然为空 */
      });
    return () => {
      alive = false;
    };
  }, [projectDir]);

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
                "flex items-center gap-2 rounded-lg border bg-[var(--surface)] px-2 py-1.5 transition-colors " +
                (dragIdx === i ? "opacity-40 " : "") +
                (overIdx === i && dragIdx !== null && dragIdx !== i
                  ? "border-[var(--accent-border)]"
                  : "border-[var(--border-soft)]")
              }
            >
              <div
                onMouseDown={() => setArmed(i)}
                onMouseUp={() => setArmed(null)}
                title="拖拽排序"
                className="flex w-9 shrink-0 cursor-grab items-center justify-center gap-0.5 text-[var(--text-faint)]"
              >
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="9" cy="6" r="1.4" />
                  <circle cx="15" cy="6" r="1.4" />
                  <circle cx="9" cy="12" r="1.4" />
                  <circle cx="15" cy="12" r="1.4" />
                  <circle cx="9" cy="18" r="1.4" />
                  <circle cx="15" cy="18" r="1.4" />
                </svg>
                <span className="text-[10px] text-[var(--text-3)]">{i + 1}</span>
              </div>
              <input
                value={s.name}
                onChange={(e) => patchStage(s.id, { name: e.target.value })}
                placeholder="阶段名"
                className={inputCls + " w-[120px] shrink-0"}
              />
              {/* 类型 segmented */}
              <div className="flex shrink-0 gap-0.5 rounded-lg bg-[var(--surface-hover)] p-0.5">
                {(["inject", "manual"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => patchStage(s.id, { kind: k })}
                    className={
                      "rounded-md px-2 py-1 text-[10.5px] font-semibold transition-colors " +
                      (s.kind === k
                        ? "bg-[var(--accent)] text-white"
                        : "text-[var(--text-2)] hover:text-[var(--text)]")
                    }
                  >
                    {k === "inject" ? "注入" : "人工"}
                  </button>
                ))}
              </div>
              <input
                value={s.text}
                onChange={(e) => patchStage(s.id, { text: e.target.value })}
                placeholder={s.kind === "inject" ? "注入命令，如 /plan-create" : "给自己的指引，如：向 AI 描述需求"}
                className={
                  inputCls + " min-w-0 flex-1 " + (s.kind === "inject" ? "font-mono text-[var(--accent-text)]" : "")
                }
              />
              {s.kind === "inject" && (
                <>
                  <button
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setSkillMenu({ x: r.left, y: r.bottom + 4, stageId: s.id });
                    }}
                    title="从当前工作区已上架 Skill 插入调用"
                    className="shrink-0 rounded-md border border-[var(--border)] px-1.5 py-1 text-[9.5px] text-[var(--accent-text)] hover:border-[var(--accent-border)]"
                  >
                    Skill▾
                  </button>
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
                </>
              )}
              <button
                onClick={() => removeStage(s.id)}
                title="删除此阶段"
                className="shrink-0 rounded px-1 text-[11px] text-[var(--danger)] hover:bg-[var(--surface-hover)]"
              >
                ✕
              </button>
            </div>
          ))}
          <button
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
            onClick={onClose}
            className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-hover)]"
          >
            取消
          </button>
          <button
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
            onPick={(invoke) => patchStage(skillMenu.stageId, { text: invoke })}
            onClose={() => setSkillMenu(null)}
          />
        )}
      </div>
    </div>
  );
}
