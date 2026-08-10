import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import FileTypeIcon from "./ui/FileTypeIcon";
import {
  ensureEngine,
  attachEngine,
  detachEngine,
  disposeEngine,
  focusEngine,
  setEngineTitleHandler,
  refitEngine,
  injectAndSubmit,
  listEngines,
} from "./terminalEngine";
import {
  PROFILES,
  DEFAULT_PROFILE,
  injectText,
  launchCmdFor,
  isAgentTerminal,
  type AgentKind,
  type DragItem,
  type Profile,
} from "../profiles";
import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import opencodeIcon from "../assets/opencode.svg";
import cursorIcon from "../assets/cursor.svg";
import { ProfileIcon, KimiIcon } from "./ProfileIcon";
import {
  agentUnavailable,
  ensureDetected,
  useAgentInstall,
  type AgentState,
} from "../agentInstall";
import HtyBoxLogo from "./ui/HtyBoxLogo";
import {
  setupMcpAgent,
  mcpBrokerUrl,
  registerAgentLauncher,
  registerAgentTerminal,
  markTerminalClosed,
  writeAgentBrief,
  type AgentSpec,
} from "../mcp";
import { buildBrief, briefPrompt } from "../protocol";
import DockEditor, { collectEditorBuf, disposeEditorBuf, isEditorDirty } from "./DockEditor";
import RunConfigBar from "./RunConfigBar";
import DockActionsMenu from "./DockActionsMenu";
import { registerDockHost, emitActiveFile, openEditor as routeOpenEditor } from "../dockBus";
import { registerFileOpener, registerFileRevealer } from "../fileOpenBus";
import * as previewWin from "../previewWindow";
import { EV_READY } from "../previewProtocol";
import { hasPrimaryShortcutModifier } from "../platformServices";
import { getSettings } from "../settings";
import {
  listClaudeSessions,
  listCodexSessions,
  listOpenCodeSessions,
  listCursorSessions,
  listKimiSessions,
  mapAgentSessionsByPty,
  terminalPtyPid,
} from "../catalog";
import { getSessionTitle, setSessionTitle, onSessionTitlesChange, splitStatusPrefix } from "../sessionTitles";
import {
  getNativeSessionLabel,
  setNativeSessionLabels,
  onNativeSessionLabelsChange,
} from "../sessionNativeLabels";
import { pingAgentActivity, clearTerm, isTermRunning, isTermFinished, onAgentStatusChange } from "../agentStatus";
import ContextMenu from "./ui/ContextMenu";
import TagEditor from "./TagEditor";
import type { RunConfig } from "../runConfigs";
import WorkflowBar from "./WorkflowBar";
import WorkflowPicker from "./WorkflowPicker";
import ConfirmModal from "./ui/ConfirmModal";
import { clearFreeInput, emitTermInputHotkey } from "./termInput/freeInputState";
import { clearTermInputMemory } from "./termInput/termInputMemory";
import { MENU_SEP, type MenuItem } from "./ui/ContextMenu";
import {
  clearRun,
  getRun,
  applyWorkflow,
  resetRun,
  archiveRunToSession,
  restoreRunFromSession,
} from "../workflowRuns";
import { getWorkflow, type Workflow } from "../workflows";

type TermParams = {
  termId: string;
  shell?: string;
  agentKind?: AgentKind;
  cwd?: string;
  env?: Record<string, string>; // M7-A：agent 终端的身份环境变量(HTYBOX_MCP_TOKEN 等)
  model?: string; // M7-G：团队成员的模型，新建时拼进 --model
  initialPrompt?: string; // M7-C：新建时的位置 prompt（让 agent 先读协作简报）
  launchCmd?: string; // M9-N8：运行配置的显式启动命令（新建时直接发，不走 launchCmdFor）
  sessionId?: string; // claude 复原用：新建发 --session-id <uuid>、复原发 --resume <uuid>（见 SESSION_IDS）
};

const DRAG_MIME = "application/x-htybox-item";

// 终端 id 形如 "<wsId>::t-…"，反推工作区 id（工作流模板库按工作区独立，scope 用它）
const wsOfTerm = (termId: string): string => {
  const i = termId.indexOf("::");
  return i >= 0 ? termId.slice(0, i) : termId;
};

// 用户手动重命名过的 Tab（termId→名字），持久化；自动命名遇到它会跳过、不覆盖。
const CT_KEY = "htybox.customTitles.v1";
const CUSTOM_TITLES: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(CT_KEY) || "{}");
  } catch {
    return {};
  }
})();
const saveCT = () => {
  try {
    localStorage.setItem(CT_KEY, JSON.stringify(CUSTOM_TITLES));
  } catch {
    /* ignore */
  }
};

// 每个 agent 终端记住它绑定的"会话名称"(=claude 通过 OSC 设的标题/会话摘要)，持久化；
// 复原时按名精确恢复（claude --resume "<名>"）→ 多终端各回各自会话，不会都续到最近那个。
const SN_KEY = "htybox.sessionNames.v1";
const SESSION_NAMES: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(SN_KEY) || "{}");
  } catch {
    return {};
  }
})();
const saveSN = () => {
  try {
    localStorage.setItem(SN_KEY, JSON.stringify(SESSION_NAMES));
  } catch {
    /* ignore */
  }
};

// 每个 agent 终端记住捕获到的真实 session id（新建发裸命令、启动后捕获；不预分配），持久化。
// 复原时按 id 精确复原（claude --resume / codex resume / …）—— 不依赖 OSC 标题、不受状态符号(✳)影响。
const SID_KEY = "htybox.sessionIds.v1";
const SESSION_IDS: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(SID_KEY) || "{}");
  } catch {
    return {};
  }
})();
const saveSI = () => {
  try {
    localStorage.setItem(SID_KEY, JSON.stringify(SESSION_IDS));
  } catch {
    /* ignore */
  }
};
// 已被某终端认领的 session id（含复原沿用的）。
const CLAIMED_SIDS = new Set<string>(Object.values(SESSION_IDS));
// 捕获任务按 termId 常驻：勿在 DockTerminal effect 清理时 abort（props.api 变化会重跑 effect，
// 反复 abort → 永远认领失败 → Tab 停在 OSC 工作区名、重命名只写 CUSTOM_TITLES）。
// 只在面板真正关闭时 abortSessionCapture。
const CAPTURE_CTRL: Record<string, AbortController> = {};
const CAPTURE_SINCE: Record<string, number> = {};
type CaptureMeta = {
  agentKind: AgentKind;
  cwd: string;
  onClaimed?: (sessionId: string) => void;
};
const CAPTURE_META: Record<string, CaptureMeta> = {};
// 认领临界区串行化：禁止多终端各自「抢最新」导致 SESSION_IDS 对调。
let captureAssignTail: Promise<void> = Promise.resolve();

function abortSessionCapture(termId: string): void {
  CAPTURE_CTRL[termId]?.abort();
  delete CAPTURE_CTRL[termId];
  delete CAPTURE_SINCE[termId];
  delete CAPTURE_META[termId];
}

