// 环境补全分类页:已就绪工作区的补缺入口(可扩展多项补全)。
// 当前首项=标准结构与库种子;契约与 init 相同(只增不覆,不改已有 native)。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  htyenvCompleteExecute,
  htyenvCompletePreview,
  type InitOutcome,
  type InitPreview,
} from "../../../htyenv";
import type { DashWorkspace } from "../DashboardShell";

export default function CompleteEnvSection({
  ws,
  libraryDir,
  onDone,
  onPendingChange,
}: {
  ws: DashWorkspace;
  libraryDir: string;
  onDone: () => void;
  onPendingChange?: (pending: number) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
        <div className="text-[13px] font-bold">环境补全</div>
        <div className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-2)]">
          针对已就绪工程，按项补齐缺失的标准结构与数据（HtyBox 升级后的新目录、治理文件、库内新种子
          skill 等）。已有文件一律不覆盖；未初始化请先走概览「初始化」。后续可在此页继续增加更多补全项。
        </div>
      </div>

      <StandardEnvCompleteCard
        ws={ws}
        libraryDir={libraryDir}
        onDone={onDone}
        onPendingChange={onPendingChange}
      />
    </div>
  );
}

/** 补全项 #1:标准 .htyworkflows 结构 + 全局库种子取件 + 薄壳重生。 */
function StandardEnvCompleteCard({
  ws,
  libraryDir,
  onDone,
  onPendingChange,
}: {
  ws: DashWorkspace;
  libraryDir: string;
  onDone: () => void;
  onPendingChange?: (pending: number) => void;
}) {
  const [preview, setPreview] = useState<InitPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<InitOutcome | null>(null);
  const [scanKey, setScanKey] = useState(0);

  const scan = useCallback(() => {
    setPreview(null);
    setError(null);
    setOutcome(null);
    setScanKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError(null);
    htyenvCompletePreview(ws.path, libraryDir)
      .then((p) => {
        if (!alive) return;
        setPreview(p);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [ws.path, libraryDir, scanKey]);

  const pending = useMemo(() => {
    if (!preview) return 0;
    return (
      preview.willCreateDirs.length +
      preview.willWriteFiles.length +
      preview.willWriteNative.length +
      preview.willFetchSkills.length
    );
  }, [preview]);

  useEffect(() => {
    onPendingChange?.(error ? 0 : pending);
  }, [pending, error, onPendingChange]);

  const run = () => {
    setRunning(true);
    setError(null);
    htyenvCompleteExecute(ws.path, libraryDir)
      .then((o) => {
        setOutcome(o);
        onDone();
        setScanKey((k) => k + 1);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setRunning(false));
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-bold">标准结构与库种子</span>
            {preview && pending > 0 && (
              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-px text-[10px] font-semibold text-[var(--accent-text)]">
                待补 {pending}
              </span>
            )}
            {preview && pending === 0 && !error && (
              <span className="rounded-full bg-[var(--success)]/12 px-2 py-px text-[10px] font-semibold text-[var(--success)]">
                已完整
              </span>
            )}
          </div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-2)]">
            补齐缺失的目录与治理/脚本文件；从全局权威库取件尚未下发的 skill（含升级后的内置种子）；必要时生成
            native 薄引导并重生薄壳。
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={scan}
            disabled={running}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] disabled:opacity-50"
          >
            重新扫描
          </button>
          <button
            onClick={run}
            disabled={running || !preview || pending === 0}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {running ? "补全中…" : "执行补全"}
          </button>
        </div>
      </div>

      {error && <div className="mt-3 break-all text-[11px] text-[var(--danger)]">{error}</div>}

      {!preview && !error ? (
        <div className="mt-3 text-[11px] text-[var(--text-3)]">扫描缺失项…</div>
      ) : preview ? (
        <div className="mt-3 space-y-1.5 rounded-lg bg-[var(--elevated)] px-3.5 py-3 text-[11px] text-[var(--text-2)]">
          {pending === 0 ? (
            <div className="text-[var(--success)]">无需补全：目录、治理文件与库 skill 均已到位</div>
          ) : (
            <>
              <div>
                将补目录 {preview.willCreateDirs.length}
                {preview.willCreateDirs.length > 0 && (
                  <span className="text-[var(--text-3)]">
                    {" "}
                    ({preview.willCreateDirs.slice(0, 4).join(", ")}
                    {preview.willCreateDirs.length > 4 ? "…" : ""})
                  </span>
                )}
              </div>
              <div>
                将写治理/脚本文件 {preview.willWriteFiles.length}
                {preview.willWriteNative.length > 0 && ` · native 薄引导 ${preview.willWriteNative.length}`}
              </div>
              <div>
                将取件 skill {preview.willFetchSkills.length}
                {preview.willFetchSkills.length > 0 && (
                  <span className="text-[var(--text-3)]">
                    {" "}
                    ({preview.willFetchSkills.slice(0, 8).join(", ")}
                    {preview.willFetchSkills.length > 8 ? "…" : ""})
                  </span>
                )}
              </div>
              {preview.nativeManual.length > 0 && (
                <div className="text-[var(--accent-text)]">
                  native 已存在不改动: {preview.nativeManual.join("、")}
                </div>
              )}
              {preview.skippedExisting.length > 0 && (
                <div className="text-[var(--text-3)]">已存在跳过 {preview.skippedExisting.length} 项</div>
              )}
            </>
          )}
        </div>
      ) : null}

      {outcome && (
        <div className="mt-3 rounded-lg border border-[var(--success)]/40 bg-[var(--success)]/8 px-3.5 py-2.5 text-[11px] text-[var(--success)]">
          上次补全:目录 {outcome.createdDirs} · 文件 {outcome.writtenFiles.length} · native{" "}
          {outcome.writtenNative.length} · 取件 {outcome.fetchedSkills.length} · 薄壳{" "}
          {outcome.writtenAdapters}
          {outcome.fetchedSkills.length > 0 && (
            <div className="mt-1 text-[var(--text-2)]">新取件: {outcome.fetchedSkills.join(", ")}</div>
          )}
        </div>
      )}
    </div>
  );
}
