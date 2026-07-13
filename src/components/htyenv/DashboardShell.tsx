// hty环境仪表盘模式外壳(plan-4 决策 2A):顶层覆盖层,终端/PTY 在底下保活不卸载。
// 三视图:entry(仪表盘欢迎,mockup envdash-welcome-toggle)/ global(全局权威库)/ workspace(工作区环境)。
import { useEffect, useState } from "react";
import WindowControls from "../WindowControls";
import HtyBoxLogo from "../ui/HtyBoxLogo";
import { useMaskDismiss } from "../ui/maskDismiss";
import { useSettings } from "../../settings";
import { htyenvLibraryStatus, htyenvStatus, type LibraryStatus } from "../../htyenv";
import ModeSwitch from "./ModeSwitch";
import GlobalEnvView from "./GlobalEnvView";
import WorkspaceEnvView from "./WorkspaceEnvView";

export interface DashWorkspace {
  name: string;
  path: string;
}

type View = { kind: "entry" } | { kind: "global" } | { kind: "workspace"; ws: DashWorkspace };

/** 工作区 hty环境就绪态(欢迎入口只显示就绪与否,用户第四轮反馈) */
type Readiness = "ready" | "none" | "error";

export default function DashboardShell({
  recents,
  openWs,
  initialPath,
  onExit,
  onOpenSettings,
}: {
  recents: DashWorkspace[];
  openWs: DashWorkspace[];
  initialPath: string | null;
  onExit: () => void;
  onOpenSettings: () => void;
}) {
  const settings = useSettings();
  const [view, setView] = useState<View>(() => {
    if (initialPath) {
      const hit = [...openWs, ...recents].find((w) => w.path === initialPath);
      if (hit) return { kind: "workspace", ws: { name: hit.name, path: hit.path } };
    }
    return { kind: "entry" };
  });
  const [showWsMenu, setShowWsMenu] = useState(false);
  const wsMenuMask = useMaskDismiss(() => setShowWsMenu(false));

  // 工作区下拉候选:已打开 + 最近(按路径去重)
  const candidates: DashWorkspace[] = [
    ...openWs,
    ...recents.filter((r) => !openWs.some((w) => w.path === r.path)),
  ];

  if (view.kind === "entry") {
    return (
      <EntryView
        recents={recents}
        libraryDir={settings.htyenvLibraryDir}
        onExit={onExit}
        onOpenSettings={onOpenSettings}
        onOpenGlobal={() => setView({ kind: "global" })}
        onOpenWorkspace={(ws) => setView({ kind: "workspace", ws })}
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg)] text-[var(--text)]">
      {/* 标题栏:品牌(回仪表盘入口) + 模式 chip + 切回正常模式 + 窗口控制 */}
      <div
        data-tauri-drag-region
        className="relative z-20 flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] pl-3 select-none"
      >
        <button onClick={() => setView({ kind: "entry" })} title="返回仪表盘入口" className="flex items-center px-0.5">
          <HtyBoxLogo size={28} initial="open" openOnHover className="transition-transform duration-200 ease-out hover:scale-110 hover:-rotate-6" />
        </button>
        <span className="rounded-md border border-[var(--accent-border)] bg-[var(--accent-soft)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--accent-text)]">
          hty环境仪表盘
        </span>
        <div className="ml-auto flex items-center gap-2 pr-1">
          <button
            onClick={onExit}
            title="切回正常工作模式(终端一直在后台运行)"
            className="rounded-md border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-2)] transition-colors hover:bg-[var(--elevated)] hover:text-[var(--text)]"
          >
            ↩ 正常工作模式
          </button>
        </div>
        <WindowControls />
      </div>

      {/* 顶部导航:全局权威环境 | 工作区下拉(▾,不平铺全部工作区) */}
      <div className="flex h-12 shrink-0 items-center gap-3 px-5">
        <button
          onClick={() => setView({ kind: "global" })}
          className={
            "rounded-lg px-3.5 py-1.5 text-xs transition-colors " +
            (view.kind === "global"
              ? "border border-[var(--accent-border)] bg-[var(--accent-soft)] font-semibold text-[var(--accent-text)]"
              : "border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)]")
          }
        >
          全局权威环境
        </button>
        <div className="relative">
          <button
            onClick={() => setShowWsMenu((v) => !v)}
            className={
              "flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs transition-colors " +
              (view.kind === "workspace"
                ? "border border-[var(--accent-border)] bg-[var(--accent-soft)] font-semibold text-[var(--accent-text)]"
                : "border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--elevated)] hover:text-[var(--text)]")
            }
          >
            {view.kind === "workspace" ? view.ws.name : "选择工作区"}
            <span className="text-[10px] opacity-70">▾</span>
          </button>
          {showWsMenu && (
            <>
              <div className="fixed inset-0 z-[60]" {...wsMenuMask} />
              <div className="absolute left-0 top-full z-[61] mt-1.5 max-h-80 w-72 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--elevated)] py-1.5 shadow-2xl">
                {candidates.length === 0 && (
                  <div className="px-3 py-2 text-xs text-[var(--text-3)]">还没有工作区(先在正常模式打开一个文件夹)</div>
                )}
                {candidates.map((w) => (
                  <button
                    key={w.path}
                    onClick={() => {
                      setView({ kind: "workspace", ws: w });
                      setShowWsMenu(false);
                    }}
                    className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-[var(--surface)]"
                  >
                    <span className="truncate text-[12.5px] text-[var(--text)]">{w.name}</span>
                    <span className="truncate font-mono text-[10px] text-[var(--text-3)]">{w.path}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {view.kind === "workspace" && (
          <span className="ml-auto truncate font-mono text-[11px] text-[var(--text-3)]">{view.ws.path}</span>
        )}
      </div>

      {/* 视图区 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {view.kind === "global" ? (
          <GlobalEnvView libraryDir={settings.htyenvLibraryDir} workspaces={candidates} />
        ) : (
          <WorkspaceEnvView ws={view.ws} libraryDir={settings.htyenvLibraryDir} />
        )}
      </div>
    </div>
  );
}

/** 仪表盘欢迎入口(mockup envdash-welcome-toggle):全局环境卡 + 最近打开(只显示就绪态)。 */
function EntryView({
  recents,
  libraryDir,
  onExit,
  onOpenSettings,
  onOpenGlobal,
  onOpenWorkspace,
}: {
  recents: DashWorkspace[];
  libraryDir: string;
  onExit: () => void;
  onOpenSettings: () => void;
  onOpenGlobal: () => void;
  onOpenWorkspace: (ws: DashWorkspace) => void;
}) {
  const [library, setLibrary] = useState<LibraryStatus | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<Record<string, Readiness>>({});

  useEffect(() => {
    let alive = true;
    htyenvLibraryStatus(libraryDir)
      .then((s) => alive && setLibrary(s))
      .catch((e) => alive && setLibraryError(String(e)));
    return () => {
      alive = false;
    };
  }, [libraryDir]);

  useEffect(() => {
    let alive = true;
    for (const r of recents) {
      htyenvStatus(r.path)
        .then((s) => {
          if (!alive) return;
          const ready: Readiness = s.present && s.manifestPresent && !s.manifestError ? "ready" : "none";
          setReadiness((prev) => ({ ...prev, [r.path]: ready }));
        })
        .catch(() => alive && setReadiness((prev) => ({ ...prev, [r.path]: "error" })));
    }
    return () => {
      alive = false;
    };
  }, [recents]);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-y-auto bg-[var(--bg)] text-[var(--text)]">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-9 select-none" />
      <div className="absolute top-0 right-0 z-10 h-9">
        <WindowControls />
      </div>
      <button
        onClick={onOpenSettings}
        title="设置"
        className="absolute top-2.5 left-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-2)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <div className="flex w-[520px] flex-col py-10">
        <div className="mb-8 flex items-center justify-center gap-5">
          <HtyBoxLogo size={100} initial="open" openOnHover />
          <span className="text-6xl font-bold tracking-tight" style={{ fontFamily: '"Baloo 2", sans-serif' }}>HtyBox</span>
        </div>
        <ModeSwitch mode="dashboard" onNormal={onExit} onDashboard={() => {}} />
        <div className="mt-2 mb-6 text-center text-[11px] text-[var(--text-3)]">
          仪表盘模式:集中管理全局权威环境与各工作区的 hty 环境
        </div>

        {/* 全局权威环境入口卡(库状态如实:未建库/损坏都是状态) */}
        <div className="mb-7 rounded-xl border border-[var(--border)] bg-[var(--elevated)] px-5 py-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold">全局权威环境</span>
            {library?.present && library.templateVersion != null && (
              <span className="rounded-md border border-[var(--accent-border)] bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-text)]">
                模板 v{library.templateVersion}
              </span>
            )}
          </div>
          {library && (
            <div className="mt-2 truncate font-mono text-[11px] text-[var(--text-2)]" title={library.path}>
              {library.path}
            </div>
          )}
          <div className="mt-1.5 text-[11px] text-[var(--text-3)]">
            {libraryError
              ? `库状态检测失败:${libraryError}`
              : !library
                ? "检测中…"
                : library.manifestError
                  ? `库登记损坏:${library.manifestError}`
                  : library.present
                    ? `${library.skillCount ?? 0} 个 skill`
                    : "尚未建立(首次初始化工程或收编 skill 时自动创建)"}
          </div>
          <button
            onClick={onOpenGlobal}
            className="mt-3 rounded-lg border border-[var(--accent-border)] px-3 py-1.5 text-[11px] font-semibold text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-soft)]"
          >
            管理全局环境 →
          </button>
        </div>

        {/* 最近打开:只显示 hty环境是否就绪(用户第四轮反馈) */}
        <div className="mb-2 px-1 text-[11px] font-semibold tracking-wider text-[var(--text-faint)] uppercase">
          最近打开(点击进入该工作区的环境视图)
        </div>
        {recents.length === 0 ? (
          <div className="px-1 text-xs text-[var(--text-3)]">还没有最近的工作区</div>
        ) : (
          <div className="space-y-0.5">
            {recents.map((r) => {
              const ready = readiness[r.path];
              return (
                <button
                  key={r.path}
                  onClick={() => onOpenWorkspace(r)}
                  className="flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--surface-soft)]"
                >
                  <div className="flex w-full items-center justify-between gap-3">
                    <span className="shrink-0 truncate text-sm font-medium text-[var(--text)]">{r.name}</span>
                    <span className="truncate font-mono text-[11px] text-[var(--text-3)]" title={r.path}>
                      {r.path}
                    </span>
                  </div>
                  <span className="flex items-center gap-1.5 text-[11px]">
                    {ready === "ready" ? (
                      <>
                        <span className="h-2 w-2 rounded-full bg-[var(--success)]" />
                        <span className="text-[var(--success)]">hty环境已就绪</span>
                      </>
                    ) : ready === "none" ? (
                      <>
                        <span className="h-2 w-2 rounded-full border border-[var(--text-3)]" />
                        <span className="text-[var(--text-3)]">未初始化 hty环境</span>
                      </>
                    ) : ready === "error" ? (
                      <span className="text-[var(--danger)]">状态检测失败</span>
                    ) : (
                      <span className="text-[var(--text-faint)]">检测中…</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="mt-8 text-center text-[11px] text-[var(--text-faint)]">
          切回正常工作模式后,工作区照常打开终端工作台(终端在两种模式下都保持运行)
        </div>
      </div>
    </div>
  );
}
