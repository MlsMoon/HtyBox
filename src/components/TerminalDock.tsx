import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import {
  ensureEngine,
  attachEngine,
  detachEngine,
  disposeEngine,
  focusEngine,
  setEngineTitleHandler,
  refitEngine,
} from "./terminalEngine";
import {
  PROFILES,
  DEFAULT_PROFILE,
  injectText,
  launchCmdFor,
  type AgentKind,
  type DragItem,
  type Profile,
} from "../profiles";
import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import HtyBoxLogo from "./ui/HtyBoxLogo";
import {
  setupMcpAgent,
  registerAgentLauncher,
  registerAgentTerminal,
  markTerminalClosed,
  writeAgentBrief,
  type AgentSpec,
} from "../mcp";
import { buildBrief, briefPrompt } from "../protocol";
import DockEditor, { disposeEditorBuf, isEditorDirty } from "./DockEditor";
import RunConfigBar from "./RunConfigBar";
import DockActionsMenu from "./DockActionsMenu";
import { registerDockHost } from "../dockBus";
import { captureSessionIds } from "../catalog";
import { getSessionTitle, setSessionTitle, onSessionTitlesChange, splitStatusPrefix } from "../sessionTitles";
import { pingAgentActivity, clearTerm } from "../agentStatus";
import ContextMenu from "./ui/ContextMenu";
import TagEditor from "./TagEditor";
import type { RunConfig } from "../runConfigs";
import WorkflowBar from "./WorkflowBar";
import WorkflowPicker from "./WorkflowPicker";
import ConfirmModal from "./ui/ConfirmModal";
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

// 每个 claude 终端记住它的 session id（=HtyBox 新建时用 `--session-id` 指定的自管 UUID），持久化。
// 复原时 `claude --resume <id>` 按 id 精确复原 —— 不依赖 OSC 标题、不受标题里 claude 状态符号(✳)影响。
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
// 已被某终端认领的 session id（含复原沿用的），避免并发新建时多个终端抢同一个捕获结果。
const CLAIMED_SIDS = new Set<string>(Object.values(SESSION_IDS));
// 新建 agent 终端后：轮询后端捕获该 cwd 下、启动后新生成的真实 session id，认领未占用者存入 SESSION_IDS。
// claude/codex 都不便预分配 id（保持新建命令行干净），故新建发裸命令、此处捕获真实 id 供日后精确复原。
async function captureSessionId(
  termId: string,
  agentKind: AgentKind,
  cwd: string,
): Promise<void> {
  const since = Date.now() - 3000; // 略提前以容时钟/落盘时延
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (SESSION_IDS[termId]) return; // 已被设置则停
    let ids: string[] = [];
    try {
      ids = await captureSessionIds(agentKind, cwd, since);
    } catch {
      /* ignore */
    }
    const fresh = ids.find((id) => !CLAIMED_SIDS.has(id));
    if (fresh) {
      CLAIMED_SIDS.add(fresh);
      SESSION_IDS[termId] = fresh;
      saveSI();
      return;
    }
  }
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
// 显示名优先级：会话自定义名(与 Session 列表联动) > 终端级自定义(shell/无 session id) > 会话名(OSC 去前缀)。
// 有身份(agent)则包成「身份（名）」；claude/codex 保留状态前缀，shell 无前缀。
function applyTabTitle(
  termId: string,
  agentKind: AgentKind,
  api: { setTitle: (t: string) => void },
): void {
  const isAgent = agentKind === "claude" || agentKind === "codex";
  const [prefix, body] = isAgent
    ? splitStatusPrefix(LAST_OSC[termId] ?? "")
    : ["", (LAST_OSC[termId] ?? "").trim()];
  // 记会话名(去前缀的 body)供回退；滤掉 shell 启动时的 exe 路径标题
  if (isAgent && body && !/^[a-zA-Z]:[\\/]/.test(body) && SESSION_NAMES[termId] !== body) {
    SESSION_NAMES[termId] = body;
    saveSN();
  }
  const sid = SESSION_IDS[termId];
  const custom = isAgent && sid ? getSessionTitle(agentKind, sid) : "";
  const name = custom || CUSTOM_TITLES[termId] || body || SESSION_NAMES[termId] || "";
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

// Tab 类型图标（方案 B 实心彩色徽章）：ClaudeCode/Codex 用现有素材（codex 随主题 invert）；
// 其余 6 类内联彩色徽章。普通终端随主题色（底=var(--text)、字=var(--bg)，暗色下不糊）。
const TAB_CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|h|cc|cpp|hpp|cs|rb|php|swift|kt|kts|scala|sh|bash|zsh|ps1|bat|lua|sql|r|dart|vue|svelte|astro|json|json5|jsonc|ya?ml|toml|xml|html?|css|scss|sass|less|styl|graphql|proto)$/i;
const TAB_IMG_RE = /\.(png|jpe?g|jfif|gif|webp|bmp|ico|avif)$/i;

