// 工作区环境视图(plan-4 Step 5):左侧分类导航(计数/告警徽标) + 分类页路由;
// 选中分类按工作区 wsState 持久化;未初始化 → 初始化引导卡(决策 3A,不读旧路径)。
import { useCallback, useEffect, useMemo, useState } from "react";
import { getWsState, setWsState } from "../../wsState";
import {
  htyenvCheck,
  htyenvCompare,
  htyenvCompletePreview,
  htyenvDashboardData,
  htyenvInitExecute,
  htyenvInitPreview,
  htyenvListBugs,
  htyenvListDebts,
  htyenvListPlans,
  htyenvStatus,
  htyenvSync,
  htyenvWorkspaceSkills,
  type DashboardData,
  type EnvStatus,
  type InitOutcome,
  type InitPreview,
  type LineageReport,
  type SyncReport,
  type WorkspaceSkillInfo,
} from "../../htyenv";
import type { DashWorkspace } from "./DashboardShell";
import OverviewSection from "./sections/OverviewSection";
import MemorySyncSection from "./sections/MemorySyncSection";
import SkillsSection from "./sections/SkillsSection";
import DocListSection from "./sections/DocListSection";
import MemorySection from "./sections/MemorySection";
import CompleteEnvSection from "./sections/CompleteEnvSection";

export type SectionKey =
  | "overview"
  | "envComplete"
  | "memorySync"
  | "skills"
  | "plans"
  | "bugs"
  | "debts"
  | "memory";

const SECTION_KEY = "htybox.envdash.section.v1";
const VALID_SECTIONS = new Set<SectionKey>([
  "overview",
  "envComplete",
  "memorySync",
  "skills",
  "plans",
  "bugs",
  "debts",
  "memory",
]);

function loadSection(wsPath: string): SectionKey {
  const raw = getWsState<string>(SECTION_KEY, wsPath, "overview");
  return VALID_SECTIONS.has(raw as SectionKey) ? (raw as SectionKey) : "overview";
}

