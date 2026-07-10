import { useState } from "react";
import RunConfigModal from "./RunConfigModal";
import { loadConfigs, loadActiveConfig, saveActiveConfig, type RunConfig } from "../runConfigs";
import { useMaskDismiss } from "./ui/maskDismiss";

/** M9-N8：终端工具栏的运行配置控件——▶ 运行 + 配置名下拉选择(Cursor 式) + ⚙ 设置。 */
export default function RunConfigBar({
  workspaceId,
  root,
  onRun,
}: {
  workspaceId: string;
  root: string;
  onRun: (c: RunConfig) => void;
}) {
  const [configs, setConfigs] = useState<RunConfig[]>(() => loadConfigs(workspaceId));
  const [activeId, setActiveId] = useState<string | null>(() => loadActiveConfig(workspaceId));
  const [showModal, setShowModal] = useState(false);
  const [open, setOpen] = useState(false);
  const mask = useMaskDismiss(() => setOpen(false));
  const active = configs.find((c) => c.id === activeId) ?? configs[0] ?? null;

  const pick = (id: string | null) => {
    setActiveId(id);
    saveActiveConfig(workspaceId, id);
  };

  return (
    <div className="relative flex items-center gap-0.5">
      <button
        onClick={() => (active ? onRun(active) : setShowModal(true))}
        title={active ? `运行：${active.name}` : "新建运行配置"}
        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--success)] transition-colors hover:bg-[var(--elevated)]"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        title="选择启动项"
        className="flex h-7 max-w-[180px] items-center gap-1 rounded-md px-2 text-xs text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] hover:text-[var(--text)]"
      >
        <span className="truncate">{active?.name ?? "运行配置"}</span>
        <svg className="h-3 w-3 shrink-0 text-[var(--text-3)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <button
        onClick={() => setShowModal(true)}
        title="运行配置设置"
        className="flex h-7 w-7 items-center justify-center rounded-md text-[13px] text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] hover:text-[var(--text)]"
      >
        ⚙
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[60]" {...mask} />
          <div className="absolute right-0 top-full z-[61] mt-1 max-h-[60vh] w-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--elevated)] py-1 shadow-xl">
            {configs.length === 0 && (
              <div className="px-3 py-3 text-center text-[11px] text-[var(--text-3)]">还没有配置，点下方添加</div>
            )}
            {configs.map((c) => (
              <div
                key={c.id}
                className={"flex items-center gap-1 px-1.5 py-0.5 " + (activeId === c.id ? "bg-[var(--accent)]/10" : "hover:bg-[var(--surface)]")}
              >
                <button
                  onClick={() => { onRun(c); setOpen(false); }}
                  title="运行"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--success)] hover:bg-[var(--success)]/10"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                </button>
                <button
                  onClick={() => { pick(c.id); setOpen(false); }}
                  className="min-w-0 flex-1 truncate py-1 text-left text-[12px] text-[var(--text)]"
                >
                  {c.name || "（未命名）"}
                </button>
                {activeId === c.id && <span className="shrink-0 pr-1 text-[10px] text-[var(--accent)]">✓</span>}
              </div>
            ))}
            <div className="my-1 border-t border-[var(--border-soft)]" />
            <button
              onClick={() => { setOpen(false); setShowModal(true); }}
              className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--text-2)] hover:bg-[var(--surface)]"
            >
              ⚙ 管理配置…
            </button>
          </div>
        </>
      )}

      {showModal && (
        <RunConfigModal
          workspaceId={workspaceId}
          root={root}
          configs={configs}
          activeId={active?.id ?? null}
          onChange={(list) => setConfigs(list)}
          onPickActive={pick}
          onRun={onRun}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
