import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Allotment } from "allotment";
import Sidebar from "./components/Sidebar";
import TerminalDock, { markWorkspaceClosing } from "./components/TerminalDock";
import ContextMenu from "./components/ui/ContextMenu";
import Welcome, { type RecentFolder } from "./components/Welcome";
import SettingsModal from "./components/SettingsModal";
import CollabModal from "./components/CollabModal";
import WakeToasts from "./components/WakeToasts";
import PasteBusyToast from "./components/PasteBusyToast";
import ScreenshotToast from "./components/ScreenshotToast";
import QuickOpen from "./components/QuickOpen";
import WindowControls from "./components/WindowControls";
import BookmarkBar from "./components/BookmarkBar";
import { disposeByPrefix } from "./components/terminalEngine";
import { launchAgents, type AgentSpec } from "./mcp";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import UpdateModal from "./components/UpdateModal";
import HtyBoxLogo from "./components/ui/HtyBoxLogo";
import { checkForUpdate, getSkippedVersion, setSkippedVersion, type Update } from "./updater";
import { getWsState, setWsState } from "./wsState";
import { onAgentStatusChange, workspaceStatus, setActiveWorkspace, clearWorkspace, type WsStatus } from "./agentStatus";
import { useMaskDismiss } from "./components/ui/maskDismiss";
import { useDoubleShift } from "./components/ui/useDoubleShift";
import { SidebarToggleIcon, useSidebarToggle } from "./components/ui/SidebarToggle";
import DashboardShell from "./components/htyenv/DashboardShell";
import { getSettings, setSetting, useSettings } from "./settings";
import { startPerfHud, stopPerfHud } from "./perf/perfHud";
import * as previewWin from "./previewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

// hty环境仪表盘入口图标(布局面板风格)
function DashboardIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

// 内容预览窗口入口图标（两形态）：未开 = 后窗虚线（第二窗口尚未打开）；已开 = 双窗实线 + 后窗带内容行。
// 两态都用 currentColor / var(--accent-soft)，浅色深色主题各自适配（图标须随主题适配的既定纪律）。
function PreviewWindowIcon({ on }: { on: boolean }) {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round">
      <rect x="1.6" y="3.2" width="13.6" height="10.4" rx="2.2" />
      <path d="M1.6 6.6h13.6" />
      {on ? (
        <>
          <rect x="8.8" y="10.4" width="13.6" height="10.4" rx="2.2" fill="var(--accent-soft)" />
          <path d="M8.8 13.8h13.6" />
          <path d="M11.8 17h7.6M11.8 19.4h4.6" strokeWidth={1.6} />
        </>
      ) : (
        <rect x="8.8" y="10.4" width="13.6" height="10.4" rx="2.2" strokeDasharray="3 2.6" opacity={0.75} />
      )}
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// 工作区运行状态三态图标：运行=陶土缺口环旋转 / 完成待查看=绿勾环+涟漪 / 已查看(空闲)=绿勾环静止
function WsStatusIcon({ status }: { status: WsStatus }) {
  if (status === "running") {
    return (
      <svg className="h-3.5 w-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="8" stroke="var(--accent-border-soft)" strokeWidth="3" />
        <circle cx="12" cy="12" r="8" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeDasharray="13 40" />
      </svg>
    );
  }
  if (status === "done-unseen") {
    return (
      <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50" style={{ background: "var(--success)" }} />
        <svg className="relative h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="8" stroke="var(--success)" strokeWidth="3" />
          <path d="M8.5 12 l2.5 2.5 l4.5 -5" stroke="var(--success)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  return (
    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="var(--success)" strokeWidth="3" />
      <path d="M8.5 12 l2.5 2.5 l4.5 -5" stroke="var(--success)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface Workspace {
  id: string; // = slug(path)，同时作为 memory 作用域 slug
  name: string; // 文件夹名
  path: string; // 文件夹绝对路径
}

const RECENTS_KEY = "htybox.recents.v1";

// 与后端 memory slug 算法一致：把 : \ / _ 全替换成 -
const slugify = (p: string) => p.replace(/[:\\/_]/g, "-");
const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

function loadRecents(): RecentFolder[] {
  try {
    const r = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    if (Array.isArray(r)) return r;
  } catch {
    /* ignore */
  }
  return [];
}

// 侧栏/终端区分栏宽度持久化
const LAYOUT_KEY = "htybox.layout.split.v1";
function loadSplit(): number[] | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number")) return v;
  } catch {
    /* ignore */
  }
  return undefined;
}
function saveSplit(sizes: number[]): void {
  // 侧栏隐藏态（首元素≈0）不写宽度，避免污染 defaultSizes 致下次启动左栏 0 宽残留
  if (!(sizes.length === 2 && sizes[0] > 1)) return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(sizes));
  } catch {
    /* ignore */
  }
}

