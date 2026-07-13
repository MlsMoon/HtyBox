// agent记忆同步页(用户第三轮反馈定名):仅本工作区权威记忆 ↔ Claude 原生缓存的单向收敛;
// codex(直读 canonical)/cursor(未实测)如实标注暂不支持同步。
import { useState } from "react";
import type { SyncReport } from "../../../htyenv";
import type { DashWorkspace } from "../DashboardShell";
import { InjectModal, slugify } from "./shared";

export default function MemorySyncSection({
  ws,
  check,
  busy,
  onMechSync,
  onRecheck,
}: {
  ws: DashWorkspace;
  check: SyncReport | null;
  busy: boolean;
  onMechSync: () => void;
  onRecheck: () => void;
}) {
  const [inject, setInject] = useState<string | null>(null);
  const memory = check?.memory;
  const canonicalDir = `${ws.path}\\.htyworkflows\\memory`;
  const pending = memory ? [...memory.conflicts.map((rel) => ({ rel, kind: "CONFLICT" as const })), ...memory.uncurated.map((rel) => ({ rel, kind: "UNCURATED" as const }))] : [];

  const buildBrief = () => {
    if (!memory) return "";
    const lines = [
      `工作区「${ws.name}」的权威记忆与 Claude 原生缓存出现待裁决项,请按双写收敛纪律处置:`,
      `- 权威侧(唯一真源): ${canonicalDir}`,
      `- Claude 缓存侧: ${memory.cacheDir}`,
    ];
    if (memory.conflicts.length > 0) {
      lines.push("- CONFLICT(同名异内容,人工确认后双写收敛——合并进权威侧,再让缓存与之一致):");
      for (const rel of memory.conflicts) lines.push(`  - ${rel}`);
    }
    if (memory.uncurated.length > 0) {
      lines.push("- UNCURATED(缓存多出、权威侧无——按策展纪律收编进权威侧或清理缓存):");
      for (const rel of memory.uncurated) lines.push(`  - ${rel}`);
    }
    if (memory.memoryMd === "conflict") {
      lines.push("- MEMORY.md 索引正文两侧不一致 → 人工确认(权威侧=契约段+索引,缓存应等于其去契约段部分)");
    }
    lines.push("- 纪律: 权威侧是唯一真源;处置完成后在 HtyBox 重跑「同步检查」确认零待裁决。");
    return lines.join("\n");
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold">Claude 记忆链路(缓存双写)</span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={onRecheck}
              disabled={busy}
              className="rounded-lg border border-[var(--border)] px-3 py-1 text-[11px] text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] disabled:opacity-50"
            >
              同步检查
            </button>
            <button
              onClick={onMechSync}
              disabled={busy}
              className="rounded-lg bg-[var(--accent)] px-3 py-1 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "执行中…" : "执行收敛(补齐缺失)"}
            </button>
          </div>
        </div>
        <div className="mt-3 space-y-1.5 font-mono text-[11px] text-[var(--text-2)]">
          <div className="flex gap-2">
            <span className="w-20 shrink-0 font-sans text-[var(--text-3)]">权威(真源)</span>
            <span className="break-all">{canonicalDir}</span>
          </div>
          <div className="flex gap-2">
            <span className="w-20 shrink-0 font-sans text-[var(--text-3)]">Claude 缓存</span>
            <span className="break-all">{memory?.cacheDir ?? "对账中…"}</span>
          </div>
        </div>
        {memory && (
          <div className="mt-3 flex flex-wrap gap-4 border-t border-[var(--border-soft)] pt-3 text-[12px]">
            <Stat label="一致" value={memory.same} />
            <Stat label={check?.mode === "sync" ? "本轮补齐" : "待补齐"} value={memory.filled.length} />
            <Stat label="CONFLICT" value={memory.conflicts.length} danger />
            <Stat label="UNCURATED" value={memory.uncurated.length} danger />
            <span className="ml-auto self-center text-[11px] text-[var(--text-3)]">
              MEMORY.md 契约:{{ consistent: "包含关系 ✓", conflict: "不一致 ⚠", canonicalMissing: "权威侧缺失", cacheMissing: "缓存侧缺失(尚无 Claude 会话)" }[memory.memoryMd]}
            </span>
          </div>
        )}
      </div>

      {/* 待裁决列表(语义项只报告,裁决注入终端) */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold">待裁决({pending.length})</span>
          {pending.length > 0 && (
            <button
              onClick={() => setInject(buildBrief())}
              className="ml-auto rounded-lg border border-[var(--danger)]/60 px-3 py-1 text-[11px] text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/10"
            >
              注入终端裁决…
            </button>
          )}
        </div>
        {!memory ? (
          <div className="mt-3 text-[11px] text-[var(--text-3)]">对账中…</div>
        ) : pending.length === 0 ? (
          <div className="mt-3 text-[11px] text-[var(--success)]">零待裁决——记忆链路干净 ✓</div>
        ) : (
          <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
            {pending.map((p) => (
              <div key={p.kind + p.rel} className="flex items-center gap-2 rounded-lg border border-[var(--border-soft)] px-3 py-1.5">
                <span
                  className={
                    "shrink-0 rounded px-1.5 py-px text-[9px] font-semibold " +
                    (p.kind === "CONFLICT"
                      ? "bg-[var(--danger)]/15 text-[var(--danger)]"
                      : "bg-[var(--accent-soft)] text-[var(--accent-text)]")
                  }
                >
                  {p.kind}
                </span>
                <span className="truncate font-mono text-[11px] text-[var(--text-2)]">{p.rel}</span>
                <span className="ml-auto shrink-0 text-[10px] text-[var(--text-3)]">
                  {p.kind === "CONFLICT" ? "两侧内容不同 → 双写收敛" : "缓存多出 → 收编或清理"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 其他 agent 如实标注 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
        <div className="text-[13px] font-bold">其他 Agent</div>
        <div className="mt-2 space-y-1.5 text-[11px]">
          <div className="flex gap-2">
            <span className="w-14 shrink-0 text-[var(--text-2)]">codex</span>
            <span className="text-[var(--text-3)]">直读权威记忆(rules/codex.md 指引),无缓存链路,无需同步</span>
          </div>
          <div className="flex gap-2">
            <span className="w-14 shrink-0 text-[var(--text-2)]">cursor</span>
            <span className="text-[var(--text-3)]">暂不支持同步(记忆链路未实测入册)</span>
          </div>
        </div>
      </div>

      {inject !== null && (
        <InjectModal
          wsId={slugify(ws.path)}
          text={inject}
          title="记忆裁决指令 → 注入 agent 终端"
          onClose={() => setInject(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[10px] text-[var(--text-3)]">{label}</span>
      <span className={"text-sm font-bold " + (danger && value > 0 ? "text-[var(--danger)]" : "text-[var(--text)]")}>
        {value}
      </span>
    </span>
  );
}
