import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  exportMemoryArchive,
  importMemoryArchive,
  inspectMemoryArchive,
  listMemoryTree,
  type MemoryImportPreview,
  type MemoryNode,
} from "../catalog";
import SearchBox from "./ui/SearchBox";
import InfoCard from "./ui/InfoCard";
import ConfirmModal from "./ui/ConfirmModal";
import TransferNotice, { type TransferNoticeValue } from "./ui/TransferNotice";
import { useSettings } from "../settings";
import { searchMatch } from "../search";
import { getWsState, setWsState } from "../wsState";

const typeColor: Record<string, string> = {
  user: "#2fa35e",
  feedback: "#d6453e",
  project: "#c15f3c",
  reference: "#4f7cc4",
};

// 分组文件夹名美化：index_0_set_core → core；index_5_mod → mod
// Memory 树展开按工作区(slug)持久化（完整复原）
const MEXP_KEY = "htybox.memoryExpanded.v1";
const prettyGroup = (n: string) => n.replace(/^index_\d+_(set_)?/, "") || n;
const countTopics = (node: MemoryNode): number =>
  node.isDir ? node.children.reduce((s, c) => s + countTopics(c), 0) : 1;

type MemoryBusy = "inspect" | "import" | "export";
type ReloadResult = "ok" | "failed" | "stale";

interface PendingMemoryImport {
  archivePath: string;
  workspacePath: string;
  preview: MemoryImportPreview;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
};

const memoryArchiveName = (workspacePath: string): string => {
  const parts = workspacePath.split(/[\\/]/).filter(Boolean);
  const leaf = parts[parts.length - 1] ?? "workspace";
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
    .trim()
    .replace(/[. ]+$/g, "");
  const shortened = Array.from(cleaned || "workspace").slice(0, 80).join("").replace(/[. ]+$/g, "");
  return `${shortened || "workspace"}-claude-memory.htybox-memory`;
};

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={"h-3 w-3 shrink-0 text-[var(--text-faint)] transition-transform " + (open ? "rotate-90" : "")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
  );
}
function FolderGlyph() {
  return <svg className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" /></svg>;
}