function TabTypeIcon({ params }: { params: TermParams & { editorPath?: string } }) {
  const ep = params.editorPath;
  const cls = "h-[15px] w-[15px] shrink-0";
  if (!ep) {
    if (params.agentKind === "claude") return <img src={claudeIcon} alt="" className={cls} draggable={false} />;
    if (params.agentKind === "codex") return <img src={codexIcon} alt="" className={"codex-glyph " + cls} draggable={false} />;
    return (
      <svg className={cls} viewBox="0 0 24 24">
        <rect x="2" y="3.5" width="20" height="17" rx="5" fill="var(--text)" />
        <polyline points="6.5 9.5 9.5 12 6.5 14.5" fill="none" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="11.5" y1="14.8" x2="16" y2="14.8" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (TAB_IMG_RE.test(ep))
    return (
      <svg className={cls} viewBox="0 0 24 24">
        <rect x="2" y="3.5" width="20" height="17" rx="5" fill="#2fa35e" />
        <circle cx="8" cy="9.5" r="1.6" fill="#fff" />
        <path d="M4.5 16.5 L9 12 L12 14.5 L15.5 11 L19.5 16" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (/\.svg$/i.test(ep))
    return (
      <svg className={cls} viewBox="0 0 24 24">
        <rect x="2" y="3.5" width="20" height="17" rx="5" fill="#d97757" />
        <path d="M5 15 C 8.5 9.5, 15.5 9.5, 19 15" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
        <rect x="3.4" y="13.6" width="3" height="3" rx="0.5" fill="#fff" />
        <rect x="17.6" y="13.6" width="3" height="3" rx="0.5" fill="#fff" />
        <circle cx="12" cy="9.2" r="1.5" fill="#fff" />
      </svg>
    );
  if (/\.(md|markdown)$/i.test(ep))
    return (
      <svg className={cls} viewBox="0 0 24 24">
        <rect x="2" y="3.5" width="20" height="17" rx="5" fill="#4f7cc4" />
        <path d="M6 15 V9.2 L8.4 12.2 L10.8 9.2 V15" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14.6 9.2 V13.6 M12.5 11.8 L14.6 14 L16.7 11.8" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (TAB_CODE_RE.test(ep))
    return (
      <svg className={cls} viewBox="0 0 24 24">
        <rect x="2" y="3.5" width="20" height="17" rx="5" fill="#8b7cff" />
        <polyline points="9 8.5 6 12 9 15.5" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points="15 8.5 18 12 15 15.5" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="13.2" y1="7.6" x2="10.8" y2="16.4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg className={cls} viewBox="0 0 24 24">
      <rect x="2" y="3.5" width="20" height="17" rx="5" fill="#8c8a82" />
      <line x1="7" y1="9" x2="17" y2="9" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      <line x1="7" y1="12" x2="17" y2="12" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      <line x1="7" y1="15" x2="13" y2="15" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
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

  const startRename = () => {
    const p = props.params as TermParams & { editorPath?: string };
    const tid = p.termId;
    const sid = tid ? SESSION_IDS[tid] : undefined;
    // 编辑"纯会话名"（不含状态前缀/身份装饰）：避免带出 ✳ 后保留导致与实时前缀重复成两份
    const pure =
      (sid && (p.agentKind === "claude" || p.agentKind === "codex")
        ? getSessionTitle(p.agentKind, sid)
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
      const sid = p.termId ? SESSION_IDS[p.termId] : undefined;
      if (p.termId && sid && (p.agentKind === "claude" || p.agentKind === "codex")) {
        // claude/codex 终端：写"会话自定义名"，与 Session 列表联动；OSC 状态前缀仍实时跟随（见 applyTabTitle）
        setSessionTitle(p.agentKind, sid, t);
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

  // Tab 取会话标识（与 commit() 同款）：claude/codex 且 sid 已捕获才能打 tag；shell / sid 未就绪不可。
  const p2 = props.params as TermParams & { editorPath?: string };
  const sid = p2.termId ? SESSION_IDS[p2.termId] : undefined;
  const canTag = !!sid && (p2.agentKind === "claude" || p2.agentKind === "codex");
  const tabSessionName =
    sid && (p2.agentKind === "claude" || p2.agentKind === "codex")
      ? getSessionTitle(p2.agentKind, sid) || splitStatusPrefix(title)[1] || title
      : title;
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
        agentKind={p2.agentKind as "claude" | "codex"}
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
  // 拖入工作流但已有绑定 → 覆盖确认（覆盖=重置进度，破坏性，走确认弹窗）
  const [confirmWf, setConfirmWf] = useState<Workflow | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    // 复原时按 session id 精确复原（claude --resume <uuid>），否则发新建命令
    const restored = RESTORED_IDS.has(termId);
    // claude 的 session id：复原取持久化的 SESSION_IDS；新建取 params(paramsFor 已生成并存入 SESSION_IDS)
    const sid = SESSION_IDS[termId] ?? props.params.sessionId;
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

    // 新建的空 claude/codex 会话(非复原、非 Session 透传 id)：启动后捕获其真实 session id 供日后精确复原
    if (!restored && !sid && cwd && (agentKind === "claude" || agentKind === "codex")) {
      void captureSessionId(termId, agentKind, cwd);
    }

    // dockview 自身的尺寸/可见性事件 → 可靠 refit（比 DOM ResizeObserver 更准；
    // 面板被显示/分屏改变时按真实列宽 fit，避免 TUI 花屏）
    const dimSub = props.api.onDidDimensionsChange(() => refitEngine(termId));
    const visSub = props.api.onDidVisibilityChange(() => refitEngine(termId));

    // 程序设置终端标题(OSC)时：记下原始标题(含状态前缀)并刷新 Tab。
    // Tab = 实时状态前缀(✳/点点) + 显示名(会话自定义名 > 终端级自定义 > 会话名)——重命名后状态前缀仍跟随。
    setEngineTitleHandler(termId, (t) => {
      const raw = t.trim();
      if (!raw) return;
      const changed = LAST_OSC[termId] !== raw;
      LAST_OSC[termId] = raw;
      applyTabTitle(termId, agentKind, props.api);
      // OSC 标题"活动检测"：内容真变 + 是 agent 终端 → 标记该工作区运行中（agentStatus 三态总线）
      if (changed && (agentKind === "claude" || agentKind === "codex")) pingAgentActivity(termId);
    });
    // 会话自定义名改变(本终端在 Tab 改、或在 Session 列表改同一会话)→ 实时刷新本 Tab
    const titleSub = onSessionTitlesChange(() => applyTabTitle(termId, agentKind, props.api));
    // 挂载/复原时先把 Tab 摆正（用已记的自定义名/会话名；都没有则保持默认"终端N"）
    applyTabTitle(termId, agentKind, props.api);

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
      c.removeEventListener("dragover", onDragOver);
      c.removeEventListener("dragleave", onDragLeave);
      c.removeEventListener("drop", onDrop);
      dimSub.dispose();
      visSub.dispose();
      titleSub();
      setEngineTitleHandler(termId, undefined);
      detachEngine(termId);
    };
  }, [termId, shell, agentKind, cwd, props.api]);
  // 内边距 + 终端底色：避免 xterm 内容贴边被面板边缘裁切。
  // flex-col：xterm 宿主(flex-1，ref 仍在宿主上、RO 观察它) + 底部工作流面板；
  // 外层 relative 供 WorkflowBar 收起态浮标 absolute 定位。面板显隐引起的宿主高度变化由
  // attachEngine 的 ResizeObserver + 防抖 fit 吸收。
  return (
    <div className="relative flex h-full w-full flex-col bg-[#1f1e1d]">
      <div ref={ref} className="min-h-0 w-full flex-1 p-2" />
      <WorkflowBar termId={termId} cwd={cwd} />
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

/** 工具栏图标：Claude / Codex 用 FanBox 仓库的官方 SVG 素材；PowerShell 用终端 >_。 */
function ProfileIcon({ id }: { id: string }) {
  if (id === "claude")
    return (
      <img src={claudeIcon} alt="Claude" className="h-4 w-4" draggable={false} />
    );
  if (id === "codex")
    return (
      <img src={codexIcon} alt="Codex" className="codex-glyph h-4 w-4" draggable={false} />
    );
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 7 9 12 4 17" />
      <line x1="11" y1="17" x2="19" y2="17" />
    </svg>
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
        // 工作区关闭中：引擎已由 disposeByPrefix 统一结束，且要保留布局/自定义名供复原 → 跳过
        if (CLOSING.has(workspaceId)) return;
        disposeEngine(termId);
        // 工作流实例：agent 终端且已捕获会话 id → 归档到会话维度（Session 复原时找回，
        // 关闭终端 ≠ 丢进度）；shell / 未捕获 → 直接清理。须在下方 delete SESSION_IDS 之前读取。
        {
          const wfSid = SESSION_IDS[termId];
          const ak = params?.agentKind;
          if (wfSid && (ak === "claude" || ak === "codex"))
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
        // claude 读 .mcp.json、codex 读 .codex/config.toml（setupMcpAgent 已分别写好）；普通启动即可
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
            },
          },
          position: prevId
            ? { referencePanel: prevId, direction: "right" }
            : undefined,
        });
        prevId = id;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, cwd]);

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
          params: { editorPath: filePath, workspaceId },
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
        {PROFILES.map((p) => (
          <button
            key={p.id}
            onClick={() => addTerminal(p)}
            title={`新建 ${p.label} 终端`}
            style={{ color: p.dotColor }}
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--elevated)]"
          >
            <ProfileIcon id={p.id} />
          </button>
        ))}
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
      <div className="dockview-theme-light min-h-0 flex-1">
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
