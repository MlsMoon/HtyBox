// 内容预览窗口的根组件（独立窗口，不含终端）。
// 结构：自绘标题栏（与主窗同款 WindowControls）+ dockview 内容区（面板全是 DockEditor）。
// 主窗把「打开某文件」经 Tauri 事件推过来，这里负责去重 / 建面板 / 激活。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import DockEditor, { adoptEditorBuf, collectEditorBuf, disposeEditorBuf, isEditorDirty } from "./DockEditor";
import FileTypeIcon from "./ui/FileTypeIcon";
import WindowControls from "./WindowControls";
import { EV_ADOPT, EV_CLOSED, EV_OPEN_FILE, EV_READY, type AdoptItem } from "../previewProtocol";
import { SETTINGS_CHANGED, reloadSettings } from "../settings";
import { writeTextFile } from "../catalog";
import { useMaskDismiss } from "./ui/maskDismiss";
import { useDoubleShift } from "./ui/useDoubleShift";
import { SidebarToggleIcon, useSidebarToggle } from "./ui/SidebarToggle";
import QuickOpen from "./QuickOpen";
import { getWsState, setWsState } from "../wsState";
import { getSettings } from "../settings";
import { registerFileOpener, registerFileRevealer } from "../fileOpenBus";
import { emitActiveFile } from "../dockBus";
import { Allotment } from "allotment";
import FilePanel from "./FilePanel";
import { initFont } from "../fonts";
import { initTheme } from "../theme";

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

interface EditorParams {
  editorPath: string;
}

/** Tab：文件类型徽章 + 文件名 + 关闭。比主窗 Tab 简单——这里没有重命名 / 标签 / 会话概念。 */
function PreviewTab(props: IDockviewPanelHeaderProps<EditorParams>) {
  const path = props.params.editorPath;
  return (
    <div className="group flex h-full items-center gap-1.5 px-2.5" title={path}>
      <FileTypeIcon path={path} />
      <span className="max-w-[180px] truncate text-[11.5px]">{props.api.title}</span>
      <button
        // 与主窗 DockTab 同一道防线：dockview 在 .dv-tab 上【冒泡】监听 pointerdown 并 openPanel，
        // 点非激活 Tab 的 ✕ 会先切过去再关 → 闪一下。捕获阶段 preventDefault 命中它的
        // defaultPrevented 逃生通道，赶在冒泡监听读取之前置位。
        onPointerDownCapture={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          props.api.close();
        }}
        className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-[var(--text-3)] opacity-0 transition-opacity hover:bg-[var(--surface-hover)] hover:text-[var(--text)] group-hover:opacity-100"
      >
        <svg className="h-2.5 w-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M1 1l8 8M9 1l-8 8" />
        </svg>
      </button>
    </div>
  );
}

function Watermark({ name }: { name: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--bg)] text-center">
      <svg className="h-9 w-9 text-[var(--text-3)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <rect x="1.5" y="3" width="14" height="11" rx="2.2" />
        <rect x="8.5" y="10" width="14" height="11" rx="2.2" fill="var(--bg)" />
      </svg>
      <div className="text-[12.5px] text-[var(--text-2)]">内容预览 · {name}</div>
      <div className="text-[11px] text-[var(--text-3)]">
        在主窗点开文件 / SVG / 图片，或在本窗双击 Shift（Ctrl+P）搜索打开
      </div>
    </div>
  );
}

const components = { editor: DockEditor };

/** 已打开的 Tab 按工作区持久化：窗口真关闭后重开，上次那批文件原样回来。 */
const TABS_KEY = "htybox.previewTabs.v1";
/** 预览窗左栏文件树的显隐与宽度，同样按工作区记忆。 */
const SIDEBAR_KEY = "htybox.previewSidebar.v1";
const SPLIT_KEY = "htybox.previewSplit.v1";

