/** 正常工作模式 ↔ hty环境仪表盘 分段切换控件(欢迎页/仪表盘入口共用;mockup envdash-welcome-toggle)。 */
export default function ModeSwitch({
  mode,
  onNormal,
  onDashboard,
}: {
  mode: "normal" | "dashboard";
  onNormal: () => void;
  onDashboard: () => void;
}) {
  const seg = (active: boolean) =>
    "flex-1 rounded-lg px-4 py-2 text-[13px] transition-colors " +
    (active
      ? "border border-[var(--accent-border)] bg-[var(--accent-soft)] font-semibold text-[var(--accent-text)]"
      : "text-[var(--text-2)] hover:text-[var(--text)]");
  return (
    <div className="flex w-full items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1">
      <button className={seg(mode === "normal")} onClick={onNormal}>
        正常工作模式
      </button>
      <button className={seg(mode === "dashboard")} onClick={onDashboard}>
        hty环境仪表盘
      </button>
    </div>
  );
}
