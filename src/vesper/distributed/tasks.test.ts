import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStorage } from "../storage.ts";
import { TaskQueue, routeTask, type VesperTask } from "./tasks.ts";
import type { DeviceRecord } from "./registry.ts";
import type { CapabilityManifest } from "./capabilities.ts";
import type { PublicDeviceIdentity, TrustState } from "./identity.ts";

function device(input: {
  id: string;
  name?: string;
  trust?: TrustState;
  online?: boolean;
  activity?: DeviceRecord["presence"]["activity"];
  capabilities?: string[];
}): DeviceRecord {
  const identity: PublicDeviceIdentity = {
    deviceId: input.id,
    deviceType: "desktop",
    name: input.name ?? input.id,
    os: "linux",
    publicKey: "k",
    createdAt: "2026-01-01T00:00:00.000Z",
    vesperVersion: "test",
  };
  const capabilities: CapabilityManifest | null = input.capabilities
    ? {
        deviceId: input.id,
        generatedAt: "2026-01-01T00:00:00.000Z",
        findings: input.capabilities.map((id) => ({
          id: id as never,
          state: "AVAILABLE" as const,
          detail: "probed",
        })),
      }
    : null;
  return {
    identity,
    trust: input.trust ?? "trusted",
    presence: {
      reachability: input.online === false ? "offline" : "online",
      activity: input.activity ?? "idle",
      lastSeen: "2026-01-01T00:00:00.000Z",
    },
    capabilities,
    enrolledAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
  };
}

function task(over: Partial<VesperTask> = {}): VesperTask {
  return {
    id: "task_1",
    description: "benchmark local models",
    state: "queued",
    priority: "normal",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: "dev_phone",
    requiredCapabilities: ["local_llm"],
    dependsOn: [],
    assignedTo: null,
    result: null,
    error: null,
    retry: { maxAttempts: 3, attempts: 0 },
    private: true,
    ...over,
  };
}

const NONE: ReadonlySet<string> = new Set();

test("task routing", async (t) => {
  await t.test("sends work to the device that can actually do it", () => {
    const outcome = routeTask({
      task: task(),
      devices: [
        device({ id: "dev_phone", capabilities: ["conversation"] }),
        device({ id: "dev_desktop", capabilities: ["local_llm", "task_execute"] }),
      ],
      completedTaskIds: NONE,
    });
    assert.equal(outcome.kind, "assigned");
    assert.equal(outcome.kind === "assigned" && outcome.deviceId, "dev_desktop");
  });

  await t.test("queues rather than degrading onto an incapable device", () => {
    const outcome = routeTask({
      task: task(),
      devices: [device({ id: "dev_phone", capabilities: ["conversation"] })],
      completedTaskIds: NONE,
    });
    assert.equal(outcome.kind, "queued");
    assert.match(outcome.reason, /No enrolled device reports the capabilities/);
  });

  await t.test("distinguishes 'nobody can' from 'the one that can is offline'", () => {
    const outcome = routeTask({
      task: task(),
      devices: [device({ id: "dev_desktop", capabilities: ["local_llm"], online: false })],
      completedTaskIds: NONE,
    });
    assert.equal(outcome.kind, "queued");
    assert.match(outcome.reason, /not online. Holding the task/);
  });

  await t.test("a portable device never receives execution", () => {
    // It reports the capability, but a restricted device runs on an untrusted host.
    const outcome = routeTask({
      task: task(),
      devices: [device({ id: "dev_usb", trust: "restricted", capabilities: ["local_llm", "task_execute"] })],
      completedTaskIds: NONE,
    });
    assert.equal(outcome.kind, "queued");
  });

  await t.test("pending and revoked devices never receive execution", () => {
    for (const trust of ["pending", "revoked", "unknown"] as const) {
      const outcome = routeTask({
        task: task(),
        devices: [device({ id: "dev_x", trust, capabilities: ["local_llm", "task_execute"] })],
        completedTaskIds: NONE,
      });
      assert.equal(outcome.kind, "queued", `${trust} must not execute`);
    }
  });

  await t.test("honours a preferred device when it qualifies", () => {
    const outcome = routeTask({
      task: task({ preferredDevice: "dev_laptop" }),
      devices: [
        device({ id: "dev_desktop", capabilities: ["local_llm", "task_execute"] }),
        device({ id: "dev_laptop", capabilities: ["local_llm", "task_execute"] }),
      ],
      completedTaskIds: NONE,
    });
    assert.equal(outcome.kind === "assigned" && outcome.deviceId, "dev_laptop");
  });

  await t.test("ignores a preferred device that cannot do the work", () => {
    const outcome = routeTask({
      task: task({ preferredDevice: "dev_phone" }),
      devices: [
        device({ id: "dev_phone", capabilities: ["conversation"] }),
        device({ id: "dev_desktop", capabilities: ["local_llm", "task_execute"] }),
      ],
      completedTaskIds: NONE,
    });
    assert.equal(outcome.kind === "assigned" && outcome.deviceId, "dev_desktop");
  });

  await t.test("prefers an idle machine over the one being used", () => {
    const outcome = routeTask({
      task: task(),
      devices: [
        device({ id: "dev_a", activity: "active", capabilities: ["local_llm", "task_execute"] }),
        device({ id: "dev_b", activity: "idle", capabilities: ["local_llm", "task_execute"] }),
      ],
      completedTaskIds: NONE,
    });
    assert.equal(outcome.kind === "assigned" && outcome.deviceId, "dev_b");
  });

  await t.test("respects an explicit eligible-device list", () => {
    const outcome = routeTask({
      task: task({ eligibleDevices: ["dev_desktop"] }),
      devices: [
        device({ id: "dev_laptop", capabilities: ["local_llm", "task_execute"] }),
        device({ id: "dev_desktop", capabilities: ["local_llm", "task_execute"], online: false }),
      ],
      completedTaskIds: NONE,
    });
    assert.equal(outcome.kind, "queued", "an ineligible device is not a fallback");
  });

  await t.test("blocks on unfinished dependencies", () => {
    const outcome = routeTask({
      task: task({ dependsOn: ["task_earlier"] }),
      devices: [device({ id: "dev_desktop", capabilities: ["local_llm", "task_execute"] })],
      completedTaskIds: NONE,
    });
    assert.equal(outcome.kind, "blocked");
    assert.match(outcome.reason, /Waiting on 1 unfinished/);
  });

  await t.test("routes once its dependency completes", () => {
    const outcome = routeTask({
      task: task({ dependsOn: ["task_earlier"] }),
      devices: [device({ id: "dev_desktop", capabilities: ["local_llm", "task_execute"] })],
      completedTaskIds: new Set(["task_earlier"]),
    });
    assert.equal(outcome.kind, "assigned");
  });
});

