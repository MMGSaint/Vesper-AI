import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "./storage.ts";
import { TaskQueue } from "./distributed/tasks.ts";
import { EventBus } from "./events.ts";
import {
  TaskExecutorRegistry,
  TaskScheduler,
  registerBuiltinExecutors,
  type TaskExecutor,
} from "./task-scheduler.ts";
import type { DeviceRecord } from "./distributed/registry.ts";
import type { CapabilityManifest } from "./distributed/capabilities.ts";

function silentLog() {
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  } as never;
  return log;
}

function device(input: {
  id: string;
  trust?: "trusted" | "restricted" | "revoked" | "pending" | "unknown";
  online?: boolean;
  capabilities?: string[];
}): DeviceRecord {
  const capabilities: CapabilityManifest | null = input.capabilities
    ? {
        deviceId: input.id,
        generatedAt: "2026-01-01T00:00:00Z",
        findings: input.capabilities.map((id) => ({
          id: id as never,
          state: "AVAILABLE" as const,
          detail: "test",
        })),
      }
    : null;
  return {
    identity: {
      deviceId: input.id,
      deviceType: "desktop",
      name: input.id,
      os: "linux",
      publicKey: "k",
      createdAt: "2026-01-01T00:00:00Z",
      vesperVersion: "test",
    },
    trust: input.trust ?? "trusted",
    capabilities,
    presence: {
      lastSeen: "2026-01-01T00:00:00Z",
      activity: input.online === false ? "unknown" : "active",
      reachability: input.online === false ? "offline" : "online",
    },
    enrolledAt: "2026-01-01T00:00:00Z",
    revokedAt: null,
  } as DeviceRecord;
}

function harness(options: { enabled?: boolean; deviceId?: string; devices?: DeviceRecord[]; executors?: TaskExecutor | { [kind: string]: TaskExecutor }; now?: () => number } = {}) {
  const storage = new MemoryStorage();
  const events = new EventBus(silentLog());
  const queue = new TaskQueue({ storage });
  const registry = new TaskExecutorRegistry();
  const deviceId = options.deviceId ?? "self";
  const devices = options.devices ?? [
    device({ id: deviceId, capabilities: ["task_execute", "local_llm"] }),
  ];
  if (options.executors) {
    if (typeof options.executors === "function") {
      registry.register("noop", options.executors);
    } else {
      for (const [kind, exec] of Object.entries(options.executors)) {
        registry.register(kind, exec);
      }
    }
  } else {
    registerBuiltinExecutors(registry);
  }
  const scheduler = new TaskScheduler({
    taskQueue: queue,
    registry,
    events,
    log: silentLog(),
    deviceId,
    devices: async () => devices,
    enabled: options.enabled ?? true,
    now: options.now,
  });
  return { storage, events, queue, registry, scheduler, deviceId };
}