export default function WorkspaceEnvView({
  ws,
  libraryDir,
}: {
  ws: DashWorkspace;
  libraryDir: string;
}) {
  const [section, setSection] = useState<SectionKey>(() => loadSection(ws.path));
  const [skillsCheckMode, setSkillsCheckMode] = useState(false);
  const [status, setStatus] = useState<EnvStatus | null>(null);
  const [check, setCheck] = useState<SyncReport | null>(null);
  const [compare, setCompare] = useState<LineageReport | null>(null);
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [skills, setSkills] = useState<WorkspaceSkillInfo[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [completePending, setCompletePending] = useState(0);

  const ready = !!status && status.present && status.manifestPresent && !status.manifestError;

  const reloadAll = useCallback(() => {
    setErrors([]);
    htyenvStatus(ws.path)
      .then((s) => {
        setStatus(s);
        if (!(s.present && s.manifestPresent && !s.manifestError)) {
          setCompletePending(0);
          return;
        }
        const grab = <T,>(p: Promise<T>, set: (v: T) => void, label: string) =>
          p.then(set).catch((e) => setErrors((prev) => [...prev, `${label}:${e}`]));
        grab(htyenvCheck(ws.path), setCheck, "对账");
        grab(htyenvCompare(ws.path, libraryDir), setCompare, "谱系对比");
        grab(htyenvDashboardData(ws.path), setDash, "全景聚合");
        grab(htyenvWorkspaceSkills(ws.path), setSkills, "Skill 清单");
        htyenvCompletePreview(ws.path, libraryDir)
          .then((p) => {
            setCompletePending(
              p.willCreateDirs.length +
                p.willWriteFiles.length +
                p.willWriteNative.length +
                p.willFetchSkills.length,
            );
          })
          .catch(() => setCompletePending(0));
      })
      .catch((e) => setErrors((prev) => [...prev, `环境识别:${e}`]));
  }, [ws.path, libraryDir]);

  useEffect(() => {
    setStatus(null);
    setCheck(null);
    setCompare(null);
    setDash(null);
    setSkills(null);
    setSkillsCheckMode(false);
    setCompletePending(0);
    setSection(loadSection(ws.path));
    reloadAll();
  }, [ws.path, reloadAll]);

  const pick = (key: SectionKey, checkMode?: boolean) => {
    setSection(key);
    if (checkMode !== undefined) setSkillsCheckMode(checkMode);
    setWsState(SECTION_KEY, ws.path, key);
  };

  const mechSync = () => {
    setBusy(true);
    htyenvSync(ws.path)
      .then(setCheck)
      .catch((e) => setErrors((prev) => [...prev, `机械同步:${e}`]))
      .finally(() => {
        setBusy(false);
        reloadAll();
      });
  };
  const recheck = () => {
    setBusy(true);
    htyenvCheck(ws.path)
      .then(setCheck)
      .catch((e) => setErrors((prev) => [...prev, `对账:${e}`]))
      .finally(() => setBusy(false));
  };

  const fetchPlans = useCallback(
    (offset: number, limit: number, query?: string, st?: string) =>
      htyenvListPlans(ws.path, offset, limit, query, st),
    [ws.path],
  );
  const fetchBugs = useCallback(
    (offset: number, limit: number, query?: string) => htyenvListBugs(ws.path, offset, limit, query),
    [ws.path],
  );
  const fetchDebts = useCallback(
    (offset: number, limit: number, query?: string) => htyenvListDebts(ws.path, offset, limit, query),
    [ws.path],
  );

  const memAlert = check ? check.memory.conflicts.length + check.memory.uncurated.length : 0;
  const skillAlert = check
    ? check.adapters.orphanShells.length +
      check.adapters.canonicalMissingEntry.length +
      check.unregistered.length +
      check.ghosts.length
    : 0;

  const sections = useMemo(
    () =>
      [
        { key: "overview" as const, label: "概览" },
        { key: "memorySync" as const, label: "agent记忆同步", alert: memAlert },
        { key: "skills" as const, label: "Skills", count: status?.canonicalSkillDirs, alert: skillAlert },
        { key: "plans" as const, label: "Plans", count: dash?.plans.total },
        { key: "bugs" as const, label: "Bugs", count: dash?.bugs.total },
        { key: "debts" as const, label: "技术债", count: dash?.debts.total },
        { key: "memory" as const, label: "Memory", count: dash?.memory.groups, unit: " 组" },
        { key: "envComplete" as const, label: "环境补全", alert: completePending },
      ] as { key: SectionKey; label: string; count?: number; unit?: string; alert?: number }[],
    [status, dash, memAlert, skillAlert, completePending],
  );

  return (
    <div className="flex h-full gap-4 p-4 pt-0">
      {/* 左侧分类导航(计数 + 告警徽标) */}
      <nav className="flex w-52 shrink-0 flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2">
        {sections.map((s) => (
          <button
            key={s.key}
            onClick={() => pick(s.key)}
            disabled={!ready && s.key !== "overview"}
            className={
              "flex items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors disabled:opacity-40 " +
              (section === s.key
                ? "border border-[var(--accent-border)] bg-[var(--accent-soft)] font-semibold text-[var(--accent-text)]"
                : "text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)]")
            }
          >
            <span>{s.label}</span>
            <span className="flex items-center gap-1.5">
              {s.alert != null && s.alert > 0 && (
                <span className="rounded-full bg-[var(--danger)]/15 px-1.5 py-px text-[9px] font-semibold text-[var(--danger)]">
                  {s.alert}
                </span>
              )}
              {s.count != null && <span className="text-[10px] text-[var(--text-3)]">{s.count}{s.unit ?? ""}</span>}
            </span>
          </button>
        ))}
        {check && (
          <div className="mt-auto px-3 pb-1 text-[9.5px] text-[var(--text-faint)]">
            对账于 {check.generatedAt.slice(5, 16).replace("T", " ")}({check.mode})
          </div>
        )}
      </nav>

      {/* 分类页区 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {errors.length > 0 && (
          <div className="mb-3 rounded-xl border border-[var(--danger)]/50 bg-[var(--danger)]/6 px-4 py-2.5">
            {errors.map((e, i) => (
              <div key={i} className="break-all text-[11px] text-[var(--danger)]">{e}</div>
            ))}
          </div>
        )}
        {!status ? (
          <div className="py-10 text-center text-xs text-[var(--text-3)]">识别环境中…</div>
        ) : !ready ? (
          <InitGuide ws={ws} status={status} libraryDir={libraryDir} onDone={reloadAll} />
        ) : section === "overview" ? (
          <OverviewSection
            status={status}
            check={check}
            compare={compare}
            dash={dash}
            busy={busy}
            onMechSync={mechSync}
            onRecheck={recheck}
            goto={pick}
            reportPath={`${ws.path}/.htyworkflows/agentsSynchronizer/last-sync-report.md`}
          />
        ) : section === "envComplete" ? (
          <CompleteEnvSection
            ws={ws}
            libraryDir={libraryDir}
            onDone={reloadAll}
            onPendingChange={setCompletePending}
          />
        ) : section === "memorySync" ? (
          <MemorySyncSection ws={ws} check={check} busy={busy} onMechSync={mechSync} onRecheck={recheck} />
        ) : section === "skills" ? (
          <SkillsSection
            ws={ws}
            skills={skills}
            check={check}
            compare={compare}
            libraryDir={libraryDir}
            checkMode={skillsCheckMode}
            setCheckMode={setSkillsCheckMode}
            reloadAll={reloadAll}
          />
        ) : section === "plans" ? (
          <DocListSection title="Plans" hasStatus fetchPage={fetchPlans} />
        ) : section === "bugs" ? (
          <DocListSection title="Bugs" hasStatus={false} fetchPage={fetchBugs} />
        ) : section === "debts" ? (
          <DocListSection title="技术债" hasStatus={false} fetchPage={fetchDebts} />
        ) : (
          <MemorySection ws={ws} check={check} />
        )}
      </div>
    </div>
  );
}

/** 初始化引导卡(决策 3A):dry-run 预览三分类清单 → 一键初始化;不读取旧 .claude 路径数据。 */
function InitGuide({
  ws,
  status,
  libraryDir,
  onDone,
}: {
  ws: DashWorkspace;
  status: EnvStatus;
  libraryDir: string;
  onDone: () => void;
}) {
  const [preview, setPreview] = useState<InitPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<InitOutcome | null>(null);

  useEffect(() => {
    let alive = true;
    htyenvInitPreview(ws.path, libraryDir)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [ws.path, libraryDir]);

  const run = () => {
    setRunning(true);
    setError(null);
    htyenvInitExecute(ws.path, libraryDir)
      .then((o) => {
        setOutcome(o);
        onDone();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setRunning(false));
  };

  return (
    <div className="mx-auto max-w-xl rounded-xl border border-[var(--border)] bg-[var(--surface)] px-6 py-5">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full border border-[var(--text-3)]" />
        <span className="text-sm font-bold">
          {status.manifestError ? "hty环境登记损坏" : "未初始化 hty环境"}
        </span>
      </div>
      {status.manifestError ? (
        <div className="mt-2 break-all text-[11px] text-[var(--danger)]">
          {status.manifestError}——请先人工修复 workflow-manifest.json(初始化不会覆盖既有文件)
        </div>
      ) : (
        <>
          <div className="mt-2 text-[11.5px] leading-relaxed text-[var(--text-2)]">
            初始化将在本工程创建 .htyworkflows 唯一真源结构(幂等只增不覆),生成 native
            薄引导并纳入保护基线,再从全局权威库取件已有 skill。
          </div>
          {error && <div className="mt-2 break-all text-[11px] text-[var(--danger)]">{error}</div>}
          {!preview ? (
            <div className="mt-3 text-[11px] text-[var(--text-3)]">生成预览中…</div>
          ) : (
            <div className="mt-3 space-y-1.5 rounded-lg bg-[var(--elevated)] px-3.5 py-3 text-[11px] text-[var(--text-2)]">
              <div>将创建目录 {preview.willCreateDirs.length} 个 · 写入治理/脚本文件 {preview.willWriteFiles.length} 个</div>
              <div>
                native 薄引导:新生成 {preview.willWriteNative.length} 个
                {preview.nativeManual.length > 0 && (
                  <span className="text-[var(--accent-text)]">
                    ;已存在 {preview.nativeManual.length} 个({preview.nativeManual.join("、")})绝不改动,初始化后按提示人工接线
                  </span>
                )}
              </div>
              <div>
                全局库:
                {preview.library.present
                  ? `已有(${preview.library.skillCount ?? 0} 个 skill),将取件 ${preview.willFetchSkills.length} 个`
                  : "尚未建立,初始化时自动建库(含内置种子 skill)"}
              </div>
              {preview.skippedExisting.length > 0 && (
                <div className="text-[var(--text-3)]">已存在跳过 {preview.skippedExisting.length} 项(接管态不覆盖)</div>
              )}
            </div>
          )}
          {outcome ? (
            <div className="mt-3 rounded-lg border border-[var(--success)]/40 bg-[var(--success)]/8 px-3.5 py-2.5 text-[11px] text-[var(--success)]">
              初始化完成:目录 {outcome.createdDirs} · 文件 {outcome.writtenFiles.length} · native {outcome.writtenNative.length} · 取件{" "}
              {outcome.fetchedSkills.length} · 薄壳 {outcome.writtenAdapters}
              {outcome.nativeManual.length > 0 && (
                <div className="mt-1 text-[var(--accent-text)]">
                  人工接线:{outcome.nativeManual.join("、")} 已存在未动,请把 .htyworkflows/rules/ 指引接入其中
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={run}
              disabled={running || !preview}
              className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {running ? "初始化中…" : "初始化 hty环境"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