/** kimi 无位置 prompt 参数：团队简报改为终端 PTY 就绪后注入。
 *  typed-ahead 由控制台输入缓冲保存、TUI 启动即消费（已实测），故引擎建好即可注入。 */
function injectBriefWhenReady(termId: string, prompt: string): void {
  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    if (listEngines(termId).some((e) => e.termId === termId)) {
      window.clearInterval(timer);
      injectAndSubmit(termId, prompt, true);
    } else if (tries >= 100) {
      window.clearInterval(timer); // 10s 未就绪（面板被秒关等）→ 放弃注入
    }
  }, 100);
}

const nativeLabelRefreshes = new Map<string, Promise<void>>();

/** 执行一次原生名刷新；调用入口按 agent+cwd 合并并发，避免每个终端重复查询同一份会话。 */
async function performNativeLabelRefresh(agentKind: AgentKind, cwd: string): Promise<void> {
  try {
    const fetcher =
      agentKind === "claude"
        ? listClaudeSessions
        : agentKind === "codex"
          ? listCodexSessions
          : agentKind === "opencode"
            ? listOpenCodeSessions
          : agentKind === "kimi"
            ? listKimiSessions
            : listCursorSessions;
    const list = await fetcher(cwd);
    setNativeSessionLabels(
      agentKind,
      list.map((s) => ({ id: s.id, label: s.label })),
    );
  } catch {
    /* ignore */
  }
}

/** 把当前 cwd 下该 agent 的 list label 写入原生名缓存，供 Tab 与 Session 列表同构。 */
function refreshNativeLabels(agentKind: AgentKind, cwd: string): Promise<void> {
  if (!cwd || !isAgentTerminal(agentKind)) return Promise.resolve();
  const key = `${agentKind}\0${cwd}`;
  const active = nativeLabelRefreshes.get(key);
  if (active) return active;

  const refresh = performNativeLabelRefresh(agentKind, cwd);
  nativeLabelRefreshes.set(key, refresh);
  void refresh.finally(() => {
    if (nativeLabelRefreshes.get(key) === refresh) nativeLabelRefreshes.delete(key);
  });
  return refresh;
}

/** 同 agent+cwd 下尚未认领、捕获未中止的终端，按 CAPTURE_SINCE 升序（= 启动顺序）。 */
function listCaptureWaiters(agentKind: AgentKind, cwd: string): string[] {
  return Object.keys(CAPTURE_META)
    .filter((tid) => {
      const m = CAPTURE_META[tid];
      if (!m || m.agentKind !== agentKind || m.cwd !== cwd) return false;
      if (SESSION_IDS[tid]) return false;
      const ac = CAPTURE_CTRL[tid];
      return !!ac && !ac.signal.aborted;
    })
    .sort((a, b) => (CAPTURE_SINCE[a] ?? 0) - (CAPTURE_SINCE[b] ?? 0));
}

/** 把 sid 绑到 termId（同步写 CLAIMED/SESSION_IDS + 迁 CUSTOM_TITLES）。 */
function bindSessionId(termId: string, agentKind: AgentKind, sid: string): void {
  CLAIMED_SIDS.add(sid);
  SESSION_IDS[termId] = sid;
  const pending = CUSTOM_TITLES[termId];
  if (pending) {
    setSessionTitle(agentKind, sid, pending);
    delete CUSTOM_TITLES[termId];
    saveCT();
  }
}

/**
 * 集中认领（串行化）：所有 agent 一律按 PTY 映射 sessionId
 * - claude：sessions/<pid>.json 落在 PTY 进程树
 * - codex/opencode/cursor/kimi：PTY 子树 agent 进程创建时间 ↔ 会话 createdAt 最近邻
 */
async function assignCapturedSessions(agentKind: AgentKind, cwd: string): Promise<void> {
  let release!: () => void;
  const prev = captureAssignTail;
  captureAssignTail = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    const waiters = listCaptureWaiters(agentKind, cwd);
    if (!waiters.length) return;
    const since = Math.min(...waiters.map((t) => CAPTURE_SINCE[t] ?? Date.now()));
    const ptyByTerm = new Map<string, number>();
    await Promise.all(
      waiters.map(async (tid) => {
        try {
          const pid = await terminalPtyPid(tid);
          if (pid != null && pid > 0) ptyByTerm.set(tid, pid);
        } catch {
          /* ignore */
        }
      }),
    );
    const ptyPids = [...new Set(ptyByTerm.values())];
    if (!ptyPids.length) return;
    let mapped: Array<{ ptyPid: number; sessionId: string }> = [];
    try {
      mapped = await mapAgentSessionsByPty(agentKind, cwd, since, ptyPids);
    } catch {
      return;
    }
    const live = listCaptureWaiters(agentKind, cwd);
    const sidByPty = new Map(mapped.map((m) => [m.ptyPid, m.sessionId]));
    const assigned: string[] = [];
    for (const tid of live) {
      if (SESSION_IDS[tid]) continue;
      const pty = ptyByTerm.get(tid);
      if (pty == null) continue;
      const sid = sidByPty.get(pty);
      if (!sid || CLAIMED_SIDS.has(sid)) continue;
      bindSessionId(tid, agentKind, sid);
      assigned.push(tid);
    }
    if (!assigned.length) return;
    saveSI();
    await refreshNativeLabels(agentKind, cwd);
    for (const tid of assigned) {
      const sid = SESSION_IDS[tid];
      if (!sid) continue;
      CAPTURE_META[tid]?.onClaimed?.(sid);
    }
  } finally {
    release();
  }
}

// 新建 agent 终端后：轮询后端捕获该 cwd 下新生成的真实 session id；认领由 assignCapturedSessions 集中调度。
async function captureSessionId(
  termId: string,
  agentKind: AgentKind,
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  // 约 45s：Codex 冷启动 + 首条消息落盘可能慢于旧的 12s 窗口
  for (let i = 0; i < 30; i++) {
    if (signal.aborted) return;
    await new Promise<void>((r) => {
      const t = setTimeout(r, 1500);
      const onAbort = () => {
        clearTimeout(t);
        r();
      };
      if (signal.aborted) {
        clearTimeout(t);
        r();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (signal.aborted) return;
    if (SESSION_IDS[termId]) return;
    await assignCapturedSessions(agentKind, cwd);
    if (SESSION_IDS[termId]) return;
  }
}

/** 同一 termId 只跑一个捕获任务；since 在首次启动时固定，effect 重跑不得重置窗口。 */
function ensureSessionCapture(
  termId: string,
  agentKind: AgentKind,
  cwd: string,
  onClaimed?: (sessionId: string) => void,
): void {
  if (SESSION_IDS[termId]) return;
  const existing = CAPTURE_CTRL[termId];
  if (existing && !existing.signal.aborted) {
    // effect 重跑可能带新 onClaimed：更新回调，不重启 since/轮询
    const meta = CAPTURE_META[termId];
    if (meta) meta.onClaimed = onClaimed;
    return;
  }
  const ac = new AbortController();
  CAPTURE_CTRL[termId] = ac;
  CAPTURE_SINCE[termId] ??= Date.now() - 3000;
  CAPTURE_META[termId] = { agentKind, cwd, onClaimed };
  void captureSessionId(termId, agentKind, cwd, ac.signal).finally(() => {
    if (CAPTURE_CTRL[termId] === ac) delete CAPTURE_CTRL[termId];
    if (!CAPTURE_CTRL[termId]) delete CAPTURE_META[termId];
  });
}
// 每个终端最近一次 OSC 原始标题(含状态前缀)，供"会话改名"事件刷新 Tab 时复用前缀。
// 状态前缀拆分(splitStatusPrefix)统一在 ../sessionTitles，与会话名剥离共用一套字符集（含 ✳、运行中动画 · 点等）。
const LAST_OSC: Record<string, string> = {};

// agent 终端的身份标签(termId→"👑 负责人")。Tab 显示为「身份（会话名）」，不锁死会话名。
const AL_KEY = "htybox.agentLabels.v1";
const AGENT_LABELS: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(AL_KEY) || "{}");
  } catch {
    return {};
  }
})();
const saveAL = () => {
  try {
    localStorage.setItem(AL_KEY, JSON.stringify(AGENT_LABELS));
  } catch {
    /* ignore */
  }
};

