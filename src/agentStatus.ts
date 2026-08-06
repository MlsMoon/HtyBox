// 运行状态总线：聚合 per-terminal "agent 是否在跑" → per-workspace 三态，驱动顶栏标签状态图标。
// 实时、不持久化（重启后进程都没了）。
//
// 活动信号（pingAgentActivity）以 agent 终端的【PTY 字节流活动】(terminalEngine 的 onOutput 上报、节流)
// 为主 + OSC 标题跳动 (TerminalDock 的 onTitle) 为辅：有字节/标题在动=运行中；二者均静默超 IDLE_MS=完成/空闲。
// 为何用 PTY 活动而非只盯标题：TUI 的 spinner 是正文行高频重绘(走 PTY)，OSC 标题仅低频更新，只盯标题会在
// "spinner 在转但标题静默"时把运行中误判为完成。仍不依赖具体 spinner 字符 → 对 claude/codex 通用、不挑 CLI 版本。
//
// 三态（优先级 running > doneUnseen > idle）：
//   running     —— 该工作区有 agent 终端正在跑
//   done-unseen —— 工作区从运行转完成、且当时不是当前激活工作区（后台跑完，待查看）
//   idle        —— 默认（已查看 / 从未运行）

export type WsStatus = "running" | "done-unseen" | "idle";

type Listener = () => void;
const listeners = new Set<Listener>();
function emit(): void {
  listeners.forEach((f) => f());
}
/** 订阅状态变化（顶栏标签用于实时刷新）。返回取消函数。 */
export function onAgentStatusChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const IDLE_MS = 2000; // PTY/标题静默超过此时长 → 判定完成/空闲（略放宽，容忍 spinner 慢帧/输出间隔）

const running = new Map<string, boolean>(); // termId → 是否运行中
const idleTimers = new Map<string, number>(); // termId → idle 定时器句柄
const doneUnseen = new Set<string>(); // 工作区 → 完成待查看
const finished = new Set<string>(); // termId → 跑过且已静默（kimi/cursor tab 完成标记；再次活动/关闭即清）
let activeWs: string | null = null; // 当前激活工作区

// 终端 id 形如 "<wsId>::<...>"，反推工作区 id
const wsOf = (termId: string): string => {
  const i = termId.indexOf("::");
  return i >= 0 ? termId.slice(0, i) : termId;
};
const wsRunning = (ws: string): boolean => {
  for (const [tid, run] of running) if (run && wsOf(tid) === ws) return true;
  return false;
};

/** agent 终端有活动（PTY 输出 / OSC 标题跳动）时调 → 标记运行 + 重置 idle 定时器。 */
export function pingAgentActivity(termId: string): void {
  const ws = wsOf(termId);
  const wasRunning = wsRunning(ws);
  const wasTermRunning = running.get(termId) === true;
  const wasFinished = finished.delete(termId); // 新活动顶掉完成标记
  running.set(termId, true);
  const t = idleTimers.get(termId);
  if (t) window.clearTimeout(t);
  idleTimers.set(
    termId,
    window.setTimeout(() => markIdle(termId), IDLE_MS),
  );
  // 工作区聚合跳变（顶栏图标）或单终端跳变（WorkflowBar 徽记 / tab 状态标记）都需要通知；
  // 高频 ping 期间三者均已稳定 → 不 emit，无重渲染开销
  if (!wasRunning || !wasTermRunning || wasFinished) emit();
}

function markIdle(termId: string): void {
  if (!running.get(termId)) return;
  const ws = wsOf(termId);
  running.set(termId, false);
  idleTimers.delete(termId);
  finished.add(termId); // 跑过且已静默 = 完成（常驻到再次活动）
  // 该工作区聚合 running 由 true→false 跳变：若此刻非当前激活工作区 → 标记"完成待查看"
  if (!wsRunning(ws) && ws !== activeWs) doneUnseen.add(ws);
  emit();
}

/** 终端关闭/进程退出 → 清其运行态（用户主动关，不算"完成待查看"）。 */
export function clearTerm(termId: string): void {
  const ws = wsOf(termId);
  const wasRunning = running.get(termId) === true;
  running.delete(termId);
  finished.delete(termId);
  const t = idleTimers.get(termId);
  if (t) {
    window.clearTimeout(t);
    idleTimers.delete(termId);
  }
  if (wasRunning && !wsRunning(ws)) emit();
}

/** 关闭整个工作区时清理其全部终端状态（避免 map 残留）。 */
export function clearWorkspace(ws: string): void {
  for (const tid of [...running.keys()]) {
    if (wsOf(tid) === ws) {
      running.delete(tid);
      finished.delete(tid);
      const t = idleTimers.get(tid);
      if (t) window.clearTimeout(t);
      idleTimers.delete(tid);
    }
  }
  doneUnseen.delete(ws);
  emit();
}

/** 设置当前激活工作区；切到某工作区即视为"已查看"，清其完成待查看标记。 */
export function setActiveWorkspace(ws: string | null): void {
  activeWs = ws;
  if (ws && doneUnseen.delete(ws)) emit();
}

/** 取某工作区的三态状态（顶栏标签图标据此渲染）。 */
export function workspaceStatus(ws: string): WsStatus {
  if (wsRunning(ws)) return "running";
  if (doneUnseen.has(ws)) return "done-unseen";
  return "idle";
}

/** 单终端是否正在跑（WorkflowBar「执行中/已静默」徽记、FlowPanel 总览运行点、tab 双点摆标记用）。 */
export function isTermRunning(termId: string): boolean {
  return running.get(termId) === true;
}

/** 单终端是否"跑过且已静默"（kimi/cursor tab 收束成点完成标记用；再次活动/关闭即清）。 */
export function isTermFinished(termId: string): boolean {
  return finished.has(termId);
}
