// Memory 分类页:工作区权威记忆(.htyworkflows/memory)分组浏览(唯一真源,决策 3A 不读旧路径)。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SyncReport } from "../../../htyenv";
import type { DashWorkspace } from "../DashboardShell";
import { PreviewModal } from "./shared";

interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

const listDir = (path: string) => invoke<DirEntry[]>("list_dir", { path });

export default function MemorySection({ ws, check }: { ws: DashWorkspace; check: SyncReport | null }) {
  const root = `${ws.path}/.htyworkflows/memory`;
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, DirEntry[] | "loading">>({});
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setOpen({});
    listDir(root)
      .then((list) => alive && setEntries(list))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [root]);

  const toggleGroup = (dir: DirEntry) => {
    if (open[dir.path]) {
      setOpen((prev) => {
        const next = { ...prev };
        delete next[dir.path];
        return next;
      });
      return;
    }
    setOpen((prev) => ({ ...prev, [dir.path]: "loading" }));
    listDir(dir.path)
      .then((list) => setOpen((prev) => ({ ...prev, [dir.path]: list })))
      .catch((e) => {
        setError(String(e));
        setOpen((prev) => {
          const next = { ...prev };
          delete next[dir.path];
          return next;
        });
      });
  };

  const memoryMd = check?.memory.memoryMd;
  const groups = (entries ?? []).filter((e) => e.isDir);
  const rootFiles = (entries ?? []).filter((e) => !e.isDir);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-bold">权威记忆(唯一真源)</span>
          {memoryMd && (
            <span
              className={
                "rounded-full border px-2 py-0.5 text-[10px] " +
                (memoryMd === "consistent"
                  ? "border-[var(--success)]/50 text-[var(--success)]"
                  : memoryMd === "conflict"
                    ? "border-[var(--danger)]/50 text-[var(--danger)]"
                    : "border-[var(--border)] text-[var(--text-3)]")
              }
            >
              MEMORY.md 契约:
              {{ consistent: "一致", conflict: "冲突", canonicalMissing: "权威侧缺失", cacheMissing: "缓存侧缺失" }[memoryMd]}
            </span>
          )}
        </div>
        <div className="mt-1 break-all font-mono text-[10.5px] text-[var(--text-3)]">{root}</div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        {error ? (
          <div className="py-6 text-center text-[11px] text-[var(--danger)]">{error}</div>
        ) : entries === null ? (
          <div className="py-6 text-center text-xs text-[var(--text-3)]">加载中…</div>
        ) : entries.length === 0 ? (
          <div className="py-6 text-center text-xs text-[var(--text-3)]">memory/ 为空</div>
        ) : (
          <>
            {rootFiles.map((f) => (
              <FileRow key={f.path} entry={f} onPreview={setPreview} indent={false} />
            ))}
            {groups.map((g) => {
              const state = open[g.path];
              return (
                <div key={g.path}>
                  <button
                    onClick={() => toggleGroup(g)}
                    className="flex w-full items-center gap-2 border-b border-[var(--border-soft)] py-2 text-left hover:bg-[var(--elevated)]/50"
                  >
                    <span className="text-[10px] text-[var(--text-3)]">{state ? "▾" : "▸"}</span>
                    <span className="truncate text-[12px] font-medium text-[var(--text)]">{g.name}</span>
                    {Array.isArray(state) && (
                      <span className="ml-auto text-[10px] text-[var(--text-3)]">{state.filter((x) => !x.isDir).length} 个文件</span>
                    )}
                  </button>
                  {state === "loading" && <div className="py-1.5 pl-8 text-[10px] text-[var(--text-3)]">读取中…</div>}
                  {Array.isArray(state) &&
                    state.map((f) =>
                      f.isDir ? (
                        <div key={f.path} className="py-1.5 pl-8 font-mono text-[10.5px] text-[var(--text-3)]">
                          {f.name}/(子目录,双层内不再展开)
                        </div>
                      ) : (
                        <FileRow key={f.path} entry={f} onPreview={setPreview} indent />
                      ),
                    )}
                </div>
              );
            })}
          </>
        )}
      </div>
      {preview && <PreviewModal path={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function FileRow({
  entry,
  onPreview,
  indent,
}: {
  entry: DirEntry;
  onPreview: (path: string) => void;
  indent: boolean;
}) {
  return (
    <div
      onDoubleClick={() => onPreview(entry.path)}
      title="双击预览"
      className={
        "flex items-center gap-2 border-b border-[var(--border-soft)] py-1.5 last:border-b-0 hover:bg-[var(--elevated)]/50 " +
        (indent ? "pl-8" : "")
      }
    >
      <span className="truncate font-mono text-[11px] text-[var(--text-2)]">{entry.name}</span>
    </div>
  );
}
