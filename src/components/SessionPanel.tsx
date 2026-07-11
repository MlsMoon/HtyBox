import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  listClaudeSessions,
  listCodexSessions,
  listCursorSessions,
  deleteClaudeSession,
  deleteCodexSession,
  deleteCursorSession,
  type SessionRef,
} from "../catalog";
import { openTerminalCmd } from "../dockBus";
import { launchCmdFor, type AgentKind } from "../profiles";
import { searchMatch } from "../search";
import SearchBox from "./ui/SearchBox";
import ContextMenu, { MENU_SEP } from "./ui/ContextMenu";
import { getSessionTitle, setSessionTitle, onSessionTitlesChange } from "../sessionTitles";
import { getWsState, setWsState } from "../wsState";
import { getSessionTags, getSessionTagIds, useTagStore, clearSession, sessionKey } from "../sessionTags";
import { tagDot } from "../tagColors";
import TagEditor from "./TagEditor";
import { useMaskDismiss } from "./ui/maskDismiss";
import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import cursorIcon from "../assets/cursor.svg";

const AGENTS = [
  { k: "claude" as const, label: "Claude Code", icon: claudeIcon },
  { k: "codex" as const, label: "Codex", icon: codexIcon },
  { k: "cursor" as const, label: "Cursor", icon: cursorIcon },
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

// Session 的 claude/codex/cursor 选择按工作区持久化（用户点名要持久化的"有状态选择"）
type SessionAgentKind = Exclude<AgentKind, "shell">;
const AGENT_KINDS: SessionAgentKind[] = ["claude", "codex", "cursor"];
const AGENT_KEY = "htybox.sessionAgent.v1";
const readAgent = (root: string): SessionAgentKind => {
  const v = getWsState<SessionAgentKind>(AGENT_KEY, root, "claude");
  return AGENT_KINDS.includes(v) ? v : "claude";
};

// tag 筛选选中集合按工作区持久化（界面状态，scope=root；与 agent 选择同范式，符合"有状态选择按工作区"）。
const FILTER_KEY = "htybox.sessionTagFilter.v1";

// 会话自定义名（用户手动重命名覆盖显示）统一收口到 ../sessionTitles，与终端 Tab【共享同一份】：
// 在 Session 列表重命名 ↔ 在终端 Tab 重命名 改的是同一会话名，两处显示一致（见 sessionTitles.ts）。

/** 「Session」页签：claude/codex 会话列表，点击复原到终端、✕ 删除（移入回收站）。 */
export default function SessionPanel({ root, workspaceId }: { root: string; workspaceId: string }) {
  const [agentKind, setAgentKindState] = useState<SessionAgentKind>(() => readAgent(root));
  const setAgentKind = (a: SessionAgentKind) => {
    setAgentKindState(a);
    setWsState(AGENT_KEY, root, a);
  };
  const [list, setList] = useState<SessionRef[] | null>(null);
  const loadSeq = useRef(0); // 初始/手动/watcher 重拉共用代际，旧请求不得覆盖新名称
  const [q, setQ] = useState("");
  const [agentOpen, setAgentOpen] = useState(false);
  const agentMask = useMaskDismiss(() => setAgentOpen(false));
  const [favs, setFavs] = useState<string[]>(() => loadSessFavs(root));
  useEffect(() => setFavs(loadSessFavs(root)), [root]); // 切工作区重载收藏
  useEffect(() => setAgentKindState(readAgent(root)), [root]); // 切工作区重载 agent 选择（持久化）
  const [menu, setMenu] = useState<{ x: number; y: number; s: SessionRef } | null>(null);
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

  const load = useCallback((kind: SessionAgentKind, silent = false) => {
    const seq = ++loadSeq.current;
    if (!silent) setList(null);
    if (!root) {
      if (seq === loadSeq.current) setList([]);
      return;
    }
    const fetcher =
      kind === "claude" ? listClaudeSessions : kind === "codex" ? listCodexSessions : listCursorSessions;
    fetcher(root)
      .then((next) => {
        if (seq === loadSeq.current) setList(next);
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
  // Codex 自动命名或 `/rename` 更新 ~/.codex/session_index.jsonl 后，后端 watcher 发事件；
  // Session 页签静默重拉（不置 loading，避免列表闪烁/滚动位置跳回顶部）。
  useEffect(() => {
    if (agentKind !== "codex") return;
    let un: (() => void) | undefined;
    let disposed = false;
    listen("codex-sessions-changed", () => {
      if (!disposed) load("codex", true);
    }).then((u) => {
      if (disposed) u();
      else {
        un = u;
        load("codex", true); // 注册完成后补拉一次，关闭首次 load 与 listener 就绪间的丢事件窗口
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
  const del = async (s: SessionRef) => {
    try {
      if (agentKind === "claude") await deleteClaudeSession(s.id);
      else if (agentKind === "codex") await deleteCodexSession(s.path);
      else await deleteCursorSession(s.path);
      // 乐观移除：直接从列表剔除该项，避免整列重载导致滚动条跳回顶部
      setList((prev) => (prev ? prev.filter((x) => x.id !== s.id) : prev));
      clearSession(sessionKey(agentKind, s.id)); // 删除会话 → 清其 tag 关联（词表保留，供他会话用）
    } catch {
      /* ignore */
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
  const card = (s: SessionRef) => {
    const editingThis = editing === favKey(s);
    return (
      <div
        key={s.id}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, s });
        }}
        title="右键更多操作（复原 / 重命名 / 收藏 / 删除）"
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
            <div className="mt-0.5 text-[10px] text-[var(--text-3)]">{new Date(s.ts).toLocaleString()}</div>
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
            className="flex w-full items-center gap-2 rounded-lg bg-[var(--surface-hover)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] hover:bg-[var(--border-soft)]"
          >
            <img src={cur.icon} alt="" className={(cur.k === "codex" ? "codex-glyph " : cur.k === "cursor" ? "cursor-glyph " : "") + "h-4 w-4"} draggable={false} />
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
                    <img src={a.icon} alt="" className={(a.k === "codex" ? "codex-glyph " : a.k === "cursor" ? "cursor-glyph " : "") + "h-4 w-4"} draggable={false} />
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
          onClick={() => load(agentKind)}
          title="刷新"
          className="shrink-0 rounded-md px-2 py-1.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)]"
        >
          ⟳
        </button>
      </div>
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
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-3">
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
        <div className="space-y-1">{restList.map(card)}</div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { id: "resume", label: "复原到终端" },
            { id: "rename", label: "重命名" },
            { id: "tags", label: "标签…" },
            { id: "fav", label: isFav(menu.s) ? "取消收藏" : "收藏" },
            MENU_SEP,
            { id: "delete", label: "删除会话（移入回收站）", danger: true },
          ]}
          onAction={(id) => {
            if (id === "resume") resume(menu.s);
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
