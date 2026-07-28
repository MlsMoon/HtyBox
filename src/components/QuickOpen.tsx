import { useEffect, useMemo, useState } from "react";
import { listAllFiles, type FileRef } from "../catalog";
import { emitActiveFile, emitActiveFolder, requestSidebarTab } from "../dockBus";
import { openFileInScope } from "../fileOpenBus";
import { loadFavFolders, toggleFavFolder, onFavFoldersChange } from "../favFolders";
import { loadIgnore } from "../fileIgnore";
import { searchScore } from "../search";
import { useSettings } from "../settings";
import { useMaskDismiss } from "./ui/maskDismiss";

/** M9：双击 Shift 唤出的全局文件搜索（统一搜索规则，排除忽略名单）。单击即决断：按 openFileFromSearch 直接在编辑器打开 / 仅在 File 页签定位选中。 */
export default function QuickOpen({
  root,
  workspaceId,
  onClose,
  onEnsureSidebar,
  onPick,
}: {
  root: string;
  workspaceId: string;
  onClose: () => void;
  onEnsureSidebar?: () => void;
  /** 给了就只做"挑一个文件交出去"（内容预览窗口用）：不碰主窗左栏，也不看 openFileFromSearch 设置 */
  onPick?: (path: string) => void;
}) {
  const [all, setAll] = useState<FileRef[]>([]);
  const [total, setTotal] = useState(0);
  const [allFolders, setAllFolders] = useState<FileRef[]>([]);
  const [folderTotal, setFolderTotal] = useState(0);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const s = useSettings();
  const mask = useMaskDismiss(onClose);
  // 收藏文件夹：与 File 页签共享 favFolders.ts，收藏后不关面板、两处实时同步
  const [favs, setFavs] = useState<string[]>(() => loadFavFolders(root));
  useEffect(() => {
    setFavs(loadFavFolders(root));
    return onFavFoldersChange(() => setFavs(loadFavFolders(root)));
  }, [root]);

  useEffect(() => {
    const ig = loadIgnore(root); // 排除被忽略的文件夹/扩展名
    listAllFiles(root, ig.folders, ig.exts, s.maxFiles)
      .then((r) => {
        setAll(r.files);
        setTotal(r.total);
        setAllFolders(r.folders);
        setFolderTotal(r.folderTotal);
      })
      .catch(() => {
        setAll([]);
        setTotal(0);
        setAllFolders([]);
        setFolderTotal(0);
      });
  }, [root, s.maxFiles]);

  const results = useMemo(() => {
    // onPick 模式（预览窗）只找文件：那边没有文件树，"定位文件夹"无处可去
    const items = onPick
      ? all.map((f) => ({ f, isDir: false }))
      : [
          ...all.map((f) => ({ f, isDir: false })),
          ...allFolders.map((f) => ({ f, isDir: true })),
        ];
    return items
      .map((it) => ({ ...it, sc: searchScore(q, it.f.name, it.f.rel) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 50);
  }, [all, allFolders, q, onPick]);

  useEffect(() => setSel(0), [q]);

  const act = (f: FileRef, isDir: boolean) => {
    if (onPick) {
      if (!isDir) onPick(f.path);
      onClose();
      return;
    }
    if (isDir) {
      // 文件夹：始终在 File 页签定位选中（无"编辑器打开"概念，不受 openFileFromSearch 影响）
      onEnsureSidebar?.();
      requestSidebarTab(workspaceId, "file");
      emitActiveFolder(workspaceId, f.path, true); // 挂载后补发 → revealFolder 定位选中
    } else if (s.openFileFromSearch) {
      openFileInScope(workspaceId, f.path); // 直接在编辑器打开（预览窗开着则由注册者改派过去）
      // 同时显式揭示：不能只靠 DockEditor 的"激活即揭示"——重复搜同一个已打开且已激活的
      // 文件时，编辑器 Tab 不会重新激活、onDidActiveChange 不触发，树的揭示/滚动就不会发生
      emitActiveFile(workspaceId, f.path, true);
    } else {
      // 仅选中：切到 File 页签并定位选中，不打开、不切走终端（找文件喂 AI 用）
      onEnsureSidebar?.(); // 侧边栏若折叠则展开
      requestSidebarTab(workspaceId, "file"); // 切 File 页签 → FilePanel 挂载
      emitActiveFile(workspaceId, f.path, true); // 挂载后补发 → reveal 定位选中
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[130] flex items-start justify-center bg-black/20 pt-[12vh]" {...mask}>
      <div
        className="w-[600px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--elevated)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (results[sel]) act(results[sel].f, results[sel].isDir);
            }
          }}
          placeholder="搜索文件（按文件名）…"
          className="w-full border-b border-[var(--border)] px-4 py-2.5 text-[14px] outline-none"
        />
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 && (
            <div className="px-4 py-6 text-center text-[12px] text-[var(--text-3)]">
              {all.length === 0 && allFolders.length === 0 ? "正在索引…" : "无匹配项"}
            </div>
          )}
          {results.map((item, i) => {
            const isFav = item.isDir && favs.includes(item.f.path);
            return (
              <button
                key={(item.isDir ? "d:" : "f:") + item.f.path}
                onMouseEnter={() => setSel(i)}
                onClick={() => act(item.f, item.isDir)}
                className={
                  "group flex w-full items-center gap-2 px-4 py-1.5 text-left " +
                  (i === sel ? "bg-[var(--accent)]/12" : "hover:bg-[var(--surface)]")
                }
              >
                {item.isDir ? (
                  <svg className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" /></svg>
                ) : (
                  <svg className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                )}
                <span className="shrink-0 text-[13px] text-[var(--text)]">{item.f.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-3)]">{item.f.rel}</span>
                {/* 文件夹可直接收藏（button 内不可嵌 button，用 span 热区）：已收藏常显实心，未收藏 hover/选中行显示 */}
                {item.isDir && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavFolder(root, item.f.path);
                    }}
                    title={isFav ? "取消收藏" : "收藏文件夹"}
                    className={
                      "shrink-0 cursor-pointer p-0.5 " +
                      (isFav
                        ? "text-[var(--accent)]"
                        : "text-[var(--text-faint)] hover:text-[var(--accent)] " +
                          (i === sel ? "opacity-100" : "opacity-0 group-hover:opacity-100"))
                    }
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill={isFav ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                    </svg>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {(all.length > 0 || allFolders.length > 0) && (
          <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--text-3)]">
            <span>
              {`共 ${total.toLocaleString()} 个文件 · ${folderTotal.toLocaleString()} 个文件夹`}
            </span>
            {(all.length < total || allFolders.length < folderTotal) && (
              <span className="shrink-0 text-[var(--accent)]">超出上限，部分未索引</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
