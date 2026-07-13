// 概览页(mockup envdash-workspace-env):环境状态卡 + 与全局权威环境摘要 + 分类统计 + 最近动向。
import { useState } from "react";
import type { DashboardData, EnvStatus, LineageReport, SyncReport } from "../../../htyenv";
import type { SectionKey } from "../WorkspaceEnvView";
import { PreviewModal, fmtUtc } from "./shared";

export default function OverviewSection({
  status,
  check,
  compare,
  dash,
  busy,
  onMechSync,
  onRecheck,
  goto: gotoSection,
  reportPath,
}: {
  status: EnvStatus;
  check: SyncReport | null;
  compare: LineageReport | null;
  dash: DashboardData | null;
  busy: boolean;
  onMechSync: () => void;
  onRecheck: () => void;
  goto: (s: SectionKey, checkMode?: boolean) => void;
  reportPath: string;
}) {
  const [showReport, setShowReport] = useState(false);
  const verify = check?.verify;
  const memory = check?.memory;
  const lineageCount = (state: string) =>
    compare?.skills.filter((s) => s.state === state).length ?? 0;
  const actionable = (compare?.skills ?? [])
    .filter((s) => s.state === "libraryAhead" || s.state === "diverged")
    .slice(0, 2);

  const statCards: { key: SectionKey; label: string; value: string; note?: string; alert?: boolean }[] = [
    {
      key: "plans",
      label: "Plans",
      value: String(dash?.plans.total ?? "-"),
      note:
        dash && dash.plans.parseFailures > 0
          ? `解析失败 ${dash.plans.parseFailures} 项(分类页可见)`
          : dash?.plans.recent[0]
            ? `${dash.plans.recent[0].date ?? ""} ${dash.plans.recent[0].name}`
            : "暂无",
      alert: !!dash && dash.plans.parseFailures > 0,
    },
    {
      key: "bugs",
      label: "Bugs",
      value: String(dash?.bugs.total ?? "-"),
      note: dash?.bugs.recent[0]?.name ?? "暂无",
    },
    {
      key: "debts",
      label: "技术债",
      value: String(dash?.debts.total ?? "-"),
      note: dash?.debts.recent[0]?.name ?? "暂无",
    },
    {
      key: "memory",
      label: "Memory",
      value: dash?.memory.present ? `${dash.memory.groups} 组` : "未建",
      note:
        memory && memory.conflicts.length + memory.uncurated.length > 0
          ? `待裁决 ${memory.conflicts.length + memory.uncurated.length}(CONFLICT ${memory.conflicts.length})`
          : `${dash?.memory.files ?? 0} 个文件`,
      alert: !!memory && memory.conflicts.length + memory.uncurated.length > 0,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        {/* 环境状态卡 */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--success)]" />
            <span className="text-sm font-bold">hty环境已就绪</span>
            {status.schemaVersion != null && (
              <span className="ml-auto rounded-md border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text-2)]">
                schemaVersion {status.schemaVersion}
              </span>
            )}
          </div>
          <div className="mt-3 space-y-2 text-[12px]">
            <Row k="Skill(canonical)" v={`${status.canonicalSkillDirs ?? 0} · 登记 ${status.registeredSkills ?? 0}`} />
            <Row
              k="Providers 名册"
              v={
                status.roster
                  ? `${status.roster.providers.join(" · ")}(三方${status.roster.consistent ? "一致 ✓" : "不一致 ⚠"})`
                  : "-"
              }
              danger={status.roster ? !status.roster.consistent : false}
            />
            <Row
              k="verify 综合校验"
              v={verify ? `${verify.checks.filter((c) => c.passed).length}/${verify.checks.length} 通过${verify.allPassed ? " ✓" : " ⚠"}` : "对账中…"}
              danger={verify ? !verify.allPassed : false}
            />
            <Row
              k="记忆单向收敛"
              v={
                memory
                  ? `同步 ${memory.same} · 待补齐 ${memory.filled.length}` +
                    (memory.conflicts.length + memory.uncurated.length > 0
                      ? ` · 待裁决 ${memory.conflicts.length + memory.uncurated.length}`
                      : "")
                  : "对账中…"
              }
              danger={!!memory && memory.conflicts.length + memory.uncurated.length > 0}
            />
          </div>
          <div className="mt-3.5 flex gap-2">
            <button
              onClick={onMechSync}
              disabled={busy}
              className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "执行中…" : "机械同步"}
            </button>
            <button
              onClick={onRecheck}
              disabled={busy}
              className="rounded-lg border border-[var(--border)] px-3.5 py-1.5 text-[12px] text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] disabled:opacity-50"
            >
              只检查
            </button>
            <button
              onClick={() => setShowReport(true)}
              className="rounded-lg border border-[var(--border)] px-3.5 py-1.5 text-[12px] text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)]"
            >
              查看报告
            </button>
          </div>
        </div>

        {/* 与全局权威环境摘要卡 */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
          <div className="text-[13px] font-bold">与全局权威环境</div>
          {!compare ? (
            <div className="mt-3 text-[11px] text-[var(--text-3)]">谱系对比中…</div>
          ) : !compare.library.present ? (
            <div className="mt-3 text-[11px] text-[var(--text-3)]">
              全局权威库尚未建立——收编任一 skill 或初始化任一工程即自动建库
            </div>
          ) : (
            <>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <Chip label={`最新 ${lineageCount("upToDate")}`} tone="gray" />
                <Chip label={`可更新 ${lineageCount("libraryAhead")}`} tone="accent" />
                <Chip label={`可回流 ${lineageCount("workspaceAhead")}`} tone="ok" />
                <Chip label={`冲突 ${lineageCount("diverged")}`} tone="err" />
                <Chip label={`未关联 ${lineageCount("untracked")}`} tone="gray" />
              </div>
              <div className="mt-3 space-y-2 border-t border-[var(--border-soft)] pt-3">
                {actionable.length === 0 ? (
                  <div className="text-[11px] text-[var(--text-3)]">暂无可更新/冲突项</div>
                ) : (
                  actionable.map((s) => (
                    <div key={s.id} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{s.id}</span>
                      <span className={"text-[11px] " + (s.state === "diverged" ? "text-[var(--danger)]" : "text-[var(--text-3)]")}>
                        {s.state === "diverged" ? "双侧演进 · 冲突" : "库前进 · 可更新"}
                      </span>
                      <button
                        onClick={() => gotoSection("skills", true)}
                        className={
                          "rounded-md border px-3 py-1 text-[11px] transition-colors " +
                          (s.state === "diverged"
                            ? "border-[var(--danger)]/60 text-[var(--danger)] hover:bg-[var(--danger)]/10"
                            : "border-[var(--accent-border)] text-[var(--accent-text)] hover:bg-[var(--accent-soft)]")
                        }
                      >
                        {s.state === "diverged" ? "裁决" : "更新"}
                      </button>
                    </div>
                  ))
                )}
              </div>
              <button
                onClick={() => gotoSection("skills", true)}
                className="mt-3 text-[11px] text-[var(--accent-text)] hover:underline"
              >
                skill 同步详情与批量操作 → Skills ·「同步检查」
              </button>
            </>
          )}
        </div>
      </div>

      {/* 分类统计卡(点击跳分类页) */}
      <div className="grid grid-cols-4 gap-4">
        {statCards.map((c) => (
          <button
            key={c.key}
            onClick={() => gotoSection(c.key)}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 text-left transition-colors hover:border-[var(--accent-border)]"
          >
            <div className="text-[11px] text-[var(--text-3)]">{c.label}</div>
            <div className="mt-1.5 text-xl font-bold">{c.value}</div>
            <div
              className={"mt-1 truncate text-[10px] " + (c.alert ? "text-[var(--danger)]" : "text-[var(--text-3)]")}
              title={c.note}
            >
              {c.note}
            </div>
            <div className="mt-2 text-[11px] text-[var(--accent-text)]">查看 →</div>
          </button>
        ))}
      </div>

      {/* 最近动向(真实数据:最近机械同步 + 最近 plans) */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
        <div className="text-[13px] font-bold">最近动向</div>
        <div className="mt-2.5 space-y-2">
          {dash?.lastSync && (
            <div className="flex gap-3 text-[11px]">
              <span className="shrink-0 font-mono text-[10px] text-[var(--text-3)]">{fmtUtc(dash.lastSync.modifiedUtc)}</span>
              <span className="truncate text-[var(--text-2)]">
                机械同步报告:{dash.lastSync.headline?.replace(/^#+\s*/, "") ?? "(无结论行)"}
              </span>
            </div>
          )}
          {(dash?.plans.recent ?? []).slice(0, 4).map((p) => (
            <div key={p.path} className="flex gap-3 text-[11px]">
              <span className="shrink-0 font-mono text-[10px] text-[var(--text-3)]">{p.date ?? "-"}</span>
              <span className="truncate text-[var(--text-2)]" title={p.name}>
                plan「{p.name}」{p.status ? ` · ${p.status}` : ""}
              </span>
            </div>
          ))}
          {!dash?.lastSync && (dash?.plans.recent ?? []).length === 0 && (
            <div className="text-[11px] text-[var(--text-3)]">暂无动向(未跑过机械同步,plans 为空)</div>
          )}
        </div>
      </div>

      {showReport && <PreviewModal path={reportPath} onClose={() => setShowReport(false)} />}
    </div>
  );
}

function Row({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-[var(--text-3)]">{k}</span>
      <span className={"truncate text-right " + (danger ? "text-[var(--danger)]" : "text-[var(--text)]")}>{v}</span>
    </div>
  );
}

function Chip({ label, tone }: { label: string; tone: "gray" | "accent" | "ok" | "err" }) {
  const cls = {
    gray: "border-[var(--border)] text-[var(--text-2)]",
    accent: "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent-text)]",
    ok: "border-[var(--success)]/50 bg-[var(--success)]/10 text-[var(--success)]",
    err: "border-[var(--danger)]/50 bg-[var(--danger)]/10 text-[var(--danger)]",
  }[tone];
  return <span className={"rounded-full border px-2.5 py-0.5 text-[10px] " + cls}>{label}</span>;
}
