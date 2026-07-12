/** 工作区相对 skill 根：多候选有序、可开关、按序唯一激活（不合并列表）。 */

import { getWsState, setWsState } from "./wsState";
import { getSettings, setSetting } from "./settings";
import { invoke } from "@tauri-apps/api/core";

export const DEFAULT_SKILL_ROOT = ".claude/skills";

/** 默认候选顺序：Claude → Cursor → Agents（默认全开）。 */
export const DEFAULT_SKILL_ROOTS: string[] = [
  ".claude/skills",
  ".cursor/skills",
  ".agents/skills",
];

/** 完整条目列表（含未启用），数组序 = 优先级。 */
const WS_ENTRIES_KEY = "htybox.skillRootEntries.v1";
/** 旧版：仅启用路径数组 */
const WS_ROOTS_KEY = "htybox.skillRoots.v1";

export type SkillRootPresetId = "claude" | "cursor" | "agents";

export interface SkillRootPreset {
  id: SkillRootPresetId;
  label: string;
  path: string;
  desc: string;
}

export const SKILL_ROOT_PRESETS: SkillRootPreset[] = [
  {
    id: "claude",
    label: "Claude",
    path: ".claude/skills",
    desc: "Claude Code 项目 skill",
  },
  {
    id: "cursor",
    label: "Cursor",
    path: ".cursor/skills",
    desc: "Cursor Agent 项目 skill",
  },
  {
    id: "agents",
    label: "Agents",
    path: ".agents/skills",
    desc: "跨客户端 Agent Skills 约定",
  },
];

export interface SkillRootEntry {
  path: string;
  enabled: boolean;
}

export interface ActiveSkillRoot {
  active: string;
  found: boolean;
  candidates: string[];
}

export function normalizeSkillsRel(input: string): string {
  return input.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function validateSkillsRel(input: string): string | null {
  const s = normalizeSkillsRel(input);
  if (!s) return "skill 根路径不能为空";
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s)) {
    return "须为工作区相对路径，不能是绝对路径";
  }
  for (const seg of s.split("/")) {
    if (!seg || seg === "." || seg === "..") {
      return "路径非法（含空段或 ..）";
    }
  }
  if (!s.endsWith("/skills") && s !== "skills") {
    return "路径须以 skills 结尾（例如 .claude/skills）";
  }
  return null;
}

export function downtimeRelFromSkillsRel(skillsRel: string): string {
  const s = normalizeSkillsRel(skillsRel) || DEFAULT_SKILL_ROOT;
  const err = validateSkillsRel(s);
  if (err) throw new Error(err);
  if (s === "skills") return "downtime/skills";
  return `${s.slice(0, -"/skills".length)}/downtime/skills`;
}

export function presetIdForPath(path: string): SkillRootPresetId | "custom" {
  const n = normalizeSkillsRel(path);
  const hit = SKILL_ROOT_PRESETS.find((p) => p.path === n);
  return hit ? hit.id : "custom";
}

