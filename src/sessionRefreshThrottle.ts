// 会话事件刷新退避(plan-3):agent 运行期该工作区的 *-sessions-changed 自动重扫,
// 从「每 500ms 事件即扫」退避为 trailing 3s 一拍 + 运行结束立即终扫;非运行期直通(现状灵敏度)。
//
// 判据复用 agentStatus(该工作区是否有 agent 终端在跑),不新增状态源;
// 终扫经 agentStatus 的 onWorkspaceIdle 回调注入(防循环 import:agentStatus 不 import 本模块)。

import { isWorkspaceRunning, onWorkspaceIdle } from "./agentStatus";

/** 运行期重扫拍长:事件 trailing 合并到 3s 一次(决策 1A)。 */
const TRAILING_MS = 3000;

interface Entry {
  wsId: string;
  fn: () => void; // 最近一次注册的刷新闭包(以最新为准)
  timer?: number; // trailing 定时器
  pending: boolean; // 是否有积压未发的刷新
}

const entries = new Map<string, Entry>();

function fire(e: Entry): void {
  if (e.timer !== undefined) {
    window.clearTimeout(e.timer);
    e.timer = undefined;
  }
  e.pending = false;
  e.fn();
}

/**
 * 会话事件驱动的刷新入口。key 建议 `${agentKind}\0${wsId}`。
 * 非运行期:直通立即执行;运行期:trailing 3s 一拍,同 key 窗口内合并。
 */
export function scheduleSessionRefresh(key: string, wsId: string, fn: () => void): void {
  if (!isWorkspaceRunning(wsId)) {
    fn();
    return;
  }
  let e = entries.get(key);
  if (!e) {
    e = { wsId, fn, pending: false };
    entries.set(key, e);
  }
  e.fn = fn;
  e.pending = true;
  if (e.timer === undefined) {
    e.timer = window.setTimeout(() => fire(e), TRAILING_MS);
  }
}

// 工作区全部静默(回合结束/终端关闭)→ 该工作区积压的刷新立即终扫一次,列表即达最新。
onWorkspaceIdle((wsId) => {
  for (const e of entries.values()) {
    if (e.wsId === wsId && e.pending) fire(e);
  }
});
