// 内容预览窗口（第二窗口）的管理入口——主窗侧使用。
// 每个工作区一个独立窗口，label = preview-<工作区 id 的稳定短 hash>。
// 为什么要 hash：Tauri 的窗口 label 限定 a-zA-Z-/:_ 字符集，而工作区 id 由路径 slug 而来、
// 可能含中文或其它非法字符，直接拼会建窗失败。
//
// 两种"关闭"语义严格区分：
// - 切换工作区导致的隐藏 → hide()，记忆保持「开」，Tab 与未保存内容原样留在窗口里；
// - 用户点顶栏按钮或窗口 × → 真销毁 + 记忆置「关」。
// 记忆按工作区独立持久化，故应用重启后能按记忆自动复原窗口。
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getWsState, setWsState } from "./wsState";
import { EV_ADOPT, EV_CLOSED, EV_OPEN_FILE, type AdoptItem } from "./previewProtocol";

/** 开关记忆（按工作区）：true = 该工作区应有预览窗，切回/重启都要复原。 */
const MEM_KEY = "htybox.previewWin.v1";

export interface PreviewTarget {
  /** 工作区 id（App.tsx 的 slug） */
  id: string;
  /** 工作区根目录绝对路径（预览窗的 Ctrl+P 搜索范围） */
  path: string;
  /** 工作区显示名（窗口标题用） */
  name: string;
}

/** FNV-1a 32 位：短、稳定、同一路径每次结果一致（不用于安全用途）。 */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** 某工作区对应的预览窗 label。与 capabilities 里的 `preview-*` glob 对应。 */
const labelFor = (workspaceId: string) => `preview-${hash32(workspaceId)}`;

/** 当前实际存在窗口的工作区（含被隐藏的）。dockBus 的路由判断要同步读，故用内存集合。 */
const live = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** 该工作区当前是否有预览窗（含隐藏态）——同步判断，供打开路由分流用。 */
export const isLive = (workspaceId: string) => live.has(workspaceId);

/** 该工作区的预览窗记忆状态（true = 应该开着）。 */
const isRemembered = (workspaceId: string) => getWsState<boolean>(MEM_KEY, workspaceId, false);

/** 订阅窗口开关变化（顶栏按钮据此切换两形态）。 */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 建窗（或唤回已隐藏的窗口）。不改记忆——记忆只由用户的开/关动作写。 */
async function show(ws: PreviewTarget): Promise<void> {
  const label = labelFor(ws.id);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.show();
    await existing.setFocus();
    live.add(ws.id);
    notify();
    return;
  }
  const q = new URLSearchParams({ ws: ws.id, path: ws.path, name: ws.name });
  new WebviewWindow(label, {
    url: `/preview.html?${q.toString()}`,
    title: `内容预览 · ${ws.name}`,
    width: 1100,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    decorations: false, // 与主窗一致：自绘标题栏（WindowControls）
    dragDropEnabled: false,
  });
  live.add(ws.id);
  notify();
}

/** 隐藏（切换工作区用）：窗口与其中的 Tab、未保存内容都留着，切回来即刻恢复。 */
async function hide(workspaceId: string): Promise<void> {
  const w = await WebviewWindow.getByLabel(labelFor(workspaceId));
  await w?.hide();
}

/** 真销毁窗口。keepMemory=true 用于应用退出（记忆要留到下次启动复原）。 */
async function destroy(workspaceId: string, keepMemory: boolean): Promise<void> {
  const w = await WebviewWindow.getByLabel(labelFor(workspaceId));
  await w?.destroy();
  live.delete(workspaceId);
  if (!keepMemory) setWsState(MEM_KEY, workspaceId, false);
  notify();
}

/** 顶栏按钮：开 ⇄ 关。用户的显式动作，写记忆。 */
export async function toggle(ws: PreviewTarget): Promise<void> {
  if (live.has(ws.id)) {
    await destroy(ws.id, false);
    return;
  }
  setWsState(MEM_KEY, ws.id, true);
  await show(ws);
}

/** 活动工作区变化 / 应用启动后调用：按各工作区记忆决定谁显示、谁隐藏。
 *  这条通路同时承担「切换工作区跟随开关」与「重启后自动复原」，不为启动另写一份逻辑。 */
export async function syncToActiveWorkspace(active: PreviewTarget | null): Promise<void> {
  for (const id of live) {
    if (!active || id !== active.id) await hide(id);
  }
  if (active && isRemembered(active.id)) await show(active);
}

/** 工作区被关闭：连同它的预览窗一起收掉，并清掉记忆（这个工作区不在了）。 */
export async function closeForWorkspace(workspaceId: string): Promise<void> {
  await destroy(workspaceId, false);
}

/** 应用退出前收干净所有预览窗——否则主窗关了、进程还被预览窗吊着不退出。
 *  记忆保留，下次启动由 syncToActiveWorkspace 复原。 */
export async function closeAllOnExit(): Promise<void> {
  for (const id of [...live]) {
    try {
      await destroy(id, true);
    } catch (e) {
      // 单个窗口销毁失败不能卡住整个退出流程（主窗正等着这一步才 destroy 自己）
      console.error("关闭内容预览窗口失败，继续退出流程", e);
      live.delete(id);
    }
  }
}

/** 把「打开这个文件」派给某工作区的预览窗。 */
export function sendOpenFile(workspaceId: string, path: string): void {
  emitTo(labelFor(workspaceId), EV_OPEN_FILE, { path }).catch((e) =>
    console.error("向内容预览窗口派发打开请求失败", e),
  );
}

/** 把一批编辑器（含未保存内容）交给某工作区的预览窗接管。 */
export function sendAdopt(workspaceId: string, items: AdoptItem[]): void {
  emitTo(labelFor(workspaceId), EV_ADOPT, { items }).catch((e) =>
    console.error("向内容预览窗口移交编辑器失败", e),
  );
}

// 预览窗被用户点 × 关掉 → 主窗同步内存态与记忆，顶栏按钮回到未开形态。
listen<{ wsId: string }>(EV_CLOSED, (e) => {
  const id = e.payload.wsId;
  live.delete(id);
  setWsState(MEM_KEY, id, false);
  notify();
}).catch((e) => console.error("监听内容预览窗口关闭事件失败", e));
