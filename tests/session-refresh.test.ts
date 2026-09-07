import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRefreshScheduler } from "../src/sessionRefreshScheduler.ts";
import type { SessionAgent, SessionRef, WorkspaceSessions } from "../src/catalog.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); }

function fakeClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer(callback: () => void, delay: number) {
      const id = sequence++;
      timers.set(id, { at: now + delay, callback });
      return () => { timers.delete(id); };
    },
    async advance(ms = 0) {
      const end = now + ms;
      await settle();
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      now = end;
      await settle();
    },
    pending: () => timers.size,
  };
}

function harness(delayedListen = false) {
  const clock = fakeClock();
  const running = new Set<string>();
  const requests: Array<{ agent: SessionAgent; cwds: string[] } & ReturnType<typeof deferred<WorkspaceSessions[]>>> = [];
  const watches: Array<{ agent: SessionAgent; changed: () => void; active: boolean; connect: () => void }> = [];
  const published: Array<{ agent: SessionAgent; groups: WorkspaceSessions[] }> = [];
  const reported: unknown[] = [];
  let unlistens = 0;
  const scheduler = createSessionRefreshScheduler({
    ...clock,
    fetch(agent, cwds) {
      const request = { agent, cwds, ...deferred<WorkspaceSessions[]>() };
      requests.push(request);
      return request.promise;
    },
    listen(agent, changed) {
      const connected = deferred<() => void>();
      const watch = { agent, changed, active: false, connect: () => {
        watch.active = true;
        connected.resolve(() => { watch.active = false; unlistens += 1; });
      } };
      watches.push(watch);
      if (!delayedListen) watch.connect();
      return connected.promise;
    },
    isWorkspaceRunning: (wsId) => running.has(wsId),
    publish: (agent, groups) => { published.push({ agent, groups }); },
    reportError: (error) => { reported.push(error); },
  });
  const finish = (index: number, label = `result-${index}`) => {
    const request = requests[index];
    request.resolve(request.cwds.map((cwd) => ({ cwd, sessions: [{ id: cwd, label, path: cwd, ts: index }] })));
  };
  const event = (agent: SessionAgent) => {
    for (const watch of watches) if (watch.agent === agent && watch.active) watch.changed();
  };
  return { ...scheduler, clock, running, requests, watches, published, reported, finish, event,
    unlistens: () => unlistens };
}

const labels = (sink: string[]) => ({ onData: (sessions: SessionRef[]) => { sink.push(sessions[0]?.label ?? "empty"); } });

test("multiple terminals and the session panel share one Agent batch across workspaces", async () => {
  const h = harness();
  const sinks = Array.from({ length: 4 }, () => [] as string[]);
  for (const sink of sinks) h.subscribeSessionList("codex", "A", "wa", labels(sink));
  const second: string[] = [];
  h.subscribeSessionList("codex", "B", "wb", labels(second));
  h.subscribeSessionList("cursor", "A", "wa");
  await h.clock.advance();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0].cwds, ["A", "B"]);
  assert.equal(h.watches.filter((watch) => watch.agent === "codex").length, 1);
  h.finish(0, "shared");
  h.finish(1);
  await settle();
  for (const sink of sinks) assert.deepEqual(sink, ["shared"]);
  assert.deepEqual(second, ["shared"]);
  assert.equal(h.published.length, 2);
  assert.equal(h.published[0].groups.length, 2);
});

test("running Agent workspace also throttles automatic scans for idle subscribed workspaces", async () => {
  const h = harness();
  h.subscribeSessionList("codex", "A", "wa");
  h.subscribeSessionList("codex", "B", "wb");
  await h.clock.advance();
  h.finish(0);
  await settle();
  h.running.add("wa");
  h.event("codex");
  for (let index = 0; index < 5; index += 1) { await h.clock.advance(500); h.event("codex"); }
  assert.equal(h.requests.length, 1);
  await h.clock.advance(500);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].cwds, ["A", "B"]);
});

test("automatic tail events keep one next batch without starving the current snapshot", async () => {
  const h = harness();
  const seen: string[] = [];
  h.subscribeSessionList("codex", "A", "wa", labels(seen));
  h.running.add("wa");
  await h.clock.advance();
  for (let index = 0; index < 100; index += 1) h.event("codex");
  await h.clock.advance(4000);
  assert.equal(h.requests.length, 1);
  h.finish(0, "snapshot");
  await h.clock.advance();
  assert.deepEqual(seen, ["snapshot"]);
  assert.equal(h.requests.length, 2);
  h.finish(1, "last change");
  await h.clock.advance();
  assert.deepEqual(seen, ["snapshot", "last change"]);
  assert.equal(h.requests.length, 2);
});

test("explicit refresh invalidates stale in-flight data and publishes only the later result", async () => {
  const h = harness();
  const seen: string[] = [];
  h.subscribeSessionList("claude", "A", "wa", labels(seen));
  await h.clock.advance();
  h.refreshSessionList("claude", "A");
  h.finish(0, "deleted row");
  await h.clock.advance();
  assert.deepEqual(seen, []);
  assert.equal(h.published.length, 0);
  assert.equal(h.requests.length, 2);
  h.finish(1, "after delete");
  await settle();
  assert.deepEqual(seen, ["after delete"]);
  assert.equal(h.published.length, 1);
});

