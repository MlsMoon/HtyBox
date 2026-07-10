import { useState } from "react";
import type { IgnoreCfg } from "../fileIgnore";
import { useMaskDismiss } from "./ui/maskDismiss";

/** M9-N6：文件树忽略名单管理（顶层文件夹名 + 扩展名）。自定义风格弹窗。 */
export default function FileIgnoreModal({
  cfg,
  onChange,
  onClose,
}: {
  cfg: IgnoreCfg;
  onChange: (c: IgnoreCfg) => void;
  onClose: () => void;
}) {
  const [folderInput, setFolderInput] = useState("");
  const [extInput, setExtInput] = useState("");
  const mask = useMaskDismiss(onClose);

  const addFolder = () => {
    const v = folderInput.trim();
    if (v && !cfg.folders.includes(v)) onChange({ ...cfg, folders: [...cfg.folders, v] });
    setFolderInput("");
  };
  const addExt = () => {
    const v = extInput.trim().toLowerCase().replace(/^\./, "");
    if (v && !cfg.exts.includes(v)) onChange({ ...cfg, exts: [...cfg.exts, v] });
    setExtInput("");
  };
  const rmFolder = (f: string) => onChange({ ...cfg, folders: cfg.folders.filter((x) => x !== f) });
  const rmExt = (e: string) => onChange({ ...cfg, exts: cfg.exts.filter((x) => x !== e) });

  const chip = (label: string, onRemove: () => void) => (
    <span key={label} className="flex items-center gap-1 rounded-full bg-[var(--surface-hover)] py-0.5 pl-2.5 pr-1 text-[11px] text-[var(--text-deep)]">
      {label}
      <button onClick={onRemove} className="rounded px-1 text-[var(--text-3)] hover:text-[var(--danger)]">✕</button>
    </span>
  );
  const section = (title: string, hint: string, items: string[], onRemove: (v: string) => void, input: string, setInput: (s: string) => void, add: () => void, placeholder: string) => (
    <div>
      <div className="text-[12px] font-semibold text-[var(--text)]">{title}</div>
      <div className="mb-1.5 text-[10.5px] text-[var(--text-3)]">{hint}</div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {items.length === 0 ? <span className="text-[11px] text-[var(--text-3)]">（空）</span> : items.map((it) => chip(it, () => onRemove(it)))}
      </div>
      <div className="flex gap-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] px-2 py-1 text-[12px] outline-none focus:border-[var(--accent-border)]"
        />
        <button onClick={add} className="shrink-0 rounded-md bg-[var(--surface-hover)] px-2.5 py-1 text-[12px] font-semibold text-[var(--text-2)] hover:bg-[var(--border-soft)] hover:text-[var(--text)]">添加</button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/30" {...mask}>
      <div className="w-[440px] max-w-[92vw] rounded-2xl bg-[var(--elevated)] p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-[var(--text)]">文件树忽略名单</span>
          <button onClick={onClose} className="rounded px-2 text-[var(--text-3)] hover:text-[var(--text)]">✕</button>
        </div>
        <div className="space-y-4">
          {section("忽略的顶层文件夹", "按文件夹名隐藏根目录下的一级文件夹", cfg.folders, rmFolder, folderInput, setFolderInput, addFolder, "如 node_modules")}
          {section("忽略的扩展名", "隐藏所有该扩展名的文件（不含点）", cfg.exts, rmExt, extInput, setExtInput, addExt, "如 log")}
        </div>
      </div>
    </div>
  );
}
