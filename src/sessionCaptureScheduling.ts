interface CaptureTask {
  run: () => Promise<void>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface CaptureGroup {
  key: string;
  queued?: CaptureTask;
  running?: CaptureTask;
  next?: CaptureTask;
}

function createTask(run: () => Promise<void>): CaptureTask {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { run, promise, resolve, reject };
}

export function createSessionCaptureScheduler() {
  const groups = new Map<string, CaptureGroup>();
  const queue: Array<{ group: CaptureGroup; task: CaptureTask }> = [];
  let active = false;
  let scheduled = false;

  function schedule(): void {
    if (active || scheduled || !queue.length) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }

  function pump(): void {
    if (active) return;
    const item = queue.shift();
    if (!item) return;
    const { group, task } = item;
    group.queued = undefined;
    group.running = task;
    active = true;
    void Promise.resolve().then(() => task.run()).then(task.resolve, task.reject).finally(() => {
      group.running = undefined;
      if (groups.get(group.key) === group) {
        // Requeue after other waiting groups, even if the next request arrived first.
        if (group.next) {
          group.queued = group.next;
          group.next = undefined;
          queue.push({ group, task: group.queued });
        } else groups.delete(group.key);
      }
      active = false;
      schedule();
    });
  }

  function request(key: string, run: () => Promise<void>): Promise<void> {
    let group = groups.get(key);
    if (!group) { group = { key }; groups.set(key, group); }
    if (group.running) {
      group.next ??= createTask(run);
      group.next.run = run;
      return group.next.promise;
    }
    if (group.queued) {
      group.queued.run = run;
      return group.queued.promise;
    }
    const task = createTask(run);
    group.queued = task;
    queue.push({ group, task });
    schedule();
    return task.promise;
  }

  function cancel(key: string): void {
    const group = groups.get(key);
    if (!group) return;
    groups.delete(key);
    const index = queue.findIndex((item) => item.group === group);
    if (index >= 0) queue.splice(index, 1);
    group.queued?.resolve();
    group.queued = undefined;
    group.next?.resolve();
    group.next = undefined;
    schedule();
  }

  return { request, cancel };
}

export function waitForSessionCapturePoll(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