/** 只显示当前工作区记忆。slug 只作 UI 状态 scope，真实目标由 workspacePath 后端解析。 */
export default function MemoryPanel({
  slug,
  workspacePath,
}: {
  slug: string;
  workspacePath: string;
}) {
  const [tree, setTree] = useState<MemoryNode[]>([]);
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(getWsState<string[]>(MEXP_KEY, slug, [])));
  const loadSeq = useRef(0);
  const transferGeneration = useRef(0);
  const currentWorkspacePath = useRef(workspacePath);
  const busyRef = useRef<MemoryBusy | null>(null);
  const [busy, setBusy] = useState<MemoryBusy | null>(null);
  const [notice, setNotice] = useState<TransferNoticeValue | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingMemoryImport | null>(null);
  const { hoverPreview } = useSettings();

  const reload = useCallback(async (
    silent = true,
    reportError = !silent,
  ): Promise<ReloadResult> => {
    const seq = ++loadSeq.current;
    if (!silent) setTree([]);
    if (!workspacePath) {
      if (seq === loadSeq.current) setTree([]);
      return seq === loadSeq.current ? "ok" : "stale";
    }
    try {
      const next = await listMemoryTree(workspacePath);
      if (seq !== loadSeq.current) return "stale";
      setTree(next);
      return "ok";
    } catch (error) {
      if (seq !== loadSeq.current) return "stale";
      if (!silent) setTree([]);
      if (reportError) {
        setNotice({
          tone: "error",
          message: `加载 Claude Memory 失败：${String(error)}`,
          details: ["请检查当前工作区、Claude projects 目录权限后重试。"],
        });
      }
      return "failed";
    }
  }, [workspacePath]);

  useLayoutEffect(() => {
    currentWorkspacePath.current = workspacePath;
    loadSeq.current += 1;
    transferGeneration.current += 1;
    busyRef.current = null;
    setTree([]);
    setBusy(null);
    setNotice(null);
    setPendingImport(null);
    return () => {
      transferGeneration.current += 1;
      busyRef.current = null;
    };
  }, [workspacePath]);

  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    void reload(false);
    setExpanded(new Set(getWsState<string[]>(MEXP_KEY, slug, []))); // 切工作区复原展开层级
    void listen("memory-changed", () => {
      if (!disposed) void reload(true);
    })
      .then((u) => {
        if (disposed) u();
        else {
          un = u;
          void reload(true, true); // 注册完成后补拉，并让当前请求失败时仍向用户显示可操作错误
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      un?.();
      loadSeq.current += 1;
    };
  }, [reload, slug]);

  const setTransferBusy = (next: MemoryBusy | null) => {
    busyRef.current = next;
    setBusy(next);
  };

  const performImport = async (
    archivePath: string,
    preview: MemoryImportPreview,
    operationWorkspace: string,
    isCurrent: () => boolean,
  ): Promise<void> => {
    const result = await importMemoryArchive(
      operationWorkspace,
      archivePath,
      preview.archiveSha256,
      preview.targetRevision,
    );
    if (!isCurrent()) return;
    const refresh = await reload(true);
    if (!isCurrent()) return;
    const retained = result.retainedBackupPath
      ? [`旧快照保留：${result.retainedBackupPath}`]
      : [];
    const refreshWarning =
      refresh === "failed"
        ? ["导入已提交但刷新失败，请手动刷新。"]
        : [];
    setNotice({
      tone: "success",
      message: "已导入 Claude Memory 完整快照",
      details: [result.targetPath, ...retained, ...refreshWarning, ...result.warnings],
    });
  };

  const exportAll = async () => {
    if (busyRef.current) return;
    const operationWorkspace = workspacePath;
    const generation = ++transferGeneration.current;
    const isCurrent = () =>
      generation === transferGeneration.current &&
      currentWorkspacePath.current === operationWorkspace;
    setTransferBusy("export");
    try {
      const destination = await save({
        title: "导出 Claude Memory",
        defaultPath: memoryArchiveName(operationWorkspace),
        filters: [{ name: "HtyBox Memory", extensions: ["htybox-memory"] }],
      });
      if (!isCurrent() || destination === null) return;
      setNotice(null);
      const result = await exportMemoryArchive(operationWorkspace, destination);
      if (!isCurrent()) return;
      setNotice({
        tone: "success",
        message: `已导出 Claude Memory（${result.fileCount.toLocaleString()} 个文件）`,
        details: [result.path, ...result.warnings],
      });
    } catch (error) {
      if (isCurrent()) {
        setNotice({ tone: "error", message: `导出 Claude Memory 失败：${String(error)}` });
      }
    } finally {
      if (isCurrent()) setTransferBusy(null);
    }
  };

  const chooseImport = async () => {
    if (busyRef.current) return;
    const operationWorkspace = workspacePath;
    const generation = ++transferGeneration.current;
    const isCurrent = () =>
      generation === transferGeneration.current &&
      currentWorkspacePath.current === operationWorkspace;
    setTransferBusy("inspect");
    try {
      const archivePath = await open({
        title: "导入 Claude Memory",
        multiple: false,
        directory: false,
        filters: [{ name: "HtyBox Memory", extensions: ["htybox-memory"] }],
      });
      if (!isCurrent() || archivePath === null) return;
      const preview = await inspectMemoryArchive(operationWorkspace, archivePath);
      if (!isCurrent()) return;
      if (preview.targetNonEmpty) {
        setPendingImport({ archivePath, workspacePath: operationWorkspace, preview });
      } else {
        setTransferBusy("import");
        await performImport(archivePath, preview, operationWorkspace, isCurrent);
      }
    } catch (error) {
      if (isCurrent()) {
        setNotice({ tone: "error", message: `导入 Claude Memory 失败：${String(error)}` });
      }
    } finally {
      if (isCurrent()) setTransferBusy(null);
    }
  };

  const commitPendingImport = async (pending: PendingMemoryImport) => {
    if (busyRef.current || pending.workspacePath !== currentWorkspacePath.current) return;
    const operationWorkspace = pending.workspacePath;
    const generation = ++transferGeneration.current;
    const isCurrent = () =>
      generation === transferGeneration.current &&
      currentWorkspacePath.current === operationWorkspace;
    setNotice(null);
    setTransferBusy("import");
    try {
      await performImport(pending.archivePath, pending.preview, operationWorkspace, isCurrent);
    } catch (error) {
      if (isCurrent()) {
        setNotice({ tone: "error", message: `导入 Claude Memory 失败：${String(error)}` });
      }
    } finally {
      if (isCurrent()) setTransferBusy(null);
    }
  };

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      setWsState(MEXP_KEY, slug, [...n]); // 持久化展开态（完整复原）
      return n;
    });

  // 搜索过滤：文件按名/描述匹配；文件夹有命中后代才保留
  const keep = (node: MemoryNode): boolean => {
    if (!q.trim()) return true;
    if (node.isDir) return node.children.some(keep);
    return searchMatch(q, node.name, node.description);
  };
  const searching = q.trim().length > 0;
  const filtered = useMemo(() => tree.filter(keep), [tree, q]);

  const renderCard = (m: MemoryNode, pad: number) => {
    const c = typeColor[m.memType] ?? "#8c8a82";
    return (
      <div key={m.path} style={{ paddingLeft: pad }}>
        <InfoCard
          name={m.name}
          hoverEnabled={hoverPreview}
          onDragStart={(e) => {
            e.dataTransfer.setData("application/x-htybox-item", JSON.stringify({ kind: "memory", path: m.path }));
            e.dataTransfer.effectAllowed = "copy";
          }}
          preview={
            <>
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-[var(--text)]">{m.name}</span>
                {m.memType && (
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold tracking-wide uppercase" style={{ color: c, background: c + "22" }}>
                    {m.memType}
                  </span>
                )}
              </div>
              <div className="mt-1 font-mono text-[10px] break-all text-[var(--text-3)]">{m.path}</div>
              <div className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-2)]">{m.description || "（无描述）"}</div>
            </>
          }
        />
      </div>
    );
  };

  const renderNode = (node: MemoryNode, depth: number) => {
    if (!node.isDir) return renderCard(node, 8 + depth * 12);
    const open = searching || expanded.has(node.path);
    const kids = node.children.filter(keep);
    return (
      <div key={node.path}>
        <div
          onClick={() => toggle(node.path)}
          style={{ paddingLeft: 8 + depth * 12 }}
          className="flex cursor-pointer items-center gap-1.5 rounded py-1 pr-2 text-[12px] font-semibold text-[var(--text-deep)] hover:bg-[var(--surface-hover)]"
        >
          <Chevron open={open} />
          <FolderGlyph />
          <span className="min-w-0 flex-1 truncate">{prettyGroup(node.name)}</span>
          <span className="shrink-0 text-[10px] font-normal text-[var(--text-3)]">{countTopics(node)}</span>
        </div>
        {open && <div className="mt-1 space-y-1.5">{kids.map((k) => renderNode(k, depth + 1))}</div>}
      </div>
    );
  };

  const visibleNotice: TransferNoticeValue | null = busy
    ? {
        tone: "busy",
        message:
          busy === "inspect"
            ? "正在检查 Memory 包…"
            : busy === "import"
              ? "正在导入 Claude Memory…"
              : "正在导出 Claude Memory…",
      }
    : notice;

  return (
    <div className="flex h-full flex-col bg-[var(--surface)]">
      <div className="flex items-center gap-2 px-2.5 pt-1 pb-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] font-semibold text-[var(--text)]">Claude Memory</div>
          <div className="truncate text-[9px] text-[var(--text-3)]">暂不支持 Codex / Cursor</div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void chooseImport()}
            disabled={busy !== null}
            title="导入 Claude Memory 完整快照"
            className="rounded-md px-1.5 py-1 text-[10.5px] font-semibold text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            导入
          </button>
          <button
            type="button"
            onClick={() => void exportAll()}
            disabled={busy !== null}
            title="导出 Claude Memory 完整快照"
            className="rounded-md px-1.5 py-1 text-[10.5px] font-semibold text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            导出
          </button>
        </div>
      </div>
      {visibleNotice && (
        <TransferNotice
          value={visibleNotice}
          onClose={busy ? undefined : () => setNotice(null)}
        />
      )}
      <div className="px-2.5 pb-2">
        <SearchBox value={q} onChange={setQ} placeholder="搜索本工作区 memory…" />
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-3">
        {filtered.length === 0 && (
          <div className="px-1 pt-6 text-center text-[11px] text-[var(--text-3)]">
            {searching ? "无匹配 memory" : "本工作区暂无 memory"}
          </div>
        )}
        {filtered.map((n) => renderNode(n, 0))}
      </div>
      {pendingImport && (
        <ConfirmModal
          title="整体替换 Claude Memory？"
          confirmText="整体替换"
          message={
            <div className="space-y-2">
              <div>
                包含 {pendingImport.preview.fileCount.toLocaleString()} 个文件、
                {pendingImport.preview.directoryCount.toLocaleString()} 个目录，共 {formatBytes(pendingImport.preview.totalBytes)}。
              </div>
              <div>
                目标非空，继续后将<strong className="text-[var(--danger)]">整体替换</strong>以下目录，不会与现有 Memory 合并：
              </div>
              <div className="break-all rounded-md bg-[var(--surface)] px-2 py-1.5 font-mono text-[10.5px] text-[var(--text-2)]">
                {pendingImport.preview.targetPath}
              </div>
            </div>
          }
          onConfirm={() => void commitPendingImport(pendingImport)}
          onClose={() => setPendingImport(null)}
        />
      )}
    </div>
  );
}
