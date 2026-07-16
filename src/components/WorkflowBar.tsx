import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { focusEngine, injectAndSubmit } from "./terminalEngine";
import { injectText, type AgentKind, type DragItem } from "../profiles";
import { deleteEntry } from "../catalog";
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
  setRunAuto,
  clearRun,
  isRunDone,
} from "../workflowRuns";
import { hasManual, injectOnlyText, type WorkflowStage } from "../workflows";
import ConfirmModal from "./ui/ConfirmModal";
import {
  beginClipboardPasteBusy,
  endClipboardPasteBusy,
} from "../clipboardPasteBusy";

// 终端底部工作流面板：进度 strip（常驻）+ 大输入框（人工阶段自动展开 / ✎ 手动开关）+
// 收起态右下角浮标。配色用终端暗区固定值（面板随终端底 #1f1e1d，不随奶油/暗主题切换）。
// 注入/发送均走 write_terminal 立即写入（计划决策 3=A，与拖拽注入同路径）。

const OK_GREEN = "#2fa35e"; // 项目既有徽标绿（user 来源徽标同款）
const DRAG_MIME = "application/x-htybox-item"; // 与终端/各左栏拖拽源同款载荷键

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

/** stepper 单点：done ✓ / active 圈 / skipped 灰圈斜杠 / pending 灰点。pulse=自动执行中当前点脉冲。 */
function StageDot({ state, title, green, pulse }: { state: string; title: string; green: boolean; pulse?: boolean }) {
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
        className={
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-[var(--accent)]" +
          (pulse ? " animate-pulse" : "")
        }
      >
        <div className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
      </div>
    );
  return <div title={title} className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#4a453e]" />;
}

