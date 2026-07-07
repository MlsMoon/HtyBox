import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listDir,
  createEntry,
  renameEntry,
  deleteEntry,
  moveEntry,
  copyEntry,
  importDroppedFile,
  importMakeDir,
  importDroppedEntry,
  revealInExplorer,
  type DirEntry,
} from "../catalog";
import { openEditor, openTerminalAt, registerActiveFileReveal, registerActiveFolderReveal } from "../dockBus";
import FileContextMenu from "./FileContextMenu";
import FileIgnoreModal from "./FileIgnoreModal";
import PromptModal from "./ui/PromptModal";
import ConfirmModal from "./ui/ConfirmModal";
import { loadIgnore, saveIgnore, extOf, type IgnoreCfg } from "../fileIgnore";
import { getWsState, setWsState } from "../wsState";
import { useSettings } from "../settings";

const DRAG_MIME = "application/x-htybox-item";
const MAX_IMPORT = 20 * 1024 * 1024; // 单文件导入上限 20MB

// 拖入文件夹支持：HTML5 FileSystem entry 的回调式 API → Promise 化
const entryFile = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));
const readBatch = (reader: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
// readEntries 每次最多返回 100 项，需循环读到返回空数组为止
async function listEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await readBatch(reader);
    if (!batch.length) break;
    all.push(...batch);
  }
  return all;
}

