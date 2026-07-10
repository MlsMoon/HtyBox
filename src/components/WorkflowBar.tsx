import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { focusEngine } from "./terminalEngine";
import { isTermRunning, onAgentStatusChange } from "../agentStatus";
import { useSettings } from "../settings";
import {
  useRun,
  markInjected,
  advanceRun,
  skipCurrent,
  goBack,
  resetRun,
  setRunCollapsed,
  clearRun,
  isRunDone,
} from "../workflowRuns";
import ConfirmModal from "./ui/ConfirmModal";

// 终端底部工作流面板：进度 strip（常驻）+ 大输入框（人工阶段自动展开 / ✎ 手动开关）+
// 收起态右下角浮标。配色用终端暗区固定值（面板随终端底 #1f1e1d，不随奶油/暗主题切换）。
// 注入/发送均走 write_terminal 立即写入（计划决策 3=A，与拖拽注入同路径）。

const OK_GREEN = "#2fa35e"; // 项目既有徽标绿（user 来源徽标同款）

function FlowGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="5" cy="12" r="2.4" fill="currentColor" stroke="none" />
      <path d="M8.5 12h4" />
      <circle cx="16" cy="12" r="2.4" fill="currentColor" stroke="none" />
      <path d="M19.5 12h1.5" />
    </svg>
  );
}

/** stepper 单点：done ✓ / active 圈 / skipped 灰圈斜杠 / pending 灰点。 */
function StageDot({ state, title, green }: { state: string; title: string; green: boolean }) {
  const accent = green ? OK_GREEN : "var(--accent)";
  if (state === "done")
    return (
      <div
        title={title}
        style={{ background: accent }}
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] leading-none text-white"
      >
        ✓
      </div>
    );
  if (state === "skipped")
    return (
      <div title={`${title}（已跳过）`} className="relative h-3 w-3 shrink-0 rounded-full border border-[#8c8a82]">
        <div className="absolute left-1/2 top-1/2 h-px w-3.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-[#8c8a82]" />
      </div>
    );
  if (state === "active" || state === "injected")
    return (
      <div
        title={title}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-[var(--accent)]"
      >
        <div className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
      </div>
    );
  return <div title={title} className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#4a453e]" />;
}

