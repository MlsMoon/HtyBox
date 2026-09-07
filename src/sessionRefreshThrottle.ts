import { listen } from "@tauri-apps/api/event";
import { isWorkspaceRunning, onWorkspaceIdle } from "./agentStatus";
import { listAgentSessionsBatch } from "./catalog";
import { perfRescan } from "./perf/perfHud";
import { setNativeSessionLabels } from "./sessionNativeLabels";
import { createSessionRefreshScheduler } from "./sessionRefreshScheduler";
import { getSettings } from "./settings";

const scheduler = createSessionRefreshScheduler({
  fetch: async (agent, cwds) => {
    const measured = getSettings().perfHud;
    const started = measured ? performance.now() : 0;
    const groups = await listAgentSessionsBatch(agent, cwds);
    if (measured) perfRescan(performance.now() - started);
    return groups;
  },
  listen: (agent, invalidate) => listen(`${agent}-sessions-changed`, invalidate),
  isWorkspaceRunning,
  publish: (agent, groups) => setNativeSessionLabels(agent, groups.flatMap((group) => group.sessions)),
  reportError: (error) => console.error("Session refresh callback failed", error),
  now: () => performance.now(),
  setTimer: (callback, delay) => {
    const timer = window.setTimeout(callback, delay);
    return () => window.clearTimeout(timer);
  },
});

onWorkspaceIdle(scheduler.workspaceIdle);

export const subscribeSessionList = scheduler.subscribeSessionList;
export const refreshSessionList = scheduler.refreshSessionList;
export const clearWorkspaceSessionRefresh = scheduler.clearWorkspaceSessionRefresh;
export type { SessionListHandlers } from "./sessionRefreshScheduler";
