import { useSyncExternalStore } from "react";

// 工作流模板库：用户自定义的"阶段序列"（注入型=skill 命令 / 人工型=用户动作），
// 应用到终端后由 workflowRuns.ts 记录进度。
// **按工作区（scope = workspaceId/slug）独立存储、不共享**——2026-07-10 用户实测后拍板，
// 推翻首版"全局库"；与书签同判例（内容/资产数据按工作区隔离，见 feedback-workspace-state-persistence）。
// 旧版全局数组（htybox.workflows.v1）作为各工作区首次播种的迁移源，数据不丢。

export type StageKind = "inject" | "manual";

/** 阶段片段：一个阶段由若干有序片段拼接。inject=固定文本(skill/@引用/文本)；manual=执行时用户填写(text=指引/占位)。 */
export interface StageSegment {
  id: string;
  kind: StageKind;
  /** inject：固定注入文本；manual：给用户的指引/占位文案 */
  text: string;
}

export interface WorkflowStage {
  id: string;
  name: string; // 阶段名，如"预热上下文"
  /** 有序片段序列（人工/注入混排，执行时按序拼接）；旧 {kind,text} 单一阶段在 load 迁移为单片段 */
  segments: StageSegment[];
  /** 注入后是否自动补回车（作用于整条拼接消息） */
  pressEnter: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  stages: WorkflowStage[];
}

const KEY = "htybox.workflows.v2"; // { [scope]: Workflow[] }
const LEGACY_KEY = "htybox.workflows.v1"; // 旧全局数组（迁移源，保留不删）