/** 自定义根标题：取 skills 前一段名（去前导点）并首字母大写，如 `.htyworkflows/skills` → `Htyworkflows`。 */
export function labelFromCustomPath(path: string): string {
  const n = normalizeSkillsRel(path);
  const base = n === "skills" ? n : n.replace(/\/skills$/i, "");
  const seg = base.split("/").filter(Boolean).pop() || base;
  const name = seg.replace(/^\.+/, "");
  if (!name) return "Custom";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function metaForPath(path: string): { label: string; desc: string; preset: boolean } {
  const n = normalizeSkillsRel(path);
  const p = SKILL_ROOT_PRESETS.find((x) => x.path === n);
  if (p) return { label: p.label, desc: p.desc, preset: true };
  return { label: labelFromCustomPath(n), desc: "自定义相对路径", preset: false };
}

export function normalizeCandidateList(raw: string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const n = normalizeSkillsRel(r);
    if (validateSkillsRel(n)) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out.length ? out : [DEFAULT_SKILL_ROOT];
}

/** 规范化条目：路径合法、去重保序；缺省三预设补到列表末（enabled=false 不覆盖用户意图）。 */
export function normalizeEntries(raw: SkillRootEntry[]): SkillRootEntry[] {
  const out: SkillRootEntry[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    const n = normalizeSkillsRel(e.path);
    if (validateSkillsRel(n) || seen.has(n)) continue;
    seen.add(n);
    out.push({ path: n, enabled: !!e.enabled });
  }
  for (const p of SKILL_ROOT_PRESETS) {
    if (!seen.has(p.path)) {
      out.push({ path: p.path, enabled: false });
      seen.add(p.path);
    }
  }
  if (!out.some((e) => e.enabled)) {
    const claude = out.find((e) => e.path === DEFAULT_SKILL_ROOT);
    if (claude) claude.enabled = true;
    else out.unshift({ path: DEFAULT_SKILL_ROOT, enabled: true });
  }
  return out;
}

export function defaultEntries(): SkillRootEntry[] {
  return DEFAULT_SKILL_ROOTS.map((path) => ({ path, enabled: true }));
}

export function enabledPathsFromEntries(entries: SkillRootEntry[]): string[] {
  return normalizeCandidateList(entries.filter((e) => e.enabled).map((e) => e.path));
}

function entriesFromEnabledPaths(paths: string[]): SkillRootEntry[] {
  const enabled = new Set(normalizeCandidateList(paths));
  const ordered: SkillRootEntry[] = paths
    .map((p) => normalizeSkillsRel(p))
    .filter((p) => !validateSkillsRel(p))
    .filter((p, i, a) => a.indexOf(p) === i)
    .map((path) => ({ path, enabled: true }));
  for (const p of SKILL_ROOT_PRESETS) {
    if (!ordered.some((e) => e.path === p.path)) {
      ordered.push({ path: p.path, enabled: enabled.has(p.path) });
    }
  }
  return normalizeEntries(ordered);
}

function readGlobalEntries(): SkillRootEntry[] | null {
  const s = getSettings();
  if (Array.isArray(s.skillRootEntries) && s.skillRootEntries.length) {
    return normalizeEntries(s.skillRootEntries);
  }
  if (Array.isArray(s.skillRoots) && s.skillRoots.length) {
    return entriesFromEnabledPaths(s.skillRoots);
  }
  if (typeof s.skillRoot === "string" && s.skillRoot.trim()) {
    return entriesFromEnabledPaths([s.skillRoot]);
  }
  return null;
}

/** 读工作区完整条目（含未启用、保序）。 */
export function loadSkillRootEntries(scope: string | null | undefined): SkillRootEntry[] {
  if (scope) {
    const v2 = getWsState<SkillRootEntry[] | undefined>(WS_ENTRIES_KEY, scope, undefined);
    if (Array.isArray(v2) && v2.length) return normalizeEntries(v2);
    const v1 = getWsState<string[] | undefined>(WS_ROOTS_KEY, scope, undefined);
    if (Array.isArray(v1) && v1.length) return entriesFromEnabledPaths(v1);
  }
  return readGlobalEntries() ?? defaultEntries();
}

/** 仅启用路径（给 resolve / 面板扫描）。 */
export function loadSkillRoots(scope: string | null | undefined): string[] {
  return enabledPathsFromEntries(loadSkillRootEntries(scope));
}

function emitRootsChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent("htybox:skill-roots"));
  } catch {
    /* ignore */
  }
}

/** 持久化完整条目；同步启用路径到 skillRoots。 */
export function saveSkillRootEntries(
  scope: string | null | undefined,
  entries: SkillRootEntry[],
): SkillRootEntry[] {
  const list = normalizeEntries(entries);
  const enabled = enabledPathsFromEntries(list);
  if (scope) {
    setWsState(WS_ENTRIES_KEY, scope, list);
    setWsState(WS_ROOTS_KEY, scope, enabled);
  }
  setSetting("skillRootEntries", list);
  setSetting("skillRoots", enabled);
  emitRootsChanged();
  return list;
}

export const resolveActiveSkillRoot = (projectDir: string, candidates: string[]) =>
  invoke<ActiveSkillRoot>("resolve_active_skill_root", {
    projectDir,
    candidates: normalizeCandidateList(candidates),
  });