// 收藏的文件夹按工作区(root)持久化：{ [root]: 绝对路径[] }
const FAV_KEY = "htybox.favFolders.v1";
function loadFavFolders(root: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(FAV_KEY) || "{}");
    return Array.isArray(all[root]) ? all[root] : [];
  } catch {
    return [];
  }
}
function saveFavFolders(root: string, paths: string[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(FAV_KEY) || "{}");
    all[root] = paths;
    localStorage.setItem(FAV_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

// 文件树展开状态按工作区(root)持久化：完整复原上次展开的目录层级（用户要"像没关过"）
const EXP_KEY = "htybox.fileExpanded.v1";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={"h-3 w-3 shrink-0 text-[var(--text-faint)] transition-transform " + (open ? "rotate-90" : "")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
  );
}
function FolderGlyph() {
  return <svg className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" /></svg>;
}
function FileGlyph() {
  return <svg className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>;
}

type Clip = { paths: string[]; mode: "cut" | "copy" };
type Menu = { x: number; y: number; node: DirEntry; isTopLevel: boolean; count: number };
type Prompt = { title: string; initial: string; confirmText: string; run: (v: string) => Promise<void> };
type Confirm = { title: string; message: string; run: () => Promise<void> };

/** 「File」页签：工作区文件树（懒加载）+ 右键菜单 + 拖入(OS复制/树内移动) + 点击开编辑器。 */
export default function FilePanel({ root, workspaceId }: { root: string; workspaceId: string }) {
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(getWsState<string[]>(EXP_KEY, root, [])));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<Menu | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [opErr, setOpErr] = useState<string | null>(null);
  const [importing, setImporting] = useState(false); // OS 文件/文件夹导入进行中
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false); // 内部拖拽进行中 → 显示"移动到根目录"投放区
  const [rootHot, setRootHot] = useState(false);
  const [favFolders, setFavFolders] = useState<string[]>(() => loadFavFolders(root));
  const [ignore, setIgnore] = useState<IgnoreCfg>(() => loadIgnore(root));
  const [activeFile, setActiveFile] = useState<string | null>(null);
  // 多选（Windows 式）：selected=选中集(高亮+批量操作目标)，anchor=Shift 区间锚点。瞬时态，不持久化。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const s = useSettings();
  const [showIgnore, setShowIgnore] = useState(false);
  const [showTop, setShowTop] = useState(false); // 滚动超过阈值 → 浮现「回到顶部」按钮（瞬时态，不持久化）
  const scrollDoneFor = useRef<string | null>(null);
  // 拖拽时的自动滚动（悬停上/下条带即滚动列表）
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef<number | null>(null);
  const startScroll = (dir: number) => {
    if (autoScroll.current != null) return;
    autoScroll.current = window.setInterval(() => {
      if (scrollRef.current) scrollRef.current.scrollTop += dir * 14;
    }, 16);
  };
  const stopScroll = () => {
    if (autoScroll.current != null) {
      window.clearInterval(autoScroll.current);
      autoScroll.current = null;
    }
  };
  useEffect(() => {
    if (!dragActive) stopScroll();
  }, [dragActive]);
  useEffect(() => () => stopScroll(), []);

  const load = useCallback((path: string) => {
    setLoading((s) => new Set(s).add(path));
    listDir(path)
      .then((entries) => {
        setChildren((c) => ({ ...c, [path]: entries }));
        setErrors((e) => { const n = { ...e }; delete n[path]; return n; });
      })
      .catch((err) => setErrors((e) => ({ ...e, [path]: String(err) })))
      .finally(() => setLoading((s) => { const n = new Set(s); n.delete(path); return n; }));
  }, []);

  useEffect(() => {
    const saved = getWsState<string[]>(EXP_KEY, root, []); // 复原该工作区上次展开的目录
    setChildren({}); setExpanded(new Set(saved)); setErrors({}); setMenu(null);
    setIgnore(loadIgnore(root)); setActiveFile(null); setSelected(new Set()); setAnchor(null); setShowTop(false);
    setFavFolders(loadFavFolders(root));
    if (root) {
      load(root);
      saved.forEach((p) => p !== root && load(p)); // 拉回各展开目录子项，渲染出层级（完整复原）
    }
  }, [root, load]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else { next.add(path); if (!children[path]) load(path); }
      setWsState(EXP_KEY, root, [...next]); // 持久化展开态（完整复原）
      return next;
    });
  const expand = (path: string) =>
    setExpanded((s) => {
      const next = new Set(s).add(path);
      setWsState(EXP_KEY, root, [...next]);
      return next;
    });

  const dirOf = (p: string) => { const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")); return i > 0 ? p.slice(0, i) : root; };
  const relOf = (p: string) => (p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]/, "") : p);
  const dirFor = (n: DirEntry) => (n.isDir ? n.path : dirOf(n.path));
  const reloadDir = (d: string) => { if (d === root || children[d]) load(d); };
  const refresh = () => { setChildren({}); if (root) load(root); expanded.forEach((p) => p !== root && load(p)); };

  // N6：忽略过滤（顶层文件夹按名 + 文件按扩展名）
  const filterEntries = (list: DirEntry[], depth: number) =>
    list.filter((e) =>
      e.isDir ? !(depth === 0 && ignore.folders.includes(e.name)) : !ignore.exts.includes(extOf(e.name)),
    );
  // 当前可见项的扁平有序路径（与 renderNode 同序：深度优先 + 仅已展开 + 忽略过滤），供 Shift 区间选 / Ctrl+A 全选
  const visibleOrder = useMemo(() => {
    const order: string[] = [];
    const walk = (list: DirEntry[], depth: number) => {
      for (const e of filterEntries(list, depth)) {
        order.push(e.path);
        if (e.isDir && expanded.has(e.path)) walk(children[e.path] ?? [], depth + 1);
      }
    };
    walk(children[root] ?? [], 0);
    return order;
  }, [children, expanded, ignore, root]);
  const applyIgnore = (cfg: IgnoreCfg) => { setIgnore(cfg); saveIgnore(root, cfg); };
  const ignoreFolder = (name: string) => { if (!ignore.folders.includes(name)) applyIgnore({ ...ignore, folders: [...ignore.folders, name] }); };
  const ignoreExt = (e: string) => { if (e && !ignore.exts.includes(e)) applyIgnore({ ...ignore, exts: [...ignore.exts, e] }); };

  // N7：揭示并定位活动文件——展开各级祖先目录 + 高亮 + 滚动到视图
  const reveal = useCallback((filePath: string) => {
    const dirs: string[] = [];
    let d = filePath.slice(0, Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/")));
    while (d.startsWith(root) && d !== root && d.length > root.length) {
      dirs.unshift(d);
      const i = Math.max(d.lastIndexOf("\\"), d.lastIndexOf("/"));
      const up = i > 0 ? d.slice(0, i) : root;
      if (up === d) break;
      d = up;
    }
    setExpanded((s) => { const n = new Set(s); dirs.forEach((x) => n.add(x)); setWsState(EXP_KEY, root, [...n]); return n; });
    // 刷新目标路径各级目录（含 root）：树缓存可能陈旧（终端/Agent 刚新建的文件），
    // 只加载"未缓存"的会漏掉"父目录已缓存但内容陈旧"→ 搜到的文件在树里无行可选中；故沿路径无条件重载
    [root, ...dirs].forEach((x) => load(x));
    scrollDoneFor.current = null; // 每次显式揭示都重置守卫：允许对"同一活动文件"再次滚动定位（与 revealFolder 对称，修复重复搜索不重新聚焦）
    setActiveFile(filePath); setSelected(new Set([filePath])); setAnchor(filePath);
  }, [root, load]);
  useEffect(() => registerActiveFileReveal(workspaceId, reveal), [workspaceId, reveal]);

  // 收藏文件夹：原树照常显示，仅在顶部独立区提供快速跳转
  const isFavFolder = (p: string) => favFolders.includes(p);
  const toggleFavFolder = (p: string) =>
    setFavFolders((prev) => {
      const next = prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p];
      saveFavFolders(root, next);
      return next;
    });
  // 在树里展开各级祖先 + 该文件夹自身 + 高亮滚动到它（收藏跳转 / 全局搜索单击文件夹复用）
  const revealFolder = useCallback((p: string) => {
    const dirs: string[] = [];
    let d = p;
    while (d.startsWith(root) && d.length >= root.length) {
      dirs.unshift(d);
      if (d === root) break;
      const i = Math.max(d.lastIndexOf("\\"), d.lastIndexOf("/"));
      const up = i > 0 ? d.slice(0, i) : root;
      if (up === d) break;
      d = up;
    }
    setExpanded((s) => {
      const n = new Set(s);
      dirs.forEach((x) => n.add(x));
      setWsState(EXP_KEY, root, [...n]);
      return n;
    });
    dirs.forEach((x) => load(x)); // 刷新路径各级目录（dirs 已含 root），避免树缓存陈旧导致目标文件夹无法定位
    scrollDoneFor.current = null;
    setActiveFile(p); setSelected(new Set([p])); setAnchor(p);
  }, [root, load]);
  useEffect(() => registerActiveFolderReveal(workspaceId, revealFolder), [workspaceId, revealFolder]);

  // OS 文件导入回退路径：WebView 不支持 entry 接口时按 FileList（仅文件，无法递归文件夹）
  const importFiles = async (dir: string, files: FileList) => {
    let any = false;
    for (const f of Array.from(files)) {
      if (f.size > MAX_IMPORT) { setOpErr(`${f.name} 超过 20MB，未导入`); continue; }
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        await importDroppedFile(dir, f.name, Array.from(buf));
        any = true;
      } catch { setOpErr(`无法导入 ${f.name}`); }
    }
    if (any) { expand(dir); reloadDir(dir); }
  };

  // 递归把文件夹内容写进导入根 base（rel 为相对 base 的 '/' 路径，空字符串=base 自身）
  const uploadDirInto = async (dirEntry: FileSystemDirectoryEntry, base: string, rel: string) => {
    const kids = await listEntries(dirEntry);
    if (!kids.length) {
      if (rel) await importDroppedEntry(base, rel, true, []); // 保留空子目录（顶层目录已由 importMakeDir 建出）
      return;
    }
    for (const k of kids) {
      const childRel = rel ? `${rel}/${k.name}` : k.name;
      if (k.isFile) {
        const f = await entryFile(k as FileSystemFileEntry);
        if (f.size > MAX_IMPORT) { setOpErr(`${f.name} 超过 20MB，未导入`); continue; }
        const bytes = new Uint8Array(await f.arrayBuffer());
        await importDroppedEntry(base, childRel, false, Array.from(bytes));
      } else if (k.isDirectory) {
        await uploadDirInto(k as FileSystemDirectoryEntry, base, childRel);
      }
    }
  };

  // OS 拖入的顶层项（文件 / 文件夹）逐个复制进目标目录（文件夹保留内部结构）
  const importEntries = async (dir: string, entries: FileSystemEntry[]) => {
    setImporting(true);
    let any = false;
    try {
      for (const en of entries) {
        try {
          if (en.isFile) {
            const f = await entryFile(en as FileSystemFileEntry);
            if (f.size > MAX_IMPORT) { setOpErr(`${f.name} 超过 20MB，未导入`); continue; }
            const bytes = new Uint8Array(await f.arrayBuffer());
            await importDroppedFile(dir, f.name, Array.from(bytes));
            any = true;
          } else if (en.isDirectory) {
            const base = await importMakeDir(dir, en.name);
            await uploadDirInto(en as FileSystemDirectoryEntry, base, "");
            any = true;
          }
        } catch (err) { setOpErr(`导入 “${en.name}” 失败：${String(err)}`); }
      }
    } finally {
      setImporting(false);
    }
    if (any) { expand(dir); reloadDir(dir); }
  };

  // 落点：OS 文件/文件夹 → 复制（保留结构）；树内 file 拖拽 → 移动
  const onFolderDrop = async (dir: string, e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDropDir(null);
    if (e.dataTransfer.types.includes("Files")) {
      // 同步收集顶层 entry：DataTransferItem 在事件结束后失效，必须在任何 await 前取完
      const entries: FileSystemEntry[] = [];
      const items = e.dataTransfer.items;
      if (items?.length) {
        for (const it of Array.from(items)) {
          if (it.kind === "file") {
            const en = it.webkitGetAsEntry();
            if (en) entries.push(en);
          }
        }
      }
      if (entries.length) await importEntries(dir, entries);
      else if (e.dataTransfer.files?.length) await importFiles(dir, e.dataTransfer.files);
      return;
    }
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    try {
      const item = JSON.parse(raw) as { kind: string; path?: string; paths?: string[] };
      if (item.kind !== "file") return;
      const srcs = item.paths?.length ? item.paths : item.path ? [item.path] : [];
      const srcDirs = new Set<string>();
      const fails: string[] = [];
      for (const src of srcs) {
        if (src === dir || dir.startsWith(src) || dirOf(src) === dir) continue; // 跳过移入自身/子目录/原地
        try { await moveEntry(src, dir); srcDirs.add(dirOf(src)); }
        catch (err) { fails.push(`${baseName(src)}：${String(err)}`); }
      }
      expand(dir); reloadDir(dir); srcDirs.forEach(reloadDir);
      setSelected(new Set());
      if (fails.length) setOpErr(`部分移动失败：${fails.join("；")}`);
    } catch (err) { setOpErr(String(err)); }
  };

  const runPrompt = (title: string, initial: string, confirmText: string, run: (v: string) => Promise<void>) =>
    setPrompt({ title, initial, confirmText, run });

  // 批量删除确认（右键删除 / Delete 键共用）：逐项进回收站，失败不中断、汇总到 opErr
  const askDeletePaths = (paths: string[]) => {
    if (!paths.length) return;
    const names = paths.slice(0, 5).map(baseName).join("、") + (paths.length > 5 ? ` 等 ${paths.length} 项` : "");
    setConfirm({
      title: paths.length > 1 ? `删除选中的 ${paths.length} 项？` : `删除 “${baseName(paths[0])}”？`,
      message: `${names}\n将移动到系统回收站，可从那里恢复。`,
      run: async () => {
        const dirs = new Set<string>();
        const fails: string[] = [];
        for (const p of paths) {
          try { await deleteEntry(p); dirs.add(dirOf(p)); }
          catch (e) { fails.push(`${baseName(p)}：${String(e)}`); }
        }
        dirs.forEach(reloadDir);
        setSelected(new Set());
        setAnchor(null);
        if (fails.length) setOpErr(`部分删除失败：${fails.join("；")}`);
      },
    });
  };

  const doAction = async (id: string, node: DirEntry) => {
    const dir = dirFor(node);
    // 批量目标：右键已保证 selected 含命中项（命中未选时已重置为该项）；兜底单项
    const targets = selected.size ? [...selected] : [node.path];
    try {
      switch (id) {
        case "openEditor": openEditor(workspaceId, node.path); break;
        case "openTerminal": openTerminalAt(workspaceId, node.path); break;
        case "newFile":
          runPrompt("新建文件", "", "创建", async (v) => { await createEntry(dir, v, false); expand(dir); reloadDir(dir); });
          break;
        case "newFolder":
          runPrompt("新建文件夹", "", "创建", async (v) => { await createEntry(dir, v, true); expand(dir); reloadDir(dir); });
          break;
        case "rename":
          runPrompt("重命名", node.name, "重命名", async (v) => { await renameEntry(node.path, v); reloadDir(dirOf(node.path)); });
          break;
        case "delete": askDeletePaths(targets); break;
        case "cut": setClip({ paths: targets, mode: "cut" }); break;
        case "copy": setClip({ paths: targets, mode: "copy" }); break;
        case "paste":
          if (clip) {
            const fails: string[] = [];
            for (const p of clip.paths) {
              try {
                if (clip.mode === "cut") await moveEntry(p, dir);
                else await copyEntry(p, dir);
              } catch (err) { fails.push(`${baseName(p)}：${String(err)}`); }
            }
            expand(dir); reloadDir(dir);
            if (clip.mode === "cut") new Set(clip.paths.map(dirOf)).forEach(reloadDir);
            setClip(null);
            if (fails.length) setOpErr(`部分粘贴失败：${fails.join("；")}`);
          }
          break;
        case "copyPath": await navigator.clipboard.writeText(targets.join("\n")); break;
        case "copyRelPath": await navigator.clipboard.writeText(targets.map(relOf).join("\n")); break;
        case "reveal": await revealInExplorer(node.path); break;
        case "toggleFav": toggleFavFolder(node.path); break;
        case "ignoreFolder": ignoreFolder(node.name); break;
        case "ignoreExt": ignoreExt(extOf(node.name)); break;
      }
    } catch (e) {
      setOpErr(String(e));
    }
  };

  // 行点击：Ctrl 离散切换 / Shift 区间 / 无修饰键按 fileClickMode 决定「选中并打开/展开」或「仅选中」
  const clickRow = (entry: DirEntry, e: React.MouseEvent) => {
    const path = entry.path;
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      setAnchor(path);
      return;
    }
    if (e.shiftKey) {
      const i = anchor ? visibleOrder.indexOf(anchor) : -1;
      const j = visibleOrder.indexOf(path);
      if (i >= 0 && j >= 0) {
        const [lo, hi] = i <= j ? [i, j] : [j, i];
        setSelected(new Set(visibleOrder.slice(lo, hi + 1)));
      } else {
        setSelected(new Set([path]));
        setAnchor(path);
      }
      return;
    }
    setSelected(new Set([path]));
    setAnchor(path);
    if (s.fileClickMode === "open") {
      if (entry.isDir) toggle(path);
      else openEditor(workspaceId, path);
    }
  };
  // 双击：仅「单击选中」模式用——打开文件 / 展开目录（open 模式单击已处理，双击不再额外动作）
  const dblRow = (entry: DirEntry) => {
    if (s.fileClickMode !== "select") return;
    if (entry.isDir) toggle(entry.path);
    else openEditor(workspaceId, entry.path);
  };

  const renderNode = (entry: DirEntry, depth: number) => {
    const isOpen = expanded.has(entry.path);
    const pad = 8 + depth * 12;
    const isDrop = dropDir === entry.path;
    const isActive = entry.path === activeFile;
    const isSel = selected.has(entry.path);
    return (
      <div key={entry.path}>
        <div
          ref={
            isActive
              ? (el) => {
                  if (el && scrollDoneFor.current !== entry.path) {
                    scrollDoneFor.current = entry.path;
                    el.scrollIntoView({ block: "nearest" });
                  }
                }
              : undefined
          }
          draggable
          onDragStart={(e) => {
            // 拖动已选中项之一→整组；拖动未选中项→重置选区为该项(Windows 行为)
            const multi = selected.has(entry.path) && selected.size > 1;
            const paths = multi ? [...selected] : [entry.path];
            if (!multi && !selected.has(entry.path)) {
              setSelected(new Set([entry.path]));
              setAnchor(entry.path);
            }
            e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "file", path: entry.path, paths }));
            e.dataTransfer.effectAllowed = "copyMove";
            // 延后到下一帧再改 DOM：dragstart 期间同步增删 DOM 会被 WebView 取消本次拖拽
            requestAnimationFrame(() => setDragActive(true));
          }}
          onDragEnd={() => {
            setDragActive(false);
            setDropDir(null);
          }}
          onDragOver={
            entry.isDir
              ? (e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  if (dropDir !== entry.path) setDropDir(entry.path);
                }
              : undefined
          }
          onDragLeave={entry.isDir ? () => setDropDir((d) => (d === entry.path ? null : d)) : undefined}
          onDrop={entry.isDir ? (e) => onFolderDrop(entry.path, e) : undefined}
          onClick={(e) => clickRow(entry, e)}
          onDoubleClick={() => dblRow(entry)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // 决策 5：命中未选中项→选区重置为该项；命中已选中项→保持选区、对整组生效
            let count = selected.size;
            if (!selected.has(entry.path)) {
              setSelected(new Set([entry.path]));
              setAnchor(entry.path);
              count = 1;
            }
            setMenu({ x: e.clientX, y: e.clientY, node: entry, isTopLevel: depth === 0, count });
          }}
          title={entry.path}
          style={{ paddingLeft: pad }}
          className={
            "flex cursor-pointer items-center gap-1.5 rounded py-1 pr-2 text-[12px] text-[var(--text-deep)] " +
            (isDrop
              ? "bg-[var(--accent)]/15 ring-1 ring-inset ring-[var(--accent-border)]"
              : isSel
                ? "bg-[var(--accent)]/12"
                : "hover:bg-[var(--surface-hover)]")
          }
        >
          {entry.isDir ? (
            <span onClick={(e) => { e.stopPropagation(); toggle(entry.path); }} className="-m-1 shrink-0 p-1" title="展开/折叠">
              <Chevron open={isOpen} />
            </span>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {entry.isDir ? <FolderGlyph /> : <FileGlyph />}
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </div>
        {entry.isDir && isOpen && (
          <>
            {errors[entry.path] && <div style={{ paddingLeft: pad + 20 }} className="py-0.5 text-[10.5px] text-[var(--danger)]">读取失败</div>}
            {loading.has(entry.path) && !children[entry.path] && <div style={{ paddingLeft: pad + 20 }} className="py-0.5 text-[10.5px] text-[var(--text-3)]">加载中…</div>}
            {filterEntries(children[entry.path] ?? [], depth + 1).map((c) => renderNode(c, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const rootEntries = filterEntries(children[root] ?? [], 0);
  return (
    <div
      className="flex h-full flex-col bg-[var(--surface)]"
      onDragOver={(e) => {
        // 只为 OS 文件允许在空白处接收(导入到根)；内部拖拽不在空白处移动 → 防误触移到根目录
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files?.length) onFolderDrop(root, e);
      }}
    >
      <div className="flex items-center justify-between gap-2 px-2.5 pt-1 pb-1.5">
        <span className="min-w-0 truncate text-[10.5px] text-[var(--text-3)]" title={root}>{root || "未打开工作区"}</span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button onClick={() => setShowIgnore(true)} title="忽略名单" className="rounded px-1.5 py-0.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]">⊘</button>
          <button onClick={refresh} title="刷新" className="rounded px-1.5 py-0.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]">⟳</button>
        </div>
      </div>
      {opErr && (
        <div className="mx-2.5 mb-1 flex items-start gap-2 rounded-md border border-[var(--accent-border-soft)] bg-[var(--accent-soft)] px-2 py-1.5">
          <span className="text-[10.5px] leading-relaxed text-[var(--accent-text)]">{opErr}</span>
          <button onClick={() => setOpErr(null)} className="ml-auto shrink-0 text-[10px] text-[var(--text-3)] hover:text-[var(--text)]">✕</button>
        </div>
      )}
      {importing && (
        <div className="mx-2.5 mb-1 rounded-md border border-[var(--accent-border)] bg-[var(--accent-soft)] px-2 py-1.5 text-[10.5px] text-[var(--accent-text)]">
          正在导入…
        </div>
      )}
      {/* 移动到根目录投放区：常驻 + 高度/透明度过渡，丝滑淡入淡出 */}
      <div
        className={
          "shrink-0 overflow-hidden transition-all duration-200 ease-out " +
          (dragActive ? "max-h-20 opacity-100" : "pointer-events-none max-h-0 opacity-0")
        }
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!rootHot) setRootHot(true);
          }}
          onDragLeave={() => setRootHot(false)}
          onDrop={(e) => {
            setRootHot(false);
            setDragActive(false);
            onFolderDrop(root, e);
          }}
          className={
            "mx-2.5 mb-1.5 rounded-md border border-dashed px-2 py-2 text-center text-[11px] transition-colors " +
            (rootHot
              ? "border-[var(--accent)] bg-[var(--accent)]/12 text-[var(--accent-text)]"
              : "border-[var(--accent-border)] text-[var(--accent-text)]")
          }
        >
          ⬆ 拖到此处 → 移动到根目录
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {/* 自动滚动条带：常驻 + 透明度/滑入过渡；非拖拽时 pointer-events-none 不挡点击 */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            startScroll(-1);
          }}
          onDragLeave={stopScroll}
          className={
            "hty-scrollhint hty-scrollhint-top absolute inset-x-2.5 top-0 z-10 flex h-7 items-center justify-center overflow-hidden rounded-md border-b border-[var(--accent)]/30 text-[11px] font-semibold text-[var(--accent-text)] transition-all duration-200 ease-out " +
            (dragActive ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0")
          }
        >
          <span className="relative z-[1] inline-flex items-center gap-1">
            <span className="hty-hint-arrow">▲</span>悬停此处上滚
          </span>
        </div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            startScroll(1);
          }}
          onDragLeave={stopScroll}
          className={
            "hty-scrollhint hty-scrollhint-bottom absolute inset-x-2.5 bottom-0 z-10 flex h-7 items-center justify-center overflow-hidden rounded-md border-t border-[var(--accent)]/30 text-[11px] font-semibold text-[var(--accent-text)] transition-all duration-200 ease-out " +
            (dragActive ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0")
          }
        >
          <span className="relative z-[1] inline-flex items-center gap-1">
            <span className="hty-hint-arrow hty-hint-arrow-down">▼</span>悬停此处下滚
          </span>
        </div>
        <div
          ref={scrollRef}
          tabIndex={0}
          onScroll={(e) => setShowTop(e.currentTarget.scrollTop > 200)}
          onClick={(e) => { if (e.target === e.currentTarget) { setSelected(new Set()); setAnchor(null); } }}
          onKeyDown={(e) => {
            // 有弹窗/输入聚焦时不接管，避免吞掉重命名框/确认框的按键
            if (prompt || confirm || menu || showIgnore) return;
            const tag = (e.target as HTMLElement).tagName;
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            if (e.key === "Delete") {
              if (selected.size) { e.preventDefault(); askDeletePaths([...selected]); }
            } else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
              e.preventDefault();
              setSelected(new Set(visibleOrder));
            } else if (e.key === "Escape") {
              setSelected(new Set());
              setAnchor(null);
            }
          }}
          className="h-full overflow-y-auto px-1 pb-3 outline-none"
        >
          {/* 收藏文件夹：独立快速跳转区（原树仍照常显示，不隐藏） */}
          {favFolders.length > 0 && (
            <div className="mb-1.5">
              <div className="flex items-center gap-1.5 px-1.5 pt-1 pb-1 text-[10px] font-semibold tracking-wider text-[var(--text-3)] uppercase">
                <svg className="h-3 w-3 text-[var(--accent)]" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                </svg>
                收藏文件夹
              </div>
              {favFolders.map((p) => (
                <div
                  key={p}
                  onClick={() => revealFolder(p)}
                  title={p}
                  className="group flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-[var(--text-deep)] hover:bg-[var(--surface-hover)]"
                >
                  <FolderGlyph />
                  <span className="shrink-0 truncate font-medium">{baseName(p)}</span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-3)]">{relOf(dirOf(p))}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavFolder(p);
                    }}
                    title="取消收藏"
                    className="shrink-0 text-[var(--text-faint)] opacity-0 hover:text-[var(--danger)] group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="my-1.5 border-t border-[var(--border)]" />
            </div>
          )}
        {errors[root] && <div className="px-2 pt-4 text-center text-[11px] text-[var(--danger)]">读取失败：{errors[root]}</div>}
        {!errors[root] && loading.has(root) && rootEntries.length === 0 && <div className="px-2 pt-6 text-center text-[11px] text-[var(--text-3)]">加载中…</div>}
        {!errors[root] && !loading.has(root) && rootEntries.length === 0 && <div className="px-2 pt-6 text-center text-[11px] text-[var(--text-3)]">空目录（可把文件拖到这里）</div>}
        {rootEntries.map((e) => renderNode(e, 0))}
        </div>
        {/* 回到顶部：滚动超过阈值浮现（常驻 DOM + 过渡；拖拽时隐藏，避让底部自动滚动条带） */}
        <button
          type="button"
          title="回到顶部"
          aria-label="回到顶部"
          onClick={() =>
            scrollRef.current?.scrollTo({
              top: 0,
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            })
          }
          className={
            "absolute right-3 bottom-3 z-10 grid h-9 w-9 place-items-center rounded-full border border-[var(--accent-border)] bg-[var(--elevated)] text-[var(--accent-text)] shadow-lg transition-all duration-200 ease-out hover:bg-[var(--accent)] hover:text-white " +
            (showTop && !dragActive
              ? "pointer-events-auto translate-y-0 opacity-100"
              : "pointer-events-none translate-y-1 opacity-0")
          }
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        </button>
      </div>
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          node={menu.node}
          hasClipboard={!!clip}
          isTopLevel={menu.isTopLevel}
          favorited={isFavFolder(menu.node.path)}
          count={menu.count}
          onAction={(id) => doAction(id, menu.node)}
          onClose={() => setMenu(null)}
        />
      )}
      {prompt && (
        <PromptModal
          title={prompt.title}
          initial={prompt.initial}
          confirmText={prompt.confirmText}
          onConfirm={(v) => {
            const p = prompt;
            setPrompt(null);
            p.run(v).catch((e) => setOpErr(String(e)));
          }}
          onClose={() => setPrompt(null)}
        />
      )}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          onConfirm={() => confirm.run().catch((e) => setOpErr(String(e)))}
          onClose={() => setConfirm(null)}
        />
      )}
      {showIgnore && (
        <FileIgnoreModal cfg={ignore} onChange={applyIgnore} onClose={() => setShowIgnore(false)} />
      )}
    </div>
  );
}
