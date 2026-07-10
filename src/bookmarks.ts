import { useSyncExternalStore } from "react";

// 书签：随手暂存需求/想法/笔记。**按工作区(scope=工作区 slug)分桶**持久化，
// 镜像 favSkills/wsState 的 { [scope]: value } 模式（用户拍板按工作区独立，见计划决策 1）。
// 标题、内容均可空（但 UI 限制不可同时为空）；颜色=分类、星标=重要(置顶)。

export type BookmarkColorKey = "red" | "amber" | "green" | "blue" | "purple" | "gray";

// 书签标签色（数据维度，非主题 token）：柔和值，与奶油主题协调、dark 下亦可读。
export const BOOKMARK_COLORS: { key: BookmarkColorKey; label: string; dot: string }[] = [
  { key: "red", label: "红", dot: "#d6695e" },
  { key: "amber", label: "橙", dot: "#d99a4e" },
  { key: "green", label: "绿", dot: "#6aa563" },
  { key: "blue", label: "蓝", dot: "#5b8fc9" },
  { key: "purple", label: "紫", dot: "#9d7cc4" },
  { key: "gray", label: "灰", dot: "#9b968c" },
];

export const DEFAULT_COLOR: BookmarkColorKey = "blue";

/** 取某颜色的圆点色值（未知 key 降级灰）。 */
export const colorDot = (key: BookmarkColorKey): string =>
  BOOKMARK_COLORS.find((c) => c.key === key)?.dot ?? "#9b968c";

export interface Bookmark {
  id: string;
  title: string; // 可空
  body: string; // 可空
  color: BookmarkColorKey;
  important: boolean;
  createdAt: number;
  updatedAt: number;
}

// v2 起「数组物理顺序即展示序」（拖拽重排直接改数组）；v1 是 updatedAt 派生序旧语义，保留作回滚。
const KEY = "htybox.bookmarks.v2";
const LEGACY_KEY = "htybox.bookmarks.v1";

// 空数组共享常量：getBookmarks 对无书签的 scope 返回它，保证 useSyncExternalStore 快照引用稳定。
const EMPTY: Bookmark[] = [];

function load(): Record<string, Bookmark[]> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, Bookmark[]>;
    // v2 缺失 → 从 v1 一次性迁移：按旧展示序（星标置顶 + updatedAt 降序）固化数组序，升级前后肉眼顺序一致
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      const migrated: Record<string, Bookmark[]> = {};
      for (const [scope, list] of Object.entries(legacy as Record<string, Bookmark[]>)) {
        migrated[scope] = [...list].sort((a, b) => {
          if (a.important !== b.important) return a.important ? -1 : 1;
          return b.updatedAt - a.updatedAt;
        });
      }
      localStorage.setItem(KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch {
    /* localStorage 不可用 / 损坏 → 降级空对象 */
  }
  return {};
}

// 模块级缓存：mutation 时整体替换 store 引用、替换对应 scope 的数组引用 → 快照按 scope 稳定。
let store: Record<string, Bookmark[]> = load();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* 静默放弃（与既有 load/save 一致） */
  }
}

function commit(scope: string, list: Bookmark[]): void {
  store = { ...store, [scope]: list };
  save();
  emit();
}

/** 读某 scope 的书签（无则返回共享空数组，引用稳定）。 */
export function getBookmarks(scope: string): Bookmark[] {
  return store[scope] ?? EMPTY;
}

export interface BookmarkInput {
  title: string;
  body: string;
  color: BookmarkColorKey;
  important: boolean;
}

export function addBookmark(scope: string, input: BookmarkInput): void {
  const now = Date.now();
  const b: Bookmark = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
  commit(scope, [b, ...getBookmarks(scope)]);
}

export function updateBookmark(scope: string, id: string, patch: Partial<BookmarkInput>): void {
  commit(
    scope,
    getBookmarks(scope).map((b) => (b.id === id ? { ...b, ...patch, updatedAt: Date.now() } : b)),
  );
}

export function deleteBookmark(scope: string, id: string): void {
  commit(scope, getBookmarks(scope).filter((b) => b.id !== id));
}

export function toggleImportant(scope: string, id: string): void {
  commit(
    scope,
    getBookmarks(scope).map((b) =>
      b.id === id ? { ...b, important: !b.important, updatedAt: Date.now() } : b,
    ),
  );
}

/** 拖拽重排：把 dragId 项移到 targetId 项之前/之后（数组物理位置）。
 *  id 缺失/自移动=无操作（拖拽手势语义：目标已不存在则什么都不发生）。 */
export function moveBookmark(
  scope: string,
  dragId: string,
  targetId: string,
  place: "before" | "after",
): void {
  if (dragId === targetId) return;
  const list = getBookmarks(scope);
  const drag = list.find((b) => b.id === dragId);
  if (!drag) return;
  const rest = list.filter((b) => b.id !== dragId);
  const ti = rest.findIndex((b) => b.id === targetId);
  if (ti < 0) return;
  const at = place === "before" ? ti : ti + 1;
  commit(scope, [...rest.slice(0, at), drag, ...rest.slice(at)]);
}

/** 撤销删除复位：把书签插回数组指定物理位置（越界钳到两端）。 */
export function insertBookmarkAt(scope: string, b: Bookmark, index: number): void {
  const list = getBookmarks(scope);
  const at = Math.max(0, Math.min(index, list.length));
  commit(scope, [...list.slice(0, at), b, ...list.slice(at)]);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 订阅某 scope 的书签（mutation 后自动重渲染；快照引用稳定不会死循环）。 */
export function useBookmarks(scope: string): Bookmark[] {
  return useSyncExternalStore(
    subscribe,
    () => getBookmarks(scope),
  );
}

/** 展示序：星标区在前、普通区在后，区内保持数组相对顺序（filter 保序）。
 *  数组物理顺序即展示序（对齐 SkillTemplateModal 模板重排范式），拖拽重排=直接改数组；
 *  刻意不再按 updatedAt 排——编辑不跳位，否则手动排好的顺序会被编辑打乱。 */
export function sortedBookmarks(list: Bookmark[]): Bookmark[] {
  return [...list.filter((b) => b.important), ...list.filter((b) => !b.important)];
}

// —— 显示 / 复制 / 注入 文本规则（标题、内容均可空，见计划决策 7）——
/** 卡片单行显示：标题优先，无标题则内容。 */
export const displayText = (b: Bookmark): string => b.title.trim() || b.body.trim();
/** 复制：内容非空复制内容，内容空复制标题。 */
export const copyTextOf = (b: Bookmark): string => (b.body.trim() ? b.body : b.title);
/** 注入：标题、内容中非空者拼接（都在则「标题\n内容」），换行由 injectText 压成单行。 */
export const injectTextOf = (b: Bookmark): string =>
  [b.title, b.body].map((s) => s.trim()).filter(Boolean).join("\n");