export default function PreviewApp({
  workspaceId,
  workspacePath,
  workspaceName,
}: {
  workspaceId: string;
  workspacePath: string;
  workspaceName: string;
}) {
  const apiRef = useRef<DockviewApi | null>(null);
  const seqRef = useRef(0);
  const [empty, setEmpty] = useState(true);
  /** 关闭时检出的未保存文件（非空 = 正在显示确认弹窗） */
  const [pendingClose, setPendingClose] = useState<Array<{ id: string; path: string }> | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  // 与主窗共用 useSidebarToggle：显隐 + 收放动画 + 落盘，手感完全一致
  const {
    visible: sidebarVisible,
    animClass: sidebarAnimClass,
    toggle: toggleSidebar,
    syncFromDrag: syncSidebarFromDrag,
  } = useSidebarToggle(
    () => getWsState<boolean>(SIDEBAR_KEY, workspaceId, true),
    (v) => setWsState(SIDEBAR_KEY, workspaceId, v),
  );
  const maskDismiss = useMaskDismiss(() => setPendingClose(null)); // 点遮罩 = 取消关闭

  /** 打开一个文件面板：已开则激活，未开则新建。 */
  const openPath = useCallback((path: string, content?: string) => {
    const api = apiRef.current;
    if (!api) return;
    const existing = api.panels.find(
      (p) => (p.params as EditorParams | undefined)?.editorPath === path,
    );
    if (existing) {
      existing.api.setActive();
      return;
    }
    const id = `p-${(seqRef.current++).toString(36)}`;
    if (content !== undefined) adoptEditorBuf(id, content); // 迁移来的未保存内容，先于面板挂载写入
    api.addPanel({
      id,
      component: "editor",
      title: basename(path),
      params: { editorPath: path, workspaceId, workspaceRoot: workspacePath },
    });
  }, [workspaceId, workspacePath]);

  // md 预览里的链接点开另一个文件 → 在本窗新开 Tab（主窗那侧由 TerminalDock 注册同名通道）
  useEffect(() => registerFileOpener(workspaceId, (p) => openPath(p)), [workspaceId, openPath]);
  // 本窗打开某文件时让左栏文件树揭示并定位它（与主窗同款链路）
  useEffect(
    () => registerFileRevealer(workspaceId, (p) => emitActiveFile(workspaceId, p)),
    [workspaceId],
  );

  const onReady = useCallback(
    (e: DockviewReadyEvent) => {
      apiRef.current = e.api;
      const persist = () =>
        setWsState(
          TABS_KEY,
          workspaceId,
          e.api.panels
            .map((p) => (p.params as EditorParams | undefined)?.editorPath)
            .filter((x): x is string => !!x),
        );
      const sync = () => {
        setEmpty(e.api.panels.length === 0);
        persist();
      };
      // 与主窗同一语义：标签不可选中时，激活后把焦点从标签移走（本窗没有终端，故只需 blur）
      e.api.onDidActivePanelChange(() => {
        if (getSettings().tabSelectable) return;
        requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.blur?.());
      });
      e.api.onDidAddPanel(sync);
      e.api.onDidRemovePanel((p) => {
        disposeEditorBuf(p.id); // 与主窗一致：面板关闭即释放未保存缓冲
        sync();
      });
      // 复原上次关窗时开着的 Tab（迁移过来的重复项由 openPath 去重）
      for (const path of getWsState<string[]>(TABS_KEY, workspaceId, [])) openPath(path);
      sync();
      // 就绪后告知主窗：可以推送存量编辑器了（迁移流程见 Step 4）
      emitTo("main", EV_READY, { wsId: workspaceId }).catch(() => {});
    },
    [workspaceId, openPath],
  );

  // 主窗推来的「打开文件」/「接管这批编辑器」
  useEffect(() => {
    const un: Array<() => void> = [];
    listen<{ path: string }>(EV_OPEN_FILE, (e) => openPath(e.payload.path)).then((u) => un.push(u));
    listen<{ items: AdoptItem[] }>(EV_ADOPT, (e) => {
      for (const it of e.payload.items) openPath(it.path, it.content);
    }).then((u) => un.push(u));
    // 主窗改了设置 / 主题 / 字体 → 本窗重读同一份 localStorage 并重应用
    listen(SETTINGS_CHANGED, () => {
      reloadSettings();
      initTheme();
      initFont();
    }).then((u) => un.push(u));
    return () => un.forEach((u) => u());
  }, [openPath]);

  useEffect(() => {
    getCurrentWindow()
      .setTitle(`内容预览 · ${workspaceName}`)
      .catch(() => {});
  }, [workspaceName]);

  // 唤起本窗文件搜索：Ctrl+P，或与主窗同款的双击 Shift（肌肉记忆一致）。
  // 本窗没有左栏，故只做"选中即在本窗打开"，不涉及主窗那套文件树定位语义。
  useDoubleShift(() => setQuickOpen(true));
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "p") {
        ev.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 防误触：默认不允许用 Delete/Backspace 关标签页（焦点常在标签上，本想删输入却关了面板）。
  // dockview 的 keydown 绑在 tabsList 上走冒泡，捕获阶段 stopPropagation 即可拦下。
  const onTabKeyDownCapture = (e: React.KeyboardEvent) => {
    if (getSettings().tabSelectable) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if ((e.target as HTMLElement).closest(".dv-tab")) e.stopPropagation();
  };

  /** 关窗收尾：告知主窗（按钮回未开态 + 记忆置关）后再销毁自己。 */
  const finishClose = useCallback(async () => {
    const win = getCurrentWindow();
    await emitTo("main", EV_CLOSED, { wsId: workspaceId }).catch((e) =>
      console.error("通知主窗预览窗口已关闭失败", e),
    );
    await win.destroy();
  }, [workspaceId]);

  // 关闭拦截：有未保存改动先弹自定义确认（禁用浏览器默认对话框，与项目其余弹窗同款）
  useEffect(() => {
    const win = getCurrentWindow();
    let un: (() => void) | undefined;
    win
      .onCloseRequested((e) => {
        e.preventDefault(); // 一律先拦下：既为脏检查，也为确保 EV_CLOSED 能送达主窗
        const api = apiRef.current;
        const dirty = (api?.panels ?? [])
          .map((p) => ({ id: p.id, path: (p.params as EditorParams | undefined)?.editorPath ?? "" }))
          .filter((x) => x.path && isEditorDirty(x.id));
        if (dirty.length) setPendingClose(dirty);
        else void finishClose();
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [finishClose]);

  /** 保存全部未保存改动后关闭。写盘失败则中止关闭并把错误显示在弹窗里，不静默丢内容。 */
  const saveAllAndClose = useCallback(async () => {
    if (!pendingClose) return;
    setSaveErr(null);
    try {
      for (const it of pendingClose) {
        const content = collectEditorBuf(it.id);
        if (content !== undefined) await writeTextFile(it.path, content);
      }
    } catch (e) {
      setSaveErr(String(e));
      return;
    }
    await finishClose();
  }, [pendingClose, finishClose]);

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg)]">
      <div
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-stretch border-b border-[var(--border)] bg-[var(--surface)]"
      >
        <button
          onClick={toggleSidebar}
          title={sidebarVisible ? "隐藏文件树" : "显示文件树"}
          className="flex h-full w-10 shrink-0 items-center justify-center text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] hover:text-[var(--text)]"
        >
          <SidebarToggleIcon open={sidebarVisible} />
        </button>
        <div data-tauri-drag-region className="flex flex-1 items-center gap-2 px-3">
          <svg className="h-4 w-4 shrink-0 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            <rect x="1.5" y="3" width="14" height="11" rx="2.2" />
            <rect x="8.5" y="10" width="14" height="11" rx="2.2" fill="var(--accent-soft)" />
          </svg>
          <span data-tauri-drag-region className="truncate text-[11.5px] font-semibold text-[var(--text-deep)]">
            内容预览 · {workspaceName}
          </span>
        </div>
        <WindowControls />
      </div>
      <div className={"min-h-0 flex-1" + sidebarAnimClass}>
        <Allotment
          proportionalLayout={false}
          defaultSizes={getWsState<number[] | undefined>(SPLIT_KEY, workspaceId, undefined)}
          onChange={(sizes) => setWsState(SPLIT_KEY, workspaceId, sizes)}
          onVisibleChange={(index, visible) => {
            if (index === 0) syncSidebarFromDrag(visible);
          }}
        >
          <Allotment.Pane minSize={200} preferredSize={280} visible={sidebarVisible}>
            {/* 文件预览配套文件树用起来才顺手；这里没有终端，故隐去「在集成终端打开」 */}
            <div className="h-full bg-[var(--surface)]">
              <FilePanel root={workspacePath} workspaceId={workspaceId} canOpenTerminal={false} />
            </div>
          </Allotment.Pane>
          <Allotment.Pane minSize={360}>
            <div
              className="dockview-theme-light relative h-full w-full"
              onKeyDownCapture={onTabKeyDownCapture}
            >
              <DockviewReact components={components} defaultTabComponent={PreviewTab} onReady={onReady} />
              {empty && (
                <div className="pointer-events-none absolute inset-0">
                  <Watermark name={workspaceName} />
                </div>
              )}
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>

      {quickOpen && (
        <QuickOpen
          root={workspacePath}
          workspaceId={workspaceId}
          onClose={() => setQuickOpen(false)}
          onPick={(path) => openPath(path)}
        />
      )}

      {pendingClose && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/25"
          {...maskDismiss}
        >
          <div className="w-[460px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--elevated)] shadow-2xl">
            <div className="flex items-start gap-3 px-5 pt-5">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)]">
                <svg className="h-4 w-4 text-[var(--accent-text)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M12 7.5v6M12 17.2v.4" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-bold text-[var(--text)]">关闭内容预览窗口？</div>
                <div className="mt-1 text-[11.5px] text-[var(--text-2)]">
                  有 <span className="font-bold text-[var(--accent-text)]">{pendingClose.length}</span>{" "}
                  个文件存在未保存的改动，关闭后这些改动会丢失。
                </div>
              </div>
            </div>
            <div className="mx-5 mt-3 max-h-40 overflow-y-auto rounded-lg bg-[var(--surface-soft)] px-3 py-2">
              {pendingClose.map((it) => (
                <div key={it.id} className="flex items-center gap-2 py-1">
                  <span className="text-[var(--accent)]">●</span>
                  <span className="shrink-0 text-[12px] text-[var(--text-deep)]">{basename(it.path)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[var(--text-3)]">
                    {it.path}
                  </span>
                </div>
              ))}
            </div>
            <div className="px-5 pt-2 text-[10.5px] text-[var(--text-3)]">
              已保存的 Tab 会被记住，下次打开预览窗自动复原。
            </div>
            {saveErr && (
              <div className="mx-5 mt-2 rounded-md bg-[var(--danger)]/10 px-3 py-1.5 text-[10.5px] text-[var(--danger)]">
                保存失败，已中止关闭：{saveErr}
              </div>
            )}
            <div className="mt-4 flex items-center gap-2 border-t border-[var(--border)] px-5 py-3">
              <button
                onClick={saveAllAndClose}
                className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-[var(--accent-text)]"
              >
                保存并关闭
              </button>
              <button
                onClick={() => setPendingClose(null)}
                className="rounded-lg border border-[var(--border)] px-3.5 py-1.5 text-[12px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface)]"
              >
                取消
              </button>
              <div className="flex-1" />
              <button
                onClick={() => void finishClose()}
                className="rounded-lg border border-[var(--accent-border-soft)] px-3.5 py-1.5 text-[12px] font-semibold text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/8"
              >
                直接关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
