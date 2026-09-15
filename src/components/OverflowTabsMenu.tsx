import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IDockviewHeaderActionsProps } from "dockview-react";
import { searchMatch } from "../search";
import SearchBox from "./ui/SearchBox";
import ConfirmModal from "./ui/ConfirmModal";
import { Pager } from "./htyenv/sections/shared";
import { useMaskDismiss } from "./ui/maskDismiss";
import FileTypeIcon from "./ui/FileTypeIcon";
import { isEditorDirty } from "./DockEditor";

const PAGE_SIZE = 20;

function editorPathOf(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const path = (params as { editorPath?: unknown }).editorPath;
  return typeof path === "string" ? path : undefined;
}

/** 标签栏右侧「额外内容」：搜索 + 分页列出本组已打开标签，并提供关闭全部。 */
export default function OverflowTabsMenu({ panels, activePanel }: IDockviewHeaderActionsProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [confirmAll, setConfirmAll] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const mask = useMaskDismiss(() => {
    if (!confirmAll) setOpen(false);
  });

  useEffect(() => {
    setPage(1);
  }, [q, panels.length]);

  useEffect(() => {
    if (panels.length === 0) setOpen(false);
  }, [panels.length]);

  const filtered = useMemo(() => {
    return panels.filter((p) => {
      const path = editorPathOf(p.params) ?? "";
      return searchMatch(q, p.title || path, path, p.id);
    });
  }, [panels, q]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const slice = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);
  const dirtyCount = panels.filter((p) => isEditorDirty(p.id)).length;

  useLayoutEffect(() => {
    if (!open) return;
    const btn = btnRef.current?.getBoundingClientRect();
    const pop = popRef.current?.getBoundingClientRect();
    if (!btn || !pop) return;
    let left = btn.right - pop.width;
    let top = btn.bottom + 4;
    if (left < 4) left = 4;
    if (left + pop.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - pop.width - 4);
    if (top + pop.height > window.innerHeight - 4) top = Math.max(4, btn.top - pop.height - 4);
    setPos({ left, top });
  }, [open, filtered.length, curPage, q]);

  if (panels.length === 0) return null;

  const closeAll = () => {
    panels.slice().forEach((p) => p.api.close());
    setConfirmAll(false);
    setOpen(false);
  };

  return (
    <div className="relative flex h-full w-fit items-stretch">
      <button
        ref={btnRef}
        type="button"
        title={`已打开 ${panels.length} 个标签`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => {
          setOpen((v) => !v);
          setQ("");
          setPage(1);
        }}
        className="flex h-full items-center gap-0.5 px-1.5 text-[11px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      >
        <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M2 4l4 4 4-4" />
        </svg>
        <span>{panels.length}</span>
      </button>
      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[60]" {...mask} />
            <div
              ref={popRef}
              data-hty-overlay
              style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 61 }}
              className="flex w-[360px] max-w-[92vw] flex-col rounded-xl border border-[var(--border)] bg-[var(--elevated)] py-2 shadow-2xl"
            >
              <div className="px-2.5 pb-2">
                <SearchBox value={q} onChange={setQ} placeholder="搜索已打开的标签…" autoFocus />
                <div className="mt-1.5 text-[10px] text-[var(--text-3)]">
                  {q.trim() ? `匹配 ${filtered.length} / ${panels.length}` : `共 ${panels.length} 个`}
                </div>
              </div>
              <div className="px-1.5">
                {slice.length === 0 ? (
                  <div className="py-6 text-center text-[11px] text-[var(--text-3)]">无匹配标签</div>
                ) : (
                  slice.map((p) => {
                    const path = editorPathOf(p.params);
                    const active = p.id === activePanel?.id;
                    return (
                      <div
                        key={p.id}
                        className={
                          "group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left " +
                          (active ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--surface)]")
                        }
                      >
                        <button
                          type="button"
                          title={path || p.title}
                          onClick={() => {
                            p.api.setActive();
                            requestAnimationFrame(() =>
                              document.querySelector(".dv-tab.dv-active-tab")?.scrollIntoView({
                                block: "nearest",
                                inline: "nearest",
                              }),
                            );
                            setOpen(false);
                          }}
                          className="flex min-w-0 flex-1 items-center gap-1.5"
                        >
                          {path ? <FileTypeIcon path={path} /> : (
                            <span className="h-[15px] w-[15px] shrink-0 rounded bg-[var(--surface-hover)]" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)]">
                            {p.title || (path ? path.split(/[\\/]/).pop() : p.id)}
                          </span>
                          {isEditorDirty(p.id) && (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" title="未保存" />
                          )}
                        </button>
                        <button
                          type="button"
                          title="关闭"
                          onPointerDown={(e) => e.preventDefault()}
                          onClick={(e) => {
                            e.stopPropagation();
                            p.api.close();
                          }}
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-3)] opacity-0 transition-opacity hover:bg-[var(--surface-hover)] hover:text-[var(--text)] group-hover:opacity-100"
                        >
                          <svg className="h-2.5 w-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
                            <path d="M1 1l8 8M9 1l-8 8" />
                          </svg>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
              <Pager page={curPage} pageCount={pageCount} onPage={setPage} />
              <div className="mt-1 flex items-center gap-2 border-t border-[var(--border-soft)] px-2.5 pt-2">
                <span className="text-[10px] text-[var(--text-3)]">{panels.length} 个标签</span>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => setConfirmAll(true)}
                  className="rounded-md px-2 py-1 text-[12px] font-semibold text-[var(--danger)] hover:bg-[var(--danger)]/8"
                >
                  关闭全部
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
      {confirmAll &&
        createPortal(
          <ConfirmModal
            title="关闭全部标签？"
            confirmText="关闭全部"
            zIndex={130}
            message={
              dirtyCount > 0
                ? `将关闭 ${panels.length} 个标签，其中 ${dirtyCount} 个文件有未保存改动，关闭后这些改动会丢失。`
                : `将关闭全部 ${panels.length} 个标签。`
            }
            onConfirm={closeAll}
            onClose={() => setConfirmAll(false)}
          />,
          document.body,
        )}
    </div>
  );
}
