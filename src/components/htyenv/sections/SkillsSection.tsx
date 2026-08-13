// Skills 分类页(用户第三轮反馈定形):常态=以 .htyworkflows 真版为扫描权威,每行真版有无 +
// 各 agent 薄壳入口图标(实心=有/虚线空心=无),缺真版孤儿壳=醒目错误行;
// 页头「同步检查」切换检查态(再点退出)=薄壳对账 + UNREGISTERED/GHOST + 与全局库五态及批量操作。
import { useMemo, useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  htyenvConflictBrief,
  htyenvUpdateFromLibrary,
  htyenvBackflowToLibrary,
  type AdapterState,
  type LineageState,
  type LineageReport,
  type SyncOpResult,
  type SyncReport,
  type WorkspaceSkillInfo,
} from "../../../htyenv";
import type { DashWorkspace } from "../DashboardShell";
import { InjectModal, Pager, slugify } from "./shared";

/** 每页条数(数据量大走分页,不靠长滚动条——用户定稿纪律) */
const PAGE_SIZE = 20;

const AGENTS: { key: string; label: string; color: string }[] = [
  { key: "claude", label: "claude(.claude)", color: "#d97757" },
  { key: "codex", label: "codex/OpenCode(.agents)", color: "#10a37f" },
  { key: "cursor", label: "cursor(.cursor)", color: "#8a92a3" },
];

const STATE_LABEL: Record<LineageState, string> = {
  untracked: "未关联",
  upToDate: "最新",
  libraryAhead: "可更新",
  workspaceAhead: "可回流",
  diverged: "冲突",
};

/** 薄壳入口图标:实心圆=有薄壳(一致/陈旧/手改),虚线空心=无;title 带状态明细 */
function AgentDot({ color, state, label }: { color: string; state?: AdapterState; label: string }) {
  const has = state === "consistent" || state === "stale" || state === "handEdited";
  const detail =
    state === "consistent" ? "一致" : state === "stale" ? "陈旧" : state === "handEdited" ? "手改" : "无薄壳";
  return (
    <span
      title={`${label}:${detail}`}
      className="inline-block h-3 w-3 rounded-full"
      style={
        has
          ? { background: color, opacity: state === "consistent" ? 1 : 0.55 }
          : { border: "1.5px dashed var(--text-3)", opacity: 0.7 }
      }
    />
  );
}

