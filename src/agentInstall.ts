import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Agent CLI 安装状态 store（设置「Agent」页 + 顶栏新建终端按钮共享的唯一事实源）。
 * 模式同 settings.ts：模块级 state + useSyncExternalStore 订阅。
 * 触发时机：首个订阅方 ensureDetected()（幂等）/ 安装完成后单 agent 刷新 / 手动 redetect()。
 */

export type AgentId = "claude" | "codex" | "cursor" | "kimi";
export const AGENT_IDS: AgentId[] = ["claude", "codex", "cursor", "kimi"];

export interface AgentState {
  phase: "unknown" | "checking" | "installed" | "missing" | "installing" | "installFailed";
  version?: string;
  path?: string;
  /** 安装失败时的输出尾部（≤4KB，页内展开诊断用） */
  outputTail?: string;
}

interface BackendStatus {
  id: string;
  installed: boolean;
  version: string | null;
  path: string | null;
}

interface InstallResult {
  ok: boolean;
  outputTail: string;
}

type State = Record<AgentId, AgentState>;

let state: State = {
  claude: { phase: "unknown" },
  codex: { phase: "unknown" },
  cursor: { phase: "unknown" },
  kimi: { phase: "unknown" },
};
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function set(id: AgentId, patch: Partial<AgentState>) {
  state = { ...state, [id]: { ...state[id], ...patch } };
  emit();
}

function applyDetected(r: BackendStatus): AgentState {
  return r.installed
    ? { phase: "installed", version: r.version ?? undefined, path: r.path ?? undefined }
    : { phase: "missing" };
}

let detectPromise: Promise<void> | null = null;

/** 全量检测（幂等：进行中不重复发起；整体失败回落 unknown，可手动重试）。 */
export function ensureDetected(): void {
  if (detectPromise) return;
  AGENT_IDS.forEach((id) => {
    if (state[id].phase !== "installing") set(id, { phase: "checking" });
  });
  detectPromise = (async () => {
    try {
      const list = await invoke<BackendStatus[]>("detect_agents");
      for (const r of list) {
        if ((AGENT_IDS as string[]).includes(r.id) && state[r.id as AgentId].phase !== "installing") {
          set(r.id as AgentId, applyDetected(r));
        }
      }
    } catch {
      AGENT_IDS.forEach((id) => {
        if (state[id].phase !== "installing") set(id, { phase: "unknown" });
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

/** 对单个 agent 跑官方安装脚本；进行中重复调用忽略。成功后仅刷新该 agent（不影响其他行状态）。 */
export async function install(id: AgentId): Promise<void> {
  if (state[id].phase === "installing") return;
  set(id, { phase: "installing", outputTail: undefined });
  try {
    const r = await invoke<InstallResult>("install_agent", { id });
    if (!r.ok) {
      set(id, { phase: "installFailed", outputTail: r.outputTail });
      return;
    }
    // 安装脚本报告成功 → 单 agent 重检测（拿版本号/路径）；检测失败不否定安装结果
    try {
      const list = await invoke<BackendStatus[]>("detect_agents");
      const hit = list.find((x) => x.id === id);
      set(id, hit ? applyDetected(hit) : { phase: "installed" });
    } catch {
      set(id, { phase: "installed" });
    }
  } catch (e) {
    set(id, { phase: "installFailed", outputTail: String(e) });
  }
}

/** 该状态是否视为「不可用」（未安装 / 安装中）——新建终端入口置灰禁点的统一判据。 */
export function agentUnavailable(st: AgentState | undefined): boolean {
  return st?.phase === "missing" || st?.phase === "installing";
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
