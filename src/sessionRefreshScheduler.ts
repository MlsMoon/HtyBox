import type { SessionAgent, SessionRef, WorkspaceSessions } from "./catalog.ts";

export interface SessionListHandlers {
  onData?: (sessions: SessionRef[]) => void;
  onError?: (error: unknown) => void;
  onInvalidate?: () => void;
}

interface SchedulerDependencies {
  fetch: (agent: SessionAgent, cwds: string[]) => Promise<WorkspaceSessions[]>;
  listen: (agent: SessionAgent, invalidate: () => void) => Promise<() => void>;
  isWorkspaceRunning: (wsId: string) => boolean;
  publish: (agent: SessionAgent, groups: WorkspaceSessions[]) => void;
  reportError: (error: unknown) => void;
  now: () => number;
  setTimer: (callback: () => void, delay: number) => () => void;
}

interface Consumer { wsId: string; handlers: SessionListHandlers }
interface Entry {
  cwd: string;
  consumers: Set<Consumer>;
  snapshot?: SessionRef[];
  due?: number;
  version: number;
}
interface Watch { active: boolean; stop?: () => void }
interface AgentState {
  agent: SessionAgent;
  entries: Map<string, Entry>;
  inFlight: boolean;
  watch?: Watch;
  timer?: { due: number; cancel: () => void };
}
interface RequestEntry { entry: Entry; consumers: Consumer[]; version: number }

const TRAILING_MS = 3000;