export default function SkillsSection({
  ws,
  skills,
  check,
  compare,
  libraryDir,
  checkMode,
  setCheckMode,
  reloadAll,
}: {
  ws: DashWorkspace;
  skills: WorkspaceSkillInfo[] | null;
  check: SyncReport | null;
  compare: LineageReport | null;
  libraryDir: string;
  checkMode: boolean;
  setCheckMode: (v: boolean) => void;
  reloadAll: () => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, SyncOpResult>>({});
  const [inject, setInject] = useState<{ title: string; text: string } | null>(null);
  const [confirmForce, setConfirmForce] = useState<{ id: string; direction: "update" | "backflow" } | null>(null);

  const adapterById = useMemo(() => {
    const m = new Map<string, Record<string, AdapterState>>();
    for (const s of check?.adapters.skills ?? []) m.set(s.id, s.states);
    return m;
  }, [check]);
  const lineageById = useMemo(() => {
    const m = new Map<string, LineageReport["skills"][number]>();
    for (const s of compare?.skills ?? []) m.set(s.id, s);
    return m;
  }, [compare]);
  const providers = check?.roster.providers ?? ["claude", "codex"];

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (skills ?? []).filter(
      (s) => !q || s.id.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
    );
  }, [skills, search]);
  const orphans = check?.adapters.orphanShells ?? [];
  const missingEntry = check?.adapters.canonicalMissingEntry ?? [];
  const libraryAheadIds = (compare?.skills ?? []).filter((s) => s.state === "libraryAhead").map((s) => s.id);

  const runBatch = (op: Promise<SyncOpResult[]>) => {
    setBusy(true);
    setOpError(null);
    op.then((list) => {
      setResults((prev) => {
        const next = { ...prev };
        for (const r of list) next[r.id] = r;
        return next;
      });
      const failed = list.filter((r) => r.error);
      if (failed.length > 0) setOpError(`${failed.length} 项未执行:${failed.map((f) => f.id).join("、")}(逐行看原因)`);
    })
      .catch((e) => setOpError(String(e)))
      .finally(() => {
        setBusy(false);
        reloadAll();
      });
  };

  const openConflictBrief = (id: string) => {
    htyenvConflictBrief(ws.path, id, libraryDir)
      .then((text) => setInject({ title: `「${id}」冲突裁决指令 → 注入 agent 终端`, text }))
      .catch((e) => setOpError(String(e)));
  };

  const orphanBrief = (provider: string, id: string) => {
    const shellRoot = provider === "codex" ? ".agents" : "." + provider;
    return [
      `工作区「${ws.name}」发现孤儿薄壳(有壳无真版),请人工决断:`,
      `- 薄壳: ${ws.path}/${shellRoot}/skills/${id}/SKILL.md`,
      `- 真版应在: ${ws.path}/.htyworkflows/skills/${id}/SKILL.md(当前缺失)`,
      "- 处置(二选一): ①这是有价值的 skill → 以薄壳 frontmatter 为线索补建真版目录,再跑机械同步重生成薄壳;",
      "  ②这是残留 → 直接删除薄壳目录。",
      "- 完成后在 HtyBox 重跑「同步检查」确认无孤儿。",
    ].join("\n");
  };

  return (
    <div className="space-y-3">
      {/* 页头:计数 + 搜索 + 同步检查切换 */}
      <div className="flex items-center gap-3">
        <span className="text-[13px] font-bold">
          Skills({rows.length}){checkMode && <span className="ml-2 text-[11px] font-normal text-[var(--accent-text)]">同步检查态</span>}
        </span>
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="搜索 skill…"
          className="ml-auto w-56 rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-1.5 text-[11px] text-[var(--text)] placeholder:text-[var(--text-3)] focus:border-[var(--accent-border)] focus:outline-none"
        />
        {checkMode && libraryAheadIds.length > 0 && (
          <button
            onClick={() => runBatch(htyenvUpdateFromLibrary(ws.path, libraryAheadIds, false, libraryDir))}
            disabled={busy}
            className="rounded-lg border border-[var(--accent-border)] px-3 py-1.5 text-[11px] font-semibold text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-50"
          >
            全部更新({libraryAheadIds.length})
          </button>
        )}
        <button
          onClick={() => setCheckMode(!checkMode)}
          className={
            "rounded-lg px-3.5 py-1.5 text-[12px] font-semibold transition-colors " +
            (checkMode
              ? "border border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent-text)]"
              : "bg-[var(--accent)] text-white hover:opacity-90")
          }
        >
          {checkMode ? "退出同步检查" : "同步检查"}
        </button>
      </div>
      {opError && <div className="break-all text-[11px] text-[var(--danger)]">{opError}</div>}

      {/* 缺真版错误区(常态/检查态都醒目展示,用户要求) */}
      {(orphans.length > 0 || missingEntry.length > 0) && (
        <div className="rounded-xl border border-[var(--danger)]/50 bg-[var(--danger)]/6 px-4 py-3">
          <div className="text-[12px] font-bold text-[var(--danger)]">
            缺真版({orphans.length + missingEntry.length})——只有薄壳/登记而无 canonical 实体
          </div>
          <div className="mt-1.5 space-y-1">
            {orphans.map((o) => (
              <div key={o.provider + o.id} className="flex items-center gap-2 text-[11px]">
                <span className="rounded bg-[var(--danger)]/15 px-1.5 py-px text-[9px] font-semibold text-[var(--danger)]">
                  孤儿薄壳
                </span>
                <span className="font-mono text-[var(--text-2)]">{o.id}</span>
                <span className="text-[var(--text-3)]">({o.provider} 侧有壳,真版缺失)</span>
                <button
                  onClick={() => setInject({ title: `孤儿薄壳「${o.id}」处置指令`, text: orphanBrief(o.provider, o.id) })}
                  className="ml-auto rounded-md border border-[var(--danger)]/60 px-2.5 py-0.5 text-[10px] text-[var(--danger)] hover:bg-[var(--danger)]/10"
                >
                  处理…
                </button>
              </div>
            ))}
            {missingEntry.map((id) => (
              <div key={id} className="flex items-center gap-2 text-[11px]">
                <span className="rounded bg-[var(--danger)]/15 px-1.5 py-px text-[9px] font-semibold text-[var(--danger)]">
                  缺 SKILL.md
                </span>
                <span className="font-mono text-[var(--text-2)]">{id}</span>
                <span className="text-[var(--text-3)]">canonical 目录在但入口文件缺失</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* UNREGISTERED / GHOST(检查态) */}
      {checkMode && check && (check.unregistered.length > 0 || check.ghosts.length > 0) && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <div className="text-[12px] font-bold">登记对账</div>
          <div className="mt-1.5 space-y-1 text-[11px]">
            {check.unregistered.map((id) => (
              <div key={"u" + id} className="flex gap-2">
                <span className="rounded bg-[var(--accent-soft)] px-1.5 py-px text-[9px] font-semibold text-[var(--accent-text)]">UNREGISTERED</span>
                <span className="font-mono text-[var(--text-2)]">{id}</span>
                <span className="text-[var(--text-3)]">canonical 有而登记无 → 「机械同步」补登</span>
              </div>
            ))}
            {check.ghosts.map((id) => (
              <div key={"g" + id} className="flex gap-2">
                <span className="rounded bg-[var(--danger)]/15 px-1.5 py-px text-[9px] font-semibold text-[var(--danger)]">GHOST</span>
                <span className="font-mono text-[var(--text-2)]">{id}</span>
                <span className="text-[var(--text-3)]">登记有而 canonical 无 → 人工决议后清账</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* skill 列表(分页,不靠长滚动条) */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        {skills === null ? (
          <div className="py-8 text-center text-xs text-[var(--text-3)]">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-xs text-[var(--text-3)]">
            {skills.length === 0 ? "canonical 尚无 skill" : "无匹配结果"}
          </div>
        ) : (
          rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((s) => {
            const states = adapterById.get(s.id);
            const lin = lineageById.get(s.id);
            const r = results[s.id];
            return (
              <div key={s.id} className="flex items-center gap-3 border-b border-[var(--border-soft)] py-2 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[12.5px] text-[var(--text)]">{s.id}</span>
                    <span className="shrink-0 rounded bg-[var(--success)]/12 px-1.5 py-px text-[9px] text-[var(--success)]">真版 ✓</span>
                  </div>
                  <div className="truncate text-[10.5px] text-[var(--text-3)]" title={s.description}>
                    {s.description ?? "(无描述)"}
                  </div>
                  {r && (
                    <div className={"truncate text-[10px] " + (r.error ? "text-[var(--danger)]" : "text-[var(--success)]")} title={r.error ?? r.status}>
                      {r.error ?? `✓ ${r.status}`}
                    </div>
                  )}
                </div>
                <span className="flex shrink-0 items-center gap-1.5">
                  {AGENTS.map((a) => (
                    <AgentDot key={a.key} color={a.color} state={states?.[a.key]} label={a.label} />
                  ))}
                </span>
                {checkMode && (
                  <>
                    <span className="w-40 shrink-0">
                      {states && (
                        <span className="flex flex-wrap gap-1">
                          {providers.map((p) => {
                            const st = states[p];
                            const tone =
                              st === "consistent"
                                ? "text-[var(--success)] border-[var(--success)]/40"
                                : st === "missing"
                                  ? "text-[var(--text-3)] border-[var(--border)]"
                                  : "text-[var(--danger)] border-[var(--danger)]/40";
                            const label = st === "consistent" ? "一致" : st === "stale" ? "陈旧" : st === "handEdited" ? "手改" : "缺失";
                            return (
                              <span key={p} className={"rounded border px-1.5 py-px text-[9px] " + tone}>
                                {p} {label}
                              </span>
                            );
                          })}
                        </span>
                      )}
                    </span>
                    <span className="w-16 shrink-0">
                      {lin && (
                        <span
                          className={
                            "rounded-full border px-2 py-0.5 text-[10px] " +
                            (lin.state === "diverged"
                              ? "border-[var(--danger)]/50 text-[var(--danger)]"
                              : lin.state === "libraryAhead"
                                ? "border-[var(--accent-border)] text-[var(--accent-text)]"
                                : lin.state === "workspaceAhead"
                                  ? "border-[var(--success)]/50 text-[var(--success)]"
                                  : "border-[var(--border)] text-[var(--text-3)]")
                          }
                          title={lin.detail}
                        >
                          {STATE_LABEL[lin.state]}
                        </span>
                      )}
                    </span>
                    <span className="flex w-32 shrink-0 justify-end gap-1">
                      {lin?.state === "libraryAhead" && (
                        <button
                          onClick={() => runBatch(htyenvUpdateFromLibrary(ws.path, [s.id], false, libraryDir))}
                          disabled={busy}
                          className="rounded-md border border-[var(--accent-border)] px-2.5 py-0.5 text-[10px] text-[var(--accent-text)] hover:bg-[var(--accent-soft)] disabled:opacity-40"
                        >
                          更新
                        </button>
                      )}
                      {lin?.state === "workspaceAhead" && (
                        <button
                          onClick={() => runBatch(htyenvBackflowToLibrary(ws.path, [s.id], false, libraryDir))}
                          disabled={busy}
                          className="rounded-md border border-[var(--success)]/50 px-2.5 py-0.5 text-[10px] text-[var(--success)] hover:bg-[var(--success)]/10 disabled:opacity-40"
                        >
                          回流
                        </button>
                      )}
                      {(lin?.state === "diverged" || (lin?.state === "untracked" && lin.libSha)) && (
                        <>
                          <button
                            onClick={() => openConflictBrief(s.id)}
                            disabled={busy}
                            className="rounded-md border border-[var(--danger)]/60 px-2.5 py-0.5 text-[10px] text-[var(--danger)] hover:bg-[var(--danger)]/10 disabled:opacity-40"
                          >
                            裁决
                          </button>
                          <button
                            onClick={() => setConfirmForce({ id: s.id, direction: "update" })}
                            disabled={busy}
                            title="裁决结论=以库为准时落地"
                            className="rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-3)] hover:bg-[var(--elevated)] disabled:opacity-40"
                          >
                            以库
                          </button>
                          <button
                            onClick={() => setConfirmForce({ id: s.id, direction: "backflow" })}
                            disabled={busy}
                            title="裁决结论=以工程为准时落地"
                            className="rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-3)] hover:bg-[var(--elevated)] disabled:opacity-40"
                          >
                            以工程
                          </button>
                        </>
                      )}
                    </span>
                  </>
                )}
              </div>
            );
          })
        )}
        <Pager page={page} pageCount={Math.max(1, Math.ceil(rows.length / PAGE_SIZE))} onPage={setPage} />
      </div>

      {inject && (
        <InjectModal wsId={slugify(ws.path)} text={inject.text} title={inject.title} onClose={() => setInject(null)} />
      )}
      {confirmForce && (
        <ConfirmModal
          title={confirmForce.direction === "update" ? `以库为准覆盖工程「${confirmForce.id}」?` : `以工程为准覆盖库「${confirmForce.id}」?`}
          message={
            confirmForce.direction === "update"
              ? "裁决落地:工程 canonical 将被库版本整树覆盖(含资源文件),薄壳随之重生成。请确认已完成语义裁决。"
              : "裁决落地:库版本将被工程 canonical 整树覆盖并追加版本链。其他工作区此后可从库更新。请确认已完成语义裁决。"
          }
          confirmText="确认落地"
          onConfirm={() =>
            runBatch(
              confirmForce.direction === "update"
                ? htyenvUpdateFromLibrary(ws.path, [confirmForce.id], true, libraryDir)
                : htyenvBackflowToLibrary(ws.path, [confirmForce.id], true, libraryDir),
            )
          }
          onClose={() => setConfirmForce(null)}
        />
      )}
    </div>
  );
}
