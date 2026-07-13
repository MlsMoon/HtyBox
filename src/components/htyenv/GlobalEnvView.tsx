// 全局权威库管理视图(plan-4 Step 4,决策 5A:只读浏览 + 收编/取件/删除管理操作)。
// 数据真实纪律:描述/版本链/来源全部取自库 manifest 与实文件;「最近动向」= 版本链事件,无事件即空。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu from "../ui/ContextMenu";
import ConfirmModal from "../ui/ConfirmModal";
import {
  htyenvCollectSkill,
  htyenvCompare,
  htyenvFetchSkill,
  htyenvLibraryDeleteSkill,
  htyenvLibrarySkills,
  htyenvLibraryStatus,
  type LibrarySkillInfo,
  type LibraryStatus,
  type SkillLineage,
} from "../../htyenv";
import type { DashWorkspace } from "./DashboardShell";
import { Pager, basename, fmtUtc } from "./sections/shared";

/** 收编弹窗每页条数(数据量大走分页,不靠长滚动条——用户定稿纪律) */
const COLLECT_PAGE_SIZE = 10;

export default function GlobalEnvView({
  libraryDir,
  workspaces,
}: {
  libraryDir: string;
  workspaces: DashWorkspace[];
}) {
  const [library, setLibrary] = useState<LibraryStatus | null>(null);
  const [skills, setSkills] = useState<LibrarySkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [libPage, setLibPage] = useState(1);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [fetchTarget, setFetchTarget] = useState<string | null>(null);
  const [collectOpen, setCollectOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setError(null);
    htyenvLibraryStatus(libraryDir)
      .then((s) => {
        setLibrary(s);
        if (s.present && !s.manifestError) {
          return htyenvLibrarySkills(libraryDir).then(setSkills);
        }
        setSkills([]);
        return undefined;
      })
      .catch((e) => setError(String(e)));
  }, [libraryDir]);
  useEffect(refresh, [refresh]);

  const filtered = useMemo(() => {
    const list = skills ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) => s.id.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
    );
  }, [skills, search]);

  /** 最近动向 = 全部版本链事件按时间降序(真实数据,无编造) */
  const activity = useMemo(() => {
    const events: { utc: string; text: string }[] = [];
    for (const s of skills ?? []) {
      for (const v of s.versions) {
        events.push({
          utc: v.collectedUtc,
          text: `入库 ${s.id} ← ${v.sourceWorkspace ? basename(v.sourceWorkspace) : "外部演进"}`,
        });
      }
    }
    events.sort((a, b) => (a.utc < b.utc ? 1 : -1));
    return events.slice(0, 8);
  }, [skills]);

  const versionTotal = useMemo(
    () => (skills ?? []).reduce((acc, s) => acc + s.versions.length, 0),
    [skills],
  );

  const runOp = (op: Promise<unknown>) => {
    setBusy(true);
    setOpError(null);
    op.catch((e) => setOpError(String(e))).finally(() => {
      setBusy(false);
      refresh();
    });
  };

  return (
    <div className="flex h-full gap-4 overflow-y-auto p-4 pt-0">
      {/* 左列:库状态 / 出厂模板 / 最近动向 */}
      <div className="flex w-80 shrink-0 flex-col gap-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
          <div className="text-[13px] font-bold">库状态</div>
          {error ? (
            <div className="mt-2 text-[11px] text-[var(--danger)]">{error}</div>
          ) : !library ? (
            <div className="mt-2 text-[11px] text-[var(--text-faint)]">检测中…</div>
          ) : (
            <>
              <div className="mt-2.5 text-[10px] text-[var(--text-3)]">路径(设置 → hty环境 可改)</div>
              <div className="mt-0.5 break-all font-mono text-[11px] text-[var(--text-2)]">{library.path}</div>
              {library.manifestError ? (
                <div className="mt-2 text-[11px] text-[var(--danger)]">库登记损坏:{library.manifestError}</div>
              ) : library.present ? (
                <>
                  <div className="mt-2.5 text-[10px] text-[var(--text-3)]">库标识 · 模板版本</div>
                  <div className="mt-0.5 font-mono text-[11px] text-[var(--text-2)]">
                    {library.libraryId} · 出厂模板 v{library.templateVersion}
                  </div>
                  <div className="mt-3 flex gap-6">
                    <div>
                      <div className="text-[10px] text-[var(--text-3)]">Skill</div>
                      <div className="text-lg font-bold">{skills?.length ?? library.skillCount ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-[var(--text-3)]">版本链</div>
                      <div className="text-lg font-bold">{versionTotal}</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="mt-2 text-[11px] text-[var(--text-3)]">
                  尚未建立——首次初始化工程或收编 skill 时自动创建
                </div>
              )}
              <button
                onClick={() => invoke("reveal_in_explorer", { path: library.path }).catch((e) => setOpError(String(e)))}
                className="mt-3 rounded-lg border border-[var(--border)] px-3 py-1 text-[11px] text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] hover:text-[var(--text)]"
              >
                打开目录
              </button>
            </>
          )}
        </div>

        {library?.present && !library.manifestError && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
            <div className="text-[13px] font-bold">出厂结构模板 v{library.templateVersion}</div>
            <div className="mt-2 text-[11px] leading-relaxed text-[var(--text-3)]">
              出厂纯结构——skills / memory 为空;内容由「收编」从各工程长出,初始化任意工程时随库下发。
            </div>
          </div>
        )}

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
          <div className="text-[13px] font-bold">最近动向</div>
          {activity.length === 0 ? (
            <div className="mt-2 text-[11px] text-[var(--text-3)]">暂无入库事件</div>
          ) : (
            <div className="mt-2 space-y-1.5">
              {activity.map((e, i) => (
                <div key={i} className="flex gap-2 text-[11px]">
                  <span className="shrink-0 font-mono text-[10px] text-[var(--text-3)]">{fmtUtc(e.utc)}</span>
                  <span className="truncate text-[var(--text-2)]" title={e.text}>{e.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 右侧:库内 Skill 列表 */}
      <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-bold">库内 Skill({filtered.length})</span>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setLibPage(1);
            }}
            placeholder="搜索库内 skill…"
            className="ml-auto w-56 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-1.5 text-[11px] text-[var(--text)] placeholder:text-[var(--text-3)] focus:border-[var(--accent-border)] focus:outline-none"
          />
          <button
            onClick={() => setCollectOpen(true)}
            disabled={busy}
            className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            从工作区收编…
          </button>
        </div>
        {opError && <div className="mt-2 break-all text-[11px] text-[var(--danger)]">{opError}</div>}
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {skills === null ? (
            <div className="py-8 text-center text-xs text-[var(--text-3)]">加载中…</div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--text-3)]">
              {skills.length === 0 ? "库内暂无 skill——用「从工作区收编…」把工程 canonical skill 收入库" : "无匹配结果"}
            </div>
          ) : (
            filtered.slice((libPage - 1) * COLLECT_PAGE_SIZE, libPage * COLLECT_PAGE_SIZE).map((s) => {
              const latest = s.versions[s.versions.length - 1];
              return (
                <div
                  key={s.id}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, id: s.id });
                  }}
                  className="flex items-center gap-3 border-b border-[var(--border-soft)] py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[13px] text-[var(--text)]">{s.id}</div>
                    <div className="truncate text-[11px] text-[var(--text-3)]" title={s.description}>
                      {s.entryMissing ? (
                        <span className="text-[var(--danger)]">实体缺 SKILL.md(库损坏)——先修复库目录</span>
                      ) : (
                        s.description ?? "(无描述)"
                      )}
                    </div>
                  </div>
                  <span className="w-16 shrink-0 text-[12px] text-[var(--text-2)]">{s.versions.length} 版</span>
                  <span
                    className="w-36 shrink-0 truncate text-[11px] text-[var(--text-3)]"
                    title={latest?.sourceWorkspace}
                  >
                    {latest ? `${fmtUtc(latest.collectedUtc)} ← ${latest.sourceWorkspace ? basename(latest.sourceWorkspace) : "外部演进"}` : "-"}
                  </span>
                  <button
                    onClick={() => setFetchTarget(s.id)}
                    disabled={busy || s.entryMissing}
                    className="shrink-0 rounded-md border border-[var(--accent-border)] px-3 py-1 text-[11px] text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-40"
                  >
                    取件
                  </button>
                </div>
              );
            })
          )}
        </div>
        <Pager page={libPage} pageCount={Math.max(1, Math.ceil(filtered.length / COLLECT_PAGE_SIZE))} onPage={setLibPage} />
        <div className="mt-2 shrink-0 text-[10px] text-[var(--text-faint)]">
          删除库内 skill:右键条目 →「删除」(危险操作不放悬停按钮)
        </div>
      </div>

      {/* 右键菜单:删除(危险) */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ id: "delete", label: "从库删除", danger: true }]}
          onAction={(id) => {
            if (id === "delete") setConfirmDelete(menu.id);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          title={`从库删除「${confirmDelete}」?`}
          message="删除库内登记与实体。已取件此 skill 的工作区不受直接影响,但其谱系将报「库侧断链」,需重新收编或除名。"
          confirmText="删除"
          onConfirm={() => runOp(htyenvLibraryDeleteSkill(confirmDelete, libraryDir))}
          onClose={() => setConfirmDelete(null)}
        />
      )}
      {fetchTarget && (
        <PickWorkspaceModal
          title={`取件「${fetchTarget}」到哪个工作区?`}
          workspaces={workspaces}
          onPick={(ws) => {
            setFetchTarget(null);
            runOp(htyenvFetchSkill(ws.path, fetchTarget, libraryDir));
          }}
          onClose={() => setFetchTarget(null)}
        />
      )}
      {collectOpen && (
        <CollectModal
          workspaces={workspaces}
          libraryDir={libraryDir}
          onDone={() => {
            setCollectOpen(false);
            refresh();
          }}
          onClose={() => setCollectOpen(false)}
        />
      )}
    </div>
  );
}