describe("TaskScheduler — the executor loop", () => {
  it("starts and completes a task with the noop executor", async () => {
    // The end-to-end assertion is the STORE state, not the return value.
    const h = harness();
    const created = await h.queue.create({
      description: "smoke test",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
    });
    await h.scheduler.tick();
    // Await two microtask flushes so the fire-and-forget executor writes complete().
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const final = await h.queue.get(created.id);
    assert.equal(final?.state, "done", `expected done, got ${final?.state}`);
    assert.match(final?.result ?? "", /noop task 'smoke test' complete/);
  });

  it("stays disabled when the config flag is off — a completely inert tick", async () => {
    const h = harness({ enabled: false });
    await h.queue.create({
      description: "should not run",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
    });
    const summary = await h.scheduler.tick();
    assert.equal(summary.started, 0);
    assert.deepEqual(summary.reasons, ["scheduler-disabled"]);
  });

  it("refuses to re-drive a task in a terminal state", async () => {
    // The queue's start() has no source-state guard, so the scheduler must enforce
    // the invariant. If a task somehow reaches the scheduler while state=done, the
    // scheduler must not call start() on it.
    let executorCalled = 0;
    const h = harness({
      executors: async () => {
        executorCalled += 1;
        return { ok: true, summary: "ran" };
      },
    });
    const created = await h.queue.create({
      description: "already done",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
    });
    // Poison: mark it done before the scheduler sees it. Then also mark it 'assigned'
    // and assigned to us to simulate a scheduling error that would otherwise send it
    // to the executor. Since the queue's state exclusion prevents assigning a done
    // task via schedule(), do it manually via direct persist:
    const raw = await h.storage.get("tasks.queue");
    if (Array.isArray(raw)) {
      const arr = raw as Array<{ id: string; state: string; assignedTo: string | null }>;
      const entry = arr.find((t) => t.id === created.id);
      if (entry) {
        entry.state = "done";
        entry.assignedTo = "self";
        await h.storage.set("tasks.queue", arr as never);
      }
    }
    // Force the queue to reload from storage — a fresh instance shares storage:
    const events2 = new EventBus(silentLog());
    const queue2 = new TaskQueue({ storage: h.storage });
    const registry = h.registry;
    const scheduler2 = new TaskScheduler({
      taskQueue: queue2,
      registry,
      events: events2,
      log: silentLog(),
      deviceId: "self",
      devices: async () => [device({ id: "self", capabilities: ["task_execute"] })],
      enabled: true,
    });
    await scheduler2.tick();
    await new Promise((r) => setImmediate(r));
    // Executor must not have been called for the done task.
    assert.equal(executorCalled, 0, "terminal-state task must not reach the executor");
    // And the state is still done.
    assert.equal((await queue2.get(created.id))?.state, "done");
  });

  it("emits task.executor_missing for a task with an unknown kind", async () => {
    const h = harness();
    await h.queue.create({
      description: "no executor for this",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "invented_kind",
    });
    await h.scheduler.tick();
    const events = h.events.recent({ type: "task.executor_missing", limit: 5 });
    assert.equal(events.length, 1);
    assert.match(events[0].title, /invented_kind/);
    // The task must remain assigned (not silently completed).
    const all = await h.queue.list();
    const task = all.find((t) => t.description === "no executor for this");
    assert.equal(task?.state, "assigned", "task with missing executor stays assigned, not silently completed");
  });

  it("does not start a task the executor kind is missing on — and stays refused across multiple ticks", async () => {
    // Confirms 'stays assigned but not re-attempted on the same tick' extends to
    // multiple ticks: no leak into started.
    const h = harness();
    await h.queue.create({
      description: "still no executor",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "missing",
    });
    for (let i = 0; i < 5; i++) await h.scheduler.tick();
    const events = h.events.recent({ type: "task.executor_missing", limit: 20 });
    // Each tick fires one event because the task keeps appearing as an assigned
    // candidate; that's honest (loss must be loud) rather than a bug.
    assert.ok(events.length >= 1);
    // The task never reached started/done.
    const task = (await h.queue.list()).find((t) => t.description === "still no executor");
    assert.equal(task?.state, "assigned");
  });

  it("translates an executor throw into fail() with a visible event", async () => {
    let calls = 0;
    const h = harness({
      executors: async () => {
        calls += 1;
        throw new Error("kaboom");
      },
    });
    const created = await h.queue.create({
      description: "will blow up",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
      maxAttempts: 1,
    });
    await h.scheduler.tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1, "executor called");
    const final = await h.queue.get(created.id);
    assert.equal(final?.state, "failed", `expected failed, got ${final?.state}`);
    assert.match(final?.error ?? "", /kaboom/);
    const errEvents = h.events.recent({ type: "task.execution_error", limit: 5 });
    assert.ok(errEvents.length >= 1, "task.execution_error event must be emitted");
    assert.match(errEvents[0].title, /kaboom/);
  });

  it("cannot start the same task twice from two concurrent ticks", async () => {
    // The inFlight set is what enforces this. If both ticks call start(), the
    // executor runs twice with the same task id — a duplicate execution.
    let executorConcurrentPeak = 0;
    let running = 0;
    const h = harness({
      executors: async () => {
        running += 1;
        executorConcurrentPeak = Math.max(executorConcurrentPeak, running);
        await new Promise((r) => setTimeout(r, 10));
        running -= 1;
        return { ok: true, summary: "ran" };
      },
    });
    await h.queue.create({
      description: "exclusive",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
    });
    // Two concurrent ticks racing for the same task:
    await Promise.all([h.scheduler.tick(), h.scheduler.tick()]);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(executorConcurrentPeak, 1, `same task ran ${executorConcurrentPeak}x concurrently`);
  });

  it("respects the per-tick cap — never starts more than maxPerTick tasks", async () => {
    const h = harness();
    // Override the maxPerTick from harness default (4) explicitly for this test:
    const constrainedScheduler = new TaskScheduler({
      taskQueue: h.queue,
      registry: h.registry,
      events: h.events,
      log: silentLog(),
      deviceId: "self",
      devices: async () => [device({ id: "self", capabilities: ["task_execute"] })],
      enabled: true,
      maxPerTick: 2,
    });
    for (let i = 0; i < 5; i++) {
      await h.queue.create({
        description: `t${i}`,
        createdBy: "user",
        requiredCapabilities: ["task_execute"],
        kind: "noop",
      });
    }
    const summary = await constrainedScheduler.tick();
    assert.equal(summary.started, 2, `expected 2 started, got ${summary.started}`);
  });

  it("does not run a task cancelled between routing and execution", async () => {
    // Race scenario: routing assigns the task, then the user cancels via the queue's
    // cancel() before the scheduler re-fetches it. The scheduler must respect the
    // fresh state.
    let calls = 0;
    const h = harness({
      executors: async () => {
        calls += 1;
        return { ok: true, summary: "should not run" };
      },
    });
    const created = await h.queue.create({
      description: "will be cancelled",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
    });
    // Route it to us via a manual schedule() call so it becomes assigned:
    await h.queue.schedule([device({ id: "self", capabilities: ["task_execute"] })]);
    // Cancel it BEFORE the scheduler's own tick:
    await h.queue.cancel(created.id);
    // Now tick:
    await h.scheduler.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 0, "cancelled task must not reach the executor");
    assert.equal((await h.queue.get(created.id))?.state, "cancelled");
  });

  it("refuses to route to a revoked device — the router already forbids it", async () => {
    // The route is upstream of the scheduler. Verify: a revoked device that is the
    // only candidate leaves the task queued, and nothing gets executed.
    const h = harness({
      devices: [device({ id: "self", trust: "revoked", capabilities: ["task_execute"] })],
    });
    await h.queue.create({
      description: "should stay queued",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
    });
    await h.scheduler.tick();
    const task = (await h.queue.list()).find((t) => t.description === "should stay queued");
    assert.equal(task?.state, "queued", `expected queued (revoked device), got ${task?.state}`);
  });

  it("refuses to route a task requiring a capability no device has", async () => {
    const h = harness({
      devices: [device({ id: "self", capabilities: ["task_execute"] })],
    });
    await h.queue.create({
      description: "needs special hw",
      createdBy: "user",
      requiredCapabilities: ["capability_that_no_one_has" as never],
      kind: "noop",
    });
    await h.scheduler.tick();
    const task = (await h.queue.list()).find((t) => t.description === "needs special hw");
    assert.equal(task?.state, "queued", "task with unmet capability must stay queued");
  });

  it("survives a restart — a task caught mid-flight is re-driven, not duplicated", async () => {
    // The queue's load() coerces assigned/running -> queued on restart. The scheduler
    // then reschedules and executes. Verify: no double-completion.
    let calls = 0;
    const executor = async () => {
      calls += 1;
      return { ok: true, summary: `attempt ${calls}` };
    };
    const storage = new MemoryStorage();
    const events1 = new EventBus(silentLog());
    const q1 = new TaskQueue({ storage });
    const r1 = new TaskExecutorRegistry();
    r1.register("noop", executor);
    const s1 = new TaskScheduler({
      taskQueue: q1,
      registry: r1,
      events: events1,
      log: silentLog(),
      deviceId: "self",
      devices: async () => [device({ id: "self", capabilities: ["task_execute"] })],
      enabled: true,
    });
    const created = await q1.create({
      description: "survives",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
      idempotent: true,
    });
    // Route + start manually, but simulate a crash BEFORE the executor completes:
    await q1.schedule([device({ id: "self", capabilities: ["task_execute"] })]);
    await q1.start(created.id);
    // Crash — don't let executor finish. Discard s1. New instance from same storage:
    const events2 = new EventBus(silentLog());
    const q2 = new TaskQueue({ storage });
    const r2 = new TaskExecutorRegistry();
    r2.register("noop", executor);
    const s2 = new TaskScheduler({
      taskQueue: q2,
      registry: r2,
      events: events2,
      log: silentLog(),
      deviceId: "self",
      devices: async () => [device({ id: "self", capabilities: ["task_execute"] })],
      enabled: true,
    });
    // The task's state on disk should be 'queued' now (coerced from running).
    const beforeTick = await q2.get(created.id);
    assert.equal(beforeTick?.state, "queued", `after restart, mid-flight task should be requeued`);
    await s2.tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const final = await q2.get(created.id);
    assert.equal(final?.state, "done");
    // The retry counter was bumped on the FIRST start (before crash). The scheduler
    // re-drove it after restart, bumping it again. That's honest.
    assert.equal(final?.retry.attempts, 2, `expected 2 attempts, got ${final?.retry.attempts}`);
  });

  it("stop() aborts in-flight executors via the signal", async () => {
    let sawAbort = false;
    const h = harness({
      executors: async (_task, ctx) => {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 200);
          ctx.signal.addEventListener("abort", () => {
            sawAbort = true;
            clearTimeout(t);
            resolve(undefined);
          });
        });
        return { ok: false, summary: "aborted" };
      },
    });
    await h.queue.create({
      description: "long task",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
    });
    await h.scheduler.tick();
    // Let the executor start:
    await new Promise((r) => setTimeout(r, 20));
    h.scheduler.stop();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(sawAbort, "executor context signal must fire on stop()");
  });

  it("times out a hung executor and does not retry a non-idempotent timeout", async () => {
    const h = harness({
      executors: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { ok: true, summary: "should not finish" };
      },
    });
    const created = await h.queue.create({
      description: "hung",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
      timeoutMs: 40,
      idempotent: false,
    });
    await h.scheduler.tick();
    await new Promise((r) => setTimeout(r, 80));
    const final = await h.queue.get(created.id);
    assert.equal(final?.state, "failed", `expected failed, got ${final?.state}`);
    assert.match(final?.error ?? "", /timed out/i);
  });

  it("skips a task whose backoff window has not elapsed", async () => {
    const h = harness();
    const created = await h.queue.create({
      description: "later",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
      backoffMs: 60_000,
    });
    await h.queue.start(created.id);
    await h.queue.fail(created.id, "try later");
    const waiting = await h.queue.get(created.id);
    assert.equal(waiting?.state, "queued");
    const tick = await h.scheduler.tick();
    assert.ok(tick.reasons.some((reason) => reason.endsWith(":backoff")));
    const still = await h.queue.get(created.id);
    assert.notEqual(still?.state, "done");
    assert.notEqual(still?.state, "running");
  });

  it("does not start a task whose dueAt is still in the future", async () => {
    let now = Date.parse("2026-09-01T20:00:00.000Z");
    let called = 0;
    const h = harness({
      now: () => now,
      executors: async () => {
        called += 1;
        return { ok: true, summary: "ran" };
      },
    });
    const created = await h.queue.create({
      description: "later",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
      dueAt: "2026-09-01T20:01:00.000Z",
    });
    const first = await h.scheduler.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(called, 0, "a future dueAt must not reach the executor");
    assert.ok(first.reasons.some((r) => r.endsWith(":not-due")), `expected not-due, got ${first.reasons}`);
    assert.equal((await h.queue.get(created.id))?.state, "assigned");

    now = Date.parse("2026-09-01T20:01:00.000Z");
    await h.scheduler.tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(called, 1);
    assert.equal((await h.queue.get(created.id))?.state, "done");
  });

  it("fails a task with a garbage dueAt instead of firing it or skipping forever", async () => {
    const h = harness();
    const created = await h.queue.create({
      description: "broken clock",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
      dueAt: "not-a-timestamp",
    });
    await h.scheduler.tick();
    await new Promise((r) => setImmediate(r));
    const final = await h.queue.get(created.id);
    assert.equal(final?.state, "failed");
    assert.match(final?.error ?? "", /dueAt is not a valid timestamp/);
  });

  it("a not-due task does not consume the per-tick cap", async () => {
    let now = Date.parse("2026-09-01T20:00:00.000Z");
    let called = 0;
    const h = harness({
      now: () => now,
      executors: async (task) => {
        called += 1;
        return { ok: true, summary: task.description };
      },
    });
    // Four future reminders would starve due work if they counted against maxPerTick
    // (default 4) the way a started task does.
    for (let i = 0; i < 4; i += 1) {
      await h.queue.create({
        description: `later-${i}`,
        createdBy: "user",
        requiredCapabilities: ["task_execute"],
        kind: "noop",
        dueAt: "2026-09-01T21:00:00.000Z",
      });
    }
    const due = await h.queue.create({
      description: "now",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
    });
    await h.scheduler.tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(called, 1, "the due task must still start");
    assert.equal((await h.queue.get(due.id))?.state, "done");
  });
});