test("task queue", async (t) => {
  await t.test("tasks are private by default", async () => {
    const queue = new TaskQueue({ storage: new MemoryStorage() });
    const created = await queue.create({ description: "summarise my notes", createdBy: "dev_a" });
    assert.equal(created.private, true);
    assert.equal(created.state, "queued");
  });

  await t.test("survives a restart, and requeues work caught mid-flight", async () => {
    const storage = new MemoryStorage();
    const first = new TaskQueue({ storage });
    const created = await first.create({
      description: "benchmark",
      createdBy: "dev_phone",
      requiredCapabilities: ["local_llm"],
    });
    await first.schedule([device({ id: "dev_desktop", capabilities: ["local_llm", "task_execute"] })]);
    await first.start(created.id);
    assert.equal((await first.get(created.id))?.state, "running");

    // The device dies here. A new process loads the same storage.
    const second = new TaskQueue({ storage });
    const restored = await second.get(created.id);
    assert.ok(restored, "the task survived the restart");
    assert.equal(restored?.state, "queued", "a task caught running is requeued, not assumed done");
    assert.equal(restored?.result, null);
  });

  await t.test("retries until the policy is exhausted, then stops", async () => {
    const queue = new TaskQueue({ storage: new MemoryStorage() });
    const created = await queue.create({
      description: "flaky",
      createdBy: "dev_a",
      maxAttempts: 2,
    });
    await queue.start(created.id);
    let after = await queue.fail(created.id, "boom");
    assert.equal(after?.state, "queued", "still has an attempt left");

    await queue.start(created.id);
    after = await queue.fail(created.id, "boom again");
    assert.equal(after?.state, "failed");
    assert.match(after?.error ?? "", /boom again/);
  });

  await t.test("scheduling records the honest reason when nothing can run it", async () => {
    const queue = new TaskQueue({ storage: new MemoryStorage() });
    await queue.create({
      description: "benchmark",
      createdBy: "dev_usb",
      requiredCapabilities: ["local_llm"],
    });
    const scheduled = await queue.schedule([
      device({ id: "dev_usb", trust: "restricted", capabilities: ["conversation"] }),
    ]);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].outcome.kind, "queued");
    assert.equal(scheduled[0].task.assignedTo, null);
  });

  await t.test("a corrupt queue costs pending work, not the ability to accept more", async () => {
    const storage = new MemoryStorage();
    await storage.set("tasks.queue", { nonsense: true } as never);
    const queue = new TaskQueue({ storage });
    assert.deepEqual(await queue.list(), []);
    const created = await queue.create({ description: "still works", createdBy: "dev_a" });
    assert.equal(created.description, "still works");
  });

  await t.test("cancel and complete are terminal and recorded", async () => {
    const queue = new TaskQueue({ storage: new MemoryStorage() });
    const a = await queue.create({ description: "one", createdBy: "dev_a" });
    const b = await queue.create({ description: "two", createdBy: "dev_a" });
    assert.equal((await queue.complete(a.id, "done it"))?.result, "done it");
    assert.equal((await queue.cancel(b.id))?.state, "cancelled");
  });
});

