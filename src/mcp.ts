import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentKind } from "./profiles";

export type AgentRole = "lead" | "worker";

export interface AgentSpec {
  agentId: string;
  roleName: string;
  role: AgentRole;
  agentKind: Exclude<AgentKind, "shell">;
  model?: string; // 模型(--model)，空/缺省用 CLI 默认
  responsibility?: string; // 职责(自由文本)，注入 env(HTYBOX_RESPONSIBILITY) 供 M7-C 协议注入
}

/** broker 端点 URL（agent 的 .mcp.json 指向它）。 */
export const mcpBrokerUrl = () => invoke<string>("mcp_broker_url");

// ---- M7-F：协作状态快照（运行面板/仪表盘轮询）----
export interface SnapshotAgent {
  agentId: string;
  role: string;
  roleName: string;
  workspace: string;
  state: string; // working | idle | pending | waiting
}
export interface SnapshotTask {
  id: string;
  assigner: string;
  worker: string;
  task: string;
  fileScope: string;
  status: string;
  summary: string;
}
export interface BrokerSnapshot {
  port: number;
  uptimeSecs: number;
  agents: SnapshotAgent[];
  tasks: SnapshotTask[];
  claims: { path: string; owner: string }[];
  shared: Record<string, string>;
  log: { seq: number; agentId: string; roleName: string; tool: string }[];
}
export const brokerSnapshot = () => invoke<BrokerSnapshot>("broker_snapshot");

/** 注册一个 agent（token→身份）并把 htybox 合并进该 cwd 的 .mcp.json。 */
export const setupMcpAgent = (args: {
  cwd: string;
  token: string;
  agentId: string;
  role: AgentRole;
  roleName: string;
  workspace: string;
}) => invoke<void>("setup_mcp_agent", args);

/** M7-C：写某 agent 的协作简报到 <cwd>/.htybox/brief-<agentId>.md（启动时 agent 先读它）。 */
export const writeAgentBrief = (args: {
  cwd: string;
  agentId: string;
  content: string;
}) => invoke<void>("write_agent_brief", args);

// ---- agent 启动总线 ----
// App(顶栏「多 Agent 协作」) 请求"在某 workspace 的终端区起若干 agent 终端"，
// 由该 workspace 的 TerminalDock 订阅并执行（它持有 dockview api）。
type Launcher = (specs: AgentSpec[], opts?: { respawn?: boolean }) => void;
const launchers = new Map<string, Launcher>();

export function registerAgentLauncher(workspaceId: string, fn: Launcher): () => void {
  launchers.set(workspaceId, fn);
  return () => {
    if (launchers.get(workspaceId) === fn) launchers.delete(workspaceId);
  };
}

export function launchAgents(
  workspaceId: string,
  specs: AgentSpec[],
  opts?: { respawn?: boolean },
): boolean {
  const fn = launchers.get(workspaceId);
  if (!fn) return false;
  if (!opts?.respawn) resetRelay(); // M7-D：新一轮团队运行重置预算/急停；M7-H 替补不重置
  fn(specs, opts);
  return true;
}

// ---- M7-D：全自动接力预算 + 急停（防失控的最低护栏）----
let relayCount = 0;
let relayStopped = false;
let relayStartAt = 0;
const RELAY_CAP = 60; // 一轮运行内自动唤醒次数硬上限，触顶停自动(回退手动点击)
const RELAY_MAX_MS = 30 * 60 * 1000; // 一轮运行时长上限(30min)，超时停自动
export function resetRelay(): void {
  relayCount = 0;
  relayStopped = false;
  relayStartAt = Date.now();
  respawnCounts.clear(); // M7-H：新一轮运行重置崩溃替补计数
}

