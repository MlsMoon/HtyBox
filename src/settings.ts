import { useSyncExternalStore } from "react";
import type { FontKey } from "./fontKeys";
import type { ThemeKey } from "./themeKeys";

/** 文件树/全局搜索的单击行为模式。 */
export type FileClickMode = "open" | "select";

/** 全局设置（未来各种开关都加到这里）。持久化在 localStorage。 */
export interface Settings {
  /** Skill/Memory 卡片鼠标悬停时弹出详情浮层 */
  hoverPreview: boolean;
  /** M7-D 多 Agent 全自动接力：开则唤醒自动注入(终端静默后)，关则半自动(弹提示点击唤醒) */
  autoRelay: boolean;
  /** 界面字体：全局 UI/会话/编辑器/预览跟随（终端等宽不受影响）。默认鸿蒙 */
  fontFamily: FontKey;
  /** 全局文件搜索（双击 Shift）一次最多索引的文件数；超出的不进搜索。默认 10 万 */
  maxFiles: number;
  /** 界面主题：light=浅色奶油 / dark=暖调棕黑 / system=跟随系统。默认 light */
  theme: ThemeKey;
  /** 文件单击行为：open=单击即打开/展开(现状,默认) / select=单击仅选中、双击才打开/展开(Windows 式)。仅文件树；全局搜索点击由 openFileFromSearch 单独控制 */
  fileClickMode: FileClickMode;
  /** 全局搜索单击文件后：true=在编辑器打开 / false=仅在 File 页签定位选中、不打开(不切走终端，便于找文件喂给 AI)。默认 false */
  openFileFromSearch: boolean;
  /** 编辑器可打开的文件大小上限（MB）；过大文件编辑可能卡顿。默认 10 */
  maxEditMB: number;
  /** 终端底部工作流面板总开关：关闭后所有终端不显示面板（绑定与进度数据保留）。默认开 */
  showWorkflowPanel: boolean;
  /** 终端中键自动滚动：按下鼠标中键出滚轮锚点、移动即按距离自动滚动（仿浏览器）。默认开 */
  middleClickScroll: boolean;
  /** 左栏 File/Skill/Memory/Session/Flow 分段切换条：开=仅图标(更紧凑) / 关=图标+文字(现状,默认) */
  sidebarTabIconOnly: boolean;
  /**
   * 全局默认 Skill 候选条目（有序，含启用开关）。工作区可在 wsState 覆盖；
   * 运行时仅对 enabled 项按序选第一个「目录已存在」的作为唯一激活根。
   */
  skillRootEntries: { path: string; enabled: boolean }[];
  /** 启用中的路径（由 skillRootEntries 派生同步，兼容旧逻辑） */
  skillRoots: string[];
  /** @deprecated 升格为 skillRoots / skillRootEntries */
  skillRoot?: string;
}

const KEY = "htybox.settings.v1";
const DEFAULT_ENTRIES = [
  { path: ".claude/skills", enabled: true },
  { path: ".cursor/skills", enabled: true },
  { path: ".agents/skills", enabled: true },
];
const DEFAULTS: Settings = {
  hoverPreview: true,
  autoRelay: false,
  fontFamily: "harmony",
  maxFiles: 100000,
  theme: "light",
  fileClickMode: "open",
  openFileFromSearch: false,
  maxEditMB: 10,
  showWorkflowPanel: true,
  middleClickScroll: true,
  sidebarTabIconOnly: false,
  skillRootEntries: DEFAULT_ENTRIES.map((e) => ({ ...e })),
  skillRoots: DEFAULT_ENTRIES.filter((e) => e.enabled).map((e) => e.path),
};

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Settings> & {
      skillRoot?: string;
    };
    const {
      skillRoot: legacyRoot,
      skillRoots: rawRoots,
      skillRootEntries: rawEntries,
      ...rest
    } = raw;
    const merged: Settings = {
      ...DEFAULTS,
      ...rest,
      skillRootEntries: DEFAULT_ENTRIES.map((e) => ({ ...e })),
      skillRoots: [...DEFAULTS.skillRoots],
    };
    if (Array.isArray(rawEntries) && rawEntries.length) {
      merged.skillRootEntries = rawEntries.map((e) => ({
        path: String(e.path),
        enabled: !!e.enabled,
      }));
      merged.skillRoots = merged.skillRootEntries.filter((e) => e.enabled).map((e) => e.path);
      if (!merged.skillRoots.length) merged.skillRoots = [...DEFAULTS.skillRoots];
    } else if (Array.isArray(rawRoots) && rawRoots.length) {
      merged.skillRoots = rawRoots;
      const en = new Set(rawRoots);
      merged.skillRootEntries = [
        ...rawRoots.map((path) => ({ path, enabled: true })),
        ...DEFAULT_ENTRIES.filter((e) => !en.has(e.path)).map((e) => ({
          path: e.path,
          enabled: false,
        })),
      ];
    } else if (typeof legacyRoot === "string" && legacyRoot.trim()) {
      merged.skillRoots = [legacyRoot];
      merged.skillRootEntries = [
        { path: legacyRoot, enabled: true },
        ...DEFAULT_ENTRIES.filter((e) => e.path !== legacyRoot).map((e) => ({
          path: e.path,
          enabled: false,
        })),
      ];
    }
    return merged;
  } catch {
    return {
      ...DEFAULTS,
      skillRootEntries: DEFAULT_ENTRIES.map((e) => ({ ...e })),
      skillRoots: [...DEFAULTS.skillRoots],
    };
  }
}

let current: Settings = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): void {
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 订阅全局设置（任意组件读取，setSetting 后自动重渲染）。 */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}