/** 目标工作区选择(取件用;自定义弹窗纪律)。 */
function PickWorkspaceModal({
  title,
  workspaces,
  onPick,
  onClose,
}: {
  title: string;
  workspaces: DashWorkspace[];
  onPick: (ws: DashWorkspace) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="w-[420px] max-w-[90vw] rounded-2xl bg-[var(--elevated)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-sm font-semibold text-[var(--text)]">{title}</div>
        {workspaces.length === 0 ? (
          <div className="py-4 text-xs text-[var(--text-3)]">没有可选工作区(先在正常模式打开文件夹)</div>
        ) : (
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {workspaces.map((w) => (
              <button
                key={w.path}
                onClick={() => onPick(w)}
                className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-[var(--surface)]"
              >
                <span className="truncate text-[12.5px] text-[var(--text)]">{w.name}</span>
                <span className="truncate font-mono text-[10px] text-[var(--text-3)]">{w.path}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex justify-end">
          <button onClick={onClose} className="rounded-md px-3 py-1 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface)]">
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/** 收编弹窗:选工作区 → 谱系对比取可收编项(untracked) → 逐项收编,展示去工程化整理指令。 */
function CollectModal({
  workspaces,
  libraryDir,
  onDone,
  onClose,
}: {
  workspaces: DashWorkspace[];
  libraryDir: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const [ws, setWs] = useState<DashWorkspace | null>(null);
  const [rows, setRows] = useState<SkillLineage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string; brief?: string }>>({});
  const [showBrief, setShowBrief] = useState<string | null>(null);
  const [collected, setCollected] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!ws) return;
    setRows(null);
    setLoadError(null);
    setQuery("");
    setPage(1);
    htyenvCompare(ws.path, libraryDir)
      .then((rep) => setRows(rep.skills.filter((s) => s.state === "untracked" && !!s.wsSha)))
      .catch((e) => setLoadError(String(e)));
  }, [ws, libraryDir]);

  const q = query.trim().toLowerCase();
  const matched = (rows ?? []).filter((r) => !q || r.id.toLowerCase().includes(q));
  const pageCount = Math.max(1, Math.ceil(matched.length / COLLECT_PAGE_SIZE));
  const pageRows = matched.slice((page - 1) * COLLECT_PAGE_SIZE, page * COLLECT_PAGE_SIZE);
  const pendingCount = matched.filter((r) => !results[r.id]?.ok).length;
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [batchNote, setBatchNote] = useState<string | null>(null);
  // 弹窗关闭后停止批量循环(不给已卸载组件 setState,也不再发后续收编)
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const collectOne = async (id: string) => {
    if (!ws) return false;
    try {
      const r = await htyenvCollectSkill(ws.path, id, libraryDir);
      if (!aliveRef.current) return true;
      setCollected(true);
      setResults((prev) => ({
        ...prev,
        [id]: { ok: true, message: r.status === "collected" ? "已收编" : "已关联(库内容一致)", brief: r.curationBrief },
      }));
      return true;
    } catch (e) {
      if (aliveRef.current) setResults((prev) => ({ ...prev, [id]: { ok: false, message: String(e) } }));
      return false;
    }
  };

  const collect = (id: string) => {
    if (batch) return;
    setBusyId(id);
    void collectOne(id).finally(() => aliveRef.current && setBusyId(null));
  };

  /** 全部收编:只针对当前搜索命中集;顺序执行(收编逐项读改写两侧 manifest,并发会互相覆盖) */
  const collectAll = async () => {
    if (!ws || batch || busyId) return;
    const targets = matched.filter((r) => !results[r.id]?.ok);
    if (targets.length === 0) return;
    setBatchNote(null);
    setBatch({ done: 0, total: targets.length });
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      if (!aliveRef.current) return;
      if (await collectOne(targets[i].id)) ok++;
      else failed++;
      if (aliveRef.current) setBatch({ done: i + 1, total: targets.length });
    }
    if (!aliveRef.current) return;
    setBatch(null);
    setBatchNote(`本轮收编:成功 ${ok}${failed > 0 ? ` · 失败 ${failed}(逐行查看原因)` : ""}`);
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/30" onClick={() => (collected ? onDone() : onClose())}>
      <div
        className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col rounded-2xl bg-[var(--elevated)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-sm font-semibold text-[var(--text)]">从工作区收编 skill 入库</div>
        {!ws ? (
          workspaces.length === 0 ? (
            <div className="py-4 text-xs text-[var(--text-3)]">没有可选工作区(先在正常模式打开文件夹)</div>
          ) : (
            <div className="max-h-72 space-y-0.5 overflow-y-auto">
              {workspaces.map((w) => (
                <button
                  key={w.path}
                  onClick={() => setWs(w)}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-[var(--surface)]"
                >
                  <span className="truncate text-[12.5px] text-[var(--text)]">{w.name}</span>
                  <span className="truncate font-mono text-[10px] text-[var(--text-3)]">{w.path}</span>
                </button>
              ))}
            </div>
          )
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2 text-[11px] text-[var(--text-3)]">
              <button onClick={() => setWs(null)} className="rounded px-1.5 py-0.5 hover:bg-[var(--surface)]">←</button>
              <span className="truncate font-mono">{ws.path}</span>
            </div>
            {rows !== null && rows.length > 0 && (
              <div className="mb-2 flex items-center gap-2">
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                  placeholder="搜索可收编 skill…"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[11px] text-[var(--text)] placeholder:text-[var(--text-3)] focus:border-[var(--accent-border)] focus:outline-none"
                />
                <span className="shrink-0 text-[10px] text-[var(--text-3)]">
                  {q ? `匹配 ${matched.length} / ${rows.length}` : `可收编 ${rows.length} 项`}
                </span>
                <button
                  onClick={() => void collectAll()}
                  disabled={batch !== null || busyId !== null || pendingCount === 0}
                  title="收编当前搜索命中的全部条目(逐项顺序执行,一项失败不阻塞其余)"
                  className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {batch ? `收编中 ${batch.done}/${batch.total}` : `全部收编(${pendingCount})`}
                </button>
              </div>
            )}
            {batchNote && <div className="mb-2 text-[11px] text-[var(--success)]">{batchNote}</div>}
            {loadError ? (
              <div className="break-all text-[11px] text-[var(--danger)]">{loadError}</div>
            ) : rows === null ? (
              <div className="py-4 text-center text-xs text-[var(--text-3)]">对比谱系中…</div>
            ) : rows.length === 0 ? (
              <div className="py-4 text-center text-xs text-[var(--text-3)]">
                该工作区没有可收编项——canonical skill 均已与库建立谱系(异版更新/回流走 Skills·同步检查)
              </div>
            ) : matched.length === 0 ? (
              <div className="py-4 text-center text-xs text-[var(--text-3)]">无匹配结果</div>
            ) : (
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                {pageRows.map((r) => {
                  const done = results[r.id];
                  return (
                    <div key={r.id} className="flex items-center gap-2 rounded-lg border border-[var(--border-soft)] px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[12px] text-[var(--text)]">{r.id}</div>
                        {r.detail && <div className="truncate text-[10px] text-[var(--text-3)]">{r.detail}</div>}
                        {done && (
                          <div className={"truncate text-[10px] " + (done.ok ? "text-[var(--success)]" : "text-[var(--danger)]")} title={done.message}>
                            {done.message}
                          </div>
                        )}
                      </div>
                      {done?.ok && done.brief && (
                        <button
                          onClick={() => setShowBrief(done.brief ?? null)}
                          className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-2)] hover:bg-[var(--surface)]"
                        >
                          去工程化指令
                        </button>
                      )}
                      <button
                        onClick={() => collect(r.id)}
                        disabled={busyId !== null || batch !== null || done?.ok}
                        className="shrink-0 rounded-md border border-[var(--accent-border)] px-3 py-1 text-[11px] text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-40"
                      >
                        {busyId === r.id ? "收编中…" : done?.ok ? "已入库" : "收编"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <Pager page={page} pageCount={pageCount} onPage={setPage} />
          </>
        )}
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => (collected ? onDone() : onClose())}
            className="rounded-md px-3 py-1 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface)]"
          >
            {collected ? "完成" : "关闭"}
          </button>
        </div>
        {showBrief && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30" onClick={() => setShowBrief(null)}>
            <div
              className="flex max-h-[70vh] w-[560px] max-w-[92vw] flex-col rounded-2xl bg-[var(--elevated)] p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 text-sm font-semibold text-[var(--text)]">去工程化整理指令(可粘贴给 agent 终端)</div>
              <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--surface)] p-3 text-[11px] leading-relaxed text-[var(--text-2)]">
                {showBrief}
              </pre>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(showBrief).catch(() => {})}
                  className="rounded-md border border-[var(--accent-border)] px-3 py-1 text-[12px] text-[var(--accent-text)] hover:bg-[var(--accent-soft)]"
                >
                  复制
                </button>
                <button onClick={() => setShowBrief(null)} className="rounded-md px-3 py-1 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface)]">
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
