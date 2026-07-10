import { Search } from "@icon-park/react";

export default function SearchBox({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** 挂载即聚焦（浮层内的搜索选择器用，免用户多点一次） */
  autoFocus?: boolean;
}) {
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-3)]"
        size={14}
        fill="currentColor"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--elevated)] py-1.5 pr-2 pl-8 text-xs text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-3)] focus:border-[var(--accent)]"
      />
    </div>
  );
}