export function createSessionRefreshScheduler(deps: SchedulerDependencies) {
  const agents = new Map<SessionAgent, AgentState>();

  function notify(callback: () => void): void {
    try { callback(); } catch (error) { deps.reportError(error); }
  }

  function mark(entry: Entry, due: number, supersede = false): void {
    if (supersede) entry.version += 1;
    entry.due = entry.due === undefined ? due : Math.min(entry.due, due);
  }

  function isRunning(state: AgentState): boolean {
    return [...state.entries.values()].some((entry) =>
      [...entry.consumers].some((consumer) => deps.isWorkspaceRunning(consumer.wsId)));
  }

  function arm(state: AgentState): void {
    const due = Math.min(...[...state.entries.values()].map((entry) => entry.due ?? Infinity));
    if (state.inFlight || !Number.isFinite(due)) {
      state.timer?.cancel();
      state.timer = undefined;
      return;
    }
    if (state.timer?.due === due) return;
    state.timer?.cancel();
    state.timer = { due, cancel: deps.setTimer(() => {
      state.timer = undefined;
      if (agents.get(state.agent) === state) void run(state);
    }, Math.max(0, due - deps.now())) };
  }

  function releaseUnused(state: AgentState): void {
    if (agents.get(state.agent) !== state) return;
    if (state.entries.size) { arm(state); return; }
    state.timer?.cancel();
    state.timer = undefined;
    if (state.watch) {
      const watch = state.watch;
      state.watch = undefined;
      watch.active = false;
      if (watch.stop) notify(watch.stop);
    }
    // The old native request still owns this Agent's single-flight slot.
    if (!state.inFlight) agents.delete(state.agent);
  }

  function remove(state: AgentState, entry: Entry, consumer: Consumer): void {
    entry.consumers.delete(consumer);
    if (!entry.consumers.size && state.entries.get(entry.cwd) === entry) {
      state.entries.delete(entry.cwd);
      entry.snapshot = undefined;
      entry.due = undefined;
    }
    releaseUnused(state);
  }

  function invalidate(state: AgentState): void {
    for (const entry of [...state.entries.values()]) {
      for (const consumer of [...entry.consumers]) {
        if (entry.consumers.has(consumer)) notify(() => consumer.handlers.onInvalidate?.());
      }
    }
    const due = deps.now() + (isRunning(state) ? TRAILING_MS : 0);
    for (const entry of state.entries.values()) mark(entry, due);
    arm(state);
  }

  function ensureListening(state: AgentState): void {
    if (state.watch || !state.entries.size) return;
    const watch: Watch = { active: true };
    state.watch = watch;
    void Promise.resolve().then(() => {
      if (!watch.active || state.watch !== watch) return;
      return deps.listen(state.agent, () => {
        if (watch.active && state.watch === watch) invalidate(state);
      });
    }).then((stop) => {
      if (!stop) return;
      if (!watch.active || state.watch !== watch) { notify(stop); return; }
      watch.stop = stop;
      // Catch changes between the initial read and asynchronous listener registration.
      for (const entry of state.entries.values()) mark(entry, deps.now());
      arm(state);
    }).catch((error: unknown) => {
      if (!watch.active || state.watch !== watch) return;
      state.watch = undefined;
      for (const entry of state.entries.values()) {
        for (const consumer of entry.consumers) notify(() => consumer.handlers.onError?.(error));
      }
      deps.reportError(error);
    });
  }

  function liveConsumers(state: AgentState, request: RequestEntry): Consumer[] {
    const { entry, version } = request;
    if (state.entries.get(entry.cwd) !== entry || entry.version !== version) return [];
    return request.consumers.filter((consumer) => entry.consumers.has(consumer));
  }

  function notifyConsumers(state: AgentState, request: RequestEntry, callback: (consumer: Consumer) => void): void {
    for (const consumer of request.consumers) {
      if (state.entries.get(request.entry.cwd) !== request.entry || request.entry.version !== request.version) return;
      if (request.entry.consumers.has(consumer)) notify(() => callback(consumer));
    }
  }

  async function run(state: AgentState): Promise<void> {
    if (state.inFlight) return;
    const requests: RequestEntry[] = [];
    for (const entry of state.entries.values()) {
      if (entry.due === undefined || entry.due > deps.now()) continue;
      entry.due = undefined;
      requests.push({ entry, consumers: [...entry.consumers], version: entry.version });
    }
    if (!requests.length) { releaseUnused(state); return; }
    state.inFlight = true;
    try {
      const groups = await deps.fetch(state.agent, requests.map(({ entry }) => entry.cwd));
      const byCwd = new Map(groups.map((group) => [group.cwd, group.sessions]));
      const deliveries = requests.map((request) => {
        const sessions = byCwd.get(request.entry.cwd);
        if (!sessions) throw new Error(`Missing session batch result: ${request.entry.cwd}`);
        return { request, sessions, consumers: liveConsumers(state, request) };
      }).filter(({ consumers }) => consumers.length > 0);
      for (const { request, sessions } of deliveries) request.entry.snapshot = sessions;
      if (deliveries.length) deps.publish(state.agent, deliveries.map(({ request, sessions }) =>
        ({ cwd: request.entry.cwd, sessions })));
      for (const { request, sessions } of deliveries) {
        notifyConsumers(state, request, (consumer) => consumer.handlers.onData?.(sessions));
      }
    } catch (error) {
      for (const request of requests) {
        notifyConsumers(state, request, (consumer) => consumer.handlers.onError?.(error));
      }
    } finally {
      state.inFlight = false;
      releaseUnused(state);
    }
  }

  function subscribeSessionList(
    agent: SessionAgent,
    cwd: string,
    wsId: string,
    handlers: SessionListHandlers = {},
  ): () => void {
    let state = agents.get(agent);
    if (!state) {
      state = { agent, entries: new Map(), inFlight: false };
      agents.set(agent, state);
    }
    let entry = state.entries.get(cwd);
    if (!entry) {
      entry = { cwd, consumers: new Set(), version: 0 };
      state.entries.set(cwd, entry);
    }
    const consumer: Consumer = { wsId, handlers };
    entry.consumers.add(consumer);
    const snapshot = entry.snapshot;
    if (snapshot) notify(() => handlers.onData?.(snapshot));
    mark(entry, deps.now(), true);
    ensureListening(state);
    arm(state);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      remove(state, entry, consumer);
    };
  }

  function refreshSessionList(agent: SessionAgent, cwd: string): void {
    const state = agents.get(agent);
    const entry = state?.entries.get(cwd);
    if (!state || !entry) return;
    mark(entry, deps.now(), true);
    ensureListening(state);
    arm(state);
  }

  function clearWorkspaceSessionRefresh(wsId: string): void {
    for (const state of [...agents.values()]) {
      for (const entry of [...state.entries.values()]) {
        for (const consumer of [...entry.consumers]) {
          if (consumer.wsId === wsId) remove(state, entry, consumer);
        }
      }
    }
  }

  function workspaceIdle(wsId: string): void {
    for (const state of agents.values()) {
      const ownsWorkspace = [...state.entries.values()].some((entry) =>
        [...entry.consumers].some((consumer) => consumer.wsId === wsId));
      if (!ownsWorkspace) continue;
      const quiet = !isRunning(state);
      for (const entry of state.entries.values()) {
        if (entry.due !== undefined && (quiet || [...entry.consumers].some((consumer) => consumer.wsId === wsId))) {
          entry.due = deps.now();
        }
      }
      arm(state);
    }
  }

  return { subscribeSessionList, refreshSessionList, clearWorkspaceSessionRefresh, workspaceIdle };
}
