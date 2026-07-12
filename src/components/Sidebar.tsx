import { useEffect, useState, type ReactElement } from "react";
import SkillPanel from "./SkillPanel";
import MemoryPanel from "./MemoryPanel";
import FilePanel from "./FilePanel";
import SessionPanel from "./SessionPanel";
import FlowPanel from "./FlowPanel";
import { getWsState, setWsState } from "../wsState";
import { registerSidebarTab } from "../dockBus";
import { useSettings } from "../settings";

type Tab = "skill" | "memory" | "file" | "session" | "flow";

function SkillIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m13 2-9 12h7l-1 8 9-12h-7z" />
    </svg>
  );
}
function MemoryIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileTreeIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function SessionIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FlowIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="5" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <path d="M8 12h4.5" />
      <circle cx="15.5" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <path d="M19 12h1.5" />
    </svg>
  );
}

const TABS: { id: Tab; label: string; icon: () => ReactElement }[] = [
  { id: "file", label: "File", icon: FileTreeIcon },
  { id: "skill", label: "Skill", icon: SkillIcon },
  { id: "memory", label: "Memory", icon: MemoryIcon },
  { id: "session", label: "Session", icon: SessionIcon },
  { id: "flow", label: "Flow", icon: FlowIcon },
];

// tab 选择按工作区独立持久化（每个工作区各记各的，跨重启保留）
const TAB_KEY = "htybox.sidebarTab.v1";
const VALID_TABS: Tab[] = ["file", "skill", "memory", "session", "flow"];
const readTab = (slug: string): Tab => {
  const t = getWsState<Tab>(TAB_KEY, slug, "skill");
  return VALID_TABS.includes(t) ? t : "skill";
};

export default function Sidebar({
  workspacePath,
  workspaceSlug,
}: {
  workspacePath: string;
  workspaceSlug: string;
}) {
  const { sidebarTabIconOnly: iconOnly } = useSettings();
  const [tab, setTabState] = useState<Tab>(() => readTab(workspaceSlug));
  // 切工作区 → 读该工作区各自的 tab（组件不 remount，state 不随 props 自动重置，需显式重载）
  useEffect(() => setTabState(readTab(workspaceSlug)), [workspaceSlug]);
  const setTab = (t: Tab) => {
    setTabState(t);
    setWsState(TAB_KEY, workspaceSlug, t);
  };
  // 外部(全局搜索“仅选中”)请求把左栏切到指定页签：注册到 dockBus 总线，组件挂载期间在线
  useEffect(
    () =>
      registerSidebarTab(workspaceSlug, (t) => {
        if (VALID_TABS.includes(t as Tab)) {
          setTabState(t as Tab);
          setWsState(TAB_KEY, workspaceSlug, t as Tab);
        }
      }),
    [workspaceSlug],
  );
  return (
    <div className="flex h-full flex-col bg-[var(--surface)]">
      {/* 分段切换条（FanBox 风格） */}
      <div className="p-2">
        <div className="flex gap-1 rounded-xl bg-[var(--surface-hover)] p-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                title={iconOnly ? t.label : undefined}
                className={
                  "flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1.5 py-1.5 text-xs font-semibold transition-all " +
                  (active
                    ? "bg-[var(--elevated)] text-[var(--text)] shadow-sm"
                    : "text-[var(--text-2)] hover:text-[var(--text)]")
                }
              >
                <Icon />
                {!iconOnly && <span className="truncate">{t.label}</span>}
              </button>
            );
          })}
        </div>
      </div>
      {/* 活动面板（作用域 = 当前工作区文件夹） */}
      <div className="min-h-0 flex-1">
        {tab === "file" ? (
          <FilePanel root={workspacePath} workspaceId={workspaceSlug} />
        ) : tab === "skill" ? (
          <SkillPanel projectDir={workspacePath} />
        ) : tab === "memory" ? (
          <MemoryPanel slug={workspaceSlug} workspacePath={workspacePath} />
        ) : tab === "session" ? (
          <SessionPanel root={workspacePath} workspaceId={workspaceSlug} />
        ) : (
          <FlowPanel projectDir={workspacePath} workspaceId={workspaceSlug} />
        )}
      </div>
    </div>
  );
}
