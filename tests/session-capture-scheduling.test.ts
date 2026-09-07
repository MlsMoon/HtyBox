import assert from "node:assert/strict";
import test from "node:test";
import { createSessionCaptureScheduler, waitForSessionCapturePoll } from "../src/sessionCaptureScheduling.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); }

test("ten queued requests for one group share one task using the latest callback", async () => {
  const scheduler = createSessionCaptureScheduler();
  const calls: number[] = [];
  const results = Array.from({ length: 10 }, (_, index) => scheduler.request("codex/A", async () => {
    calls.push(index);
  }));
  assert.equal(new Set(results).size, 1);
  await Promise.all(results);
  assert.deepEqual(calls, [9]);
});

test("running duplicates form one follow-up behind all other queued groups", async () => {
  const scheduler = createSessionCaptureScheduler();
  const first = deferred();
  const second = deferred();
  const calls: string[] = [];
  const a = scheduler.request("A", async () => { calls.push("A1"); await first.promise; });
  await settle();
  const repeats = Array.from({ length: 10 }, () => scheduler.request("A", async () => { calls.push("A2"); }));
  const b = scheduler.request("B", async () => { calls.push("B"); await second.promise; });
  const c = scheduler.request("C", async () => { calls.push("C"); });
  assert.equal(new Set(repeats).size, 1);
  assert.notEqual(repeats[0], a);
  first.resolve();
  await settle();
  assert.deepEqual(calls, ["A1", "B"]);
  second.resolve();
  await Promise.all([a, b, c, ...repeats]);
  assert.deepEqual(calls, ["A1", "B", "C", "A2"]);
});

test("canceling a queued group completes waiters without running it and permits immediate reuse", async () => {
  const scheduler = createSessionCaptureScheduler();
  const calls: string[] = [];
  const old = scheduler.request("A", async () => { calls.push("old"); });
  scheduler.cancel("A");
  const fresh = scheduler.request("A", async () => { calls.push("new"); });
  await Promise.all([old, fresh]);
  assert.deepEqual(calls, ["new"]);
});

test("canceling a running group drops its follow-up but keeps new groups globally serialized", async () => {
  const scheduler = createSessionCaptureScheduler();
  const native = deferred();
  const calls: string[] = [];
  let active = 0;
  let maximum = 0;
  const run = (name: string, gate?: Promise<void>) => async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    calls.push(name);
    if (gate) await gate;
    active -= 1;
  };
  const old = scheduler.request("A", run("old", native.promise));
  await settle();
  const dirty = scheduler.request("A", run("canceled dirty"));
  const b = scheduler.request("B", run("B"));
  scheduler.cancel("A");
  const fresh = scheduler.request("A", run("fresh"));
  await dirty;
  await settle();
  assert.deepEqual(calls, ["old"]);
  native.resolve();
  await Promise.all([old, b, fresh]);
  assert.deepEqual(calls, ["old", "B", "fresh"]);
  assert.equal(maximum, 1);
});

test("a failed native request rejects its callers while other groups and its follow-up continue", async () => {
  const scheduler = createSessionCaptureScheduler();
  const native = deferred();
  const calls: string[] = [];
  const error = new Error("native mapping failed");
  const a = scheduler.request("A", () => native.promise);
  const observed = a.then(() => "unexpected success", (value: unknown) => value);
  await settle();
  const next = scheduler.request("A", async () => { calls.push("A retry"); });
  const b = scheduler.request("B", async () => { calls.push("B"); });
  native.reject(error);
  assert.equal(await observed, error);
  await Promise.all([next, b]);
  assert.deepEqual(calls, ["B", "A retry"]);
});

test("synchronous callback exceptions do not leave the global queue locked", async () => {
  const scheduler = createSessionCaptureScheduler();
  const error = new Error("synchronous failure");
  const a = scheduler.request("A", () => { throw error; });
  const duplicate = scheduler.request("A", () => { throw error; });
  let completed = false;
  const b = scheduler.request("B", async () => { completed = true; });
  const results = await Promise.allSettled([a, duplicate, b]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "rejected");
  if (results[0].status === "rejected") assert.equal(results[0].reason, error);
  assert.equal(completed, true);
});

test("normal polling completion removes every abort listener and clears its timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const added = t.mock.method(controller.signal, "addEventListener");
  const removed = t.mock.method(controller.signal, "removeEventListener");
  const cleared = t.mock.method(globalThis, "clearTimeout");
  for (let index = 0; index < 30; index += 1) {
    const wait = waitForSessionCapturePoll(controller.signal, 1500);
    t.mock.timers.tick(1500);
    await wait;
  }
  assert.equal(added.mock.callCount(), 30);
  assert.equal(removed.mock.callCount(), 30);
  assert.equal(cleared.mock.callCount(), 30);
  for (let index = 0; index < 30; index += 1) {
    assert.equal(added.mock.calls[index].arguments[1], removed.mock.calls[index].arguments[1]);
  }
});

test("aborting a poll clears the timer and listener without waiting for the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const removed = t.mock.method(controller.signal, "removeEventListener");
  const cleared = t.mock.method(globalThis, "clearTimeout");
  const wait = waitForSessionCapturePoll(controller.signal, 1500);
  controller.abort();
  await wait;
  assert.equal(removed.mock.callCount(), 1);
  assert.equal(cleared.mock.callCount(), 1);
  t.mock.timers.tick(1500);
  assert.equal(removed.mock.callCount(), 1);
});

test("an already aborted signal registers neither a timer nor an abort listener", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const added = t.mock.method(controller.signal, "addEventListener");
  const timed = t.mock.method(globalThis, "setTimeout");
  await waitForSessionCapturePoll(controller.signal, 1500);
  assert.equal(added.mock.callCount(), 0);
  assert.equal(timed.mock.callCount(), 0);
});
