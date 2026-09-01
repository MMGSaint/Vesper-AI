/**
 * Reminder executor: a due-at task that is not a tool call.
 *
 * The property under test is that a reminder notifies and completes, and that stuffing
 * a tool name into the persisted args cannot turn it into a tool call. The delayed
 * tool_call path is covered in tool-executor.test.ts; this file is the other kind.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime } from "./test-helpers.ts";
import { EventBus } from "./events.ts";
import { NotificationHub } from "./notifications.ts";
import { REMINDER_TASK_KIND, createReminderExecutor } from "./reminder-executor.ts";
import { TOOL_CALL_TASK_KIND } from "./tool-executor.ts";
import type { VesperTask } from "./distributed/tasks.ts";

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

function fakeTask(over: Partial<VesperTask> = {}): VesperTask {
  return {
    id: "task-reminder-1",
    description: "Stand up",
    state: "running",
    priority: "normal",
    createdAt: "2026-09-01T20:00:00.000Z",
    updatedAt: "2026-09-01T20:00:00.000Z",
    createdBy: "self",
    requiredCapabilities: [],
    dependsOn: [],
    assignedTo: "self",
    result: null,
    error: null,
    retry: { maxAttempts: 3, attempts: 1 },
    private: true,
    kind: REMINDER_TASK_KIND,
    ...over,
  };
}

describe("createReminderExecutor", () => {
  it("pushes a subsystem notification and a durable event", async () => {
    const events = new EventBus(silentLog());
    const hub = new NotificationHub(true, 0);
    const host: string[] = [];
    const executor = createReminderExecutor({
      notifications: hub,
      events,
      notifyHost: (title, body) => {
        host.push(`${title}|${body}`);
        return { ok: true, summary: "dispatched" };
      },
    });

    const result = await executor(fakeTask({ args: { message: "walk around" } }), {
      deviceId: "self",
      signal: new AbortController().signal,
      log: silentLog(),
    });

    assert.equal(result.ok, true);
    const notes = hub.recent();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].author, "subsystem");
    assert.equal(notes[0].kind, "info");
    assert.equal(notes[0].title, "Stand up");
    assert.equal(notes[0].body, "walk around");
    assert.equal(host[0], "Stand up|walk around");
    const fired = events.recent({ type: "task.reminder", limit: 5 });
    assert.equal(fired.length, 1);
    assert.match(fired[0].title, /Stand up/);
  });

  it("ignores args.tool — a reminder is not a tool_call by another name", async () => {
    const events = new EventBus(silentLog());
    const hub = new NotificationHub(true, 0);
    const executor = createReminderExecutor({ notifications: hub, events });
    const result = await executor(
      fakeTask({
        args: { tool: "fs_write", args: { path: "/etc/passwd", content: "nope" }, message: "hydrate" },
      }),
      { deviceId: "self", signal: new AbortController().signal, log: silentLog() },
    );
    assert.equal(result.ok, true);
    assert.equal(hub.recent()[0].body, "hydrate");
    assert.equal(result.data && "tool" in result.data, false, "must not echo a planted tool name");
  });

  it("treats shutdown as transient so the reminder can fire next boot", async () => {
    const events = new EventBus(silentLog());
    const hub = new NotificationHub(true, 0);
    const executor = createReminderExecutor({ notifications: hub, events });
    const ctl = new AbortController();
    ctl.abort();
    const result = await executor(fakeTask(), {
      deviceId: "self",
      signal: ctl.signal,
      log: silentLog(),
    });
    assert.equal(result.ok, false);
    assert.equal(hub.recent().length, 0);
  });
});

describe("task_create reminder and dueAt, through the runtime", () => {
  it("the runtime registers the reminder kind", async () => {
    const runtime = await testRuntime();
    assert.equal(runtime.taskExecutors.has(REMINDER_TASK_KIND), true);
  });

  it("dueAt without a tool queues a reminder, not a tool_call", async () => {
    const runtime = await testRuntime();
    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: {
        description: "drink water",
        dueAt: new Date(Date.now() + 60_000).toISOString(),
        message: "a full glass",
      },
      workspaceId: "general",
    });
    assert.equal(queued.result?.ok, true, queued.result?.summary);
    const taskId = (queued.result?.data as { taskId?: string }).taskId!;
    const task = await runtime.taskQueue.get(taskId);
    assert.equal(task?.kind, REMINDER_TASK_KIND);
    assert.equal(task?.args?.message, "a full glass");
    assert.ok(task?.dueAt);
  });

  it("inSeconds: 0 fires on the next tick and lands in the hub", async () => {
    const runtime = await testRuntime({ config: { agent: { driveTasksOnIdle: true } } });
    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: { description: "stretch", inSeconds: 0, message: "stand up" },
      workspaceId: "general",
    });
    const taskId = (queued.result?.data as { taskId?: string }).taskId!;
    await runtime.taskScheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const task = await runtime.taskQueue.get(taskId);
    assert.equal(task?.state, "done", `expected done, got ${task?.state} / ${task?.error}`);
    const notes = runtime.notifications.recent();
    assert.ok(
      notes.some((n) => n.author === "subsystem" && n.title === "stretch"),
      `no reminder in hub: ${JSON.stringify(notes)}`,
    );
  });

  it("a future dueAt is still assigned, not started", async () => {
    const runtime = await testRuntime({ config: { agent: { driveTasksOnIdle: true } } });
    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: {
        description: "later tonight",
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      workspaceId: "general",
    });
    const taskId = (queued.result?.data as { taskId?: string }).taskId!;
    await runtime.taskScheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const task = await runtime.taskQueue.get(taskId);
    assert.equal(task?.state, "assigned", `a future reminder must wait, got ${task?.state}`);
    assert.equal(runtime.notifications.recent().some((n) => n.title === "later tonight"), false);
  });

  it("refuses dueAt and inSeconds together", async () => {
    const runtime = await testRuntime();
    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: {
        description: "ambiguous",
        dueAt: new Date().toISOString(),
        inSeconds: 10,
      },
      workspaceId: "general",
    });
    assert.equal(queued.result?.ok, false);
    assert.match(queued.result?.summary ?? "", /not both/);
  });

  it("a due reminder stays assigned while driveTasksOnIdle is off", async () => {
    const runtime = await testRuntime();
    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: { description: "stretch now", inSeconds: 0, message: "stand up" },
      workspaceId: "general",
    });
    const taskId = (queued.result?.data as { taskId?: string }).taskId!;
    const tick = await runtime.taskScheduler.tick();
    assert.deepEqual(tick.reasons, ["scheduler-disabled"]);
    const task = await runtime.taskQueue.get(taskId);
    assert.equal(task?.kind, REMINDER_TASK_KIND);
    assert.equal(task?.state, "assigned", `must wait for the idle-drive flag, got ${task?.state}`);
    assert.equal(runtime.notifications.recent().some((n) => n.title === "stretch now"), false);
  });

  it("a planted tool name on a reminder does not write a file", async () => {
    const base = await mkdtemp(join(tmpdir(), "vesper-reminder-"));
    const approved = join(base, "docs");
    await mkdir(approved, { recursive: true });
    await writeFile(join(approved, "keep.txt"), "safe");
    const runtime = await testRuntime({
      config: {
        approvedRoots: [approved],
        agent: { driveTasksOnIdle: true },
      },
    });
    const planted = join(approved, "pwned.txt");
    const created = await runtime.taskQueue.create({
      description: "innocent reminder",
      createdBy: "self",
      kind: REMINDER_TASK_KIND,
      dueAt: new Date(Date.now() - 1000).toISOString(),
      args: {
        tool: "fs_write",
        args: { path: planted, content: "owned" },
        message: "hello",
      },
    });
    await runtime.taskScheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const task = await runtime.taskQueue.get(created.id);
    assert.equal(task?.state, "done", `reminder should complete, got ${task?.state} / ${task?.error}`);
    const wrote = await stat(planted).then(
      () => true,
      () => false,
    );
    assert.equal(wrote, false, "a reminder must never run the planted tool");
    assert.notEqual(created.kind, TOOL_CALL_TASK_KIND);
  });
});
