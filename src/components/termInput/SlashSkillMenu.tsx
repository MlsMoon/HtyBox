import { useEffect, useRef } from "react";
import type { ManagedSkill } from "../../catalog";

/** CLI 风格斜杠菜单：无圆角、左陶土竖线、双列 invoke|desc、→ 选中。 */
export default function SlashSkillMenu({
  skills,
  selected,
  onSelect,
  onPick,
}: {
  skills: ManagedSkill[];
  selected: number;
  onSelect: (i: number) => void;
  onPick: (s: ManagedSkill) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const sel = Math.max(0, Math.min(selected, Math.max(0, skills.length - 1)));

  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-slash-i="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel, skills.length]);

  if (skills.length === 0) {
    return (
      <div className="htybox-slash-menu border-l-2 border-[var(--accent)] bg-[#1f1e1d] px-3 py-2 text-[11px] text-[#8c8a82]">
        无匹配 Skill
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="htybox-slash-menu max-h-[220px] overflow-y-auto border-l-2 border-[var(--accent)] bg-[#1f1e1d] py-1"
      role="listbox"
      aria-label="Skill 斜杠补全"
    >
      {skills.map((s, i) => {
        const on = i === sel;
        return (
          <button
            key={s.dir}
            type="button"
            data-slash-i={i}
            role="option"
            aria-selected={on}
            title={s.description ? `${s.name} — ${s.description}` : s.name}
            onMouseEnter={() => onSelect(i)}
            onMouseDown={(e) => {
              // mousedown 抢在 blur 前完成补全
              e.preventDefault();
              onPick(s);
            }}
            className={
              "flex w-full items-baseline gap-3 px-3 py-1.5 text-left font-mono text-[12px] " +
              (on ? "bg-[#3a2a22] text-[var(--accent)]" : "text-[#e5e2dc] hover:bg-[#2a2620]")
            }
          >
            <span className={"w-[148px] shrink-0 truncate " + (on ? "font-bold" : "")}>
              {on ? "→ " : "  "}
              {s.invoke}
            </span>
            <span className={"min-w-0 flex-1 truncate font-sans text-[11px] " + (on ? "text-[#b4aea3]" : "text-[#8c8a82]")}>
              {s.description || s.name}
            </span>
          </button>
        );
      })}
      {skills.length > 7 && (
        <div className="px-3 pb-1 pt-0.5 font-mono text-[10px] text-[#8c8a82]">↓ more below</div>
      )}
    </div>
  );
}