test("task lifecycle events reach the runtime's event bus", async (t) => {
  const { testRuntime } = await import("../test-helpers.ts");

  await t.test("create → start → complete emits three events with the task ids", async () => {
    // A background subscriber (the catchup summary, notification hub, or a future
    // scheduler) needs to see every state transition, not just the ones a scheduler
    // happens to poll for. Consequence-based: assert on the event bus, not on the
    // callback's return.
    const runtime = await testRuntime();
    const before = runtime.events.recent({ limit: 100 }).length;

    const task = await runtime.taskQueue.create({
      description: "compose reply",
      createdBy: "local",
    });
    await runtime.taskQueue.start(task.id);
    await runtime.taskQueue.complete(task.id, "done");

    const after = runtime.events.recent({ limit: 100 });
    const taskEvents = after
      .slice(before)
      .filter((event) => event.type.startsWith("task."))
      .map((event) => ({ type: event.type, title: event.title }));

    assert.equal(taskEvents.length, 3, `expected 3 task events, got ${taskEvents.length}: ${JSON.stringify(taskEvents)}`);
    assert.equal(taskEvents[0].type, "task.created");
    assert.equal(taskEvents[1].type, "task.started");
    assert.equal(taskEvents[2].type, "task.completed");
    assert.match(taskEvents[0].title, /compose reply/);
    assert.match(taskEvents[2].title, /Task done/);
  });

  await t.test("a failure that will retry differs from a failure that is final", async () => {
    // The mission's honesty rule again: 'failed for now' is not the same news as
    // 'given up'. Both must reach the bus, and the final one must be visible as such.
    const runtime = await testRuntime();
    const task = await runtime.taskQueue.create({
      description: "flaky work",
      createdBy: "local",
      maxAttempts: 2,
    });

    await runtime.taskQueue.start(task.id);
    await runtime.taskQueue.fail(task.id, "boom");
    await runtime.taskQueue.start(task.id);
    await runtime.taskQueue.fail(task.id, "boom again");

    const failures = runtime.events
      .recent({ limit: 100 })
      .filter((event) => event.type === "task.failed");

    assert.equal(failures.length, 2, `expected 2 failure events, got ${failures.length}`);
    assert.match(failures[0].title, /will retry/);
    assert.match(failures[1].title, /failed after/);
    assert.equal(failures[0].severity, "info", "retry-eligible failure is info");
    assert.equal(failures[1].severity, "warn", "final failure is warn");
  });

  await t.test("cancellation reaches the bus and the catchup summary counts it", async () => {
    // If a user cancels a task, catchup should reflect that when they ask
    // 'what happened while I was away'. This asserts on the whole path: cancel →
    // event → catchup category badge.
    const runtime = await testRuntime();
    const task = await runtime.taskQueue.create({
      description: "abandoned work",
      createdBy: "local",
    });
    await runtime.taskQueue.cancel(task.id);

    const cancelled = runtime.events
      .recent({ limit: 100 })
      .find((event) => event.type === "task.cancelled");
    assert.ok(cancelled, "task.cancelled event was not emitted");

    const catchup = await runtime.chat("catch me up");
    assert.match(catchup.reply, /Tasks:.*1 queued/);
    assert.match(catchup.reply, /Tasks:.*1 cancelled/);
  });
});
