import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { focusEngine, injectAndSubmit } from "./terminalEngine";
import { injectText, type AgentKind, type DragItem } from "../profiles";
import { deleteEntry } from "../catalog";
import { hasPrimaryShortcutModifier, readClipboardText } from "../platformServices";
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
import TermInputShell, { DRAG_MIME } from "./termInput/TermInputShell";
import SlashSkillMenu from "./termInput/SlashSkillMenu";
import { useSlashSkills } from "./termInput/useSlashSkills";
import {
  onTermInputHotkey,
  setFreeInputOpen,
  toggleFreeInput,
} from "./termInput/freeInputState";
import {
  handleInputStashKey,
  takeStash,
  useLeftCtrlHeld,
  type StashMap,
} from "./termInput/inputStash";
import { getTermInputMemory, setTermInputMemory } from "./termInput/termInputMemory";

// 终端底部：工作流进度 strip + CLI 双线输入（人工阶段 / ✎ / 无工作流自由输入）+ 斜杠 Skill 补全。
// 配色用终端暗区固定值。注入/发送走 injectAndSubmit。

const OK_GREEN = "#2fa35e";
const FIELD_DRAFT = "draft";

function applyCaret(
  setText: (t: string) => void,
  ta: HTMLTextAreaElement | null | undefined,
  next: { text: string; cursor: number },
) {
  setText(next.text);
  requestAnimationFrame(() => {
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(next.cursor, next.cursor);
  });
}

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
  agentKind?: AgentKind;
}) {
  const run = useRun(termId);
  const settings = useSettings();
  const slash = useSlashSkills(cwd, agentKind);
  const [running, setRunning] = useState(() => isTermRunning(termId));
  const [inputOverride, setInputOverride] = useState<boolean | null>(null);
  const [bootMem] = useState(() => getTermInputMemory(termId));
  const [draft, setDraft] = useState(bootMem.draft);
  const [dragOver, setDragOver] = useState(false);
  const [attachments, setAttachments] = useState(bootMem.attachments);
  const [segInputs, setSegInputs] = useState(bootMem.segInputs);
  const [dragSeg, setDragSeg] = useState<string | null>(null);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  /** 无工作流内置输入：跟全局记忆开关（设置 · 终端） */
  const freeOpen = settings.termFreeInputOpen;
  /** 仅用户主动打开时聚焦，避免「记忆为开」切终端时抢焦点 */
  const focusFreeRef = useRef(false);
  const [caret, setCaret] = useState(0);
  const [activeSeg, setActiveSeg] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const ranThisStage = useRef(false);
  const autoExecRef = useRef(-1);
  const autoAdvRef = useRef(-1);
  const stashRef = useRef<StashMap>({ ...bootMem.stash });
  /** 上一阶段游标；与当前相等则不清理（首挂载 / 换终端载入后对齐） */
  const prevStageRef = useRef<number | null>(null);
  const leftCtrl = useLeftCtrlHeld();
  const [stashRev, setStashRev] = useState(0); // 暂存槽变化时重渲（徽标）+ 触发草稿落盘
  const touchStash = () => setStashRev((n) => n + 1);
  const isStashed = (fieldId: string) => fieldId in stashRef.current;
  const onStashKey = (
    e: React.KeyboardEvent,
    fieldId: string,
    text: string,
    setText: (t: string) => void,
  ) => {
    if (handleInputStashKey(e, leftCtrl.current, fieldId, text, stashRef.current, setText)) {
      touchStash();
      return true;
    }
    return false;
  };

  const stageCursor = run?.cursor ?? -1;

  useEffect(() => {
    setRunning(isTermRunning(termId));
    return onAgentStatusChange(() => setRunning(isTermRunning(termId)));
  }, [termId]);

  // 输入内容落盘：终端未关则跨应用重启复原；关终端时由 TerminalDock clear
  useEffect(() => {
    setTermInputMemory(termId, {
      draft,
      attachments,
      segInputs,
      stash: { ...stashRef.current },
    });
  }, [termId, draft, attachments, segInputs, stashRev]);

  useEffect(() => {
    if (!run && freeOpen && focusFreeRef.current) {
      focusFreeRef.current = false;
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, [run, freeOpen]);

  // 快捷键：无 run → 切换自由输入；有 run → 展开工作流输入并聚焦
  useEffect(() => {
    return onTermInputHotkey((id) => {
      if (id !== termId) return;
      if (!run) {
        const next = toggleFreeInput(termId);
        if (next) focusFreeRef.current = true;
        return;
      }
      setInputOverride(true);
      requestAnimationFrame(() => taRef.current?.focus());
    });
  }, [termId, run]);

  // 换阶段：清分段输入与暂存（主输入 draft 保留，与原行为一致）
  useEffect(() => {
    if (prevStageRef.current === null) {
      prevStageRef.current = stageCursor;
      return;
    }
    if (prevStageRef.current === stageCursor) return;
    prevStageRef.current = stageCursor;
    setInputOverride(null);
    ranThisStage.current = false;
    autoExecRef.current = -1;
    autoAdvRef.current = -1;
    setSegInputs({});
    stashRef.current = {};
    setStashRev((n) => n + 1);
  }, [stageCursor]);
  useEffect(() => {
    if (running) ranThisStage.current = true;
  }, [running]);

  useEffect(() => {
    if (!run || !run.auto) return;
    const idx = run.cursor;
    if (idx >= run.stages.length) return;
    const st = run.states[idx];
    const s = run.stages[idx];
    if (st === "active" && !hasManual(s)) {
      if (autoExecRef.current === idx) return;
      autoExecRef.current = idx;
      const t = window.setTimeout(() => {
        injectAndSubmit(termId, injectOnlyText(s), !!s.pressEnter);
        focusEngine(termId);
        markInjected(termId);
      }, 120);
      return () => window.clearTimeout(t);
    }
    if (st === "injected" && !running && ranThisStage.current) {
      if (autoAdvRef.current === idx) return;
      autoAdvRef.current = idx;
      advanceRun(termId);
    }
  }, [run, running, termId]);

  const syncCaret = (text: string, el: HTMLTextAreaElement, segId: string | null) => {
    const c = el.selectionStart ?? text.length;
    setCaret(c);
    setActiveSeg(segId);
    slash.onCursor(text, c);
  };

  const slashMenu = (text: string, onApply: (next: { text: string; cursor: number }) => void) => {
    const st = slash.menuFor(text, caret);
    if (!st) return null;
    return (
      <SlashSkillMenu
        skills={st.list}
        selected={st.selected}
        onSelect={slash.setSel}
        onPick={(s) => onApply(slash.applyComplete(text, caret, s))}
      />
    );
  };

  // ── 无工作流：自由输入（不受 showWorkflowPanel 约束）──
  if (!run) {
    const sendFree = () => {
      const t = draft.replace(/\r?\n/g, " ").trim();
      if (!t && attachments.length === 0) return;
      const refs = attachments.map((p) => "@" + p).join(" ");
      injectAndSubmit(termId, [refs, t].filter(Boolean).join(" "), true);
      setAttachments([]);
      const restored = takeStash(stashRef.current, FIELD_DRAFT);
      setDraft(restored ?? "");
      touchStash();
      taRef.current?.focus();
    };
    const pasteImageProbe = () => {
      if (!cwd) return;
      const fwd = () => {
        beginClipboardPasteBusy();
        invoke<string>("save_clipboard_image", { workspaceDir: cwd })
          .then((p) => setAttachments((a) => [...a, p]))
          .catch(() => {})
          .finally(() => endClipboardPasteBusy());
      };
      readClipboardText()
        .then((raw) => {
          if (!raw) fwd();
        })
        .catch(fwd);
    };
    const onInputDrop = (e: React.DragEvent) => {
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
    if (!freeOpen) {
      return (
        <button
          type="button"
          onClick={() => {
            focusFreeRef.current = true;
            setFreeInputOpen(termId, true);
          }}
          title="打开内置输入并记住为默认（Ctrl+Shift+I）"
          className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5 border border-[#3a3631] bg-[#292623]/95 px-3 py-1 text-[10px] font-bold text-[var(--accent)] shadow-lg hover:border-[var(--accent)]"
        >
          ✎ 输入
        </button>
      );
    }

    return (
      <div className="relative z-10 shrink-0 border-t border-[#3a3631] bg-[#292623]">
        <TermInputShell
          title="自由输入"
          stashed={isStashed(FIELD_DRAFT)}
          value={draft}
          onChange={setDraft}
          onCaret={(v, el) => syncCaret(v, el, null)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (onStashKey(e, FIELD_DRAFT, draft, setDraft)) return;
            const r = slash.handleKey(e, draft);
            if (r.handled) {
              if (r.next) applyCaret(setDraft, taRef.current, r.next);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendFree();
              return;
            }
            if (hasPrimaryShortcutModifier(e) && !e.altKey && (e.key === "v" || e.key === "V")) pasteImageProbe();
          }}
          placeholder="向 AI 描述本轮需求 / 问题背景…"
          dragOver={dragOver}
          setDragOver={setDragOver}
          textareaRef={taRef}
          attachments={attachments}
          onRemoveAttachment={(p) => {
            setAttachments((a) => a.filter((x) => x !== p));
            deleteEntry(p).catch(() => {});
          }}
          onDropItem={onInputDrop}
          menu={slashMenu(draft, (next) => applyCaret(setDraft, taRef.current, next))}
        />
        <div className="flex h-[28px] items-center justify-end gap-2 bg-[#24211e] px-3">
          <button
            type="button"
            onClick={() => setFreeInputOpen(termId, false)}
            title="收起并记住为默认关闭"
            className="flex h-6 w-6 items-center justify-center border border-[#3a3631] text-[#8c8a82] hover:text-[#e5e2dc]"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // 有工作流但不显示面板 → 整组件隐藏（自由输入与此解耦，上面已 return）
  if (!settings.showWorkflowPanel) return null;

  const total = run.stages.length;
  const done = isRunDone(run);
  const cur = done ? undefined : run.stages[run.cursor];
  const curState = done ? undefined : run.states[run.cursor];
  const stepNo = Math.min(run.cursor + 1, total);
  const autoOn = !!run.auto;
  const autoPaused = autoOn && !done && !!cur && hasManual(cur);
  const autoRunning = autoOn && !done && !autoPaused;
  const plainManual = !!cur && cur.segments.length === 1 && cur.segments[0].kind === "manual";

  if (run.collapsed) {
    return (
      <button
        onClick={() => setRunCollapsed(termId, false)}
        title={`${run.workflowName} · ${stepNo}/${total} · 点击展开工作流面板`}
        className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5 rounded-full border border-[#3a3631] bg-[#292623]/95 px-3 py-1 text-[10px] font-bold text-[var(--accent)] shadow-lg hover:border-[var(--accent)]"
      >
        <FlowGlyph className="h-3 w-3" />
        <span style={done ? { color: OK_GREEN } : undefined}>{done ? "✓" : `${stepNo}/${total}`}</span>
        {running && (
          <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-[var(--accent)] border-t-transparent" />
        )}
      </button>
    );
  }

  const execStage = () => {
    if (!cur || curState !== "active" || hasManual(cur)) return;
    injectAndSubmit(termId, injectOnlyText(cur), !!cur.pressEnter);
    focusEngine(termId);
    markInjected(termId);
  };
  const send = () => {
    const t = draft.replace(/\r?\n/g, " ").trim();
    if (!t && attachments.length === 0) return;
    const refs = attachments.map((p) => "@" + p).join(" ");
    injectAndSubmit(termId, [refs, t].filter(Boolean).join(" "), true);
    if (run.auto) markInjected(termId);
    setAttachments([]);
    const restored = takeStash(stashRef.current, FIELD_DRAFT);
    setDraft(restored ?? "");
    touchStash();
    taRef.current?.focus();
  };
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
  const pasteImageProbe = () => {
    if (!cwd) return;
    const fwd = () => {
      beginClipboardPasteBusy();
      invoke<string>("save_clipboard_image", { workspaceDir: cwd })
        .then((p) => setAttachments((a) => [...a, p]))
        .catch(() => {})
        .finally(() => endClipboardPasteBusy());
    };
    readClipboardText()
      .then((raw) => {
        if (!raw) fwd();
      })
      .catch(fwd);
  };
  const removeAttachment = (p: string) => {
    setAttachments((a) => a.filter((x) => x !== p));
    deleteEntry(p).catch(() => {});
  };

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
    deleteEntry(p).catch(() => {});
  };
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
    if (run.auto) markInjected(termId);
    // 发送后清片段；若片段有 LeftCtrl+S 暂存则还原文字
    setSegInputs(() => {
      const n: Record<string, { text: string; atts: string[] }> = {};
      cur.segments.forEach((seg) => {
        if (seg.kind !== "manual") return;
        const restored = takeStash(stashRef.current, seg.id);
        if (restored != null) n[seg.id] = { text: restored, atts: [] };
      });
      return n;
    });
    touchStash();
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
    readClipboardText()
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

  const showInput = !done && (inputOverride ?? (!!cur && hasManual(cur)));
  const ghostBtn =
    "shrink-0 rounded-md border border-[#3a3631] px-2 py-1 text-[10px] text-[#8c8a82] hover:border-[#8c8a82] hover:text-[#e5e2dc]";

  const plainSegId = plainManual && cur ? cur.segments[0].id : null;
  const plainText = plainSegId ? segVal(plainSegId).text : draft;
  const setPlainText = (v: string) => {
    if (plainSegId) setSegText(plainSegId, v);
    else setDraft(v);
  };

  return (
    <div className="relative z-10 shrink-0 border-t border-[#3a3631] bg-[#292623]">
      {autoRunning && (
        <div className="htybox-auto-flow pointer-events-none absolute inset-x-0 top-0 z-20 h-[3px]" />
      )}

      {showInput && cur && (
        <>
          {autoPaused && (
            <div className="mx-3 mt-2 flex items-center gap-1.5 border border-[#6b4d38] bg-[#2e241d] px-2.5 py-1.5 text-[10px]">
              <span className="shrink-0 font-bold text-[var(--accent)]">⏸ 自动已暂停</span>
              <span className="truncate text-[#e5e2dc]">当前人工阶段，填写后发送 —— 自动将继续接续后续阶段</span>
            </div>
          )}

          {hasManual(cur) ? (
            plainManual && plainSegId ? (
              <TermInputShell
                title={cur.name}
                stashed={isStashed(plainSegId)}
                value={plainText}
                onChange={setPlainText}
                onCaret={(v, el) => syncCaret(v, el, plainSegId)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (onStashKey(e, plainSegId, plainText, (t) => setSegText(plainSegId, t))) return;
                  const r = slash.handleKey(e, plainText);
                  if (r.handled) {
                    if (r.next) applyCaret((t) => setSegText(plainSegId, t), taRef.current, r.next);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendStage();
                    return;
                  }
                  if (hasPrimaryShortcutModifier(e) && !e.altKey && (e.key === "v" || e.key === "V")) pasteImageToSeg(plainSegId);
                }}
                placeholder={cur.segments[0].text || "输入内容，Enter 发送…"}
                dragOver={dragOver}
                setDragOver={setDragOver}
                textareaRef={taRef}
                attachments={segVal(plainSegId).atts}
                onRemoveAttachment={(p) => removeSegAtt(plainSegId, p)}
                onDropItem={(e) => onSegDrop(plainSegId, e)}
                menu={slashMenu(plainText, (next) =>
                  applyCaret((t) => setSegText(plainSegId, t), taRef.current, next),
                )}
              />
            ) : (
              /* 多段内联：去圆角卡片，保留片段编排 + 斜杠 */
              <div className="px-3 pb-2 pt-2">
                <div className="flex items-center gap-1.5 pb-1.5 text-[10px] text-[#8c8a82]">
                  <span className="text-[var(--accent)]">✎</span>
                  <span className="shrink-0 font-semibold text-[#e5e2dc]">{cur.name}</span>
                  <span className="shrink-0 bg-[#3a2a22] px-1.5 py-0.5 text-[9px] font-bold text-[var(--accent)]">多段拼接</span>
                  {cur.segments.some((s) => s.kind === "manual" && isStashed(s.id)) && (
                    <span
                      title="有片段已暂存 · Left Ctrl+S 恢复"
                      className="shrink-0 border border-[#6b4d38] bg-[#3a2a22] px-1.5 py-0.5 text-[9px] font-bold text-[var(--accent)]"
                    >
                      暂存中
                    </span>
                  )}
                  <span className="ml-auto shrink-0">输入将发送到该终端</span>
                </div>
                <div className="h-px w-full bg-[var(--accent)]" />
                <div
                  className="flex flex-wrap items-center gap-x-1 gap-y-2 px-1 py-2.5"
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragSeg(null);
                  }}
                >
                  {cur.segments.map((seg) =>
                    seg.kind === "inject" ? (
                      <span
                        key={seg.id}
                        title="注入片段（固定，自动跟随）"
                        className="shrink-0 border border-[#6b4d38] bg-[#3a2a22] px-1.5 py-0.5 font-mono text-[11px] text-[var(--accent)]"
                      >
                        {seg.text}
                      </span>
                    ) : (
                      <span key={seg.id} className="inline-flex items-center gap-1">
                        <textarea
                          value={segVal(seg.id).text}
                          rows={1}
                          onChange={(e) => {
                            setSegText(seg.id, e.target.value);
                            syncCaret(e.target.value, e.target, seg.id);
                          }}
                          onSelect={(e) => syncCaret(segVal(seg.id).text, e.currentTarget, seg.id)}
                          onKeyUp={(e) => syncCaret(segVal(seg.id).text, e.currentTarget, seg.id)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            const text = segVal(seg.id).text;
                            if (onStashKey(e, seg.id, text, (t) => setSegText(seg.id, t))) return;
                            const r = slash.handleKey(e, text);
                            if (r.handled) {
                              if (r.next) {
                                setSegText(seg.id, r.next.text);
                                requestAnimationFrame(() => {
                                  const el = e.currentTarget;
                                  el.setSelectionRange(r.next!.cursor, r.next!.cursor);
                                  setCaret(r.next!.cursor);
                                });
                              }
                              return;
                            }
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              sendStage();
                              return;
                            }
                            if (hasPrimaryShortcutModifier(e) && !e.altKey && (e.key === "v" || e.key === "V")) pasteImageToSeg(seg.id);
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
                            "htybox-seg-field resize-none border-b border-dashed bg-transparent px-1 py-0.5 align-bottom text-[12px] leading-snug text-[#e5e2dc] outline-none placeholder:text-[#8c8a82]/70 " +
                            (dragSeg === seg.id
                              ? "border-solid border-[var(--accent)] bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]"
                              : "border-[var(--accent)]/50 focus:border-solid focus:border-[var(--accent)]")
                          }
                        />
                        {segVal(seg.id).atts.map((p) => (
                          <span
                            key={p}
                            title={p}
                            className="inline-flex items-center gap-0.5 bg-[#3a3631] px-1.5 py-0.5 text-[9.5px] font-semibold text-[var(--accent)]"
                          >
                            📷{p.split(/[\\/]/).filter(Boolean).pop()}
                            <button onClick={() => removeSegAtt(seg.id, p)} title="移除并删除该临时图片文件" className="ml-0.5 text-[#8c8a82] hover:text-[#e5e2dc]">
                              ✕
                            </button>
                          </span>
                        ))}
                      </span>
                    ),
                  )}
                </div>
                {activeSeg &&
                  slashMenu(segVal(activeSeg).text, (next) => {
                    setSegText(activeSeg, next.text);
                    setCaret(next.cursor);
                  })}
                <div className="h-px w-full bg-[var(--accent)]" />
              </div>
            )
          ) : (
            <TermInputShell
              title={cur.name}
              stashed={isStashed(FIELD_DRAFT)}
              value={draft}
              onChange={setDraft}
              onCaret={(v, el) => syncCaret(v, el, null)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (onStashKey(e, FIELD_DRAFT, draft, setDraft)) return;
                const r = slash.handleKey(e, draft);
                if (r.handled) {
                  if (r.next) applyCaret(setDraft, taRef.current, r.next);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                  return;
                }
                if (hasPrimaryShortcutModifier(e) && !e.altKey && (e.key === "v" || e.key === "V")) pasteImageProbe();
              }}
              placeholder="输入内容，Enter 发送…"
              dragOver={dragOver}
              setDragOver={setDragOver}
              textareaRef={taRef}
              attachments={attachments}
              onRemoveAttachment={removeAttachment}
              onDropItem={onInputDrop}
              menu={slashMenu(draft, (next) => applyCaret(setDraft, taRef.current, next))}
            />
          )}
        </>
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
        <button
          onClick={() => setRunCollapsed(termId, true)}
          title="隐藏面板（收起为右下角浮标）"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[#3a3631] text-[#8c8a82] hover:text-[#e5e2dc]"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
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