export default function WorkflowBar({
  termId,
  cwd,
  agentKind,
}: {
  termId: string;
  cwd?: string;
  agentKind?: AgentKind; // 目标终端 agent 类型：拖拽注入按它算引用形态（skill=/名 或 @路径）
}) {
  const run = useRun(termId);
  const settings = useSettings();
  const [running, setRunning] = useState(() => isTermRunning(termId));
  const [inputOverride, setInputOverride] = useState<boolean | null>(null); // null=跟随阶段类型
  const [draft, setDraft] = useState("");
  const [dragOver, setDragOver] = useState(false); // 左栏项拖到输入框上方时的高亮
  // 图片附件（真实模型）：粘贴的截图先存 temp png 暂存在此、不进终端；Enter 发送时才与文字
  // 一起注入。附件状态完全归 HtyBox 所有——可见可删（删=真删临时文件），不存在"终端里删了
  // 但提示不同步"的脱钩（此前"立即注入+本地计数"方案的缺陷，用户打回）。
  const [attachments, setAttachments] = useState<string[]>([]);
  // 多段人工阶段：每个人工片段各自的输入（文字 + 粘贴的截图附件），键=片段 id。瞬态（决策 3-A）。
  const [segInputs, setSegInputs] = useState<Record<string, { text: string; atts: string[] }>>({});
  const [dragSeg, setDragSeg] = useState<string | null>(null); // 内联填空：拖拽悬停的目标人工片段 id（落点高亮）
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const ranThisStage = useRef(false); // 本阶段注入后 agent 是否跑起来过（区分"未开跑"与"已静默"）
  const autoExecRef = useRef(-1); // 自动模式：已自动执行过的阶段下标（防重复注入）
  const autoAdvRef = useRef(-1); // 自动模式：已自动推进过的阶段下标（防重复推进）

  useEffect(() => {
    setRunning(isTermRunning(termId));
    return onAgentStatusChange(() => setRunning(isTermRunning(termId)));
  }, [termId]);

  const cursor = run?.cursor ?? -1;
  // 进入新阶段：输入框回到自动逻辑、清"跑过"标记 + 清自动 guard（附件同 draft：属"待发送内容"，不随阶段清）
  useEffect(() => {
    setInputOverride(null);
    ranThisStage.current = false;
    autoExecRef.current = -1;
    autoAdvRef.current = -1;
    setSegInputs({}); // 进新阶段清各人工片段输入（瞬态）
  }, [cursor, termId]);
  useEffect(() => {
    if (running) ranThisStage.current = true;
  }, [running]);

  // 自动执行 driver：注入阶段跑完静默即自动推进下一阶段；遇人工阶段不自动执行（自然暂停）。
  // 复用现有回合结束判据（injected && !running && ranThisStage，见"已静默可确认"）；guard 按阶段下标防重入。
  useEffect(() => {
    if (!run || !run.auto) return;
    const idx = run.cursor;
    if (idx >= run.stages.length) return; // 已完成
    const st = run.states[idx];
    const s = run.stages[idx];
    if (st === "active" && !hasManual(s)) {
      // 纯注入阶段（无人工片段）才自动执行；含人工片段=暂停点，等用户填写发送
      if (autoExecRef.current === idx) return; // 本阶段已自动执行
      autoExecRef.current = idx;
      const t = window.setTimeout(() => {
        injectAndSubmit(termId, injectOnlyText(s), !!s.pressEnter);
        focusEngine(termId);
        markInjected(termId);
      }, 120); // 小延时让上一阶段静默/终端就绪，避免抖动
      return () => window.clearTimeout(t);
    }
    if (st === "injected" && !running && ranThisStage.current) {
      if (autoAdvRef.current === idx) return; // 本阶段已自动推进
      autoAdvRef.current = idx;
      advanceRun(termId);
    }
  }, [run, running, termId]);

  if (!run || !settings.showWorkflowPanel) return null;

  const total = run.stages.length;
  const done = isRunDone(run);
  const cur = done ? undefined : run.stages[run.cursor];
  const curState = done ? undefined : run.states[run.cursor];
  const stepNo = Math.min(run.cursor + 1, total);
  const autoOn = !!run.auto; // 自动执行模式开
  const autoPaused = autoOn && !done && !!cur && hasManual(cur); // 自动开但停在含人工片段的阶段
  const autoRunning = autoOn && !done && !autoPaused; // 自动开且正在自动接续（非暂停）
  // 纯人工单片段=无拼接：退化为普通输入框，不显示"多段拼接"标签与拼接预览
  const plainManual = !!cur && cur.segments.length === 1 && cur.segments[0].kind === "manual";

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
    if (!cur || curState !== "active" || hasManual(cur)) return;
    // 纯注入阶段：全部注入片段按序拼接后一次提交（跨 agent 一致，见 injectAndSubmit）
    injectAndSubmit(termId, injectOnlyText(cur), !!cur.pressEnter);
    focusEngine(termId);
    markInjected(termId);
  };
  const send = () => {
    const t = draft.replace(/\r?\n/g, " ").trim();
    if (!t && attachments.length === 0) return;
    // 附件以 @路径 引用注入（与拖文件进终端同一语义），与文字拼一条消息提交
    const refs = attachments.map((p) => "@" + p).join(" ");
    injectAndSubmit(termId, [refs, t].filter(Boolean).join(" "), true);
    // 自动模式：人工阶段发送后标记为已注入 → 其 agent 跑完静默即由 driver 自动推进续跑
    if (run.auto) markInjected(termId);
    setDraft("");
    setAttachments([]);
    taRef.current?.focus(); // 支持多轮往返，焦点留在输入框
  };
  // 左栏 file/skill/memory/书签 拖进输入框：按目标 agent 算引用（skill=/名 或 @路径），
  // 追加到 draft 末尾（空格分隔、不覆盖，遵 feedback_free_text_skill_append 与 appendInvokes 同款约定），
  // 只"打出"不自动发送（撰写态，发送权交回用户）。workflow 项=绑定语义，撰写框不接。
  const onInputDrop = (e: React.DragEvent) => {
    setDragOver(false);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    e.preventDefault();
    try {
      const item = JSON.parse(raw) as DragItem;
      if (item.kind === "workflow") return;
      const ref = injectText(item, agentKind ?? "shell");
      if (!ref) return;
      setDraft((d) => (!d ? ref : /\s$/.test(d) ? d + ref : d + " " + ref));
      taRef.current?.focus();
    } catch {
      /* ignore */
    }
  };

  // 粘贴图片/截图：后端把剪贴板位图存到 <工作区>/.htybox/tmp/clip-<ts>.png（真存储，48h 自动
  // 清理），先作为附件暂存在输入框（可见可删），Enter 发送时才以 @路径 注入终端。
  // readText 有文本 → 走 textarea 默认粘贴（不拦截）；空/异常（剪贴板为图片）→ 按图片处理。
  // 注：0x16/win32 键盘注入均无法触发 claude 的原生粘图（ConPTY 探针实证），勿再走该路线。
  const pasteImageProbe = () => {
    if (!cwd) return;
    const fwd = () => {
      beginClipboardPasteBusy();
      invoke<string>("save_clipboard_image", { workspaceDir: cwd })
        .then((p) => setAttachments((a) => [...a, p]))
        .catch(() => {}) // 剪贴板无图 → 静默
        .finally(() => endClipboardPasteBusy());
    };
    navigator.clipboard
      ?.readText()
      .then((raw) => {
        if (!raw) fwd();
      })
      .catch(fwd);
  };
  const removeAttachment = (p: string) => {
    setAttachments((a) => a.filter((x) => x !== p));
    deleteEntry(p).catch(() => {}); // 真删临时文件；失败静默（48h 清理兜底）
  };
  const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

  // ── 多段人工阶段：每个人工片段独立输入（文字 + 粘图），发送时按序拼接 ──
  const segVal = (id: string) => segInputs[id] ?? { text: "", atts: [] as string[] };
  const setSegText = (id: string, text: string) =>
    setSegInputs((m) => ({ ...m, [id]: { text, atts: m[id]?.atts ?? [] } }));
  const appendSegText = (id: string, ref: string) =>
    setSegInputs((m) => {
      const d = m[id]?.text ?? "";
      const next = !d ? ref : /\s$/.test(d) ? d + ref : d + " " + ref;
      return { ...m, [id]: { text: next, atts: m[id]?.atts ?? [] } };
    });
  const addSegAtt = (id: string, p: string) =>
    setSegInputs((m) => ({ ...m, [id]: { text: m[id]?.text ?? "", atts: [...(m[id]?.atts ?? []), p] } }));
  const removeSegAtt = (id: string, p: string) => {
    setSegInputs((m) => ({ ...m, [id]: { text: m[id]?.text ?? "", atts: (m[id]?.atts ?? []).filter((x) => x !== p) } }));
    deleteEntry(p).catch(() => {}); // 真删临时图片文件
  };
  // 按序拼接：inject 片段=固定文本；manual 片段=文字（压单行）+ 各图片 @路径（决策 2-A：文字→图片）
  const composeStage = (st: WorkflowStage): string =>
    st.segments
      .map((seg) =>
        seg.kind === "inject"
          ? seg.text.trim()
          : [segVal(seg.id).text.replace(/\r?\n/g, " ").trim(), ...segVal(seg.id).atts.map((p) => "@" + p)]
              .filter(Boolean)
              .join(" "),
      )
      .filter(Boolean)
      .join(" ");
  const sendStage = () => {
    if (!cur) return;
    const msg = composeStage(cur);
    if (!msg) return;
    injectAndSubmit(termId, msg, true);
    if (run.auto) markInjected(termId); // 自动模式：发送后进 injected → 跑完静默由 driver 续跑
    setSegInputs((m) => {
      const n = { ...m };
      cur.segments.forEach((seg) => delete n[seg.id]); // 清本阶段输入（图已交终端引用，不删文件）
      return n;
    });
    focusEngine(termId);
  };
  const pasteImageToSeg = (id: string) => {
    if (!cwd) return;
    const fwd = () => {
      beginClipboardPasteBusy();
      invoke<string>("save_clipboard_image", { workspaceDir: cwd })
        .then((p) => addSegAtt(id, p))
        .catch(() => {})
        .finally(() => endClipboardPasteBusy());
    };
    navigator.clipboard
      ?.readText()
      .then((raw) => {
        if (!raw) fwd();
      })
      .catch(fwd);
  };
  const onSegDrop = (id: string, e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    e.preventDefault();
    try {
      const item = JSON.parse(raw) as DragItem;
      if (item.kind === "workflow") return;
      const ref = injectText(item, agentKind ?? "shell");
      if (ref) appendSegText(id, ref);
    } catch {
      /* ignore */
    }
  };

  // 输入框显隐：手动覆盖优先，否则含人工片段的阶段自动展开
  const showInput = !done && (inputOverride ?? (!!cur && hasManual(cur)));

  // 全部操作独立按钮直出（用户拍板：本面板不用弹出菜单）；小文字按钮统一灰系描边风格
  const ghostBtn =
    "shrink-0 rounded-md border border-[#3a3631] px-2 py-1 text-[10px] text-[#8c8a82] hover:border-[#8c8a82] hover:text-[#e5e2dc]";

  return (
    <div className="relative z-10 shrink-0 border-t border-[#3a3631] bg-[#292623]">
      {/* 自动执行中：顶边流光条（陶土渐变流动，读作"自动接续在流动"） */}
      {autoRunning && (
        <div className="htybox-auto-flow pointer-events-none absolute inset-x-0 top-0 z-20 h-[3px]" />
      )}
      {/* ── 大输入框区（人工阶段自动展开 / ✎ 手动开关） ── */}
      {showInput && cur && (
        <div className="px-3 pb-2 pt-2">
          {autoPaused && (
            <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-[#6b4d38] bg-[#2e241d] px-2.5 py-1.5 text-[10px]">
              <span className="shrink-0 font-bold text-[var(--accent)]">⏸ 自动已暂停</span>
              <span className="truncate text-[#e5e2dc]">当前人工阶段，填写后发送 —— 自动将继续接续后续阶段</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 pb-1.5 text-[10px] text-[#8c8a82]">
            <span>✎</span>
            <span className="shrink-0 font-semibold text-[#e5e2dc]">{cur.name}</span>
            {hasManual(cur) && !plainManual && (
              <span className="shrink-0 rounded-full bg-[#3a2a22] px-1.5 py-0.5 text-[9px] font-bold text-[var(--accent)]">多段拼接</span>
            )}
            <span className="ml-auto shrink-0">输入将发送到该终端</span>
          </div>
          {hasManual(cur) ? (
            plainManual ? (
              /* 纯人工·单片段（无拼接）：普通输入框，不显示拼接预览 */
              <>
                <div
                  className="relative"
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    if (!dragOver) setDragOver(true);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
                  }}
                  onDrop={(e) => {
                    setDragOver(false);
                    onSegDrop(cur.segments[0].id, e);
                  }}
                >
                  <textarea
                    value={segVal(cur.segments[0].id).text}
                    rows={3}
                    onChange={(e) => setSegText(cur.segments[0].id, e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendStage();
                        return;
                      }
                      if (e.ctrlKey && !e.altKey && (e.key === "v" || e.key === "V")) pasteImageToSeg(cur.segments[0].id);
                    }}
                    placeholder={cur.segments[0].text || "输入内容，Enter 发送到终端…"}
                    className={
                      "w-full resize-none rounded-xl border bg-[#1f1e1d] px-3 py-2 pr-12 text-[12px] leading-relaxed text-[#e5e2dc] outline-none transition-colors placeholder:text-[#8c8a82]/60 " +
                      (dragOver ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/40" : "border-[var(--accent)]/60 focus:border-[var(--accent)]")
                    }
                  />
                  <button
                    onClick={sendStage}
                    title="发送到终端（Enter）"
                    className="absolute bottom-3 right-2.5 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-[13px] font-bold text-white transition-opacity hover:opacity-85"
                  >
                    ↑
                  </button>
                </div>
                {segVal(cur.segments[0].id).atts.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
                    {segVal(cur.segments[0].id).atts.map((p) => (
                      <span key={p} title={p} className="flex items-center gap-1 rounded-full bg-[#3a3631] px-2 py-0.5 text-[9.5px] font-semibold text-[var(--accent)]">
                        📷 {baseName(p)}
                        <button
                          onClick={() => removeSegAtt(cur.segments[0].id, p)}
                          title="移除并删除该临时图片文件"
                          className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] leading-none text-[#8c8a82] hover:bg-[#4a453e] hover:text-[#e5e2dc]"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="pt-1 text-[9px] text-[#8c8a82]/80">Enter 发送 · Shift+Enter 换行 · 截图/图片 Ctrl+V 附加 · 左栏 Skill/文件/记忆可拖入</div>
              </>
            ) : (
              /* 内联填空式：注入=橙 token 只读、人工=下划线可填、图片内联；框本身即最终发送（无独立预览） */
              <>
                <div
                  className="flex flex-wrap items-center gap-x-1 gap-y-2 rounded-xl border border-[var(--accent)]/50 bg-[#1f1e1d] px-3 py-2.5"
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragSeg(null);
                  }}
                >
                  {cur.segments.map((seg) =>
                    seg.kind === "inject" ? (
                      <span
                        key={seg.id}
                        title="注入片段（固定，自动跟随）"
                        className="shrink-0 rounded-md border border-[#6b4d38] bg-[#3a2a22] px-1.5 py-0.5 font-mono text-[11px] text-[var(--accent)]"
                      >
                        {seg.text}
                      </span>
                    ) : (
                      <span key={seg.id} className="inline-flex items-center gap-1">
                        <textarea
                          value={segVal(seg.id).text}
                          rows={1}
                          onChange={(e) => setSegText(seg.id, e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              sendStage();
                              return;
                            }
                            if (e.ctrlKey && !e.altKey && (e.key === "v" || e.key === "V")) pasteImageToSeg(seg.id);
                          }}
                          onDragOver={(e) => {
                            if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "copy";
                            if (dragSeg !== seg.id) setDragSeg(seg.id);
                          }}
                          onDrop={(e) => {
                            setDragSeg(null);
                            onSegDrop(seg.id, e);
                          }}
                          placeholder={seg.text || "填写…"}
                          className={
                            "htybox-seg-field resize-none rounded border-b border-dashed bg-transparent px-1 py-0.5 align-bottom text-[12px] leading-snug text-[#e5e2dc] outline-none placeholder:text-[#8c8a82]/70 " +
                            (dragSeg === seg.id
                              ? "border-solid border-[var(--accent)] bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]"
                              : "border-[var(--accent)]/50 focus:border-solid focus:border-[var(--accent)]")
                          }
                        />
                        {segVal(seg.id).atts.map((p) => (
                          <span
                            key={p}
                            title={p}
                            className="inline-flex items-center gap-0.5 rounded-full bg-[#3a3631] px-1.5 py-0.5 text-[9.5px] font-semibold text-[var(--accent)]"
                          >
                            📷{baseName(p)}
                            <button onClick={() => removeSegAtt(seg.id, p)} title="移除并删除该临时图片文件" className="ml-0.5 text-[#8c8a82] hover:text-[#e5e2dc]">✕</button>
                          </span>
                        ))}
                      </span>
                    ),
                  )}
                  <button
                    onClick={sendStage}
                    title="发送到终端（Enter）"
                    className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[13px] font-bold text-white hover:opacity-85"
                  >
                    ↑
                  </button>
                </div>
                <div className="pt-1 text-[9px] text-[#8c8a82]/80">橙色=注入固定片段（自动跟随）· 下划线处填人工内容 / Ctrl+V 粘图 / 可拖入引用 · 空片段发送时省略 · Enter 发送</div>
              </>
            )
          ) : (
            /* 纯注入阶段 ✎ 展开：自由输入一条 ad-hoc 消息发送到终端 */
            <>
              <div
                className="relative"
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  if (!dragOver) setDragOver(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
                }}
                onDrop={onInputDrop}
              >
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
                      return;
                    }
                    if (e.ctrlKey && !e.altKey && (e.key === "v" || e.key === "V")) pasteImageProbe();
                  }}
                  placeholder="输入内容，Enter 发送到终端…"
                  className={
                    "w-full resize-none rounded-xl border bg-[#1f1e1d] px-3 py-2 pr-12 text-[12px] leading-relaxed text-[#e5e2dc] outline-none transition-colors placeholder:text-[#8c8a82]/60 " +
                    (dragOver
                      ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/40"
                      : "border-[var(--accent)]/60 focus:border-[var(--accent)]")
                  }
                />
                <button
                  onClick={send}
                  title="发送到终端（Enter）"
                  className="absolute bottom-3 right-2.5 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-[13px] font-bold text-white transition-opacity hover:opacity-85"
                >
                  ↑
                </button>
              </div>
              {attachments.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
                  {attachments.map((p) => (
                    <span key={p} title={p} className="flex items-center gap-1 rounded-full bg-[#3a3631] px-2 py-0.5 text-[9.5px] font-semibold text-[var(--accent)]">
                      📷 {baseName(p)}
                      <button
                        onClick={() => removeAttachment(p)}
                        title="移除并删除该临时图片文件"
                        className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] leading-none text-[#8c8a82] hover:bg-[#4a453e] hover:text-[#e5e2dc]"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="pt-1 text-[9px] text-[#8c8a82]/80">
                Enter 发送 · Shift+Enter 换行 · 截图/图片 Ctrl+V 附加 · 左栏 Skill/文件/记忆可拖入
              </div>
            </>
          )}
        </div>
      )}
      {/* ── 进度 strip（34px 常驻） ── */}
      <div className="flex h-[34px] items-center gap-2 bg-[#24211e] px-3">
        <FlowGlyph className={"h-3.5 w-3.5 shrink-0 " + (done ? "text-[#2fa35e]" : "text-[var(--accent)]") + (autoRunning ? " animate-pulse" : "")} />
        <span className="max-w-[120px] shrink-0 truncate text-[11px] font-semibold text-[#e5e2dc]" title={run.workflowName}>
          {run.workflowName}
        </span>
        <span
          className="shrink-0 rounded-full bg-[#3a3631] px-2 py-0.5 text-[9.5px] font-bold"
          style={{ color: done ? OK_GREEN : "var(--accent)" }}
        >
          {done ? `${total}/${total}` : `${stepNo}/${total}`}
        </span>
        {/* stepper（自动执行中：当前点脉冲 + 流光点滑过） */}
        <div className="relative flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
          {run.stages.map((s, i) => (
            <StageDot
              key={s.id}
              state={run.states[i]}
              title={`${i + 1}. ${s.name}`}
              green={done}
              pulse={autoRunning && i === run.cursor}
            />
          ))}
          {autoRunning && (
            <div
              className="htybox-auto-travel pointer-events-none absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[#ffd9c9]"
              style={{ boxShadow: "0 0 5px 1px #ffd9c9" }}
            />
          )}
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
              {cur && !hasManual(cur) && curState === "active" && (
                <span className="truncate font-mono text-[10px] text-[#8c8a82]" title={injectOnlyText(cur)}>
                  {injectOnlyText(cur)}
                  {cur.pressEnter ? " ⏎" : ""}
                </span>
              )}
              {curState === "injected" && running && !autoRunning && (
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
        {/* 自动执行开关（纯图标·三态 ▶停 / spinner 运行 / ⏸暂停；hover 出说明；「执行阶段」左侧） */}
        {!done && (
          <button
            onClick={() => setRunAuto(termId, !autoOn)}
            title={
              autoOn
                ? autoPaused
                  ? "自动执行已暂停（当前人工阶段），填写发送后自动继续 · 点击关闭自动"
                  : "自动执行中：注入阶段跑完自动接续下一阶段，遇人工暂停 · 点击关闭"
                : "自动执行：注入阶段跑完自动接续下一阶段，遇人工阶段自动暂停"
            }
            className={
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border " +
              (autoOn ? "border-[#6b4d38] bg-[#3a2a22]" : "border-[#3a3631] hover:border-[#8c8a82]")
            }
          >
            {!autoOn ? (
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="8.5" stroke="#8c8a82" strokeWidth="1.6" />
                <path d="M10 8.4 L15.6 12 L10 15.6 Z" fill="#8c8a82" />
              </svg>
            ) : autoPaused ? (
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="var(--accent)">
                <rect x="7" y="6" width="3.6" height="12" rx="1" />
                <rect x="13.4" y="6" width="3.6" height="12" rx="1" />
              </svg>
            ) : (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
            )}
          </button>
        )}
        {/* 主按钮 */}
        {done ? (
          <button
            onClick={() => setConfirmUnbind(true)}
            className="shrink-0 rounded-md border border-[#3a3631] px-3 py-1 text-[10.5px] font-semibold text-[#8c8a82] hover:border-[#8c8a82] hover:text-[#e5e2dc]"
          >
            解绑工作流
          </button>
        ) : cur && !hasManual(cur) && curState === "active" ? (
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