// 侧边栏显隐：按工作区独立持久化（用户要求各工作区各记各的，scope=工作区 id）。
// 宽度由 allotment 内部 cachedVisibleSize 自动恢复。
const SIDEBAR_KEY = "htybox.sidebarVisible.v1";

// 已打开的工作区 + 活动工作区持久化（退出重进复原标签栏）
const OPEN_KEY = "htybox.openWorkspaces.v1";
function loadOpen(): { ws: Workspace[]; active: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) || "null");
    if (v && Array.isArray(v.ws)) {
      const ws: Workspace[] = v.ws.filter(
        (w: unknown): w is Workspace =>
          !!w &&
          typeof (w as Workspace).id === "string" &&
          typeof (w as Workspace).name === "string" &&
          typeof (w as Workspace).path === "string",
      );
      const active = ws.some((w) => w.id === v.active)
        ? (v.active as string)
        : ws.length
          ? ws[ws.length - 1].id
          : null;
      return { ws, active };
    }
  } catch {
    /* ignore */
  }
  return { ws: [], active: null };
}

export default function App() {
  const [persisted] = useState(loadOpen);
  const [recents, setRecents] = useState<RecentFolder[]>(loadRecents);
  const [openWs, setOpenWs] = useState<Workspace[]>(persisted.ws);
  const [activeId, setActiveId] = useState<string | null>(persisted.active);
  const [showSettings, setShowSettings] = useState(false);
  const [showCollab, setShowCollab] = useState(false);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [showWsPicker, setShowWsPicker] = useState(false); // 顶栏「+」工作区选择下拉
  const wsPickerMask = useMaskDismiss(() => setShowWsPicker(false));
  // 已挂载过的 workspace（懒挂载 + 挂载后常驻 → 切走/回欢迎页时 PTY 后台存活）
  // 复原时只挂载活动工作区，其余标签待点击时再挂载
  const [opened, setOpened] = useState<Set<string>>(
    () => new Set(persisted.active ? [persisted.active] : []),
  );
  const [splitSizes] = useState(loadSplit); // 分栏宽度（持久化）
  // 侧栏显隐 + 收放动画：与内容预览窗口共用 useSidebarToggle，两窗手感一致
  const {
    visible: sidebarVisible,
    animClass: sidebarAnimClass,
    toggle: toggleSidebar,
    syncFromDrag: syncSidebarFromDrag,
    setVisible: setSidebarVisible,
  } = useSidebarToggle(
    () => (persisted.active ? getWsState<boolean>(SIDEBAR_KEY, persisted.active, true) : true),
    (v) => {
      if (activeId) setWsState(SIDEBAR_KEY, activeId, v);
    },
  ); // 侧边栏显隐（按工作区持久化）
  const [update, setUpdate] = useState<Update | null>(null); // 可用更新（null=无）
  const [showUpdate, setShowUpdate] = useState(false); // 更新弹窗开关
  const [appVersion, setAppVersion] = useState(""); // 应用真实版本号（来自打包进二进制的 tauri.conf.json）
  const [wsMenu, setWsMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [, forceStatusTick] = useReducer((x: number) => x + 1, 0); // agentStatus 变化 → 重渲染顶栏
  const dashMode = useSettings().envDashboardMode; // hty环境仪表盘模式(持久化,重启恢复)

  useEffect(() => {
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
    } catch {
      /* ignore */
    }
  }, [recents]);

  // 按设置同步全局截图热键（默认开；关则不注册，避免与飞书等抢 Ctrl+Shift+A）
  useEffect(() => {
    void invoke("set_screenshot_hotkey_enabled", {
      enabled: getSettings().screenshotHotkey,
    }).catch(() => {});
  }, []);

  // 性能诊断角标(终端性能主题群 plan-1)：随设置启停，默认关
  const perfHudOn = useSettings().perfHud;
  useEffect(() => {
    if (perfHudOn) startPerfHud();
    else stopPerfHud();
    return () => stopPerfHud();
  }, [perfHudOn]);

  // 持久化已打开的工作区 + 活动工作区（退出重进复原标签栏）
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify({ ws: openWs, active: activeId }));
    } catch {
      /* ignore */
    }
  }, [openWs, activeId]);

  // 运行状态总线：订阅刷新顶栏标签三态图标 + 把当前激活工作区告知总线（切到即清"完成待查看"）
  useEffect(() => onAgentStatusChange(forceStatusTick), [forceStatusTick]);
  useEffect(() => setActiveWorkspace(activeId), [activeId]);
  // 内容预览窗口跟随活动工作区：目标工作区记忆为「开」的自动显示，其余隐藏（Tab 不丢）。
  // 应用启动后这个 effect 同样会跑一次 → 退出前开着的预览窗自动复原。
  // 依赖只取 activeId：工作区列表的其它变动不该把预览窗抢到前台。
  const wsRef = useRef(openWs);
  const wsTabsRef = useRef<HTMLDivElement>(null);
  wsRef.current = openWs;
  useEffect(() => {
    const w = wsRef.current.find((x) => x.id === activeId) ?? null;
    previewWin.syncToActiveWorkspace(w ? { id: w.id, path: w.path, name: w.name } : null);
  }, [activeId]);

  // 关主窗 = 退出应用：先收掉全部预览窗（否则进程被它们吊着不退出），记忆保留待下次复原
  useEffect(() => {
    const win = getCurrentWindow();
    let un: (() => void) | undefined;
    win
      .onCloseRequested(async (e) => {
        e.preventDefault();
        await previewWin.closeAllOnExit();
        await win.destroy();
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, []);

  // L5-4P：把已打开工作区 + 当前激活发布给本机 Host，供 iOS 远程镜像（纯加法，桌面行为不变）
  useEffect(() => {
    invoke("set_workspaces", {
      workspaces: openWs.map((w) => ({ id: w.id, name: w.name, path: w.path })),
      activeId,
    }).catch(() => {});
  }, [openWs, activeId]);

  // 读取应用真实版本号（运行时从二进制内的 tauri.conf.json 取），供底部状态栏显示
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // 启动检查更新：有可用更新 → 记下；未被「跳过」则自动弹窗（端点不可达/离线静默忽略）
  useEffect(() => {
    checkForUpdate().then((u) => {
      if (!u) return;
      setUpdate(u);
      if (getSkippedVersion() !== u.version) setShowUpdate(true);
    });
  }, []);

  // 跳过/关闭更新弹窗：记住此版本（不再自动弹），左上角标仍保留可手动触发
  const dismissUpdate = () => {
    setUpdate((u) => {
      if (u) setSkippedVersion(u.version);
      return u;
    });
    setShowUpdate(false);
  };

  // 设置界面手动检查发现新版本：手动=显式意图，无视「跳过此版本」直接弹窗；覆盖前 close 旧实例防 rid 泄漏
  const handleUpdateFound = (u: Update) => {
    setUpdate((prev) => {
      if (prev && prev !== u) prev.close().catch(() => {});
      return u;
    });
    setShowUpdate(true);
  };

  const openFolder = (path: string) => {
    const id = slugify(path);
    const name = basename(path);
    setOpenWs((ws) => (ws.some((w) => w.id === id) ? ws : [...ws, { id, name, path }]));
    setOpened((s) => new Set(s).add(id));
    setActiveId(id);
    setRecents((rs) => [{ name, path }, ...rs.filter((r) => r.path !== path)].slice(0, 12));
  };

  // 顶栏「+」：弹系统选择器选目录，选完即加为标签（无缝，不回欢迎页）
  const pickFolder = async () => {
    setShowWsPicker(false);
    const sel = await open({ directory: true, multiple: false, title: "选择文件夹作为工作区" });
    if (typeof sel === "string") openFolder(sel);
  };

  const closeWs = (id: string) => {
    // 标记关闭中：卸载期间别把残缺布局写回；但【保留】布局键 → 重新打开可复原终端
    markWorkspaceClosing(id);
    previewWin.closeForWorkspace(id); // 工作区没了，它的内容预览窗口也一并收掉（并清记忆）
    disposeByPrefix(id + "::"); // 结束该工作区全部终端（PTY）
    clearWorkspace(id); // 清该工作区运行状态总线
    const rest = openWs.filter((w) => w.id !== id);
    setOpenWs(rest);
    setOpened((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (id === activeId) setActiveId(rest.length ? rest[rest.length - 1].id : null);
  };

  // 切工作区 → 读该工作区各自的侧边栏显隐（按工作区独立）
  useEffect(() => {
    if (activeId) setSidebarVisible(getWsState<boolean>(SIDEBAR_KEY, activeId, true));
  }, [activeId]);

  const active = openWs.find((w) => w.id === activeId) ?? null;
  // 顶栏「内容预览窗口」按钮的开/关形态（窗口在别处被关掉时也会同步过来）
  const previewOpen = useSyncExternalStore(previewWin.subscribe, () =>
    activeId ? previewWin.isLive(activeId) : false,
  );

  // 双击 Shift → 全局文件搜索（quick-open，仅在有活动工作区时）。
  // 判定逻辑与内容预览窗口共用 useDoubleShift，两窗手感一致。
  const activeRef = useRef(active);
  activeRef.current = active;
  useDoubleShift(() => {
    if (activeRef.current) setShowQuickOpen(true);
  });

  // 工作区标签过多时竖向滚轮转横滚，避免把右上角窗口按钮挤出窗口。
  // 标题栏仅在有活动工作区时挂载，故依赖 activeId 以便条出现后再绑监听。
  useEffect(() => {
    const el = wsTabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [activeId]);

  // 主窗被点回前台时，把当前工作区的预览窗一并提到其它应用之上——它是独立窗口，
  // 否则回到 HtyBox 时它可能还压在别的应用下面。焦点全程留在主窗：
  // 预览窗用「瞬时置顶再取消」提上来，随后主窗同样提一次，回到 主窗 > 预览窗 > 其它应用 的层序。
  useEffect(() => {
    const win = getCurrentWindow();
    let un: (() => void) | undefined;
    let last = 0;
    win
      .onFocusChanged(({ payload: focused }) => {
        const id = activeRef.current?.id;
        if (!focused || !id || !previewWin.isLive(id)) return;
        const now = Date.now();
        if (now - last < 300) return; // 连续获焦事件只处理一次
        last = now;
        void (async () => {
          try {
            await previewWin.raiseWithoutFocus(id);
            await win.setAlwaysOnTop(true);
            await win.setAlwaysOnTop(false);
          } catch (e) {
            console.error("把内容预览窗口带到前台失败", e);
          }
        })();
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, []);

  return (
    <div className="relative flex h-screen w-screen flex-col bg-[var(--bg)] text-[var(--text)]">
      {/* 顶部：品牌(回欢迎页) + 工作区标签 + 多 Agent（无活动工作区时隐藏） */}
      {active && (
        <div
          data-tauri-drag-region
          className="relative z-20 flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] pl-3 select-none"
        >
          <div className="relative shrink-0">
            <button
              onClick={() => setActiveId(null)}
              title="返回欢迎页"
              className="flex items-center px-0.5"
            >
              <HtyBoxLogo size={28} initial="open" openOnHover className="transition-transform duration-200 ease-out hover:scale-110 hover:-rotate-6" />
            </button>
            {update && (
              <button
                onClick={() => setShowUpdate(true)}
                title={`发现新版本 v${update.version}，点击更新`}
                className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--success)] text-white shadow ring-2 ring-[var(--surface)]"
              >
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--success)] opacity-60" />
                <svg className="relative h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
          <button
            onClick={toggleSidebar}
            title={sidebarVisible ? "隐藏侧边栏" : "显示侧边栏"}
            className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] hover:text-[var(--text)]"
          >
            <SidebarToggleIcon open={sidebarVisible} />
          </button>
          <div
            ref={wsTabsRef}
            data-tauri-drag-region="false"
            className="ml-3 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {openWs.map((w) => {
              const isActive = w.id === activeId;
              return (
                <div
                  key={w.id}
                  onClick={() => {
                    setActiveId(w.id);
                    setOpened((s) => (s.has(w.id) ? s : new Set(s).add(w.id)));
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setWsMenu({ x: e.clientX, y: e.clientY, id: w.id });
                  }}
                  title={w.path}
                  className={
                    "flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-3 py-1 text-xs whitespace-nowrap transition-colors " +
                    (isActive
                      ? "border border-[var(--border)] border-t-2 border-t-[var(--accent)] bg-[var(--elevated)] text-[var(--text)]"
                      : "border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)]")
                  }
                >
                  <WsStatusIcon status={workspaceStatus(w.id)} />
                  <span className="max-w-[140px] truncate">{w.name}</span>
                </div>
              );
            })}
          </div>
          <div className="relative shrink-0">
            <button
              onClick={() => setShowWsPicker((v) => !v)}
              title="打开工作区"
              className="flex h-6 w-6 items-center justify-center rounded text-lg leading-none text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] hover:text-[var(--text)]"
            >
              +
            </button>
            {showWsPicker && (
              <>
                <div className="fixed inset-0 z-[60]" {...wsPickerMask} />
                <div className="absolute left-0 top-full z-[61] mt-1.5 w-72 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--elevated)] py-1.5 shadow-2xl">
                  <button
                    onClick={pickFolder}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] font-semibold text-[var(--text)] hover:bg-[var(--surface)]"
                  >
                    <svg
                      className="h-4 w-4 shrink-0 text-[var(--accent)]"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    </svg>
                    打开文件夹作为工作区…
                  </button>
                  {recents.length > 0 && (
                    <>
                      <div className="my-1 border-t border-[var(--border-soft)]" />
                      <div className="px-3 pt-1 pb-1 text-[10px] font-semibold tracking-wider text-[var(--text-3)] uppercase">
                        最近
                      </div>
                      <div className="max-h-72 overflow-y-auto">
                        {recents.map((r) => {
                          const isOpen = openWs.some((w) => w.path === r.path);
                          return (
                            <button
                              key={r.path}
                              onClick={() => {
                                openFolder(r.path);
                                setShowWsPicker(false);
                              }}
                              title={r.path}
                              className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-[var(--surface)]"
                            >
                              <div className="flex w-full items-center gap-2">
                                <span className="truncate text-[12.5px] text-[var(--text)]">{r.name}</span>
                                {isOpen && (
                                  <span className="ml-auto shrink-0 rounded bg-[var(--surface-hover)] px-1 py-px text-[9px] font-medium text-[var(--text-faint)]">
                                    已打开
                                  </span>
                                )}
                              </div>
                              <span className="truncate font-mono text-[10px] text-[var(--text-3)]">{r.path}</span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 pr-1">
            <button
              onClick={() => previewWin.toggle({ id: active.id, path: active.path, name: active.name })}
              title={
                previewOpen
                  ? "关闭内容预览窗口"
                  : "打开内容预览窗口（文件 / SVG / 图片改在独立窗口预览）"
              }
              className={
                "flex h-7 w-7 items-center justify-center rounded-md transition-colors " +
                (previewOpen
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)]")
              }
            >
              <PreviewWindowIcon on={previewOpen} />
            </button>
            <BookmarkBar scope={active.id} workspacePath={active.path} />
            <button
              onClick={() => setSetting("envDashboardMode", true)}
              title="hty环境仪表盘(终端保持后台运行)"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] hover:text-[var(--text)]"
            >
              <DashboardIcon />
            </button>
            <button
              onClick={() => setShowSettings(true)}
              title="设置"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] hover:text-[var(--text)]"
            >
              <GearIcon />
            </button>
            <button
              onClick={() => setShowCollab(true)}
              title="Agent Team：团队库 / 配置 / 一键开启"
              className="cursor-pointer rounded-md border border-[var(--accent-border-soft)] bg-[var(--accent)]/12 px-3 py-1 text-xs font-semibold text-[var(--accent-text)] transition-colors hover:bg-[var(--accent)]/20"
            >
              Agent Team
            </button>
          </div>
          <WindowControls />
        </div>
      )}

      {/* 两栏：侧栏(Skill/Memory) | 终端区。终端区"始终挂载"——回欢迎页只是被覆盖层盖住，
          终端 PTY 后台存活、不卸载、不被误杀。 */}
      <div className={"min-h-0 flex-1" + sidebarAnimClass}>
        <Allotment
          proportionalLayout={false}
          defaultSizes={splitSizes}
          onChange={saveSplit}
          onVisibleChange={(index, visible) => {
            if (index === 0) syncSidebarFromDrag(visible);
          }}
        >
          <Allotment.Pane minSize={220} preferredSize={300} visible={sidebarVisible}>
            {active ? (
              <Sidebar workspacePath={active.path} workspaceSlug={active.id} />
            ) : (
              <div className="h-full bg-[var(--surface)]" />
            )}
          </Allotment.Pane>
          <Allotment.Pane minSize={400}>
            <div className="relative h-full w-full">
              {openWs
                .filter((w) => opened.has(w.id))
                .map((w) => (
                  <div
                    key={w.id}
                    className={
                      // 不用 display:none：非活动用 opacity-0+低层级。opacity-0 仍与视口相交，
                      // xterm 内置 IntersectionObserver 不会暂停它 → 终端常驻渲染、切回不空白。
                      "absolute inset-0 " +
                      (w.id === activeId
                        ? "z-10"
                        : "z-0 opacity-0 pointer-events-none")
                    }
                  >
                    <TerminalDock workspaceId={w.id} cwd={w.path} />
                  </div>
                ))}
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>

      {/* 底部状态栏 */}
      {active && (
        <div className="flex h-6 shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-3 text-[10px] text-[var(--text-faint)]">
          <span className="truncate font-mono">{active.path}</span>
          <span className="ml-auto shrink-0">
            {openWs.length} 个工作区 · HtyBox{appVersion ? ` v${appVersion}` : ""}
          </span>
        </div>
      )}

      {/* 欢迎页：覆盖层（Cursor 式初始界面）。盖在终端区之上，终端在底下保活。仪表盘态由 DashboardShell 接管欢迎职责 */}
      {!dashMode && !active && (
        <div className="absolute inset-0 z-50">
          <Welcome
            recents={recents}
            onOpen={openFolder}
            onOpenSettings={() => setShowSettings(true)}
            onSwitchDashboard={() => setSetting("envDashboardMode", true)}
          />
        </div>
      )}

      {/* hty环境仪表盘模式：顶层覆盖层（决策 2A），终端/PTY 在底下保活不卸载 */}
      {dashMode && (
        <div className="absolute inset-0 z-50">
          <DashboardShell
            recents={recents}
            openWs={openWs.map((w) => ({ name: w.name, path: w.path }))}
            initialPath={active?.path ?? null}
            onExit={() => setSetting("envDashboardMode", false)}
            onOpenSettings={() => setShowSettings(true)}
          />
        </div>
      )}

      {/* 全局设置弹窗（盖在最上层） */}
      {showSettings && (
        <SettingsModal root={active?.path ?? null} onClose={() => setShowSettings(false)} onUpdateFound={handleUpdateFound} />
      )}

      {/* 多 Agent 协作：团队库 + 一键开启（在当前工作区起整支团队） */}
      {showCollab && (
        <CollabModal
          canLaunch={!!active}
          onClose={() => setShowCollab(false)}
          onLaunch={(specs: AgentSpec[]) => {
            if (active) launchAgents(active.id, specs);
          }}
        />
      )}

      {/* M9 双击 Shift 全局文件搜索 */}
      {showQuickOpen && active && (
        <QuickOpen
          root={active.path}
          workspaceId={active.id}
          onClose={() => setShowQuickOpen(false)}
          onEnsureSidebar={() => {
            if (!sidebarVisible) {
              setSidebarVisible(true);
              setWsState(SIDEBAR_KEY, active.id, true);
            }
          }}
        />
      )}

      {/* 自更新：发现新版本弹窗（更新日志 + 跳过/立刻更新 + 下载安装重启） */}
      {showUpdate && update && <UpdateModal update={update} onDismiss={dismissUpdate} />}

      {/* 工作区标签右键菜单（关闭工作区，移出标签防误触） */}
      {wsMenu && (
        <ContextMenu
          x={wsMenu.x}
          y={wsMenu.y}
          items={[{ id: "close", label: "关闭工作区", danger: true }]}
          onAction={(id) => {
            if (id === "close") closeWs(wsMenu.id);
          }}
          onClose={() => setWsMenu(null)}
        />
      )}

      {/* M7-B 半自动唤醒提示（全局监听 broker 的 agent-wake） */}
      <WakeToasts />
      <PasteBusyToast />
      <ScreenshotToast />
    </div>
  );
}
