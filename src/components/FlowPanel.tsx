import { useEffect, useState } from "react";
import { useWorkflows, duplicateWorkflow, deleteWorkflow, emptyWorkflow, ensureSeed, type Workflow } from "../workflows";
import { useAllRuns, isRunDone, type WorkflowRun } from "../workflowRuns";
import { isTermRunning, onAgentStatusChange } from "../agentStatus";
import { activateTerminal, terminalTitle } from "../dockBus";
import ContextMenu, { MENU_SEP, type MenuItem } from "./ui/ContextMenu";
import ConfirmModal from "./ui/ConfirmModal";
import WorkflowEditor from "./WorkflowEditor";

// 左栏「Flow」页签：上=工作流模板库（全局，卡片拖拽到终端即应用；右键 复制/删除，
// 编辑/新建随 WorkflowEditor 接线），下=本工作区「进行中」实例总览（点击跳转激活该终端）。

const DRAG_MIME = "application/x-htybox-item";
const OK_GREEN = "#2fa35e";

function FlowCard({ wf, onMenu }: { wf: Workflow; onMenu: (e: React.MouseEvent) => void }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "workflow", workflowId: wf.id }));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
      title={`拖到终端应用「${wf.name}」 · 右键管理`}
      className="cursor-grab rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 transition-colors hover:border-[var(--accent-border)]"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--text)]">
          {wf.name || "（未命名）"}
        </span>
        <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[9px] font-bold text-[var(--accent-text)]">
          {wf.stages.length} 步
        </span>
      </div>
      {wf.description && (
        <div className="mt-1 truncate text-[10px] text-[var(--text-3)]">{wf.description}</div>
      )}
    </div>
  );
}

/** 「进行中」总览行：终端名 + 迷你进度 + 当前阶段 + 运行点；点击跳转激活该终端。 */
function RunRow({ termId, run, workspaceId }: { termId: string; run: WorkflowRun; workspaceId: string }) {
  const total = run.stages.length;
  const done = isRunDone(run);
  const stepNo = Math.min(run.cursor + 1, total);
  const running = isTermRunning(termId);
  const title = terminalTitle(workspaceId, termId) || "终端";
  const curName = done ? "已完成" : run.stages[run.cursor]?.name ?? "";
  return (
    <button
      onClick={() => activateTerminal(workspaceId, termId)}
      title="点击跳转到该终端"
      className="block w-full rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-left transition-colors hover:border-[var(--accent-border)]"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--text)]">{title}</span>
        {running ? (
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--accent)] border-t-transparent" />
        ) : (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: done ? OK_GREEN : "var(--text-3)" }}
          />
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--surface-hover)]">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.round((run.cursor / total) * 100)}%`,
              background: done ? OK_GREEN : "var(--accent)",
            }}
          />
        </div>
        <span className="shrink-0 text-[9px] text-[var(--text-3)]">
          {done ? `${total}/${total}` : `${stepNo}/${total}`}
        </span>
      </div>
      <div className="mt-1 truncate text-[9.5px] text-[var(--text-3)]">
        当前：{curName} · {run.workflowName}
      </div>
    </button>
  );
}

export default function FlowPanel({
  projectDir,
  workspaceId,
}: {
  projectDir: string;
  workspaceId: string;
}) {
  // 模板库按工作区独立（scope=workspaceId）；首次打开该工作区播种（旧全局库优先）
  useEffect(() => ensureSeed(workspaceId), [workspaceId]);
  const workflows = useWorkflows(workspaceId);
  const runs = useAllRuns();
  const [menu, setMenu] = useState<{ x: number; y: number; wf: Workflow } | null>(null);
  const [confirmDel, setConfirmDel] = useState<Workflow | null>(null);
  const [editing, setEditing] = useState<{ wf: Workflow; isNew: boolean } | null>(null);
  // 运行点实时刷新（agentStatus 跳变触发重渲染）
  const [, setTick] = useState(0);
  useEffect(() => onAgentStatusChange(() => setTick((n) => n + 1)), []);

  const runEntries = Object.entries(runs).filter(([tid]) => tid.startsWith(workspaceId + "::"));

  const menuItems: (MenuItem | typeof MENU_SEP)[] = [
    { id: "edit", label: "编辑" },
    { id: "duplicate", label: "复制一份" },
    MENU_SEP,
    { id: "delete", label: "删除工作流", danger: true },
  ];
  const onMenuAction = (id: string) => {
    if (!menu) return;
    if (id === "edit") setEditing({ wf: menu.wf, isNew: false });
    else if (id === "duplicate") duplicateWorkflow(workspaceId, menu.wf.id);
    else if (id === "delete") setConfirmDel(menu.wf);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto px-2 pb-3">
      {/* 模板库 */}
      <div className="flex items-center gap-1.5 px-1 pb-1.5 pt-1">
        <span className="text-[11px] font-bold text-[var(--text-2)]">工作流</span>
        <span className="rounded-full bg-[var(--surface-hover)] px-1.5 text-[9.5px] text-[var(--text-2)]">
          {workflows.length}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => setEditing({ wf: emptyWorkflow(), isNew: true })}
          className="text-[11px] text-[var(--accent-text)] hover:underline"
        >
          ＋ 新建
        </button>
      </div>
      <div className="space-y-1.5">
        {workflows.map((w) => (
          <FlowCard key={w.id} wf={w} onMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, wf: w })} />
        ))}
        {workflows.length === 0 && (
          <div className="px-1 py-3 text-center text-[11px] text-[var(--text-3)]">还没有工作流</div>
        )}
      </div>
      <div className="px-1 pt-2 text-[9.5px] text-[var(--text-3)]">
        拖拽卡片到终端即可应用 ↗ · 终端 Tab 右键、工具栏 flow ▾ 也可
      </div>

      {/* 进行中（本工作区实例总览） */}
      {runEntries.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 px-1 pb-1.5 pt-4">
            <span className="text-[11px] font-bold text-[var(--text-2)]">进行中</span>
            <span className="rounded-full bg-[var(--surface-hover)] px-1.5 text-[9.5px] text-[var(--text-2)]">
              {runEntries.length}
            </span>
          </div>
          <div className="space-y-1.5">
            {runEntries.map(([tid, run]) => (
              <RunRow key={tid} termId={tid} run={run} workspaceId={workspaceId} />
            ))}
          </div>
        </>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onAction={onMenuAction} onClose={() => setMenu(null)} />
      )}
      {confirmDel && (
        <ConfirmModal
          title="删除工作流"
          message={`删除「${confirmDel.name}」模板；已应用到终端的进行中实例不受影响（快照独立）。`}
          confirmText="删除"
          onConfirm={() => deleteWorkflow(workspaceId, confirmDel.id)}
          onClose={() => setConfirmDel(null)}
        />
      )}
      {editing && (
        <WorkflowEditor
          scope={workspaceId}
          initial={editing.wf}
          isNew={editing.isNew}
          projectDir={projectDir}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
