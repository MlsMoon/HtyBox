// M9：把"打开编辑器 / 在此开终端"从 Sidebar(FilePanel) 路由到对应 workspace 的
// TerminalDock(dockview 宿主)。仿 mcp.ts 的 registerAgentLauncher，按 workspaceId 注册。
import { listen } from "@tauri-apps/api/event";
import { isLive, sendAdopt, sendOpenFile } from "./previewWindow";
import { EV_READY } from "./previewProtocol";

interface DockHost {
  openEditor: (path: string) => void;
  /** 主窗里已开的编辑器（未保存内容随行），供移交给内容预览窗口 */
  collectEditors: () => Array<{ path: string; content?: string }>;
  /** 关掉这些路径对应的编辑器面板（移交完成后主窗只剩终端） */
  closeEditors: (paths: string[]) => void;
  openTerminalAt: (cwd: string) => void;
  openTerminalCmd: (opts: { command: string; agentKind: string; title: string; cwd?: string; sessionId?: string }) => void;
  activateTerminal: (termId: string) => void;
  terminalTitle: (termId: string) => string | undefined;
}

const hosts = new Map<string, DockHost>();

export function registerDockHost(workspaceId: string, host: DockHost): () => void {
  hosts.set(workspaceId, host);
  return () => {
    if (hosts.get(workspaceId) === host) hosts.delete(workspaceId);
  };
}

/** 在某工作区的 dockview 里打开文件编辑器 Tab。
 *  该工作区的内容预览窗口开着时改派给那个窗口——"非终端的打开一律不进主窗"的唯一分流点，
 *  调用方（FilePanel / QuickOpen）无需关心去哪个窗口。 */
export function openEditor(workspaceId: string, path: string): void {
  if (isLive(workspaceId)) {
    sendOpenFile(workspaceId, path);
    return;
  }
  hosts.get(workspaceId)?.openEditor(path);
}

// 预览窗建好并就绪 → 把主窗里该工作区已开的编辑器（含未保存内容）整体移交过去，主窗只剩终端。
// 放在 dockBus 是因为这里同时握着 dock 宿主与预览窗派发通道，无需绕第三方。
listen<{ wsId: string }>(EV_READY, (e) => {
  const wsId = e.payload.wsId;
  const host = hosts.get(wsId);
  if (!host) return;
  const items = host.collectEditors();
  if (!items.length) return;
  sendAdopt(wsId, items);
  host.closeEditors(items.map((i) => i.path));
}).catch((e) => console.error("监听内容预览窗口就绪事件失败", e));

/** 在某工作区的 dockview 里新开一个 cwd=指定目录的终端。 */
export function openTerminalAt(workspaceId: string, cwd: string): void {
  hosts.get(workspaceId)?.openTerminalAt(cwd);
}

/** 在某工作区新开终端并自动执行命令（运行配置 / 复原会话用）。 */
export function openTerminalCmd(
  workspaceId: string,
  opts: { command: string; agentKind: string; title: string; cwd?: string; sessionId?: string },
): void {
  hosts.get(workspaceId)?.openTerminalCmd(opts);
}

/** 激活并聚焦某终端面板（FlowPanel「进行中」总览点击跳转用）。 */
export function activateTerminal(workspaceId: string, termId: string): void {
  hosts.get(workspaceId)?.activateTerminal(termId);
}

/** 取某终端面板当前 Tab 标题（FlowPanel 总览行显示终端名用；面板不存在返回 undefined）。 */
export function terminalTitle(workspaceId: string, termId: string): string | undefined {
  return hosts.get(workspaceId)?.terminalTitle(termId);
}

// M9-N7：编辑器面板被激活时通知 FilePanel“揭示并定位”该文件。FilePanel 注册，TerminalDock 触发。
// 本总线职责已含「左栏页签控制」(registerSidebarTab/requestSidebarTab)——供全局搜索“仅选中”时切到 File 页签。
const revealers = new Map<string, (path: string) => void>();
// 切到 File 页签前 FilePanel 尚未挂载时，暂存待揭示路径；挂载注册 reveal 时补发(仅 queueIfAbsent 调用方入队)。
const pendingReveal = new Map<string, string>();
export function registerActiveFileReveal(workspaceId: string, fn: (path: string) => void): () => void {
  revealers.set(workspaceId, fn);
  const pending = pendingReveal.get(workspaceId);
  if (pending !== undefined) {
    pendingReveal.delete(workspaceId);
    fn(pending);
  }
  return () => {
    if (revealers.get(workspaceId) === fn) revealers.delete(workspaceId);
  };
}
/** 揭示并定位文件。queueIfAbsent=true 时，若 FilePanel 尚未挂载则暂存，挂载后自动补发(全局搜索“仅选中”用)。 */
export function emitActiveFile(workspaceId: string, path: string, queueIfAbsent = false): void {
  const fn = revealers.get(workspaceId);
  if (fn) fn(path);
  else if (queueIfAbsent) pendingReveal.set(workspaceId, path);
}

// 左栏页签控制：Sidebar 注册其 setTab，外部(如全局搜索“仅选中”)请求把左栏切到指定页签。
const sidebarTabSetters = new Map<string, (tab: string) => void>();
export function registerSidebarTab(workspaceId: string, fn: (tab: string) => void): () => void {
  sidebarTabSetters.set(workspaceId, fn);
  return () => {
    if (sidebarTabSetters.get(workspaceId) === fn) sidebarTabSetters.delete(workspaceId);
  };
}
export function requestSidebarTab(workspaceId: string, tab: string): void {
  sidebarTabSetters.get(workspaceId)?.(tab);
}

// 文件夹定位通道（对称文件的 reveal）：FilePanel 注册 revealFolder，全局搜索单击文件夹时触发。
const folderRevealers = new Map<string, (path: string) => void>();
const pendingFolderReveal = new Map<string, string>();
export function registerActiveFolderReveal(workspaceId: string, fn: (path: string) => void): () => void {
  folderRevealers.set(workspaceId, fn);
  const pending = pendingFolderReveal.get(workspaceId);
  if (pending !== undefined) {
    pendingFolderReveal.delete(workspaceId);
    fn(pending);
  }
  return () => {
    if (folderRevealers.get(workspaceId) === fn) folderRevealers.delete(workspaceId);
  };
}
/** 揭示并定位文件夹。queueIfAbsent=true 时若 FilePanel 未挂载则暂存，挂载后补发（全局搜索单击文件夹用）。 */
export function emitActiveFolder(workspaceId: string, path: string, queueIfAbsent = false): void {
  const fn = folderRevealers.get(workspaceId);
  if (fn) fn(path);
  else if (queueIfAbsent) pendingFolderReveal.set(workspaceId, path);
}