// ---- M7-H：崩溃替补熔断（同 agent 连续替补 ≥3 次则停）----
const respawnCounts = new Map<string, number>();
const RESPAWN_CAP = 3;
export function bumpRespawn(agentId: string): number {
  const n = (respawnCounts.get(agentId) ?? 0) + 1;
  respawnCounts.set(agentId, n);
  return n;
}
export function respawnExceeded(agentId: string): boolean {
  return (respawnCounts.get(agentId) ?? 0) >= RESPAWN_CAP;
}
/** TermAgentInfo → AgentSpec（替补时按原身份重建）。 */
export function termInfoToSpec(i: TermAgentInfo): AgentSpec {
  return {
    agentId: i.agentId,
    roleName: i.roleName,
    role: i.role,
    agentKind: i.agentKind,
    model: i.model,
    responsibility: i.responsibility,
  };
}
export function relayStop(): void {
  relayStopped = true;
}
export function relayResume(): void {
  relayStopped = false;
}
export function relayIsStopped(): boolean {
  return relayStopped;
}
/** 申请一次自动唤醒额度；false = 已急停 / 触顶次数 / 超时(应回退手动)。 */
export function relayAllow(): boolean {
  if (
    relayStopped ||
    relayCount >= RELAY_CAP ||
    Date.now() - relayStartAt > RELAY_MAX_MS
  )
    return false;
  relayCount += 1;
  return true;
}

/** M7-D 急停：向所有 agent 终端发 Ctrl+C(\x03) 真中断（停注入之外的硬停）。 */
export function interruptAllAgents(): void {
  for (const termId of agentTerminals.values()) {
    invoke("write_terminal", { id: termId, data: "\x03" }).catch(() => {});
  }
}
export function relayUsage(): { count: number; cap: number; stopped: boolean } {
  return { count: relayCount, cap: RELAY_CAP, stopped: relayStopped };
}

// ---- M7-B：agentId → termId 映射（半自动唤醒时定位要注入的终端）----
const agentTerminals = new Map<string, string>();
export function setAgentTerminal(agentId: string, termId: string): void {
  agentTerminals.set(agentId, termId);
}
export function getAgentTerminal(agentId: string): string | undefined {
  return agentTerminals.get(agentId);
}

// ---- M7-H：每 agent 终端的完整身份（崩溃自愈替补用）----
export interface TermAgentInfo {
  agentId: string;
  roleName: string;
  role: AgentRole;
  agentKind: Exclude<AgentKind, "shell">;
  model?: string;
  responsibility?: string;
  cwd: string;
  workspaceId: string;
  token: string; // broker 注册用的 token（退出时按它精确注销该实例）
}

/** M7-H：agent 终端退出 → 按 token 从 broker 花名册注销该实例。 */
export const agentExited = (token: string) =>
  invoke<void>("agent_exited", { token });
const termAgents = new Map<string, TermAgentInfo>();
const intentionallyClosed = new Set<string>(); // 用户主动关闭的终端 → 退出事件不当崩溃

export function registerAgentTerminal(termId: string, info: TermAgentInfo): void {
  termAgents.set(termId, info);
  agentTerminals.set(info.agentId, termId);
  intentionallyClosed.delete(termId); // 复用 termId 时清旧标记
}
export function getTermAgent(termId: string): TermAgentInfo | undefined {
  return termAgents.get(termId);
}
export function markTerminalClosed(termId: string): void {
  intentionallyClosed.add(termId);
}
export function wasIntentionallyClosed(termId: string): boolean {
  return intentionallyClosed.has(termId);
}

/** M7-H：监听 broker(实为 pty) 的 "terminal-exit"（子进程退出，payload=termId）。 */
export function onTerminalExit(fn: (termId: string) => void): Promise<UnlistenFn> {
  return listen<string>("terminal-exit", (e) => fn(e.payload));
}

// ---- M7-B：唤醒事件（broker 在某挂起 agent 收到新消息时 emit "agent-wake"）----
export interface AgentWake {
  agentId: string;
  roleName: string;
  workspace: string;
  from: string;
  preview: string;
}
export function onAgentWake(fn: (w: AgentWake) => void): Promise<UnlistenFn> {
  return listen<AgentWake>("agent-wake", (e) => fn(e.payload));
}

// ---- M7-D：死循环事件（broker 检测到同内容连发≥3 次的 A↔B 空转）----
export interface AgentLoop {
  from: string;
  to: string;
  preview: string;
}
export function onAgentLoop(fn: (l: AgentLoop) => void): Promise<UnlistenFn> {
  return listen<AgentLoop>("agent-loop", (e) => fn(e.payload));
}
