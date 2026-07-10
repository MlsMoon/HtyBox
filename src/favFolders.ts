// 收藏文件夹公共模块：按工作区(root)分桶持久化，FilePanel 树 / QuickOpen 全局搜索共用。
// 沿用 M9 的 localStorage key（格式 { [root]: 绝对路径[] }，与 wsState 同构 = 零迁移）；
// 写入后派发 window 事件，多处订阅实时同步（模式镜像 sessionTitles.ts）。
import { getWsState, setWsState } from "./wsState";

const KEY = "htybox.favFolders.v1"; // { [root]: 绝对路径[] }
const EVT = "htybox:fav-folders";

/** 取某工作区收藏的文件夹绝对路径列表（按收藏先后序）。 */
export function loadFavFolders(root: string): string[] {
  const v = getWsState<string[]>(KEY, root, []);
  return Array.isArray(v) ? v : []; // 历史持久化数据可能损坏，读取层校验形状
}

function save(root: string, paths: string[]): void {
  setWsState(KEY, root, paths);
  window.dispatchEvent(new Event(EVT));
}

export function isFavFolder(root: string, path: string): boolean {
  return loadFavFolders(root).includes(path);
}

/** 收藏 / 取消收藏切换。 */
export function toggleFavFolder(root: string, path: string): void {
  const cur = loadFavFolders(root);
  save(root, cur.includes(path) ? cur.filter((x) => x !== path) : [...cur, path]);
}

/**
 * 文件系统变更同步：oldPath 被改名/移动为 newPath（null = 已删除）时，
 * 其本身与子孙收藏一并重映射（删除则移除），收藏区不留死链。
 */
export function remapFavPaths(root: string, oldPath: string, newPath: string | null): void {
  const under = (p: string) =>
    p === oldPath || p.startsWith(oldPath + "\\") || p.startsWith(oldPath + "/");
  const cur = loadFavFolders(root);
  if (!cur.some(under)) return;
  const next: string[] = [];
  for (const p of cur) {
    if (!under(p)) next.push(p);
    else if (newPath != null) next.push(newPath + p.slice(oldPath.length));
  }
  save(root, next);
}

/** 订阅收藏变化（FilePanel / QuickOpen 实时刷新）。返回取消函数。 */
export function onFavFoldersChange(fn: () => void): () => void {
  window.addEventListener(EVT, fn);
  return () => window.removeEventListener(EVT, fn);
}
