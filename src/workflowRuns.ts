import { useSyncExternalStore } from "react";
import type { Workflow, WorkflowStage } from "./workflows";

// 工作流运行实例：termId → 进度。**绑 termId**（dockview 布局 round-trip 后 termId 不变 →
// 重启/重开工作区进度自动复原；Session 面板手动复原=新 termId、不继承，为已知边界。见计划决策 4）。
// **应用即快照**：stages 从模板拷贝，此后编辑/删除模板不影响进行中实例（计划设计原则 3）。

export type StageStatus = "pending" | "active" | "injected" | "done" | "skipped";

export interface WorkflowRun {
  workflowId: string;
  workflowName: string; // 冗余快照：模板被删后面板仍能显示名称
  stages: WorkflowStage[]; // 应用时快照
  cursor: number; // 当前阶段下标；=== stages.length 即全部完成
  states: StageStatus[]; // 与 stages 等长
  collapsed?: boolean; // 面板收起为右下角浮标（每终端独立，随实例持久化）
  startedAt: number;
  updatedAt: number;
}

const KEY = "htybox.workflowRuns.v1";

function load(): Record<string, WorkflowRun> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, WorkflowRun>;
  } catch {
    /* localStorage 不可用 / 损坏 → 降级空表 */
  }
  return {};
}

let store: Record<string, WorkflowRun> = load();
const listeners = new Set<() => void>();

function commit(termId: string, run: WorkflowRun | undefined): void {
  const next = { ...store };
  if (run) next[termId] = run;
  else delete next[termId];
  store = next;
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

export function getRun(termId: string): WorkflowRun | undefined {
  return store[termId];
}

/** 订阅单终端实例（推进/收起后自动重渲染；对象引用随 mutation 整体替换，快照稳定）。 */
export function useRun(termId: string): WorkflowRun | undefined {
  return useSyncExternalStore(subscribe, () => store[termId]);
}

/** 订阅全表（FlowPanel「进行中」总览用；配合 termId 前缀过滤出本工作区）。 */
export function useAllRuns(): Record<string, WorkflowRun> {
  return useSyncExternalStore(subscribe, () => store);
}

/** 实例是否已全部完成（done/skipped）。 */
export const isRunDone = (r: WorkflowRun): boolean => r.cursor >= r.stages.length;

/** 应用工作流到终端（快照阶段定义；已有实例则整体覆盖）。 */
export function applyWorkflow(termId: string, wf: Workflow): void {
  const now = Date.now();
  const states: StageStatus[] = wf.stages.map((_, i) => (i === 0 ? "active" : "pending"));
  commit(termId, {
    workflowId: wf.id,
    workflowName: wf.name,
    stages: wf.stages.map((s) => ({ ...s })),
    cursor: 0,
    states,
    startedAt: now,
    updatedAt: now,
  });
}

/** 当前阶段（注入型）已把命令注入终端 → active → injected。 */
export function markInjected(termId: string): void {
  const r = store[termId];
  if (!r || r.cursor >= r.stages.length || r.states[r.cursor] !== "active") return;
  const states = [...r.states];
  states[r.cursor] = "injected";
  commit(termId, { ...r, states, updatedAt: Date.now() });
}

/** 结束当前阶段并推进：当前 → 指定终态（done/skipped），下一阶段（若有）→ active。 */
function settle(termId: string, endState: "done" | "skipped"): void {
  const r = store[termId];
  if (!r || r.cursor >= r.stages.length) return;
  const states = [...r.states];
  states[r.cursor] = endState;
  const cursor = r.cursor + 1;
  if (cursor < states.length) states[cursor] = "active";
  commit(termId, { ...r, states, cursor, updatedAt: Date.now() });
}

/** 用户点「✓ 下一步」：当前阶段完成、推进。 */
export function advanceRun(termId: string): void {
  settle(termId, "done");
}

/** 跳过当前阶段并推进。 */
export function skipCurrent(termId: string): void {
  settle(termId, "skipped");
}

/** 回退一步：上一阶段重新变 active，当前（未完成的）退回 pending。完成态下回到最后一个阶段。 */
export function goBack(termId: string): void {
  const r = store[termId];
  if (!r || r.cursor <= 0) return;
  const states = [...r.states];
  if (r.cursor < states.length) states[r.cursor] = "pending";
  const cursor = r.cursor - 1;
  states[cursor] = "active";
  commit(termId, { ...r, states, cursor, updatedAt: Date.now() });
}

/** 重置进度：全部 pending、阶段 1 active（保留 collapsed 偏好）。 */
export function resetRun(termId: string): void {
  const r = store[termId];
  if (!r) return;
  const states: StageStatus[] = r.stages.map((_, i) => (i === 0 ? "active" : "pending"));
  commit(termId, { ...r, states, cursor: 0, startedAt: Date.now(), updatedAt: Date.now() });
}

/** 面板收起/展开（右下角浮标态）。 */
export function setRunCollapsed(termId: string, collapsed: boolean): void {
  const r = store[termId];
  if (!r) return;
  commit(termId, { ...r, collapsed, updatedAt: Date.now() });
}

/** 解绑/终端关闭清理：删除该终端的实例。 */
export function clearRun(termId: string): void {
  if (store[termId]) commit(termId, undefined);
}

// ── 会话维度归档：关闭终端 ≠ 丢进度 ──
// 终端关闭时若已捕获 agent 会话 id → 实例移入会话归档表（键 "agentKind:sessionId"，同
// sessionTags 键范式）；Session 面板复原该会话到新终端时移回。关闭时才取 sessionId（此时
// 早已捕获完毕），避开"绑定期异步捕获"的时序问题。无 UI 订阅归档表，不需要响应式。

const SKEY = "htybox.workflowRunsBySession.v1"; // { [sessionKey]: WorkflowRun }

function loadSessionStore(): Record<string, WorkflowRun> {
  try {
    const v = JSON.parse(localStorage.getItem(SKEY) || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, WorkflowRun>;
  } catch {
    /* ignore */
  }
  return {};
}

let sessionStore: Record<string, WorkflowRun> = loadSessionStore();

function saveSessionStore(): void {
  try {
    localStorage.setItem(SKEY, JSON.stringify(sessionStore));
  } catch {
    /* ignore */
  }
}

/** 终端关闭：把该终端的实例归档到会话维度（供 Session 复原找回），并从终端表移除。 */
export function archiveRunToSession(termId: string, sessionKey: string): void {
  const r = store[termId];
  if (!r) return;
  sessionStore = { ...sessionStore, [sessionKey]: r };
  saveSessionStore();
  commit(termId, undefined);
}

/** Session 复原：把该会话的归档实例移回新终端（无归档则无事发生）。 */
export function restoreRunFromSession(sessionKey: string, termId: string): void {
  const r = sessionStore[sessionKey];
  if (!r) return;
  const next = { ...sessionStore };
  delete next[sessionKey];
  sessionStore = next;
  saveSessionStore();
  commit(termId, { ...r, updatedAt: Date.now() });
}
