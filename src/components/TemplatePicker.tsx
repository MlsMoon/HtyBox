import type { SkillTemplate } from "../skillTemplates";
import { useMaskDismiss } from "./ui/maskDismiss";

/** M8-C：切换当前 Skill 模板的下拉框（锚定在模板栏按钮下方，非弹窗）。点某模板即应用并关闭。 */
export default function TemplatePicker({
  templates,
  activeId,
  onPick,
  onManage,
  onClose,
}: {
  templates: SkillTemplate[];
  activeId: string | null;
  onPick: (t: SkillTemplate) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const mask = useMaskDismiss(onClose);
  return (
    <>
      <div className="fixed inset-0 z-[60]" {...mask} />
      <div className="absolute left-0 top-full z-[61] mt-1 max-h-[60vh] w-full min-w-[220px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--elevated)] py-1 shadow-xl">
        {templates.length === 0 && (
          <div className="px-3 py-3 text-center text-[11px] text-[var(--text-3)]">还没有模板，点 ⚙ 新建</div>
        )}
        {templates.map((t) => {
          const active = t.id === activeId;
          return (
            <button
              key={t.id}
              onClick={() => {
                onPick(t);
                onClose();
              }}
              className={
                "flex w-full items-center gap-2 px-3 py-1.5 text-left " +
                (active ? "bg-[var(--accent)]/10" : "hover:bg-[var(--surface)]")
              }
            >
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)]">{t.name || "（未命名）"}</span>
              <span className="shrink-0 text-[10px] text-[var(--text-3)]">{t.skillDirs.length}</span>
              {active && (
                <svg className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </button>
          );
        })}
        <div className="my-1 border-t border-[var(--border-soft)]" />
        <button
          onClick={() => {
            onClose();
            onManage();
          }}
          className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--text-2)] hover:bg-[var(--surface)]"
        >
          ⚙ 管理模板…
        </button>
      </div>
    </>
  );
}
