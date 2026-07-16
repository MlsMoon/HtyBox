// 环境补全分类页:三卡分离——① 标准结构与库种子(补缺)② 官方文件更新(谱系式基线三态)
// ③ 内置种子更新(复用谱系)。补缺 + cleanOutdated 安全更新经同一 complete_execute([]) 落地(均不动用户内容);
// diverged 覆盖走逐项确认弹窗(危险操作,默认全不勾)。契约见 htyenv::init / managed。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  htyenvCompare,
  htyenvCompleteExecute,
  htyenvCompletePreview,
  htyenvManagedMergeBrief,
  htyenvManagedReconcile,
  htyenvUpdateFromLibrary,
  type InitOutcome,
  type InitPreview,
  type LineageReport,
} from "../../../htyenv";
import type { DashWorkspace } from "../DashboardShell";
import { useMaskDismiss } from "../../ui/maskDismiss";
import { InjectModal, slugify } from "./shared";

const PILL = "rounded-full px-2 py-px text-[10px] font-semibold";
const BTN_GHOST =
  "rounded-lg border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] disabled:opacity-50";
const BTN_PRIMARY =
  "rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50";

export default function CompleteEnvSection({
  ws,
  libraryDir,
  onDone,
  onPendingChange,
  onGotoSkills,
}: {
  ws: DashWorkspace;
  libraryDir: string;
  onDone: () => void;
  onPendingChange?: (pending: number) => void;
  onGotoSkills?: () => void;
}) {
  const [preview, setPreview] = useState<InitPreview | null>(null);
  const [compare, setCompare] = useState<LineageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<InitOutcome | null>(null);
  const [scanKey, setScanKey] = useState(0);
  const [divergedModal, setDivergedModal] = useState(false);
  const [inject, setInject] = useState<{ title: string; text: string } | null>(null);

  const rescan = useCallback(() => {
    setOutcome(null);
    setScanKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setCompare(null);
    setError(null);
    htyenvCompletePreview(ws.path, libraryDir)
      .then((p) => alive && setPreview(p))
      .catch((e) => {
        if (alive) {
          setError(String(e));
          setPreview(null);
        }
      });
    // 种子聚合失败不阻塞主卡(库不可用等)
    htyenvCompare(ws.path, libraryDir)
      .then((c) => alive && setCompare(c))
      .catch(() => alive && setCompare(null));
    return () => {
      alive = false;
    };
  }, [ws.path, libraryDir, scanKey]);

  const replenish = useMemo(() => {
    if (!preview) return 0;
    return (
      preview.willCreateDirs.length +
      preview.willWriteFiles.length +
      preview.willWriteNative.length +
      preview.willFetchSkills.length
    );
  }, [preview]);
  const updatable = preview?.willUpdateFiles ?? [];
  const diverged = preview?.divergedFiles ?? [];
  const reconciled = preview?.reconciledFiles ?? [];
  const seedUpdates = useMemo(
    () => (compare?.skills ?? []).filter((s) => s.bundled && s.state === "libraryAhead"),
    [compare],
  );

  useEffect(() => {
    onPendingChange?.(error ? 0 : replenish + updatable.length + diverged.length);
  }, [replenish, updatable.length, diverged.length, error, onPendingChange]);

  // 补缺 + 全部 cleanOutdated 安全更新(不动用户内容);confirmDiverged 非空时追加覆盖本地改动项
  const runSafe = (confirmDiverged: string[]) => {
    setRunning(true);
    setError(null);
    htyenvCompleteExecute(ws.path, libraryDir, confirmDiverged)
      .then((o) => {
        setOutcome(o);
        onDone();
        setScanKey((k) => k + 1);
        setDivergedModal(false);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setRunning(false));
  };

  const updateSeeds = () => {
    if (seedUpdates.length === 0) return;
    setRunning(true);
    setError(null);
    htyenvUpdateFromLibrary(ws.path, seedUpdates.map((s) => s.id), false, libraryDir)
      .then(() => {
        onDone();
        setScanKey((k) => k + 1);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setRunning(false));
  };

  // diverged 注入裁决:生成合并 brief(导出官方到 tmp)→ 注入所选 AI 终端;单个传 [rel]、批量传全部
  const injectAdjudicate = (rels: string[]) => {
    if (rels.length === 0) return;
    setError(null);
    htyenvManagedMergeBrief(ws.path, rels)
      .then((text) =>
        setInject({
          title:
            rels.length === 1
              ? `「${rels[0]}」注入裁决合并 → 注入 AI 终端`
              : `全部 ${rels.length} 项注入裁决合并 → 注入 AI 终端`,
          text,
        }),
      )
      .catch((e) => setError(String(e)));
  };
  // 标记已裁决:设 base=builtin → Reconciled,不再报 diverged
  const markReconciled = (rels: string[]) => {
    setRunning(true);
    setError(null);
    htyenvManagedReconcile(ws.path, rels)
      .then(() => {
        onDone();
        setScanKey((k) => k + 1);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setRunning(false));
  };

  const detail = (arr: string[], n = 4) =>
    arr.length ? ` (${arr.slice(0, n).join(", ")}${arr.length > n ? "…" : ""})` : "";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
        <div className="text-[13px] font-bold">环境补全</div>
        <div className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-2)]">
          针对已就绪工程，按项补齐缺失结构、更新官方内置资产（HtyBox 升级后修好的工具 / 治理文件 / 内置种子）。补缺与安全更新均不动用户内容；本地改动过的文件需逐项确认才覆盖。native 入口与 memory 索引等项目内容不纳入更新检测。
        </div>
      </div>

      {error && <div className="break-all text-[11px] text-[var(--danger)]">{error}</div>}

      {/* ① 标准结构与库种子（补缺） */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold">标准结构与库种子</span>
              {preview &&
                (replenish > 0 ? (
                  <span className={`${PILL} bg-[var(--accent-soft)] text-[var(--accent-text)]`}>待补 {replenish}</span>
                ) : (
                  <span className={`${PILL} bg-[var(--success)]/12 text-[var(--success)]`}>已完整</span>
                ))}
            </div>
            <div className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-2)]">
              补齐缺失的目录与治理/脚本文件；从全局库取件尚未下发的 skill；必要时生成 native 薄引导并重生薄壳。
            </div>
            {preview && replenish > 0 && (
              <div className="mt-1.5 text-[11px] text-[var(--text-3)]">
                将补目录 {preview.willCreateDirs.length} · 治理/脚本文件 {preview.willWriteFiles.length}
                {preview.willWriteNative.length > 0 && ` · native ${preview.willWriteNative.length}`} · 取件 skill{" "}
                {preview.willFetchSkills.length}
                {detail(preview.willFetchSkills, 6)}
              </div>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <button onClick={rescan} disabled={running} className={BTN_GHOST}>
              重新扫描
            </button>
            <button onClick={() => runSafe([])} disabled={running || !preview || replenish === 0} className={BTN_PRIMARY}>
              {running ? "补全中…" : "执行补全"}
            </button>
          </div>
        </div>
      </div>

      {/* ② 官方文件更新（三态） */}
      <div className="rounded-xl border border-[var(--accent-border)] bg-[var(--surface)] px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <span className="text-[13px] font-bold">官方文件更新</span>
            <div className="mt-1 text-[11px] leading-relaxed text-[var(--text-3)]">
              HtyBox 升级后官方工具 / 治理文件的更新检测（谱系式基线三态）。
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button onClick={rescan} disabled={running} className={BTN_GHOST}>
              重新扫描
            </button>
            <button
              onClick={() => runSafe([])}
              disabled={running || updatable.length === 0}
              className={BTN_PRIMARY}
            >
              {running ? "更新中…" : `全部安全更新 · ${updatable.length}`}
            </button>
          </div>
        </div>

        {!preview ? (
          <div className="mt-3 text-[11px] text-[var(--text-3)]">扫描中…</div>
        ) : updatable.length === 0 && diverged.length === 0 && reconciled.length === 0 ? (
          <div className="mt-3 text-[11px] text-[var(--success)]">官方文件均为最新，无需更新。</div>
        ) : (
          <div className="mt-3 space-y-3">
            {updatable.length > 0 && (
              <div className="rounded-lg bg-[var(--elevated)] px-3.5 py-3">
                <div className="flex items-center gap-2">
                  <span className={`${PILL} bg-[var(--success)]/16 text-[var(--success)]`}>可更新 {updatable.length}</span>
                  <span className="text-[11px] text-[var(--text-2)]">与已装基线一致、官方已更新 → 可安全一键覆盖，不丢改动</span>
                </div>
                <ul className="mt-2 space-y-1">
                  {updatable.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-[11px]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
                      <span className="font-mono text-[var(--text)]">{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {diverged.length > 0 && (
              <div className="rounded-lg bg-[var(--elevated)] px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`${PILL} bg-[var(--danger)]/14 text-[var(--danger)]`}>本地改动 {diverged.length}</span>
                  <span className="text-[11px] text-[var(--text-2)]">你改过 / 首次无基线 → 覆盖将丢弃本地修改</span>
                  <div className="ml-auto flex flex-wrap gap-2">
                    <button
                      onClick={() => injectAdjudicate(diverged)}
                      disabled={running}
                      className="rounded-lg border border-[var(--accent-border)] px-3 py-1.5 text-[11px] font-semibold text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-50"
                    >
                      全部注入裁决
                    </button>
                    <button
                      onClick={() => markReconciled(diverged)}
                      disabled={running}
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] disabled:opacity-50"
                    >
                      全部标记已裁决
                    </button>
                    <button
                      onClick={() => setDivergedModal(true)}
                      disabled={running}
                      className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-1.5 text-[11px] font-semibold text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/16 disabled:opacity-50"
                    >
                      逐项确认覆盖…
                    </button>
                  </div>
                </div>
                <ul className="mt-2 space-y-1">
                  {diverged.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-[11px]">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />
                      <span className="min-w-0 flex-1 truncate font-mono text-[var(--text)]">{f}</span>
                      <button
                        onClick={() => injectAdjudicate([f])}
                        disabled={running}
                        className="shrink-0 rounded border border-[var(--accent-border)] px-2 py-0.5 text-[10.5px] text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-50"
                      >
                        注入裁决
                      </button>
                      <button
                        onClick={() => markReconciled([f])}
                        disabled={running}
                        className="shrink-0 rounded border border-[var(--border)] px-2 py-0.5 text-[10.5px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface)] disabled:opacity-50"
                      >
                        标记已裁决
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-3)]">
                  注入裁决 = 把官方版导出并注入 AI 终端，AI 合并你的改动与官方更新（不丢内容），完成后点「标记已裁决」；「逐项确认覆盖」= 直接接受官方版（弃本地）。
                </div>
              </div>
            )}
            {reconciled.length > 0 && (
              <div className="rounded-lg bg-[var(--elevated)] px-3.5 py-2.5 text-[10.5px] leading-relaxed text-[var(--text-3)]">
                已裁决（保留本地变体，官方再升级才提示）{reconciled.length} 项：
                <span className="font-mono text-[var(--text-2)]">{reconciled.join("、")}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ③ 内置种子更新（复用谱系；仅有更新时出现） */}
      {seedUpdates.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-bold">内置种子更新</span>
                <span className={`${PILL} bg-[var(--accent-soft)] text-[var(--accent-text)]`}>{seedUpdates.length} 有更新</span>
              </div>
              <div className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-2)]">官方内置 skill 有新版本（库领先），可安全快进更新：</div>
              <ul className="mt-1.5 space-y-1">
                {seedUpdates.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 text-[11px]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                    <span className="font-mono text-[var(--text)]">{s.id}</span>
                    <span className={`${PILL} bg-[var(--success)]/16 text-[var(--success)]`}>库领先</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex shrink-0 gap-2">
              {onGotoSkills && (
                <button onClick={onGotoSkills} disabled={running} className={BTN_GHOST}>
                  去 Skills 页 →
                </button>
              )}
              <button onClick={updateSeeds} disabled={running} className={BTN_PRIMARY}>
                {running ? "更新中…" : "更新"}
              </button>
            </div>
          </div>
        </div>
      )}

      {outcome && (
        <div className="rounded-lg border border-[var(--success)]/40 bg-[var(--success)]/8 px-3.5 py-2.5 text-[11px] text-[var(--success)]">
          上次执行：补目录 {outcome.createdDirs} · 文件 {outcome.writtenFiles.length} · 更新{" "}
          {outcome.updatedFiles.length} · 取件 {outcome.fetchedSkills.length} · 薄壳 {outcome.writtenAdapters}
          {outcome.updatedFiles.length > 0 && (
            <div className="mt-1 text-[var(--text-2)]">已更新：{outcome.updatedFiles.join(", ")}</div>
          )}
        </div>
      )}

      {divergedModal && (
        <DivergedConfirmModal
          files={diverged}
          running={running}
          onConfirm={(sel) => runSafe(sel)}
          onClose={() => setDivergedModal(false)}
        />
      )}

      {inject && (
        <InjectModal
          wsId={slugify(ws.path)}
          text={inject.text}
          title={inject.title}
          onClose={() => setInject(null)}
        />
      )}
    </div>
  );
}

/** diverged 逐项确认覆盖弹窗:默认全不勾(最安全,逐项显式 opt-in);遮罩 down+up 双判外点关闭。 */
function DivergedConfirmModal({
  files,
  running,
  onConfirm,
  onClose,
}: {
  files: string[];
  running: boolean;
  onConfirm: (selected: string[]) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const mask = useMaskDismiss(onClose);
  const toggle = (f: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(f)) n.delete(f);
      else n.add(f);
      return n;
    });
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40" {...mask}>
      <div
        className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col rounded-2xl bg-[var(--elevated)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-[var(--text)]">确认覆盖本地改动的官方文件</div>
        <div className="mt-3 rounded-lg border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--text-2)]">
          覆盖为官方内置版将丢弃这些文件的本地修改，操作不可撤销。请仅勾选确属「落后官方、应更新」的文件；疑似项目定制的建议保留。
        </div>
        <div className="mb-1 mt-3 text-[11px] font-semibold text-[var(--text-3)]">本地改动文件（{files.length}）</div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {files.map((f) => (
            <label
              key={f}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--surface)]"
            >
              <input
                type="checkbox"
                checked={sel.has(f)}
                onChange={() => toggle(f)}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              <span className="truncate font-mono text-[12px] text-[var(--text)]">{f}</span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[11px] text-[var(--text-3)]">未勾选的保留本地版本，不受影响。</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface)]"
            >
              取消
            </button>
            <button
              onClick={() => onConfirm([...sel])}
              disabled={sel.size === 0 || running}
              className="rounded-md bg-[var(--danger)] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[var(--danger-hover)] disabled:opacity-50"
            >
              {running ? "覆盖中…" : `覆盖选中 ${sel.size} 项`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
