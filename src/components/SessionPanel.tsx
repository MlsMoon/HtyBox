import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  listClaudeSessions,
  listCodexSessions,
  listOpenCodeSessions,
  listCursorSessions,
  listKimiSessions,
  listHermesSessions,
  listGrokSessions,
  deleteClaudeSession,
  deleteCodexSession,
  deleteOpenCodeSession,
  deleteCursorSession,
  deleteKimiSession,
  deleteHermesSession,
  deleteGrokSession,
  exportSessionArchive,
  importSessionArchive,
  type SessionAgent,
  type SessionRef,
} from "../catalog";
import { openTerminalCmd } from "../dockBus";
import { launchCmdFor } from "../profiles";
import { getSettings } from "../settings";
import { perfRescan } from "../perf/perfHud";
import { scheduleSessionRefresh } from "../sessionRefreshThrottle";
import { KimiIcon } from "./ProfileIcon";
import { searchMatch } from "../search";
import SearchBox from "./ui/SearchBox";
import { Pager } from "./htyenv/sections/shared";
import ContextMenu, { MENU_SEP } from "./ui/ContextMenu";
import TransferNotice, { type TransferNoticeValue } from "./ui/TransferNotice";
import { getSessionTitle, setSessionTitle, onSessionTitlesChange } from "../sessionTitles";
import { setNativeSessionLabels } from "../sessionNativeLabels";
import { getWsState, setWsState } from "../wsState";
import { getSessionTags, getSessionTagIds, useTagStore, clearSession, sessionKey } from "../sessionTags";
import { tagDot } from "../tagColors";
import TagEditor from "./TagEditor";
import { useMaskDismiss } from "./ui/maskDismiss";
import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import opencodeIcon from "../assets/opencode.svg";
import cursorIcon from "../assets/cursor.svg";
import hermesIcon from "../assets/hermes.svg";
import grokIcon from "../assets/grok.svg";

const AGENTS: { k: SessionAgentKind; label: string; icon?: string }[] = [
  { k: "claude" as const, label: "Claude Code", icon: claudeIcon },
  { k: "codex" as const, label: "Codex", icon: codexIcon },
  { k: "opencode" as const, label: "OpenCode", icon: opencodeIcon },
  { k: "cursor" as const, label: "Cursor", icon: cursorIcon },
  { k: "kimi" as const, label: "Kimi" }, // kimi 图标走内联 KimiIcon（深色需反转白底黑 K，img 做不到）
  { k: "hermes" as const, label: "Hermes", icon: hermesIcon },
  { k: "grok" as const, label: "Grok Build", icon: grokIcon },
];

