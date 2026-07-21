import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkflows, ensureSeed, type Workflow } from "../workflows";
import { PROFILES, isAgentTerminal, type Profile } from "../profiles";
import { ProfileIcon } from "./ProfileIcon";
import { agentUnavailable, useAgentInstall } from "../agentInstall";

// 工作流锚定选择器（fixed 坐标 + portal + 边界回弹，交互同 ContextMenu）。双模式：
//   apply：Tab 右键「应用工作流…」→ 点某工作流 onPick(wf)，绑定到该终端
//   spawn：工具栏「flow ▾」→ 先选 agent 类型（Claude/Codex segmented），点工作流 onSpawn(profile, wf)
// 模板库按工作区独立（scope=workspaceId）。
export default function WorkflowPicker({
  scope,
  x,
  y,
  mode,
  onPick,
  onSpawn,
  onClose,
}: {
  scope: string;
  x: number;
  y: number;
  mode: "apply" | "spawn";
  onPick?: (wf: Workflow) => void;
  onSpawn?: (profile: Profile, wf: Workflow) => void;
  onClose: () => void;
}) {
  // 可能先于 FlowPanel 打开（如直接点工具栏 flow▾）→ 此处也负责首开播种（幂等）
  useEffect(() => ensureSeed(scope), [scope]);
  const workflows = useWorkflows(scope);
  const agents = PROFILES.filter((p) => p.agentKind !== "shell");
  const [agentIdx, setAgentIdx] = useState(0);
  // spawn 模式：未安装/安装中的 agent 不可选；当前选中项变不可用（检测刷新后）自动切到第一个可用项
  const installSt = useAgentInstall();
  const stOf = (p: Profile) =>
    isAgentTerminal(p.agentKind) ? installSt[p.agentKind] : undefined;
  useEffect(() => {
    if (mode !== "spawn") return;
    setAgentIdx((i) => {
      if (!agentUnavailable(stOf(agents[i]))) return i;
      const ok = agents.findIndex((p) => !agentUnavailable(stOf(p)));
      return ok >= 0 ? ok : i;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installSt, mode]);
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
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 120 }}
      className="w-[240px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--elevated)] py-1 shadow-xl"
    >
      <div className="px-3 pb-1 pt-1.5 text-[10px] text-[var(--text-3)]">
        {mode === "spawn" ? "按工作流新建终端" : "应用工作流到该终端"}
      </div>
      {mode === "spawn" && (
        <div className="mx-3 mb-1.5 flex gap-1 rounded-lg bg-[var(--surface-hover)] p-1">
          {agents.map((p, i) => {
            const un = agentUnavailable(stOf(p));
            return (
              <button
                key={p.id}
                disabled={un}
                onClick={() => setAgentIdx(i)}
                title={un ? `未安装 ${p.label}，请到 设置 → Agent 安装` : p.label}
                className={
                  "flex flex-1 items-center justify-center rounded-md py-1.5 transition-colors " +
                  (un ? "cursor-not-allowed opacity-35 grayscale " : "") +
                  (i === agentIdx
                    ? "bg-[var(--accent)]/15 ring-1 ring-inset ring-[var(--accent)]"
                    : un
                      ? ""
                      : "hover:bg-[var(--surface)]")
                }
              >
                <ProfileIcon id={p.id} />
              </button>
            );
          })}
        </div>
      )}
      <div className="max-h-[46vh] overflow-y-auto">
        {workflows.length === 0 && (
          <div className="px-3 py-3 text-center text-[11px] text-[var(--text-3)]">
            还没有工作流，去左栏「Flow」页签新建
          </div>
        )}
        {workflows.map((w) => (
          <button
            key={w.id}
            onClick={() => {
              if (mode === "spawn") {
                const prof = agents[agentIdx];
                if (agentUnavailable(stOf(prof))) return; // 双保险:置灰按钮不可选,此处兜底并发/时序边界
                onSpawn?.(prof, w);
              } else {
                onPick?.(w);
              }
              onClose();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface)]"
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)]">{w.name || "（未命名）"}</span>
            <span className="shrink-0 text-[10px] text-[var(--text-3)]">{w.stages.length} 步</span>
          </button>
        ))}
      </div>
      {mode === "spawn" && (
        <div className="border-t border-[var(--border-soft)] px-3 py-1.5 text-[9px] text-[var(--text-3)]">
          点击 = 新建所选 agent 终端并绑定该工作流
        </div>
      )}
    </div>,
    document.body,
  );
}
