import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DirEntry } from "../catalog";

interface Item {
  id: string;
  label: string;
  danger?: boolean;
}
const SEP = "sep" as const;

/** M9：文件树自定义右键菜单（非系统默认）。点项 → onAction(id) + 关闭。 */
export default function FileContextMenu({
  x,
  y,
  node,
  hasClipboard,
  isTopLevel,
  favorited,
  count,
  canOpenTerminal = true,
  onAction,
  onClose,
}: {
  x: number;
  y: number;
  node: DirEntry;
  hasClipboard: boolean;
  isTopLevel: boolean;
  favorited: boolean;
  count: number;
  /** 关掉「在集成终端打开」——内容预览窗口没有终端 */
  canOpenTerminal?: boolean;
  onAction: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: x + r.width > window.innerWidth ? Math.max(4, window.innerWidth - r.width - 4) : x,
      top: y + r.height > window.innerHeight ? Math.max(4, window.innerHeight - r.height - 4) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const dot = node.name.lastIndexOf(".");
  const ext = node.isDir || dot <= 0 ? "" : node.name.slice(dot + 1).toLowerCase();
  const paste: (Item | typeof SEP)[] = hasClipboard ? [{ id: "paste", label: "粘贴" }] : [];
  const ignoreItems: Item[] = [
    ...(isTopLevel && node.isDir ? [{ id: "ignoreFolder", label: "忽略此文件夹" }] : []),
    ...(ext ? [{ id: "ignoreExt", label: `忽略 .${ext} 文件` }] : []),
  ];
  const common: (Item | typeof SEP)[] = [
    { id: "newFile", label: "新建文件" },
    { id: "newFolder", label: "新建文件夹" },
    SEP,
    { id: "cut", label: "剪切" },
    { id: "copy", label: "复制" },
    ...paste,
    SEP,
    { id: "copyPath", label: "复制路径" },
    { id: "copyRelPath", label: "复制相对路径" },
    { id: "reveal", label: "在资源管理器中显示" },
    ...(ignoreItems.length ? [SEP, ...ignoreItems] : []),
    SEP,
    { id: "rename", label: "重命名" },
    { id: "delete", label: "删除", danger: true },
  ];
  const head: (Item | typeof SEP)[] = node.isDir
    ? [
        // 内容预览窗口没有终端，隐去该项而不是留个点了没反应的菜单
        ...(canOpenTerminal ? [{ id: "openTerminal", label: "在集成终端打开" } as Item] : []),
        { id: "toggleFav", label: favorited ? "取消收藏文件夹" : "收藏文件夹" },
        SEP,
      ]
    : [{ id: "openEditor", label: "在编辑器打开" }, SEP];
  // 多选(>1)：只保留对多项有意义的批量项（决策 6）；单选与现状逐项一致
  const multi: (Item | typeof SEP)[] = [
    { id: "cut", label: `剪切 ${count} 项` },
    { id: "copy", label: `复制 ${count} 项` },
    SEP,
    { id: "copyPath", label: "复制路径" },
    { id: "copyRelPath", label: "复制相对路径" },
    SEP,
    { id: "delete", label: `删除 ${count} 项`, danger: true },
  ];
  const items = count > 1 ? multi : [...head, ...common];

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 120 }}
      className="min-w-[190px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--elevated)] py-1 shadow-xl"
    >
      {items.map((it, i) =>
        it === SEP ? (
          <div key={`s${i}`} className="my-1 border-t border-[var(--border-soft)]" />
        ) : (
          <button
            key={it.id}
            onClick={() => {
              onAction(it.id);
              onClose();
            }}
            className={
              "block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface)] " +
              (it.danger ? "text-[var(--danger)]" : "text-[var(--text-deep)]")
            }
          >
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