// 计算并设置某终端 Tab 标题：实时状态前缀(✳/点点) + 显示名。
// 显示名权威（与 Session 列表同构）：会话自定义名 > 原生 label(index/首句/ai-title) >
//   终端级自定义(捕获前重命名) >（仅无 session id 时）OSC 去前缀会话名。
// 有身份(agent)则包成「身份（名）」；claude/codex 保留状态前缀，shell 无前缀。
function applyTabTitle(
  termId: string,
  agentKind: AgentKind,
  api: { setTitle: (t: string) => void },
  paramSid?: string,
): void {
  const isAgent = isAgentTerminal(agentKind);
  const [prefix, body] = isAgent
    ? splitStatusPrefix(LAST_OSC[termId] ?? "")
    : ["", (LAST_OSC[termId] ?? "").trim()];
  // 无 sid 时记 OSC 会话名供回退；滤掉 shell 启动时的 exe 路径标题
  if (isAgent && body && !/^[a-zA-Z]:[\\/]/.test(body) && SESSION_NAMES[termId] !== body) {
    SESSION_NAMES[termId] = body;
    saveSN();
  }
  const sid = SESSION_IDS[termId] ?? paramSid;
  const custom = isAgent && sid ? getSessionTitle(agentKind, sid) : "";
  const native = isAgent && sid ? getNativeSessionLabel(agentKind, sid) : "";
  // sid 已知后不再用 OSC body 当会话名（Codex OSC 常是工作区目录名，与列表原生名脱节）
  const name =
    (isAgent && sid
      ? custom || native || CUSTOM_TITLES[termId] || ""
      : CUSTOM_TITLES[termId] || body || SESSION_NAMES[termId] || "") || "";
  if (!name) return; // 尚无任何可显示名字 → 不覆盖默认"终端N"
  const role = AGENT_LABELS[termId];
  const shown = role ? `${role}（${name}）` : name;
  api.setTitle(isAgent && prefix ? prefix + shown : shown);
}

// 本次运行中由布局复原出来的终端 id → 启动时发"复原命令"（claude --resume / codex resume）。
const RESTORED_IDS = new Set<string>();

// 正在关闭的 workspace：其 dock 卸载期间 dockview 仍会逐个移除面板并触发 layout 变更，
// 此时绝不能把"拆到一半的残缺布局"写回 localStorage（否则复原会拿到坏掉的单面板布局）。
const CLOSING = new Set<string>();
export function markWorkspaceClosing(workspaceId: string): void {
  CLOSING.add(workspaceId);
}

