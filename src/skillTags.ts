import { useMemo, useSyncExternalStore } from "react";
import { rotateColor, type TagColorKey } from "./tagColors";
import type { Tag } from "./sessionTags";

// Skill 标签系统：给工作区内 skill（按 dir）打可自定义 tag。
// - 与 sessionTags **完全独立**（另一 localStorage key、互不 import 写对方）。
// - 按 projectDir 分桶：{ vocab, bySkill }；关联键 = ManagedSkill.dir（上下架不丢）。
// - 订阅模型镜像 sessionTags（useSyncExternalStore + 整体换引用）。

export type { Tag };

export interface SkillTagBucket {
  vocab: Tag[];
  bySkill: Record<string, string[]>; // dir -> tagId[]
}

type RootStore = Record<string, SkillTagBucket>; // projectDir -> bucket

const KEY = "htybox.skillTags.v1";
const EMPTY_IDS: string[] = [];
const EMPTY_BUCKET: SkillTagBucket = { vocab: [], bySkill: {} };

function load(): RootStore {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (v && typeof v === "object") return v as RootStore;
  } catch {
    /* localStorage 不可用 / 损坏 → 降级空 */
  }
  return {};
}

let store: RootStore = load();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}
function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* 静默放弃 */
  }
}

function bucketOf(projectDir: string): SkillTagBucket {
  return store[projectDir] ?? EMPTY_BUCKET;
}

function setBucket(projectDir: string, bucket: SkillTagBucket): void {
  store = { ...store, [projectDir]: bucket };
  save();
  emit();
}

function joinTags(ids: string[], vocab: Tag[]): Tag[] {
  return ids
    .map((id) => vocab.find((t) => t.id === id))
    .filter((t): t is Tag => !!t);
}

// ===== 读 =====

export function getSkillVocab(projectDir: string): Tag[] {
  return bucketOf(projectDir).vocab;
}

export function getSkillTagIds(projectDir: string, dir: string): string[] {
  return bucketOf(projectDir).bySkill[dir] ?? EMPTY_IDS;
}

export function getSkillTags(projectDir: string, dir: string): Tag[] {
  const b = bucketOf(projectDir);
  return joinTags(b.bySkill[dir] ?? EMPTY_IDS, b.vocab);
}

export function getSkillTagBucket(projectDir: string): SkillTagBucket {
  return bucketOf(projectDir);
}

// ===== 写 =====

export function createSkillTag(projectDir: string, name: string, color?: TagColorKey): Tag {
  const n = name.trim();
  const b = bucketOf(projectDir);
  const existing = b.vocab.find((t) => t.name === n);
  if (existing) return existing;
  const tag: Tag = {
    id: crypto.randomUUID(),
    name: n,
    color: color ?? rotateColor(b.vocab.length),
  };
  setBucket(projectDir, { ...b, vocab: [...b.vocab, tag] });
  return tag;
}

export function addSkillTag(projectDir: string, dir: string, tagId: string): void {
  const b = bucketOf(projectDir);
  const ids = b.bySkill[dir] ?? EMPTY_IDS;
  if (ids.includes(tagId)) return;
  setBucket(projectDir, {
    ...b,
    bySkill: { ...b.bySkill, [dir]: [...ids, tagId] },
  });
}

export function removeSkillTag(projectDir: string, dir: string, tagId: string): void {
  const b = bucketOf(projectDir);
  const ids = b.bySkill[dir] ?? EMPTY_IDS;
  if (!ids.includes(tagId)) return;
  setBucket(projectDir, {
    ...b,
    bySkill: { ...b.bySkill, [dir]: ids.filter((x) => x !== tagId) },
  });
}

export function toggleSkillTag(projectDir: string, dir: string, tagId: string): void {
  const b = bucketOf(projectDir);
  const ids = b.bySkill[dir] ?? EMPTY_IDS;
  if (ids.includes(tagId)) {
    setBucket(projectDir, {
      ...b,
      bySkill: { ...b.bySkill, [dir]: ids.filter((x) => x !== tagId) },
    });
  } else {
    setBucket(projectDir, {
      ...b,
      bySkill: { ...b.bySkill, [dir]: [...ids, tagId] },
    });
  }
}

export function updateSkillTag(
  projectDir: string,
  tagId: string,
  patch: { name?: string; color?: TagColorKey },
): boolean {
  const b = bucketOf(projectDir);
  const cur = b.vocab.find((t) => t.id === tagId);
  if (!cur) return false;
  const name = patch.name !== undefined ? patch.name.trim() : cur.name;
  if (!name) return false;
  if (b.vocab.some((t) => t.id !== tagId && t.name === name)) return false;
  setBucket(projectDir, {
    ...b,
    vocab: b.vocab.map((t) =>
      t.id === tagId ? { ...t, name, color: patch.color ?? t.color } : t,
    ),
  });
  return true;
}

export function countSkillsWithTag(projectDir: string, tagId: string): number {
  return Object.values(bucketOf(projectDir).bySkill).filter((ids) => ids.includes(tagId)).length;
}

/** 从词表删除 tag，并清掉本工作区所有 skill 对它的引用（空关联键移除）。 */
export function deleteSkillTag(projectDir: string, tagId: string): void {
  const b = bucketOf(projectDir);
  if (!b.vocab.some((t) => t.id === tagId)) return;
  const vocab = b.vocab.filter((t) => t.id !== tagId);
  const bySkill: Record<string, string[]> = {};
  for (const [dir, ids] of Object.entries(b.bySkill)) {
    const next = ids.includes(tagId) ? ids.filter((x) => x !== tagId) : ids;
    if (next.length > 0) bySkill[dir] = next;
  }
  setBucket(projectDir, { vocab, bySkill });
}

/** 清除某 skill 全部 tag 关联（词表保留）。 */
export function clearSkillTags(projectDir: string, dir: string): void {
  const b = bucketOf(projectDir);
  if (!(dir in b.bySkill)) return;
  const bySkill = { ...b.bySkill };
  delete bySkill[dir];
  setBucket(projectDir, { ...b, bySkill });
}

// ===== 订阅 + hooks =====

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSkillVocab(projectDir: string): Tag[] {
  return useSyncExternalStore(subscribe, () => getSkillVocab(projectDir));
}

export function useSkillTags(projectDir: string, dir: string): Tag[] {
  const ids = useSyncExternalStore(subscribe, () => getSkillTagIds(projectDir, dir));
  const vocab = useSyncExternalStore(subscribe, () => getSkillVocab(projectDir));
  return useMemo(() => joinTags(ids, vocab), [ids, vocab]);
}

/** 订阅本工作区整桶（vocab 或任意 skill 关联变化都触发）。 */
export function useSkillTagStore(projectDir: string): SkillTagBucket {
  return useSyncExternalStore(subscribe, () => getSkillTagBucket(projectDir));
}
