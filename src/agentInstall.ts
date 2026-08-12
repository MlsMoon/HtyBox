import { useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Agent CLI 安装状态 store（设置「Agent」页 + 顶栏新建终端按钮共享的唯一事实源）。
 * 模式同 settings.ts：模块级 state + useSyncExternalStore 订阅。
 * 触发时机：首个订阅方 ensureDetected()（幂等）/ 安装或更新完成后单 agent 刷新 / 手动 redetect()。
 */

export type AgentId = "claude" | "codex" | "cursor" | "kimi" | "hermes";
export const AGENT_IDS: AgentId[] = ["claude", "codex", "cursor", "kimi", "hermes"];

export type AgentPhase =
  | "unknown"
  | "checking"
  | "installed"
  | "missing"
  | "installing"
  | "installFailed"
  | "updating"
  | "updateFailed";

export interface AgentState {
  phase: AgentPhase;
  version?: string;
  path?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  /** 安装/更新进行中：最新一行输出（进度条旁辅助文案） */
  progressLine?: string;
  /** 失败时的输出尾部（≤4KB，页内展开诊断用） */
  outputTail?: string;
}

interface BackendStatus {
  id: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
}

interface InstallResult {
  ok: boolean;
  outputTail: string;
}

interface ProgressEvent {
  kind: string;
  line: string | null;
}

type State = Record<AgentId, AgentState>;

let state: State = {
  claude: { phase: "unknown" },
  codex: { phase: "unknown" },
  cursor: { phase: "unknown" },
  kimi: { phase: "unknown" },
  hermes: { phase: "unknown" },
};
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function set(id: AgentId, patch: Partial<AgentState>) {
  state = { ...state, [id]: { ...state[id], ...patch } };
  emit();
}

function isBusy(phase: AgentPhase): boolean {
  return phase === "installing" || phase === "updating";
}

function applyDetected(r: BackendStatus): AgentState {
  if (!r.installed) {
    return { phase: "missing" };
  }
  return {
    phase: "installed",
    version: r.version ?? undefined,
    path: r.path ?? undefined,
    latestVersion: r.latestVersion ?? undefined,
    updateAvailable: r.updateAvailable,
    progressLine: undefined,
    outputTail: undefined,
  };
}

let detectPromise: Promise<void> | null = null;

/** 全量检测（幂等：进行中不重复发起；不打断 installing/updating；整体失败回落 unknown）。 */
export function ensureDetected(): void {
  if (detectPromise) return;
  AGENT_IDS.forEach((id) => {
    if (!isBusy(state[id].phase)) set(id, { phase: "checking" });
  });
  detectPromise = (async () => {
    try {
      const list = await invoke<BackendStatus[]>("detect_agents");
      for (const r of list) {
        if ((AGENT_IDS as string[]).includes(r.id) && !isBusy(state[r.id as AgentId].phase)) {
          set(r.id as AgentId, applyDetected(r));
        }
      }
    } catch {
      AGENT_IDS.forEach((id) => {
        if (!isBusy(state[id].phase)) set(id, { phase: "unknown" });
      });
    } finally {
      detectPromise = null;
    }
  })();
}

/** 手动重新检测（设置页「重新检测」按钮）。 */
export function redetect(): void {
  ensureDetected();
}

function progressChannel(id: AgentId): Channel<ProgressEvent> {
  const ch = new Channel<ProgressEvent>();
  ch.onmessage = (ev) => {
    if (ev.kind === "output" && ev.line) {
      set(id, { progressLine: ev.line });
    }
  };
  return ch;
}

async function refreshOne(id: AgentId, fallbackPhase: "installed" | "missing"): Promise<void> {
  try {
    const list = await invoke<BackendStatus[]>("detect_agents");
    const hit = list.find((x) => x.id === id);
    set(id, hit ? applyDetected(hit) : { phase: fallbackPhase });
  } catch {
    set(id, { phase: fallbackPhase });
  }
}

/** 对单个 agent 跑官方安装脚本；进行中重复调用忽略。成功后立刻离开 busy，再后台重检测。 */
export async function install(id: AgentId): Promise<void> {
  if (isBusy(state[id].phase)) return;
  set(id, {
    phase: "installing",
    outputTail: undefined,
    progressLine: undefined,
    updateAvailable: undefined,
    latestVersion: undefined,
  });
  try {
    const r = await invoke<InstallResult>("install_agent", {
      id,
      onProgress: progressChannel(id),
    });
    if (!r.ok) {
      set(id, { phase: "installFailed", outputTail: r.outputTail, progressLine: undefined });
      return;
    }
    // 先收起进度条，避免成功后仍停在 installing 等 detect（含拉 latest）
    set(id, { phase: "installed", progressLine: undefined, outputTail: undefined });
    await refreshOne(id, "installed");
  } catch (e) {
    set(id, { phase: "installFailed", outputTail: String(e), progressLine: undefined });
  }
}

/**
 * 对**单个** agent 执行更新（不批量、不连带其它行）。
 * 进行中重复调用忽略；成功后立刻离开 busy，再后台重检测。
 */
export async function update(id: AgentId): Promise<void> {
  if (isBusy(state[id].phase)) return;
  const prev = state[id];
  set(id, {
    phase: "updating",
    outputTail: undefined,
    progressLine: undefined,
  });
  try {
    const r = await invoke<InstallResult>("update_agent", {
      id,
      onProgress: progressChannel(id),
    });
    if (!r.ok) {
      set(id, { phase: "updateFailed", outputTail: r.outputTail, progressLine: undefined });
      return;
    }
    // 立刻离开 busy：成功瞬间不再显示假进度；版本号由随后 refresh 补齐
    set(id, {
      phase: "installed",
      version: prev.version,
      path: prev.path,
      latestVersion: prev.latestVersion,
      updateAvailable: false,
      progressLine: undefined,
      outputTail: undefined,
    });
    await refreshOne(id, "installed");
  } catch (e) {
    set(id, { phase: "updateFailed", outputTail: String(e), progressLine: undefined });
  }
}

/** 该状态是否视为「不可用」（未安装 / 安装中 / 更新中）——新建终端入口置灰禁点的统一判据。 */
export function agentUnavailable(st: AgentState | undefined): boolean {
  return st?.phase === "missing" || st?.phase === "installing" || st?.phase === "updating";
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 订阅 agent 安装状态（任何组件读取，状态变更自动重渲染）。 */
export function useAgentInstall(): State {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