// Tab 类型图标（方案 B 实心彩色徽章）：ClaudeCode/Codex/Cursor/Kimi 用官方素材（codex/cursor 随主题 invert，kimi 浅色带底）；
// 其余 6 类内联彩色徽章。普通终端随主题色（底=var(--text)、字=var(--bg)，暗色下不糊）。
function TabTypeIcon({ params }: { params: TermParams & { editorPath?: string } }) {
  const ep = params.editorPath;
  const cls = "h-[15px] w-[15px] shrink-0";
  // 编辑器面板 → 按扩展名走共享的文件类型徽章（与内容预览窗口同一套）
  if (ep) return <FileTypeIcon path={ep} className={cls} />;
  if (params.agentKind === "claude") return <img src={claudeIcon} alt="" className={cls} draggable={false} />;
  if (params.agentKind === "codex") return <img src={codexIcon} alt="" className={"codex-glyph " + cls} draggable={false} />;
  if (params.agentKind === "opencode") return <img src={opencodeIcon} alt="" className={cls} draggable={false} />;
  if (params.agentKind === "cursor") return <img src={cursorIcon} alt="" className={"cursor-glyph " + cls} draggable={false} />;
  if (params.agentKind === "kimi") return <KimiIcon className={cls} />;
  return (
    <svg className={cls} viewBox="0 0 24 24">
      <rect x="2" y="3.5" width="20" height="17" rx="5" fill="var(--text)" />
      <polyline points="6.5 9.5 9.5 12 6.5 14.5" fill="none" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="11.5" y1="14.8" x2="16" y2="14.8" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 自定义 Tab：自动命名标题 + 双击内联重命名（重命名后不被自动命名覆盖）+ 关闭。 */
function DockTab(props: IDockviewPanelHeaderProps<TermParams>) {
  const [title, setTitle] = useState(props.api.title ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null); // Tab 右键菜单
  const [tagEditor, setTagEditor] = useState<{ x: number; y: number } | null>(null); // 标签编辑器
  const [wfPicker, setWfPicker] = useState<{ x: number; y: number } | null>(null); // 应用工作流选择器
  const [confirmWfUnbind, setConfirmWfUnbind] = useState(false); // 解绑工作流确认
  useEffect(() => {
    const d = props.api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [props.api]);
  // kimi/cursor tab 状态标记：订阅运行状态总线（running/finished 跳变才 emit，高频 ping 不触发重渲染）
  const [, setStatusTick] = useState(0);
  useEffect(() => onAgentStatusChange(() => setStatusTick((n) => n + 1)), []);

  const startRename = () => {
    const p = props.params as TermParams & { editorPath?: string };
    const tid = p.termId;
    const sid = (tid ? SESSION_IDS[tid] : undefined) ?? p.sessionId;
    // 编辑"纯会话名"（不含状态前缀/身份装饰）：避免带出 ✳ 后保留导致与实时前缀重复成两份
    const pure =
      (sid && isAgentTerminal(p.agentKind)
        ? getSessionTitle(p.agentKind, sid) || getNativeSessionLabel(p.agentKind, sid)
        : "") ||
      (tid ? CUSTOM_TITLES[tid] : "") ||
      (tid ? SESSION_NAMES[tid] : "") ||
      splitStatusPrefix(title)[1] ||
      title;
    setDraft(pure);
    setEditing(true);
  };
  const commit = () => {
    const t = draft.trim();
    if (t) {
      const p = props.params as TermParams & { editorPath?: string };
      const sid = (p.termId ? SESSION_IDS[p.termId] : undefined) ?? p.sessionId;
      if (p.termId && sid && isAgentTerminal(p.agentKind)) {
        // 确保 SESSION_IDS 与 params 对齐，避免只写了 updateParameters 时列表/Tab 脱节
        if (!SESSION_IDS[p.termId]) {
          SESSION_IDS[p.termId] = sid;
          CLAIMED_SIDS.add(sid);
          saveSI();
        }
        // claude/codex/cursor 终端：写"会话自定义名"，与 Session 列表联动；OSC 状态前缀仍实时跟随（见 applyTabTitle）
        setSessionTitle(p.agentKind, sid, t);
        applyTabTitle(p.termId, p.agentKind, props.api, sid);
      } else {
        // shell / session id 未捕获 / 编辑器面板：回退到按终端(或文件)的自定义名
        const key = p.termId ?? p.editorPath ?? props.api.id;
        CUSTOM_TITLES[key] = t;
        saveCT();
        props.api.setTitle(t);
      }
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        className="my-1 w-[150px] rounded border border-[var(--accent-border)] bg-[var(--elevated)] px-1.5 py-0.5 text-xs text-[var(--text)] outline-none"
      />
    );
  }

  // Tab 取会话标识（与 commit() 同款）：agent 终端且 sid 已捕获才能打 tag；shell / sid 未就绪不可。
  const p2 = props.params as TermParams & { editorPath?: string };
  const sid = (p2.termId ? SESSION_IDS[p2.termId] : undefined) ?? p2.sessionId;
  const canTag = !!sid && isAgentTerminal(p2.agentKind);
  const tabSessionName =
    sid && isAgentTerminal(p2.agentKind)
      ? getSessionTitle(p2.agentKind, sid) ||
        getNativeSessionLabel(p2.agentKind, sid) ||
        splitStatusPrefix(title)[1] ||
        title
      : title;
  // kimi/cursor 无 OSC 原生状态前缀 → 自研 tab 标记：双点摆(活跃) / 收束成点(跑完静默)；三态语义见 agentStatus.ts
  const tabStatus =
    p2.termId && (p2.agentKind === "kimi" || p2.agentKind === "cursor")
      ? isTermRunning(p2.termId)
        ? "running"
        : isTermFinished(p2.termId)
          ? "finished"
          : null
      : null;
  return (
    <>
    <div
      onDoubleClick={startRename}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      title="双击重命名 · 右键打标签"
      className="flex h-full items-center gap-2 px-2 text-xs"
    >
      <TabTypeIcon params={props.params as TermParams & { editorPath?: string }} />
      {tabStatus === "running" && p2.termId && (
        <span
          className="tab-swing"
          // 多 tab 并跑相位错开：按 termId 字符码取模 0–0.9s
          style={{ "--swing-delay": `${([...p2.termId].reduce((a, c) => a + c.charCodeAt(0), 0) % 10) / 10}s` } as React.CSSProperties}
        >
          <i /><i />
        </span>
      )}
      {tabStatus === "finished" && (
        <span className="tab-merge"><i className="m-a" /><i className="m-b" /><i className="m-dot" /><i className="m-halo" /></span>
      )}
      <span className="max-w-[180px] truncate">{title}</span>
      <span
        // 点非激活 Tab 的 ✕：dockview 会在 pointerdown 阶段先 openPanel(切过去显示该 Tab)再 close → 视觉闪一下。
        // 捕获阶段 preventDefault 命中 dockview 的 defaultPrevented 逃生通道(tabs.js onPointerDown/onTabClick
        // 开头都 `if (event.defaultPrevented) return`)；用 capture 是因 dockview 在 .dv-tab 上原生【冒泡】监听
        // pointerdown，而 React 委托在 app root，捕获阶段必早于该冒泡监听执行 → 赶在它读 defaultPrevented 前置位。
        onPointerDownCapture={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          props.api.close();
        }}
        className="flex h-4 w-4 items-center justify-center rounded text-[13px] leading-none text-[var(--text-3)] hover:bg-[var(--border)] hover:text-[var(--text)]"
      >
        ✕
      </span>
    </div>
    {menu && (
      <ContextMenu
        x={menu.x}
        y={menu.y}
        items={(() => {
          const items: (MenuItem | typeof MENU_SEP)[] = [
            { id: "rename", label: "重命名" },
            { id: "tags", label: canTag ? "标签…" : "标签（会话初始化中…）" },
          ];
          // 终端面板才有工作流项（编辑器面板无 termId）；按当前是否已绑定动态出项
          if (p2.termId) {
            items.push(MENU_SEP);
            if (getRun(p2.termId)) {
              items.push({ id: "wf-reset", label: "重置工作流进度" });
              items.push({ id: "wf-unbind", label: "解绑工作流", danger: true });
            } else {
              items.push({ id: "wf-apply", label: "应用工作流…" });
            }
          }
          return items;
        })()}
        onAction={(id) => {
          if (id === "rename") startRename();
          else if (id === "tags" && canTag) setTagEditor({ x: menu.x, y: menu.y });
          else if (id === "wf-apply") setWfPicker({ x: menu.x, y: menu.y });
          else if (id === "wf-reset" && p2.termId) resetRun(p2.termId);
          else if (id === "wf-unbind") setConfirmWfUnbind(true);
        }}
        onClose={() => setMenu(null)}
      />
    )}
    {wfPicker && p2.termId && (
      <WorkflowPicker
        scope={wsOfTerm(p2.termId)}
        x={wfPicker.x}
        y={wfPicker.y}
        mode="apply"
        onPick={(wf) => applyWorkflow(p2.termId as string, wf)}
        onClose={() => setWfPicker(null)}
      />
    )}
    {confirmWfUnbind && p2.termId && (
      <ConfirmModal
        title="解绑工作流"
        message="将移除该终端的工作流进度（模板不受影响）。"
        confirmText="解绑"
        onConfirm={() => clearRun(p2.termId as string)}
        onClose={() => setConfirmWfUnbind(false)}
      />
    )}
    {tagEditor && canTag && (
      <TagEditor
        x={tagEditor.x}
        y={tagEditor.y}
        agentKind={p2.agentKind as Exclude<AgentKind, "shell">}
        sessionId={sid as string}
        sessionName={tabSessionName}
        onClose={() => setTagEditor(null)}
      />
    )}
    </>
  );
}

/** dockview 面板：挂终端引擎 + 自动命名 + 作为 skill/memory 拖拽落点。 */
function DockTerminal(props: IDockviewPanelProps<TermParams>) {
  const { termId, shell, agentKind = "shell", cwd, env } = props.params;
  const ref = useRef<HTMLDivElement>(null);
  const apiRef = useRef(props.api);
  apiRef.current = props.api;
  // 拖入工作流但已有绑定 → 覆盖确认（覆盖=重置进度，破坏性，走确认弹窗）
  const [confirmWf, setConfirmWf] = useState<Workflow | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    // 复原时按 session id 精确复原（claude --resume <uuid>），否则发新建命令
    const restored = RESTORED_IDS.has(termId);
    // layout 可能经 updateParameters 带上 sessionId，而 SESSION_IDS 偶发丢失 → 从 params 回填
    const paramSid = props.params.sessionId;
    if (paramSid && !SESSION_IDS[termId]) {
      SESSION_IDS[termId] = paramSid;
      CLAIMED_SIDS.add(paramSid);
      saveSI();
    }
    const sid = SESSION_IDS[termId] ?? paramSid;
    const launch =
      !restored && props.params.launchCmd
        ? props.params.launchCmd // M9-N8：运行配置命令直接发
        : launchCmdFor(
            agentKind,
            restored,
            sid,
            props.params.model, // 团队成员新建时带 --model
            restored ? undefined : props.params.initialPrompt, // 新建时先读协作简报
          );
    ensureEngine(termId, shell, launch, cwd, env, agentKind);
    attachEngine(termId, c);

    // 新建空 agent：捕获真实 session id。任务挂在模块级，effect 重跑不得 abort。
    if (!restored && !sid && cwd && isAgentTerminal(agentKind)) {
      ensureSessionCapture(termId, agentKind, cwd, (claimed) => {
        apiRef.current.updateParameters({ sessionId: claimed } as TermParams);
        applyTabTitle(termId, agentKind, apiRef.current, claimed);
      });
    }

    // dockview 自身的尺寸/可见性事件 → 可靠 refit（比 DOM ResizeObserver 更准；
    // 面板被显示/分屏改变时按真实列宽 fit，避免 TUI 花屏）
    const dimSub = apiRef.current.onDidDimensionsChange(() => refitEngine(termId));
    const visSub = apiRef.current.onDidVisibilityChange(() => refitEngine(termId));

    // 「标签页可选中」关闭时：本面板成为活动面板即把焦点交给终端，切过去可直接打字，
    // 标签自身不保持选中态（删除键因此落不到标签上）。
    // 必须等 dockview 真正把面板显示出来：对隐藏元素调 focus() 无效，故等到
    // api.isVisible 且延后一帧（避开浏览器 mousedown 把焦点给可聚焦标签的默认行为）。
    const grabFocus = () => {
      if (getSettings().tabSelectable) return;
      if (!apiRef.current.isActive || !apiRef.current.isVisible) return;
      requestAnimationFrame(() => focusEngine(termId));
    };
    const actSub = apiRef.current.onDidActiveChange(grabFocus);
    const visFocusSub = apiRef.current.onDidVisibilityChange(grabFocus);

    // Ctrl+Shift+I：仅当前活动终端面板唤起内置输入（自由输入切换 / 工作流输入展开）
    const onHotkey = (e: KeyboardEvent) => {
      if (!(hasPrimaryShortcutModifier(e) && e.shiftKey && !e.altKey && (e.key === "I" || e.key === "i"))) return;
      if (!apiRef.current.isActive || !apiRef.current.isVisible) return;
      e.preventDefault();
      e.stopPropagation();
      emitTermInputHotkey(termId);
    };
    window.addEventListener("keydown", onHotkey, true);

    // 程序设置终端标题(OSC)时：记下原始标题(含状态前缀)并刷新 Tab。
    setEngineTitleHandler(termId, (t) => {
      const raw = t.trim();
      if (!raw) return;
      const changed = LAST_OSC[termId] !== raw;
      LAST_OSC[termId] = raw;
      applyTabTitle(termId, agentKind, apiRef.current, SESSION_IDS[termId] ?? paramSid);
      if (changed && isAgentTerminal(agentKind)) pingAgentActivity(termId);
    });
    const refreshTitle = () =>
      applyTabTitle(termId, agentKind, apiRef.current, SESSION_IDS[termId] ?? props.params.sessionId);
    const titleSub = onSessionTitlesChange(refreshTitle);
    const nativeSub = onNativeSessionLabelsChange(refreshTitle);
    // Claude ai-title / Codex rollout·index / Cursor meta.json / Kimi state.json → 重拉原生 label，自动命名进 Tab
    const sessionsEvt =
      agentKind === "claude"
        ? "claude-sessions-changed"
        : agentKind === "codex"
          ? "codex-sessions-changed"
          : agentKind === "opencode"
            ? "opencode-sessions-changed"
          : agentKind === "cursor"
            ? "cursor-sessions-changed"
            : agentKind === "kimi"
              ? "kimi-sessions-changed"
              : null;
    let sessionsUnlisten: (() => void) | undefined;
    let sessionsDisposed = false;
    if (sessionsEvt && cwd) {
      void listen(sessionsEvt, () => {
        if (sessionsDisposed) return;
        void refreshNativeLabels(agentKind, cwd).then(refreshTitle);
      }).then((u) => {
        if (sessionsDisposed) u();
        else {
          sessionsUnlisten = u;
          void refreshNativeLabels(agentKind, cwd).then(refreshTitle);
        }
      });
    }
    applyTabTitle(termId, agentKind, apiRef.current, sid);

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        c.classList.add("htybox-drop");
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (!c.contains(e.relatedTarget as Node | null))
        c.classList.remove("htybox-drop");
    };
    const onDrop = (e: DragEvent) => {
      const raw = e.dataTransfer?.getData(DRAG_MIME);
      c.classList.remove("htybox-drop");
      if (!raw) return;
      e.preventDefault();
      try {
        const item = JSON.parse(raw) as DragItem;
        // workflow：语义=绑定到本终端（非文本注入）；已有实例走覆盖确认（会重置进度）
        if (item.kind === "workflow") {
          const wf = item.workflowId ? getWorkflow(wsOfTerm(termId), item.workflowId) : undefined;
          if (wf) {
            if (getRun(termId)) setConfirmWf(wf);
            else applyWorkflow(termId, wf);
          }
          return;
        }
        const text = injectText(item, agentKind) + (e.shiftKey ? "\r" : "");
        invoke("write_terminal", { id: termId, data: text }).catch(() => {});
        focusEngine(termId);
      } catch {
        /* ignore */
      }
    };

    c.addEventListener("dragover", onDragOver);
    c.addEventListener("dragleave", onDragLeave);
    c.addEventListener("drop", onDrop);

    return () => {
      sessionsDisposed = true;
      sessionsUnlisten?.();
      c.removeEventListener("dragover", onDragOver);
      c.removeEventListener("dragleave", onDragLeave);
      c.removeEventListener("drop", onDrop);
      window.removeEventListener("keydown", onHotkey, true);
      dimSub.dispose();
      visSub.dispose();
      actSub.dispose();
      visFocusSub.dispose();
      titleSub();
      nativeSub();
      // 故意不 abort 捕获：见 ensureSessionCapture 注释
      setEngineTitleHandler(termId, undefined);
      detachEngine(termId);
    };
    // props.api 用 apiRef，不进 deps，避免 dockview 重渲染反复拆装
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId, shell, agentKind, cwd, env]);
  // 内边距 + 终端底色：避免 xterm 内容贴边被面板边缘裁切。
  // flex-col：xterm 宿主(flex-1，ref 仍在宿主上、RO 观察它) + 底部工作流面板；
  // 外层 relative 供 WorkflowBar 收起态浮标 absolute 定位。面板显隐引起的宿主高度变化由
  // attachEngine 的 ResizeObserver + 防抖 fit 吸收。
  return (
    <div className="relative flex h-full w-full flex-col bg-[#1f1e1d]">
      <div ref={ref} className="min-h-0 w-full flex-1 p-2" />
      <WorkflowBar termId={termId} cwd={cwd} agentKind={agentKind} />
      {confirmWf && (
        <ConfirmModal
          title="覆盖当前工作流"
          message={`该终端已绑定工作流，改为应用「${confirmWf.name}」并重新开始？`}
          confirmText="覆盖应用"
          onConfirm={() => applyWorkflow(termId, confirmWf)}
          onClose={() => setConfirmWf(null)}
        />
      )}
    </div>
  );
}