export function genId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `wf-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function emptySegment(kind: StageKind = "inject"): StageSegment {
  return { id: genId(), kind, text: "" };
}

const stage = (name: string, kind: StageKind, text: string, pressEnter = true): WorkflowStage => ({
  id: genId(),
  name,
  segments: [{ id: genId(), kind, text }],
  pressEnter,
});

/** 阶段是否含人工片段（执行时需用户填写→暂停点；无则纯注入，可一键/自动执行）。 */
export function hasManual(s: WorkflowStage): boolean {
  return s.segments.some((seg) => seg.kind === "manual");
}

/** 纯注入阶段：全部注入片段按序空格拼接（供一键 / 自动执行）。 */
export function injectOnlyText(s: WorkflowStage): string {
  return s.segments
    .filter((seg) => seg.kind === "inject")
    .map((seg) => seg.text)
    .filter(Boolean)
    .join(" ");
}

/** 旧 {kind,text} 单一阶段 → 单片段；已是 segments 则规整化。加载期（模板 + run 快照）迁移共用。 */
export function migrateStage(s: unknown): WorkflowStage {
  const o = (s ?? {}) as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "";
  const pressEnter = o.pressEnter !== false;
  const id = typeof o.id === "string" ? o.id : genId();
  const segFrom = (kind: unknown, text: unknown): StageSegment => ({
    id: genId(),
    kind: kind === "manual" ? "manual" : "inject",
    text: typeof text === "string" ? text : "",
  });
  if (Array.isArray(o.segments)) {
    const segs = o.segments.map((seg) => {
      const so = (seg ?? {}) as Record<string, unknown>;
      return {
        id: typeof so.id === "string" ? so.id : genId(),
        kind: so.kind === "manual" ? "manual" : "inject",
        text: typeof so.text === "string" ? so.text : "",
      } as StageSegment;
    });
    return { id, name, segments: segs.length ? segs : [emptySegment()], pressEnter };
  }
  return { id, name, segments: [segFrom(o.kind, o.text)], pressEnter };
}

/** 迁移整条工作流（其阶段逐个迁移）。 */
export function migrateWorkflow(w: unknown): Workflow {
  const o = (w ?? {}) as Record<string, unknown>;
  return {
    id: typeof o.id === "string" ? o.id : genId(),
    name: typeof o.name === "string" ? o.name : "",
    description: typeof o.description === "string" ? o.description : undefined,
    stages: Array.isArray(o.stages) ? o.stages.map(migrateStage) : [],
  };
}

/** 工作区首次播种的内置种子：用户的常规 skill 驱动开发流。 */
function seedWorkflow(): Workflow {
  return {
    id: genId(),
    name: "常规开发流",
    description: "预热 → 需求 → 计划 → 讨论 → 执行 → 验收 → 归档",
    stages: [
      stage("预热上下文", "inject", "/htybox-dev"),
      stage("描述需求", "manual", "向 AI 描述本轮需求/问题背景（可用下方输入框发送）"),
      stage("创建计划", "inject", "/plan-create"),
      stage("讨论计划", "manual", "确认决策点，让 AI 就地迭代计划"),
      stage("执行计划", "inject", "/plan-auto-execute"),
      stage("验收", "manual", "验证产物：实测 / 构建 / UI 检查"),
      stage("归档计划", "inject", "/plan-finish"),
      stage("沉淀记忆", "inject", "/htyworkflows-memory-skill-update"),
      stage("更新日志（可跳过）", "inject", "/changelog-append"),
    ],
  };
}

/** 旧版全局库（v1 数组）：作为新工作区首次播种源；无或为空返回 null。 */
function loadLegacy(): Workflow[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    if (Array.isArray(v) && v.length) return (v as unknown[]).map(migrateWorkflow);
  } catch {
    /* ignore */
  }
  return null;
}

function load(): Record<string, Workflow[]> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, Workflow[]> = {};
      for (const [scope, list] of Object.entries(v as Record<string, unknown>)) {
        if (Array.isArray(list)) out[scope] = list.map(migrateWorkflow); // 旧 {kind,text} 阶段迁移为单片段
      }
      return out;
    }
  } catch {
    /* localStorage 不可用 / 损坏 → 降级空表 */
  }
  return {};
}

// 模块级缓存 + useSyncExternalStore（仿 bookmarks.ts）；EMPTY 共享常量保证快照引用稳定。
let store: Record<string, Workflow[]> = load();
const EMPTY: Workflow[] = [];
const listeners = new Set<() => void>();

function commit(scope: string, list: Workflow[]): void {
  store = { ...store, [scope]: list };
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
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

/** 确保某工作区已初始化：从未见过的 scope → 播种（旧全局库优先，否则内置种子）。
 *  已初始化（含用户删光=[]）不再复活。消费方（FlowPanel/WorkflowPicker）挂载时调用，幂等。 */
export function ensureSeed(scope: string): void {
  if (!scope || scope in store) return;
  const legacy = loadLegacy();
  const seed = legacy
    ? legacy.map((w) => ({ ...w, stages: w.stages.map((s) => ({ ...s })) }))
    : [seedWorkflow()];
  commit(scope, seed);
}

export function getWorkflows(scope: string): Workflow[] {
  return store[scope] ?? EMPTY;
}

export function getWorkflow(scope: string, id: string): Workflow | undefined {
  return getWorkflows(scope).find((w) => w.id === id);
}

/** 订阅某工作区的模板库（增删改后自动重渲染；快照引用稳定）。 */
export function useWorkflows(scope: string): Workflow[] {
  return useSyncExternalStore(subscribe, () => getWorkflows(scope));
}

export function addWorkflow(scope: string, wf: Workflow): void {
  commit(scope, [wf, ...getWorkflows(scope)]);
}

export function updateWorkflow(scope: string, wf: Workflow): void {
  commit(scope, getWorkflows(scope).map((w) => (w.id === wf.id ? wf : w)));
}

export function deleteWorkflow(scope: string, id: string): void {
  commit(scope, getWorkflows(scope).filter((w) => w.id !== id));
}

/** 复制一份（新 id、名称加"副本"、阶段全部重新分配 id）。 */
export function duplicateWorkflow(scope: string, id: string): void {
  const src = getWorkflow(scope, id);
  if (!src) return;
  commit(scope, [
    {
      ...src,
      id: genId(),
      name: `${src.name} 副本`,
      stages: src.stages.map((s) => ({ ...s, id: genId() })),
    },
    ...getWorkflows(scope),
  ]);
}

export function emptyStage(): WorkflowStage {
  return { id: genId(), name: "", segments: [emptySegment("inject")], pressEnter: true };
}

export function emptyWorkflow(): Workflow {
  return { id: genId(), name: "", description: "", stages: [emptyStage()] };
}

/** 校验：有名字、≥1 阶段、每阶段有名、注入阶段必须有注入文本。返回错误文案或 null。 */
export function validateWorkflow(wf: Workflow): string | null {
  if (!wf.name.trim()) return "请填写工作流名称";
  if (wf.stages.length === 0) return "至少需要一个阶段";
  for (let i = 0; i < wf.stages.length; i++) {
    const s = wf.stages[i];
    if (!s.name.trim()) return `阶段 ${i + 1} 缺少名称`;
    if (s.segments.length === 0) return `阶段 ${i + 1}「${s.name}」至少需要一个片段`;
    for (const seg of s.segments) {
      if (seg.kind === "inject" && !seg.text.trim())
        return `阶段 ${i + 1}「${s.name}」有注入片段为空`;
    }
  }
  return null;
}