test("idle flushes pending work immediately and explicit refresh bypasses the running delay", async () => {
  const h = harness();
  h.subscribeSessionList("cursor", "A", "wa");
  h.subscribeSessionList("cursor", "B", "wb");
  await h.clock.advance();
  h.finish(0);
  await settle();
  h.running.add("wa");
  h.event("cursor");
  await h.clock.advance(100);
  h.refreshSessionList("cursor", "A");
  await h.clock.advance();
  assert.deepEqual(h.requests[1].cwds, ["A"]);
  h.finish(1);
  await settle();
  h.event("cursor");
  h.running.delete("wa");
  h.workspaceIdle("wa");
  await h.clock.advance();
  assert.deepEqual(h.requests[2].cwds, ["A", "B"]);
  h.finish(2);
  await h.clock.advance(5000);
  assert.equal(h.requests.length, 3);
});

test("closing and immediately reopening retains the old in-flight barrier but rejects its results", async () => {
  const h = harness();
  const oldSeen: string[] = [];
  const newSeen: string[] = [];
  const stop = h.subscribeSessionList("codex", "A", "wa", labels(oldSeen));
  await h.clock.advance();
  stop();
  h.subscribeSessionList("codex", "A", "wa", labels(newSeen));
  await h.clock.advance();
  assert.equal(h.requests.length, 1);
  h.finish(0, "old window");
  await h.clock.advance();
  assert.deepEqual(oldSeen, []);
  assert.deepEqual(newSeen, []);
  assert.equal(h.published.length, 0);
  assert.equal(h.requests.length, 2);
  h.finish(1, "new window");
  await settle();
  assert.deepEqual(newSeen, ["new window"]);
  assert.equal(h.unlistens(), 1);
});

test("workspace clearing cannot let an old unsubscribe remove a reopened Agent", async () => {
  const h = harness();
  const oldStop = h.subscribeSessionList("codex", "A", "wa");
  await h.clock.advance();
  h.finish(0);
  await settle();
  h.clearWorkspaceSessionRefresh("wa");
  const seen: string[] = [];
  h.subscribeSessionList("codex", "A", "wa", labels(seen));
  oldStop();
  oldStop();
  await h.clock.advance();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(seen, [], "the previous subscription snapshot was released");
  h.finish(1, "reopened");
  await settle();
  assert.deepEqual(seen, ["reopened"]);
});

test("late listener registration is released and cannot invalidate reopened consumers", async () => {
  const h = harness(true);
  let invalidations = 0;
  const stop = h.subscribeSessionList("kimi", "A", "wa");
  await h.clock.advance();
  stop();
  h.subscribeSessionList("kimi", "A", "wa", { onInvalidate: () => { invalidations += 1; } });
  await settle();
  h.watches[0].connect();
  h.watches[1].connect();
  await settle();
  assert.equal(h.unlistens(), 1);
  assert.equal(h.watches.filter((watch) => watch.active).length, 1);
  h.watches[0].changed();
  assert.equal(invalidations, 0);
  h.event("kimi");
  assert.equal(invalidations, 1);
  assert.equal(h.requests.length, 1);
});

test("listener becoming ready catches a missed change without invoking file-event consumers", async () => {
  const h = harness(true);
  let invalidations = 0;
  h.subscribeSessionList("kimi", "A", "wa", { onInvalidate: () => { invalidations += 1; } });
  await h.clock.advance();
  h.finish(0);
  await settle();
  h.watches[0].connect();
  await h.clock.advance();
  assert.equal(h.requests.length, 2);
  assert.equal(invalidations, 0);
});

test("last unsubscribe cancels queued work and an unsubscribed workspace cannot request a scan", async () => {
  const h = harness();
  const stop = h.subscribeSessionList("claude", "A", "wa");
  stop();
  h.refreshSessionList("claude", "A");
  await h.clock.advance(5000);
  assert.equal(h.requests.length, 0);
  assert.equal(h.watches.length, 0);
  assert.equal(h.clock.pending(), 0);
  const activeStop = h.subscribeSessionList("claude", "A", "wa");
  await h.clock.advance();
  h.finish(0);
  await settle();
  h.running.add("wa");
  h.event("claude");
  activeStop();
  await h.clock.advance(5000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.clock.pending(), 0);
  assert.equal(h.unlistens(), 1);
});

test("one consumer leaving does not suppress live peers or let a throwing callback block them", async () => {
  const h = harness();
  const removed: string[] = [];
  const live: string[] = [];
  const stop = h.subscribeSessionList("codex", "A", "wa", labels(removed));
  h.subscribeSessionList("codex", "A", "wa", { onData: () => { throw new Error("consumer failed"); } });
  h.subscribeSessionList("codex", "A", "wa", labels(live));
  await h.clock.advance();
  stop();
  h.finish(0, "result");
  await settle();
  assert.deepEqual(removed, []);
  assert.deepEqual(live, ["result"]);
  assert.equal(h.reported.length, 1);
  assert.equal(h.unlistens(), 0);
});

test("scan failures notify consumers and later events retry without an automatic retry loop", async () => {
  const h = harness();
  const errors: unknown[] = [];
  const seen: string[] = [];
  h.subscribeSessionList("grok", "A", "wa", { ...labels(seen), onError: (error) => { errors.push(error); } });
  await h.clock.advance();
  const error = new Error("read failed");
  h.requests[0].reject(error);
  await h.clock.advance(5000);
  assert.deepEqual(errors, [error]);
  assert.equal(h.requests.length, 1);
  h.event("grok");
  await h.clock.advance();
  assert.equal(h.requests.length, 2);
  h.finish(1, "recovered");
  await settle();
  assert.deepEqual(seen, ["recovered"]);
});