const components = { terminal: DockTerminal, editor: DockEditor };

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

let seq = 0;
let termNo = 0;
const nextTitle = () => `终端${++termNo}`;
const titleFor = (p: Profile) =>
  p.agentKind === "shell" ? nextTitle() : `${nextTitle()} · ${p.label}`;
const paramsFor = (p: Profile, id: string, cwd: string): TermParams => ({
  termId: id,
  shell: p.shell,
  agentKind: p.agentKind,
  cwd,
});

/** dock 空态水印：无任何终端/编辑器面板时，奶油底 + hty 盒子 logo + 常用操作提示（Cursor 式）。 */
function DockWatermark() {
  const kc = "rounded bg-[var(--surface-hover)] px-1.5 py-0.5 font-mono text-[11px] leading-none text-[var(--text-2)]";
  const row = (label: string, val: React.ReactNode) => (
    <div className="flex items-center justify-between gap-10">
      <span className="text-[var(--text-3)]">{label}</span>
      <span className="flex items-center gap-1 text-[var(--text-faint)]">{val}</span>
    </div>
  );
  return (
    <div className="flex h-full w-full select-none flex-col items-center justify-center gap-8 bg-[var(--bg)]">
      <HtyBoxLogo size={128} initial="open" openOnHover />
      <div className="flex w-[268px] flex-col gap-2.5 text-[12.5px]">
        {row("新建终端", <span>点击上方 ▸_ / Claude / Codex</span>)}
        {row(
          "搜索文件",
          <>
            <kbd className={kc}>Shift</kbd>
            <kbd className={kc}>Shift</kbd>
          </>,
        )}
        {row("注入引用", <span>拖 Skill / 文件 入终端</span>)}
      </div>
    </div>
  );
}