// 会话收藏：按工作区 root 分组，存 "agentKind:id"（持久化，跨重启），收藏的置顶成区显示。
const SESS_FAV_KEY = "htybox.favSessions.v1";
function loadSessFavs(root: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(SESS_FAV_KEY) || "{}");
    return Array.isArray(all[root]) ? all[root] : [];
  } catch {
    return [];
  }
}
function saveSessFavs(root: string, keys: string[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(SESS_FAV_KEY) || "{}");
    all[root] = keys;
    localStorage.setItem(SESS_FAV_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

// Session 的 claude/codex/cursor/kimi 选择按工作区持久化（用户点名要持久化的"有状态选择"）
type SessionAgentKind = SessionAgent;
const AGENT_KINDS: SessionAgentKind[] = ["claude", "codex", "opencode", "cursor", "kimi", "hermes", "grok"];
const AGENT_KEY = "htybox.sessionAgent.v1";
const readAgent = (root: string): SessionAgentKind => {
  const v = getWsState<SessionAgentKind>(AGENT_KEY, root, "claude");
  return AGENT_KINDS.includes(v) ? v : "claude";
};

// tag 筛选选中集合按工作区持久化（界面状态，scope=root；与 agent 选择同范式，符合"有状态选择按工作区"）。
const FILTER_KEY = "htybox.sessionTagFilter.v1";

const sessionAgentLabel = (agent: SessionAgent): string =>
  AGENTS.find((item) => item.k === agent)?.label ?? agent;

const sessionArchiveName = (title: string, agent: SessionAgent, id: string): string => {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const shortened = Array.from(cleaned || "session").slice(0, 80).join("").replace(/[. ]+$/g, "");
  return `${shortened || "session"}-${agent}-${id.slice(0, 8)}.htybox-session`;
};

// 会话自定义名（用户手动重命名覆盖显示）统一收口到 ../sessionTitles，与终端 Tab【共享同一份】：
// 在 Session 列表重命名 ↔ 在终端 Tab 重命名 改的是同一会话名，两处显示一致（见 sessionTitles.ts）。

/** 「Session」页签：claude/codex 会话列表，点击复原到终端、✕ 删除（移入回收站）。 */
/** plan-3 分页页长:rest 列表每页 20(Pager 单页自隐);收藏区始终全显(量少)。 */
const SESS_PAGE_SIZE = 20;

export default function SessionPanel({ root, workspaceId }: { root: string; workspaceId: string }) {  const [agentKind, setAgentKindState] = useState<SessionAgentKind>(() => readAgent(root));
  const [list, setList] = useState<SessionRef[] | null>(null);
  const loadSeq = useRef(0); // 初始/手动/watcher 重拉共用代际，旧请求不得覆盖新名称
  const setAgentKind = (a: SessionAgentKind) => {
    if (a === agentKind) return;
    loadSeq.current += 1;
    setList(null);
    setAgentKindState(a);
    setWsState(AGENT_KEY, root, a);
  };
  const transferGeneration = useRef(0);
  const currentRoot = useRef(root);
  const busyRef = useRef<"import" | "export" | null>(null);
  const [busy, setBusy] = useState<"import" | "export" | null>(null);
  const [notice, setNotice] = useState<TransferNoticeValue | null>(null);
  const [q, setQ] = useState("");
  const [agentOpen, setAgentOpen] = useState(false);
  const agentMask = useMaskDismiss(() => setAgentOpen(false));
  const [favs, setFavs] = useState<string[]>(() => loadSessFavs(root));
  const [menu, setMenu] = useState<{ x: number; y: number; s: SessionRef } | null>(null);
  useEffect(() => setFavs(loadSessFavs(root)), [root]); // 切工作区重载收藏
  useEffect(() => setAgentKindState(readAgent(root)), [root]); // 切工作区重载 agent 选择（持久化）
  useLayoutEffect(() => {
    currentRoot.current = root;
    loadSeq.current += 1;
    transferGeneration.current += 1;
    busyRef.current = null;
    setList(null);
    setBusy(null);
    setNotice(null);
    setAgentOpen(false);
    setMenu(null);
    return () => {
      transferGeneration.current += 1;
      busyRef.current = null;
    };
  }, [root]);
  const [, setTitleVer] = useState(0); // 会话自定义名变化(本面板或终端 Tab 改同一会话)→ 自增触发重渲染
  useEffect(() => onSessionTitlesChange(() => setTitleVer((v) => v + 1)), []);
  const [editing, setEditing] = useState<string | null>(null); // 正在重命名的会话键 "agentKind:id"
  const [draft, setDraft] = useState("");
  const cur = AGENTS.find((a) => a.k === agentKind) ?? AGENTS[0];
  // —— tag ——：订阅整个 store，任意会话 tag 变化 → 重渲染（卡片 chips / 筛选 / 下拉计数实时）
  const tagStore = useTagStore();
  const vocab = tagStore.vocab;
  const [tagEditor, setTagEditor] = useState<{ x: number; y: number; s: SessionRef } | null>(null);
  const [filterOpen, setFilterOpen] = useState(false); // tag 筛选下拉开关
  const filterMask = useMaskDismiss(() => setFilterOpen(false));
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(() => getWsState<string[]>(FILTER_KEY, root, []));
  useEffect(() => setSelectedTagIds(getWsState<string[]>(FILTER_KEY, root, [])), [root]); // 切工作区重载筛选
  const setFilter = (ids: string[]) => {
    setSelectedTagIds(ids);
    setWsState(FILTER_KEY, root, ids);
  };
  const toggleFilter = (id: string) =>
    setFilter(selectedTagIds.includes(id) ? selectedTagIds.filter((x) => x !== id) : [...selectedTagIds, id]);
  // 有效筛选集 = 选中集 ∩ 词表：deleteTag 后（或任何来源的）悬挂 id 永不参与过滤/激活态/计数。
  // 写入端保留原始集、不跨工作区清洗持久化桶（wsState 无枚举 API 且读取端已免疫）。
  const effectiveTagIds = useMemo(
    () => selectedTagIds.filter((id) => vocab.some((t) => t.id === id)),
    [selectedTagIds, vocab],
  );
  const effectiveTagIdsRef = useRef(effectiveTagIds);
  effectiveTagIdsRef.current = effectiveTagIds;

  const load = useCallback((kind: SessionAgentKind, silent = false) => {
    const seq = ++loadSeq.current;
    if (!silent) setList(null);
    if (!root) {
      if (seq === loadSeq.current) setList([]);
      return;
    }
    const fetcher =
      kind === "claude"
        ? listClaudeSessions
        : kind === "codex"
          ? listCodexSessions
          : kind === "opencode"
            ? listOpenCodeSessions
          : kind === "kimi"
            ? listKimiSessions
            : kind === "hermes"
              ? listHermesSessions
              : kind === "grok"
                ? listGrokSessions
                : listCursorSessions;
    const scanT0 = getSettings().perfHud ? performance.now() : 0; // 性能探针(plan-1)：会话重扫计时
    fetcher(root)
      .then((next) => {
        if (getSettings().perfHud) perfRescan(performance.now() - scanT0);
        if (seq !== loadSeq.current) return;
        setNativeSessionLabels(
          kind,
          next.map((s) => ({ id: s.id, label: s.label })),
        );
        setList(next);
      })
      .catch(() => {
        if (seq === loadSeq.current) {
          setList((prev) => (silent && prev !== null ? prev : []));
        }
      });
  }, [root]);
  useEffect(() => {
    load(agentKind);
  }, [agentKind, load]);
  // Claude ai-title / Codex index·rollout / Cursor meta.json / Kimi state.json 落盘后，后端 watcher 发事件；
  // Session 页签静默重拉（不置 loading，避免列表闪烁/滚动位置跳回顶部）。
  useEffect(() => {
    const evt =
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
              : agentKind === "hermes"
                ? "hermes-sessions-changed"
                : agentKind === "grok"
                  ? "grok-sessions-changed"
                  : null;
    if (!evt) return;
    let un: (() => void) | undefined;
    let disposed = false;
    listen(evt, () => {
      // plan-3：agent 运行期退避为 3s trailing + 结束终扫;非运行期直通(现状灵敏度)
      if (!disposed)
        scheduleSessionRefresh(`${agentKind}\0${workspaceId}`, workspaceId, () =>
          load(agentKind, true),
        );
    }).then((u) => {
      if (disposed) u();
      else {
        un = u;
        load(agentKind, true); // 注册完成后补拉一次，关闭首次 load 与 listener 就绪间的丢事件窗口
      }
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [agentKind, load]);

  const resume = (s: SessionRef) => {
    // 复原命令统一收敛到 launchCmdFor（决策3），不再手搓字符串——三种 agent 只用改一处。
    const command = launchCmdFor(agentKind, true, s.id) ?? "";
    const name = getSessionTitle(agentKind, s.id) || s.label;
    openTerminalCmd(workspaceId, { command, agentKind, title: `↺ ${name.slice(0, 18)}`, sessionId: s.id });
  };
  const setTransferBusy = (next: "import" | "export" | null) => {
    busyRef.current = next;
    setBusy(next);
  };
  const exportOne = async (s: SessionRef, kind: SessionAgentKind) => {
    if (busyRef.current) return;
    const operationRoot = root;
    const generation = ++transferGeneration.current;
    const isCurrent = () =>
      generation === transferGeneration.current && currentRoot.current === operationRoot;
    setAgentOpen(false);
    setTransferBusy("export");
    try {
      const title = getSessionTitle(kind, s.id) || s.label;
      const destination = await save({
        title: "导出会话",
        defaultPath: sessionArchiveName(title, kind, s.id),
        filters: [{ name: "HtyBox Session", extensions: ["htybox-session"] }],
      });
      if (!isCurrent() || destination === null) return;
      setNotice(null);
      const result = await exportSessionArchive(kind, s.id, operationRoot, s.path || null, destination);
      if (!isCurrent()) return;
      setNotice({
        tone: "success",
        message: `已导出 ${sessionAgentLabel(result.agent)} 会话`,
        details: [result.path, ...result.warnings],
      });
    } catch (error) {
      if (isCurrent()) {
        setNotice({ tone: "error", message: `导出会话失败：${String(error)}` });
      }
    } finally {
      if (isCurrent()) setTransferBusy(null);
    }
  };
  const importOne = async () => {
    if (busyRef.current) return;
    const operationRoot = root;
    const generation = ++transferGeneration.current;
    const isCurrent = () =>
      generation === transferGeneration.current && currentRoot.current === operationRoot;
    setAgentOpen(false);
    setTransferBusy("import");
    try {
      const archivePath = await open({
        title: "导入会话",
        multiple: false,
        directory: false,
        filters: [{ name: "HtyBox Session", extensions: ["htybox-session"] }],
      });
      if (!isCurrent() || archivePath === null) return;
      setNotice(null);
      const result = await importSessionArchive(archivePath, operationRoot, operationRoot);
      if (!isCurrent()) return;

      setQ("");
      const filterWarning =
        effectiveTagIdsRef.current.length > 0
          ? ["当前标签筛选仍开启，导入的会话可能被隐藏。"]
          : [];
      setNotice({
        tone: "success",
        message:
          result.status === "alreadyPresent"
            ? `${sessionAgentLabel(result.agent)} 会话已存在且内容相同`
            : `已导入 ${sessionAgentLabel(result.agent)} 会话`,
        details: [`会话 ID：${result.id}`, ...filterWarning, ...result.warnings],
      });
      if (result.agent === agentKind) {
        load(result.agent, true);
      } else {
        setAgentKind(result.agent);
      }
    } catch (error) {
      if (isCurrent()) {
        setNotice({ tone: "error", message: `导入会话失败：${String(error)}` });
      }
    } finally {
      if (isCurrent()) setTransferBusy(null);
    }
  };
  const del = async (s: SessionRef) => {
    try {
      if (agentKind === "claude") await deleteClaudeSession(s.id);
      else if (agentKind === "codex") await deleteCodexSession(s.path);
      else if (agentKind === "opencode") await deleteOpenCodeSession(s.id, root);
      else if (agentKind === "kimi") await deleteKimiSession(s.path);
      else if (agentKind === "hermes") await deleteHermesSession(s.id);
      else if (agentKind === "grok") await deleteGrokSession(s.path);
      else await deleteCursorSession(s.path);
      // 乐观移除：直接从列表剔除该项，避免整列重载导致滚动条跳回顶部
      setList((prev) => (prev ? prev.filter((x) => x.id !== s.id) : prev));
      clearSession(sessionKey(agentKind, s.id)); // 删除会话 → 清其 tag 关联（词表保留，供他会话用）
    } catch (error) {
      setNotice({ tone: "error", message: `删除会话失败：${String(error)}` });
    }
  };
  const favKey = (s: SessionRef) => `${agentKind}:${s.id}`;
  const displayLabel = (s: SessionRef) => getSessionTitle(agentKind, s.id) || s.label;
  const tagNamesOf = (s: SessionRef) => getSessionTags(agentKind, s.id).map((t) => t.name);
  const filtered = (list ?? []).filter((s) => {
    if (!searchMatch(q, displayLabel(s), s.id, ...tagNamesOf(s))) return false;
    // tag 筛选：OR（会话 tag 与选中集合有交集即显示）；空集合 = 不筛选（悬挂 id 经有效集剔除）
    if (effectiveTagIds.length > 0) {
      const ids = getSessionTagIds(agentKind, s.id);
      if (!effectiveTagIds.some((tid) => ids.includes(tid))) return false;
    }
    return true;
  });
  const isFav = (s: SessionRef) => favs.includes(favKey(s));
  const toggleFav = (s: SessionRef) => {
    const k = favKey(s);
    const next = favs.includes(k) ? favs.filter((x) => x !== k) : [...favs, k];
    setFavs(next);
    saveSessFavs(root, next);
  };
  // plan-3 分页:rest 列表每页 20(Pager 单页自隐);收藏区始终全显(量少)。筛选/搜索/工作区/agent 变化回第 1 页。
  const [page, setPage] = useState(1);
  const listScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => setPage(1), [q, effectiveTagIds, agentKind, root]);
  const onPage = (p: number) => {
    setPage(p);
    listScrollRef.current?.scrollTo({ top: 0 });
  };
  const startRename = (s: SessionRef) => {
    setEditing(favKey(s));
    setDraft(displayLabel(s));
  };
  const commitRename = (s: SessionRef) => {
    const t = draft.trim();
    // 空或与原标题相同 → 传空串清除自定义、恢复原名；否则写入（与终端 Tab 共享、并实时刷新两处）
    setSessionTitle(agentKind, s.id, t && t !== s.label ? t : "");
    setEditing(null);
  };
  const favList = filtered.filter(isFav);
  const restList = filtered.filter((s) => !isFav(s));
  const pageCount = Math.ceil(restList.length / SESS_PAGE_SIZE);
  const curPage = Math.min(page, Math.max(1, pageCount)); // 列表缩短(删除/筛选)时收敛越界页码
  const pagedRest = restList.slice((curPage - 1) * SESS_PAGE_SIZE, curPage * SESS_PAGE_SIZE);
  const visibleNotice: TransferNoticeValue | null = busy
    ? {
        tone: "busy",
        message: busy === "import" ? "正在导入会话…" : "正在导出会话…",
      }
    : notice;
  const card = (s: SessionRef) => {
    const editingThis = editing === favKey(s);
    return (
      <div
        key={s.id}
        onContextMenu={(e) => {
          e.preventDefault();
          if (busyRef.current) return;
          setMenu({ x: e.clientX, y: e.clientY, s });
        }}
        title="右键更多操作（复原 / 导出 / 重命名 / 收藏 / 删除）"
        className="group flex items-start gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-2.5 py-1.5 transition-colors hover:border-[var(--accent-border)] hover:bg-[var(--surface-soft)]"
      >
        {editingThis ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitRename(s);
              else if (e.key === "Escape") setEditing(null);
            }}
            onBlur={() => commitRename(s)}
            className="my-0.5 min-w-0 flex-1 rounded border border-[var(--accent-border)] bg-[var(--surface)] px-1.5 py-0.5 text-[12px] text-[var(--text)] outline-none"
          />
        ) : (
          <button onClick={() => resume(s)} title="复原此会话到终端" className="min-w-0 flex-1 cursor-pointer text-left">
            <div className="truncate text-[12px] text-[var(--text)]">{displayLabel(s)}</div>
            <div className="mt-0.5 text-[10px] text-[var(--text-3)]">
              {new Date(s.ts).toLocaleString()}
              <span className="ml-1.5 font-mono opacity-70" title={s.id}>
                {(s.id.startsWith("session_") ? s.id.slice("session_".length) : s.id).slice(0, 8)}
              </span>
            </div>
            {(() => {
              const cardTags = getSessionTags(agentKind, s.id);
              return cardTags.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {cardTags.map((t) => (
                    <span
                      key={t.id}
                      className="inline-flex items-center gap-1 rounded-[4px] border px-1 py-px text-[10px] font-semibold"
                      style={{ color: tagDot(t.color), borderColor: tagDot(t.color) + "66", backgroundColor: tagDot(t.color) + "22" }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tagDot(t.color) }} />
                      {t.name}
                    </span>
                  ))}
                </div>
              ) : null;
            })()}
          </button>
        )}
        {!editingThis && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleFav(s);
            }}
            title={isFav(s) ? "取消收藏" : "收藏"}
            className={
              "shrink-0 px-0.5 text-[13px] leading-none transition-opacity " +
              (isFav(s)
                ? "text-[var(--accent)]"
                : "text-[var(--text-faint)] opacity-0 hover:text-[var(--accent)] group-hover:opacity-100")
            }
          >
            {isFav(s) ? "♥" : "♡"}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-[var(--surface)]">
      <div className="flex items-center gap-1 px-2.5 pt-2">
        <div className="relative min-w-0 flex-1">
          <button
            onClick={() => setAgentOpen((v) => !v)}
            disabled={busy !== null}
            className="flex w-full items-center gap-2 rounded-lg bg-[var(--surface-hover)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] hover:bg-[var(--border-soft)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {cur.k === "kimi" ? (
              <KimiIcon className="h-4 w-4" />
            ) : (
              <img
                src={cur.icon}
                alt=""
                className={
                  (cur.k === "codex"
                    ? "codex-glyph "
                    : cur.k === "cursor"
                      ? "cursor-glyph "
                      : cur.k === "hermes"
                        ? "hermes-glyph "
                        : cur.k === "grok"
                          ? "grok-glyph "
                        : "") + "h-4 w-4"
                }
                draggable={false}
              />
            )}
            <span className="min-w-0 flex-1 truncate text-left">{cur.label}</span>
            <svg className="h-3 w-3 shrink-0 text-[var(--text-3)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {agentOpen && (
            <>
              <div className="fixed inset-0 z-[60]" {...agentMask} />
              <div className="absolute left-0 top-full z-[61] mt-1 w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--elevated)] py-1 shadow-xl">
                {AGENTS.map((a) => (
                  <button
                    key={a.k}
                    onClick={() => {
                      setAgentKind(a.k);
                      setAgentOpen(false);
                    }}
                    className={
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] " +
                      (a.k === agentKind ? "bg-[var(--accent)]/10 text-[var(--text)]" : "text-[var(--text-deep)] hover:bg-[var(--surface)]")
                    }
                  >
                    {a.k === "kimi" ? (
                      <KimiIcon className="h-4 w-4" />
                    ) : (
                      <img
                        src={a.icon}
                        alt=""
                        className={
                          (a.k === "codex"
                            ? "codex-glyph "
                            : a.k === "cursor"
                              ? "cursor-glyph "
                              : a.k === "hermes"
                                ? "hermes-glyph "
                                : a.k === "grok"
                                  ? "grok-glyph "
                                : "") + "h-4 w-4"
                        }
                        draggable={false}
                      />
                    )}
                    <span className="flex-1">{a.label}</span>
                    {a.k === agentKind && (
                      <svg className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button
          onClick={() => void importOne()}
          disabled={busy !== null}
          title="导入会话包"
          className="shrink-0 rounded-md px-2 py-1.5 text-[11px] font-semibold text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          导入
        </button>
        <button
          onClick={() => load(agentKind)}
          disabled={busy !== null}
          title="刷新"
          className="shrink-0 rounded-md px-2 py-1.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          ⟳
        </button>
      </div>
      {visibleNotice && (
        <div className="pt-2">
          <TransferNotice
            value={visibleNotice}
            onClose={busy ? undefined : () => setNotice(null)}
          />
        </div>
      )}
      <div className="px-2.5 pt-2 pb-1.5">
        <SearchBox value={q} onChange={setQ} placeholder={`搜索 ${agentKind} 会话…`} />
        {vocab.length > 0 && (
          <div className="relative mt-1.5">
            <button
              onClick={() => setFilterOpen((v) => !v)}
              className={
                "flex w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] transition-colors " +
                (effectiveTagIds.length > 0
                  ? "border-[var(--accent-border)] bg-[var(--accent)]/10 text-[var(--text)]"
                  : "border-[var(--border)] bg-[var(--elevated)] text-[var(--text-2)] hover:bg-[var(--surface-soft)]")
              }
            >
              <svg className="h-3.5 w-3.5 shrink-0 text-[var(--text-2)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 5h18l-7 8v6l-4-2v-4z" />
              </svg>
              {effectiveTagIds.length === 0 ? (
                <>
                  <span>标签筛选</span>
                  <span className="ml-auto text-[10px] text-[var(--text-3)]">点击多选</span>
                </>
              ) : (
                <>
                  {(() => {
                    const sel = vocab.filter((t) => selectedTagIds.includes(t.id));
                    const shown = sel.slice(0, 3); // 首期固定前 3 个 + …+N（像素级自适应省略留打磨）
                    const rest = sel.length - shown.length;
                    return (
                      <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                        {shown.map((t) => (
                          <span key={t.id} className="inline-flex shrink-0 items-center gap-1">
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tagDot(t.color) }} />
                            {t.name}
                          </span>
                        ))}
                        {rest > 0 && <span className="shrink-0 text-[10px] font-semibold text-[var(--text-3)]">…+{rest}</span>}
                      </span>
                    );
                  })()}
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      setFilter([]);
                    }}
                    title="清除筛选"
                    className="shrink-0 px-0.5 leading-none text-[var(--text-3)] hover:text-[var(--text)]"
                  >
                    ✕
                  </span>
                </>
              )}
              <svg
                className={"h-3 w-3 shrink-0 text-[var(--text-3)] transition-transform " + (filterOpen ? "rotate-180" : "")}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {filterOpen && (
              <>
                <div className="fixed inset-0 z-[60]" {...filterMask} />
                <div className="absolute top-full right-0 left-0 z-[61] mt-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--elevated)] py-1 shadow-xl">
                  <div className="flex items-center justify-between px-3 py-1">
                    <span className="text-[10px] font-bold tracking-wide text-[var(--text-2)]">按标签筛选</span>
                    <span className="text-[10px] text-[var(--text-3)]">任一匹配 · OR</span>
                  </div>
                  <div className="my-1 border-t border-[var(--border-soft)]" />
                  {vocab.map((t) => {
                    const on = selectedTagIds.includes(t.id);
                    const count = (list ?? []).filter((s) => getSessionTagIds(agentKind, s.id).includes(t.id)).length;
                    return (
                      <button
                        key={t.id}
                        onClick={() => toggleFilter(t.id)}
                        className={
                          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] " +
                          (on ? "bg-[var(--accent)]/5" : "hover:bg-[var(--surface)]")
                        }
                      >
                        <span
                          className={
                            "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border " +
                            (on ? "border-[var(--accent)] bg-[var(--accent)]" : "border-[var(--border)] bg-[var(--elevated)]")
                          }
                        >
                          {on && (
                            <svg className="h-2.5 w-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          )}
                        </span>
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tagDot(t.color) }} />
                        <span className="min-w-0 flex-1 truncate text-[var(--text-deep)]">{t.name}</span>
                        <span className="shrink-0 text-[10px] text-[var(--text-3)]">{count}</span>
                      </button>
                    );
                  })}
                  <div className="my-1 border-t border-[var(--border-soft)]" />
                  <div className="flex items-center justify-between px-3 py-0.5">
                    <button onClick={() => setFilter([])} className="text-[10.5px] text-[var(--accent-text)] hover:underline">
                      清除全部
                    </button>
                    <span className="text-[10px] text-[var(--text-3)]">已选 {effectiveTagIds.length}</span>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div ref={listScrollRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-3">
        {list === null && <div className="pt-6 text-center text-[11px] text-[var(--text-3)]">加载中…</div>}
        {list !== null && filtered.length === 0 && (
          <div className="pt-6 text-center text-[11px] text-[var(--text-3)]">无 {agentKind} 会话</div>
        )}
        {favList.length > 0 && (
          <div className="mb-2">
            <div className="flex items-center gap-1.5 px-1 pt-1 pb-1.5 text-[10px] font-semibold tracking-wider text-[var(--text-3)] uppercase">
              <svg className="h-3 w-3 text-[var(--accent)]" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              收藏 · {favList.length}
            </div>
            <div className="space-y-1">{favList.map(card)}</div>
            <div className="my-2.5 border-t border-[var(--border)]" />
          </div>
        )}
        <div className="space-y-1">{pagedRest.map(card)}</div>
        <Pager page={curPage} pageCount={pageCount} onPage={onPage} />
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { id: "resume", label: "复原到终端" },
            // kimi/hermes/opencode/grok 归档导入导出本期未接入 → 隐藏其导出入口
            ...(["kimi", "hermes", "opencode", "grok"].includes(agentKind)
              ? []
              : [{ id: "export", label: "导出会话…" }]),
            { id: "rename", label: "重命名" },
            { id: "tags", label: "标签…" },
            { id: "fav", label: isFav(menu.s) ? "取消收藏" : "收藏" },
            MENU_SEP,
            {
              id: "delete",
              label: agentKind === "opencode" ? "删除会话（先备份到回收站）" : "删除会话（移入回收站）",
              danger: true,
            },
          ]}
          onAction={(id) => {
            if (id === "resume") resume(menu.s);
            else if (id === "export") void exportOne(menu.s, agentKind);
            else if (id === "rename") startRename(menu.s);
            else if (id === "tags") setTagEditor({ x: menu.x, y: menu.y, s: menu.s });
            else if (id === "fav") toggleFav(menu.s);
            else if (id === "delete") void del(menu.s);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {tagEditor && (
        <TagEditor
          x={tagEditor.x}
          y={tagEditor.y}
          agentKind={agentKind}
          sessionId={tagEditor.s.id}
          sessionName={displayLabel(tagEditor.s)}
          onClose={() => setTagEditor(null)}
        />
      )}
    </div>
  );
}