export default function WorkflowBar({ termId }: { termId: string }) {
  const run = useRun(termId);
  const settings = useSettings();
  const [running, setRunning] = useState(() => isTermRunning(termId));
  const [inputOverride, setInputOverride] = useState<boolean | null>(null); // null=跟随阶段类型
  const [draft, setDraft] = useState("");
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const ranThisStage = useRef(false); // 本阶段注入后 agent 是否跑起来过（区分"未开跑"与"已静默"）

  useEffect(() => {
    setRunning(isTermRunning(termId));
    return onAgentStatusChange(() => setRunning(isTermRunning(termId)));
  }, [termId]);

  const cursor = run?.cursor ?? -1;
  // 进入新阶段：输入框回到自动逻辑、清"跑过"标记
  useEffect(() => {
    setInputOverride(null);
    ranThisStage.current = false;
  }, [cursor, termId]);
  useEffect(() => {
    if (running) ranThisStage.current = true;
  }, [running]);

  if (!run || !settings.showWorkflowPanel) return null;

  const total = run.stages.length;
  const done = isRunDone(run);
  const cur = done ? undefined : run.stages[run.cursor];
  const curState = done ? undefined : run.states[run.cursor];
  const stepNo = Math.min(run.cursor + 1, total);

  // ── 收起态：右下角迷你浮标（absolute 于 DockTerminal 外层 relative 容器，不占 flex 高度）──
  if (run.collapsed) {
    return (
      <button
        onClick={() => setRunCollapsed(termId, false)}
        title={`${run.workflowName} · ${stepNo}/${total} · 点击展开工作流面板`}
        className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5 rounded-full border border-[#3a3631] bg-[#292623]/95 px-3 py-1 text-[10px] font-bold text-[var(--accent)] shadow-lg hover:border-[var(--accent)]"
      >
        <FlowGlyph className="h-3 w-3" />
        <span style={done ? { color: OK_GREEN } : undefined}>
          {done ? "✓" : `${stepNo}/${total}`}
        </span>
        {running && (
          <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-[var(--accent)] border-t-transparent" />
        )}
      </button>
    );
  }

  // ── 动作 ──
  const execStage = () => {
    if (!cur || curState !== "active" || cur.kind !== "inject") return;
    const data = cur.text + (cur.pressEnter ? "\r" : "");
    invoke("write_terminal", { id: termId, data }).catch(() => {});
    focusEngine(termId);
    markInjected(termId);
  };
  const send = () => {
    const t = draft.replace(/\r?\n/g, " ").trim();
    if (!t) return;
    invoke("write_terminal", { id: termId, data: t + "\r" }).catch(() => {});
    setDraft("");
    taRef.current?.focus(); // 支持多轮往返，焦点留在输入框
  };

  // 输入框显隐：手动覆盖优先，否则人工阶段自动展开
  const showInput = !done && (inputOverride ?? cur?.kind === "manual");

  // 全部操作独立按钮直出（用户拍板：本面板不用弹出菜单）；小文字按钮统一灰系描边风格
  const ghostBtn =
    "shrink-0 rounded-md border border-[#3a3631] px-2 py-1 text-[10px] text-[#8c8a82] hover:border-[#8c8a82] hover:text-[#e5e2dc]";

  return (
    <div className="relative z-10 shrink-0 border-t border-[#3a3631] bg-[#292623]">
      {/* ── 大输入框区（人工阶段自动展开 / ✎ 手动开关） ── */}
      {showInput && cur && (
        <div className="px-3 pb-2 pt-2">
          <div className="flex items-center gap-1.5 pb-1.5 text-[10px] text-[#8c8a82]">
            <span>✎</span>
            <span className="shrink-0 font-semibold text-[#e5e2dc]">{cur.name}</span>
            {cur.kind === "manual" && cur.text && <span className="truncate">— {cur.text}</span>}
            <span className="ml-auto shrink-0">输入将发送到该终端</span>
          </div>
          <div className="relative">
            <textarea
              ref={taRef}
              value={draft}
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={cur.kind === "manual" && cur.text ? cur.text : "输入内容，Enter 发送到终端…"}
              className="w-full resize-none rounded-xl border border-[var(--accent)]/60 bg-[#1f1e1d] px-3 py-2 pr-12 text-[12px] leading-relaxed text-[#e5e2dc] outline-none transition-colors placeholder:text-[#8c8a82]/60 focus:border-[var(--accent)]"
            />
            <button
              onClick={send}
              title="发送到终端（Enter）"
              className="absolute bottom-3 right-2.5 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-[13px] font-bold text-white transition-opacity hover:opacity-85"
            >
              ↑
            </button>
          </div>
          <div className="pt-1 text-[9px] text-[#8c8a82]/80">Enter 发送 · Shift+Enter 换行 · 多行将压成单行发送</div>
        </div>
      )}
      {/* ── 进度 strip（34px 常驻） ── */}
      <div className="flex h-[34px] items-center gap-2 bg-[#24211e] px-3">
        <FlowGlyph className={"h-3.5 w-3.5 shrink-0 " + (done ? "text-[#2fa35e]" : "text-[var(--accent)]")} />
        <span className="max-w-[120px] shrink-0 truncate text-[11px] font-semibold text-[#e5e2dc]" title={run.workflowName}>
          {run.workflowName}
        </span>
        <span
          className="shrink-0 rounded-full bg-[#3a3631] px-2 py-0.5 text-[9.5px] font-bold"
          style={{ color: done ? OK_GREEN : "var(--accent)" }}
        >
          {done ? `${total}/${total}` : `${stepNo}/${total}`}
        </span>
        {/* stepper */}
        <div className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
          {run.stages.map((s, i) => (
            <StageDot key={s.id} state={run.states[i]} title={`${i + 1}. ${s.name}`} green={done} />
          ))}
        </div>
        {/* 当前阶段 / 完成文案 + 命令预览 / 运行徽记 */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {done ? (
            <span className="truncate text-[10.5px] font-semibold" style={{ color: OK_GREEN }}>
              ✓ 工作流已完成
            </span>
          ) : (
            <>
              <span className="shrink-0 text-[10.5px] text-[#8c8a82]">当前：</span>
              <span className="shrink-0 text-[10.5px] font-semibold text-[#e5e2dc]">{cur?.name}</span>
              {cur?.kind === "inject" && curState === "active" && (
                <span className="truncate font-mono text-[10px] text-[#8c8a82]" title={cur.text}>
                  {cur.text}
                  {cur.pressEnter ? " ⏎" : ""}
                </span>
              )}
              {curState === "injected" && running && (
                <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-[var(--accent)]">
                  <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-[var(--accent)] border-t-transparent" />
                  执行中…
                </span>
              )}
              {curState === "injected" && !running && ranThisStage.current && (
                <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold" style={{ color: OK_GREEN }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: OK_GREEN }} />
                  已静默，可确认
                </span>
              )}
            </>
          )}
        </div>
        {/* 主按钮 */}
        {done ? (
          <button
            onClick={() => setConfirmUnbind(true)}
            className="shrink-0 rounded-md border border-[#3a3631] px-3 py-1 text-[10.5px] font-semibold text-[#8c8a82] hover:border-[#8c8a82] hover:text-[#e5e2dc]"
          >
            解绑工作流
          </button>
        ) : cur?.kind === "inject" && curState === "active" ? (
          <button
            onClick={execStage}
            className="shrink-0 rounded-md bg-[var(--accent)] px-3 py-1 text-[10.5px] font-semibold text-white hover:opacity-85"
          >
            ▶ 执行阶段
          </button>
        ) : (
          <button
            onClick={() => advanceRun(termId)}
            className={
              "shrink-0 rounded-md px-3 py-1 text-[10.5px] font-semibold " +
              (curState === "injected" && running
                ? "border border-[#3a3631] text-[#8c8a82] hover:border-[#8c8a82] hover:text-[#e5e2dc]"
                : "bg-[var(--accent)] text-white hover:opacity-85")
            }
          >
            ✓ 下一步
          </button>
        )}
        {/* 流程操作（全部直出，无弹出菜单） */}
        {!done && (
          <button onClick={() => skipCurrent(termId)} title="跳过当前阶段并进入下一阶段" className={ghostBtn}>
            跳过
          </button>
        )}
        {run.cursor > 0 && (
          <button onClick={() => goBack(termId)} title="回到上一阶段" className={ghostBtn}>
            回退
          </button>
        )}
        <button onClick={() => resetRun(termId)} title="重置进度，从阶段 1 重新开始" className={ghostBtn}>
          重置
        </button>
        <div className="h-4 w-px shrink-0 bg-[#3a3631]" />
        {/* ✎ 输入框开关 */}
        {!done && (
          <button
            onClick={() => setInputOverride(showInput ? false : true)}
            title={showInput ? "收起输入框" : "展开输入框"}
            className={
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[11px] " +
              (showInput
                ? "border-[#3a3631] bg-[#3a3631] text-[#e5e2dc]"
                : "border-[#3a3631] text-[#8c8a82] hover:text-[#e5e2dc]")
            }
          >
            ✎
          </button>
        )}
        {/* ⌄ 隐藏面板（收起为右下角浮标） */}
        <button
          onClick={() => setRunCollapsed(termId, true)}
          title="隐藏面板（收起为右下角浮标）"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[#3a3631] text-[#8c8a82] hover:text-[#e5e2dc]"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {/* 解绑（危险操作放最右端 + 确认弹窗防误触；done 态主按钮已是解绑，不重复出） */}
        {!done && (
          <button
            onClick={() => setConfirmUnbind(true)}
            title="解绑工作流（移除该终端的进度，模板不受影响）"
            className="shrink-0 rounded-md border border-[#3a3631] px-2 py-1 text-[10px] text-[var(--danger)] hover:border-[var(--danger)]"
          >
            解绑
          </button>
        )}
      </div>
      {confirmUnbind && (
        <ConfirmModal
          title="解绑工作流"
          message={`将从该终端移除「${run.workflowName}」的进度（模板不受影响）。`}
          confirmText="解绑"
          onConfirm={() => clearRun(termId)}
          onClose={() => setConfirmUnbind(false)}
        />
      )}
    </div>
  );
}