/** 顶栏新建按钮 tooltip：未安装/安装中给出引导，否则原「新建 X 终端」。 */
function addTerminalTitle(p: Profile, st: AgentState | undefined): string {
  if (st?.phase === "missing") return `未安装 ${p.label}，请到 设置 → Agent 安装`;
  if (st?.phase === "installing") return `${p.label} 正在安装，稍候…`;
  return `新建 ${p.label} 终端`;
}

/** 终端区：一个 workspace 一个实例；终端 id/布局键按 workspace 隔离，cwd=工作区文件夹。 */
export default function TerminalDock({
  workspaceId,
  cwd,
}: {
  workspaceId: string;
  cwd: string;
}) {
  const apiRef = useRef<DockviewApi | null>(null);
  const layoutKey = `htybox.dock.layout.${workspaceId}`;
  const mkId = () =>
    `${workspaceId}::t-${Date.now().toString(36)}-${(seq++).toString(36)}`;

  const addTerminal = useCallback(
    (profile: Profile) => {
      const api = apiRef.current;
      if (!api) return;
      const id = mkId();
      api.addPanel({
        id,
        component: "terminal",
        title: titleFor(profile),
        params: paramsFor(profile, id, cwd),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // M9-N8：运行一个配置——新开 PowerShell 终端、cwd=配置目录(默认工作区根)、自动执行命令
  const runCfg = useCallback(
    (cfg: RunConfig) => {
      const api = apiRef.current;
      if (!api) return;
      const id = mkId();
      api.addPanel({
        id,
        component: "terminal",
        title: `▶ ${cfg.name}`,
        params: {
          termId: id,
          shell: "powershell.exe",
          agentKind: "shell" as AgentKind,
          cwd: cfg.cwd?.trim() || cwd,
          launchCmd: cfg.command.replace(/[\r\n]+$/, "") + "\r",
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cwd],
  );

  // 按工作流新建终端：选 agent + 工作流 → 新建终端并立即绑定（阶段 1 待执行）
  const [spawnPicker, setSpawnPicker] = useState<{ x: number; y: number } | null>(null);
  const spawnWithWorkflow = useCallback(
    (profile: Profile, wf: Workflow) => {
      const api = apiRef.current;
      if (!api) return;
      const id = mkId();
      api.addPanel({
        id,
        component: "terminal",
        title: titleFor(profile),
        params: paramsFor(profile, id, cwd),
      });
      applyWorkflow(id, wf);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cwd],
  );

  // M9：dock 批量操作（关闭所有/其他/已保存编辑器）
  const closeAll = useCallback(() => {
    apiRef.current?.panels.slice().forEach((p) => p.api.close());
  }, []);
  const closeOthers = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const active = api.activePanel;
    api.panels.slice().forEach((p) => {
      if (p !== active) p.api.close();
    });
  }, []);
  const closeSavedEditors = useCallback(() => {
    apiRef.current?.panels.slice().forEach((p) => {
      const ep = (p.params as { editorPath?: string } | undefined)?.editorPath;
      if (ep && !isEditorDirty(p.id)) p.api.close();
    });
  }, []);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      CLOSING.delete(workspaceId); // 重新打开 → 不再处于关闭态

      api.onDidRemovePanel((panel) => {
        const params = panel.params as (TermParams & { editorPath?: string }) | undefined;
        const termId = params?.termId;
        if (!termId) {
          if (params?.editorPath) disposeEditorBuf(panel.id); // 编辑器面板：清未保存缓冲
          return;
        }
        markTerminalClosed(termId); // M7-H：主动关闭 → 其 PTY 退出事件不当崩溃
        clearTerm(termId); // 清运行状态总线（agentStatus 三态）
        clearFreeInput(termId); // 清无工作流自由输入展开态（全局开关：no-op）
        abortSessionCapture(termId);
        // 工作区关闭中：引擎已由 disposeByPrefix 统一结束，且要保留布局/自定义名/输入草稿供复原 → 跳过
        if (CLOSING.has(workspaceId)) return;
        clearTermInputMemory(termId); // 用户关终端：清空该终端输入记忆
        disposeEngine(termId);
        // 工作流实例：agent 终端且已捕获会话 id → 归档到会话维度（Session 复原时找回，
        // 关闭终端 ≠ 丢进度）；shell / 未捕获 → 直接清理。须在下方 delete SESSION_IDS 之前读取。
        {
          const wfSid = SESSION_IDS[termId];
          const ak = params?.agentKind;
          if (wfSid && isAgentTerminal(ak))
            archiveRunToSession(termId, `${ak}:${wfSid}`);
          else clearRun(termId);
        }
        if (CUSTOM_TITLES[termId]) {
          delete CUSTOM_TITLES[termId];
          saveCT();
        }
        if (SESSION_NAMES[termId]) {
          delete SESSION_NAMES[termId];
          saveSN();
        }
        if (SESSION_IDS[termId]) {
          // 关闭终端释放认领，避免僵尸 CLAIMED 挡住后续同 cwd 新会话捕获
          CLAIMED_SIDS.delete(SESSION_IDS[termId]);
          delete SESSION_IDS[termId];
          saveSI();
        }
        if (AGENT_LABELS[termId]) {
          delete AGENT_LABELS[termId];
          saveAL();
        }
      });

      api.onDidLayoutChange(() => {
        if (CLOSING.has(workspaceId)) return; // 关闭中：别把残缺布局写回
        try {
          localStorage.setItem(layoutKey, JSON.stringify(api.toJSON()));
        } catch {
          /* ignore */
        }
      });

      let restored = false;
      const saved = localStorage.getItem(layoutKey);
      if (saved) {
        try {
          api.fromJSON(JSON.parse(saved));
          restored = api.panels.length > 0;
          // 标记为"复原"，DockTerminal 启动时改发 resume 命令
          if (restored)
            api.panels.forEach((p) => {
              const tid = (p.params as TermParams | undefined)?.termId;
              if (tid) RESTORED_IDS.add(tid);
            });
        } catch {
          restored = false;
        }
      }
      if (restored) {
        termNo = Math.max(termNo, api.panels.length);
      }
      // 无已存布局：不再默认建终端，留空 → 显示 DockWatermark，由用户点工具栏图标手动新建
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Agent CLI 安装检测：本组件订阅 store（顶栏置灰用），首个订阅触发一次检测（幂等）。
  const agentInstall = useAgentInstall();
  useEffect(() => {
    ensureDetected();
  }, []);

  // M7-A：响应 App「多 Agent 协作」，在本工作区起 agent 终端（注册身份 + 注入 token env）。
  // 顺序创建并左右分屏（都可见 → 都按真实列宽起、都连上 broker）。
  useEffect(() => {
    return registerAgentLauncher(
      workspaceId,
      async (specs: AgentSpec[], opts?: { respawn?: boolean }) => {
      const api = apiRef.current;
      if (!api) return;
      let prevId: string | undefined;
      for (const spec of specs) {
        const token =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${(seq++).toString(36)}`;
        try {
          await setupMcpAgent({
            cwd,
            token,
            agentId: spec.agentId,
            role: spec.role,
            roleName: spec.roleName,
            workspace: workspaceId,
          });
        } catch (e) {
          console.error("setup_mcp_agent failed", e);
          continue;
        }
        const id = mkId();
        // 身份标签（👑Lead / 🔧worker）；Tab 显示为「身份（会话名）」，会话名随 onTitle 更新
        const label = (spec.role === "lead" ? "👑 " : "🔧 ") + spec.roleName;
        AGENT_LABELS[id] = label;
        saveAL();
        // M7-B 唤醒定位 + M7-H 崩溃替补：登记该终端的完整身份
        registerAgentTerminal(id, {
          agentId: spec.agentId,
          roleName: spec.roleName,
          role: spec.role,
          agentKind: spec.agentKind,
          model: spec.model,
          responsibility: spec.responsibility,
          cwd,
          workspaceId,
          token,
        });
        // M7-C：写协作简报（角色/职责/协议/花名册），启动用位置 prompt 让它先读 → 自己按协议协作
        try {
          await writeAgentBrief({
            cwd,
            agentId: spec.agentId,
            content: buildBrief(spec, specs, undefined, opts?.respawn),
          });
        } catch (e) {
          console.error("write_agent_brief failed", e);
        }
        let opencodeConfig: string | undefined;
        if (spec.agentKind === "opencode") {
          try {
            const url = await mcpBrokerUrl();
            opencodeConfig = JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              mcp: {
                htybox: {
                  type: "remote",
                  url,
                  oauth: false,
                  headers: { Authorization: "Bearer {env:HTYBOX_MCP_TOKEN}" },
                },
              },
            });
          } catch (e) {
            console.error("mcp_broker_url failed", e);
            continue;
          }
        }
        // OpenCode 用进程级内联配置接入团队 MCP，不改用户的 opencode.json。
        api.addPanel({
          id,
          component: "terminal",
          title: label,
          params: {
            termId: id,
            shell: "powershell.exe",
            agentKind: spec.agentKind,
            cwd,
            model: spec.model, // 新建时拼进 --model
            initialPrompt: briefPrompt(spec.agentId), // M7-C：启动先读协作简报
            env: {
              HTYBOX_MCP_TOKEN: token,
              HTYBOX_AGENT_ID: spec.agentId,
              HTYBOX_ROLE: spec.role,
              HTYBOX_ROLE_NAME: spec.roleName,
              HTYBOX_WORKSPACE_ID: workspaceId,
              HTYBOX_RESPONSIBILITY: spec.responsibility ?? "", // 职责，供 M7-C 协议注入
              ...(opencodeConfig ? { OPENCODE_CONFIG_CONTENT: opencodeConfig } : {}),
            },
          },
          position: prevId
            ? { referencePanel: prevId, direction: "right" }
            : undefined,
        });
        // kimi 无位置 prompt 参数（-p 是非交互模式）：简报改为终端就绪后 injectAndSubmit 注入
        if (spec.agentKind === "kimi") injectBriefWhenReady(id, briefPrompt(spec.agentId));
        prevId = id;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, cwd]);

  // 编辑器面板与宿主之间的两条通道（DockEditor 只认 fileOpenBus，不直接依赖 dockBus / 窗口状态）：
  // 打开另一个文件 → 走 dockBus 分流（预览窗开着会自动转过去）；面板激活 → 左栏文件树揭示定位。
  // 编辑器面板的收集 / 批量关闭：dock 宿主接口与「移交给预览窗」共用同一份实现
  const collectEditors = useCallback((): Array<{ path: string; content?: string }> => {
    const api = apiRef.current;
    if (!api) return [];
    const out: { path: string; content?: string }[] = [];
    for (const p of api.panels) {
      const path = (p.params as { editorPath?: string } | undefined)?.editorPath;
      if (!path) continue;
      const content = collectEditorBuf(p.id); // 未保存的随行搬走，已保存的让对端读盘
      out.push(content === undefined ? { path } : { path, content });
    }
    return out;
  }, []);
  const closeEditors = useCallback((paths: string[]) => {
    const api = apiRef.current;
    if (!api) return;
    const want = new Set(paths);
    for (const p of [...api.panels]) {
      const path = (p.params as { editorPath?: string } | undefined)?.editorPath;
      if (path && want.has(path)) p.api.close();
    }
  }, []);

  useEffect(() => {
    // 打开文件的分流点：该工作区的内容预览窗口开着就改派过去，否则落本 dock。
    // 放在主窗侧注册（而非 dockBus 内部），第二个窗口才不会被迫 import 窗口状态机。
    const un1 = registerFileOpener(workspaceId, (p) => {
      if (previewWin.isLive(workspaceId)) previewWin.sendOpenFile(workspaceId, p);
      else routeOpenEditor(workspaceId, p);
    });
    const un2 = registerFileRevealer(workspaceId, (p) => emitActiveFile(workspaceId, p));
    // 预览窗建好并就绪 → 把本工作区已开的编辑器（含未保存内容）整体移交过去，主窗只剩终端
    let unReady: (() => void) | undefined;
    listen<{ wsId: string }>(EV_READY, (e) => {
      if (e.payload.wsId !== workspaceId) return;
      const items = collectEditors();
      if (!items.length) return;
      previewWin.sendAdopt(workspaceId, items);
      closeEditors(items.map((i) => i.path));
    })
      .then((u) => {
        unReady = u;
      })
      .catch((e) => console.error("监听内容预览窗口就绪事件失败", e));
    return () => {
      un1();
      un2();
      unReady?.();
    };
  }, [workspaceId, collectEditors, closeEditors]);

  // M9：注册"打开编辑器 / 在此开终端"总线（FilePanel 点击文件、右键操作经此路由到本 dock）。
  useEffect(() => {
    return registerDockHost(workspaceId, {
      openEditor: (filePath) => {
        const api = apiRef.current;
        if (!api) return;
        const existing = api.panels.find(
          (p) => (p.params as { editorPath?: string } | undefined)?.editorPath === filePath,
        );
        if (existing) {
          existing.api.setActive();
          return;
        }
        api.addPanel({
          id: `${workspaceId}::e-${Date.now().toString(36)}-${(seq++).toString(36)}`,
          component: "editor",
          title: baseName(filePath),
          params: { editorPath: filePath, workspaceId, workspaceRoot: cwd },
        });
      },
      openTerminalAt: (atCwd) => {
        const api = apiRef.current;
        if (!api) return;
        const id = mkId();
        api.addPanel({
          id,
          component: "terminal",
          title: titleFor(DEFAULT_PROFILE),
          params: { ...paramsFor(DEFAULT_PROFILE, id, cwd), cwd: atCwd },
        });
      },
      openTerminalCmd: (opts) => {
        const api = apiRef.current;
        if (!api) return;
        const id = mkId();
        // Session 面板复原：记下被复原的 session id，供退出重进后再按 id 精确复原；
        // 该会话若有归档的工作流进度（终端曾关闭），一并移回新终端
        if (opts.sessionId) {
          SESSION_IDS[id] = opts.sessionId;
          saveSI();
          restoreRunFromSession(`${opts.agentKind}:${opts.sessionId}`, id);
        }
        api.addPanel({
          id,
          component: "terminal",
          title: opts.title,
          params: {
            termId: id,
            shell: "powershell.exe",
            agentKind: opts.agentKind as AgentKind,
            cwd: opts.cwd || cwd,
            launchCmd: opts.command.replace(/[\r\n]+$/, "") + "\r",
            sessionId: opts.sessionId,
          },
        });
      },
      activateTerminal: (termId) => {
        const api = apiRef.current;
        if (!api) return;
        const panel = api.panels.find(
          (p) => (p.params as TermParams | undefined)?.termId === termId,
        );
        if (panel) {
          panel.api.setActive();
          focusEngine(termId);
        }
      },
      collectEditors,
      closeEditors,
      terminalTitle: (termId) => {
        const api = apiRef.current;
        // PanelApi 的 title 属性（DockTab 的 props.api.title 同源，已实证）
        return api?.panels.find((p) => (p.params as TermParams | undefined)?.termId === termId)
          ?.api.title;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, cwd]);

  return (
    <div className="flex h-full w-full flex-col bg-[#1f1e1d]">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
        {PROFILES.map((p) => {
          // 非 shell 且 CLI 未安装/安装中 → 置灰禁点（tooltip 引导去设置页安装）
          const st = isAgentTerminal(p.agentKind) ? agentInstall[p.agentKind] : undefined;
          const un = agentUnavailable(st);
          return (
            <button
              key={p.id}
              disabled={un}
              onClick={() => addTerminal(p)}
              title={addTerminalTitle(p, st)}
              style={{ color: p.dotColor }}
              className={
                "flex h-7 w-7 items-center justify-center rounded-md transition-colors " +
                (un ? "cursor-not-allowed opacity-35 grayscale" : "hover:bg-[var(--elevated)]")
              }
            >
              <ProfileIcon id={p.id} />
            </button>
          );
        })}
        <button
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setSpawnPicker({ x: r.left, y: r.bottom + 4 });
          }}
          title="按工作流新建终端"
          className="flex h-7 items-center gap-0.5 rounded-md px-1.5 text-[var(--accent)] transition-colors hover:bg-[var(--elevated)]"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="5" cy="12" r="2.4" fill="currentColor" stroke="none" />
            <path d="M8.5 12h4" />
            <circle cx="16" cy="12" r="2.4" fill="currentColor" stroke="none" />
            <path d="M19.5 12h1.5" />
          </svg>
          <span className="text-[8px] text-[var(--text-3)]">▾</span>
        </button>
        <div className="flex-1" />
        <RunConfigBar workspaceId={workspaceId} root={cwd} onRun={runCfg} />
        <DockActionsMenu
          onCloseAll={closeAll}
          onCloseOthers={closeOthers}
          onCloseSaved={closeSavedEditors}
        />
      </div>
      {spawnPicker && (
        <WorkflowPicker
          scope={workspaceId}
          x={spawnPicker.x}
          y={spawnPicker.y}
          mode="spawn"
          onSpawn={spawnWithWorkflow}
          onClose={() => setSpawnPicker(null)}
        />
      )}
      <div
        className="dockview-theme-light min-h-0 flex-1"
        // 「标签页可选中」关闭时的兜底：键盘导航（Tab 键）仍可能把焦点送进标签栏，
        // 此时删除键会落到标签上关掉面板。dockview 的 keydown 绑在 tabsList 上走冒泡，
        // 捕获阶段 stopPropagation 即可拦下；开关打开时放行其原生行为。
        onKeyDownCapture={(e) => {
          if (getSettings().tabSelectable) return;
          if (e.key !== "Delete" && e.key !== "Backspace") return;
          if ((e.target as HTMLElement).closest(".dv-tab")) e.stopPropagation();
        }}
      >
        <DockviewReact
          components={components}
          defaultTabComponent={DockTab}
          watermarkComponent={DockWatermark}
          onReady={onReady}
        />
      </div>
    </div>
  );
}
