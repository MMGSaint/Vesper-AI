/**
 * The scheduler→tool path, and the ways it must not become a side door.
 *
 * Phase 2 registered one executor: `noop`. So the sentence "a scheduled task cannot
 * bypass authorization" was true the way a sentence about an empty set is true — nothing
 * scheduled could reach a tool at all. These tests exist because that changed.
 *
 * The three side doors, each with its own test below:
 *
 *   1. `ToolRegistry.get(name).handler` is public and runs with no validation, no gate,
 *      no governor and no origin check.
 *   2. `invoke` trusts `confirmed: true` verbatim — nothing checks that a person
 *      actually approved anything.
 *   3. An ABSENT origin is full local authority, so an executor that merely forgot to
 *      pass one would be indistinguishable from the person at the keyboard.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRuntime } from "./test-helpers.ts";
import { TOOL_CALL_TASK_KIND, createToolCallExecutor } from "./tool-executor.ts";
import { decideScheduledToolRequest, type RequestOrigin } from "./tools/remote.ts";
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

function fakeTask(args: unknown): VesperTask {
  return {
    id: "task-1",
    description: "test task",
    state: "running",
    priority: "normal",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: "self",
    requiredCapabilities: [],
    dependsOn: [],
    assignedTo: "self",
    result: null,
    error: null,
    retry: { maxAttempts: 3, attempts: 1 },
    private: true,
    kind: TOOL_CALL_TASK_KIND,
    args: args as VesperTask["args"],
  };
}

function ctx() {
  return { deviceId: "self", signal: new AbortController().signal, log: silentLog() };
}

async function sandboxRuntime(opts: { driveTasks?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), "vesper-exec-"));
  const approved = join(base, "docs");
  await mkdir(approved, { recursive: true });
  const runtime = await testRuntime({
    config: {
      approvedRoots: [approved],
      // `driveTasksOnIdle` is false in a default install: a runtime with no executors
      // stays silent about work it cannot do. Turning it on is a policy decision, so a
      // test that needs the scheduler to run has to make it explicitly.
      ...(opts.driveTasks ? { agent: { driveTasksOnIdle: true } } : {}),
    },
  });
  return { base, approved, runtime };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("a scheduled task runs tools through the real chain", () => {
  it("executes an allowed tool and reports what it did", async () => {
    const { runtime } = await sandboxRuntime();
    const executor = createToolCallExecutor({
      tools: runtime.tools,
      workspaceId: () => runtime.workspaces.current().id,
    });

    const result = await executor(
      fakeTask({ tool: "memory_remember", args: { category: "fact", key: "colour", value: "green" } }),
      ctx(),
    );

    assert.equal(result.ok, true, `refused: ${result.summary}`);
    // Assert the world changed, not the sentence that came back.
    const hits = await runtime.memory.search("colour");
    assert.ok(
      hits.some((entry) => entry.value.includes("green")),
      "the tool must actually have run",
    );
  });

  it("goes through argument validation, not around it", async () => {
    // `invoke` validates against the advertised schema BEFORE the gate. Task args are
    // persisted, cross-device and unvalidated on the way in, so this is the only place
    // their shape is ever checked.
    const { runtime } = await sandboxRuntime();
    const executor = createToolCallExecutor({
      tools: runtime.tools,
      workspaceId: () => runtime.workspaces.current().id,
    });

    const result = await executor(
      fakeTask({ tool: "memory_remember", args: { category: 42, key: "k" } }),
      ctx(),
    );

    assert.equal(result.ok, false);
  });
});

describe("a task being queued is not authorization", () => {
  it("REFUSES a confirm-tier tool rather than running it unattended", async () => {
    // fs_write is confirm-tier. A person can approve it; a timer cannot.
    const { approved, runtime } = await sandboxRuntime();
    const file = join(approved, "unattended.txt");
    const executor = createToolCallExecutor({
      tools: runtime.tools,
      workspaceId: () => runtime.workspaces.current().id,
    });

    const result = await executor(
      fakeTask({ tool: "fs_write", args: { path: file, content: "WROTE-WITHOUT-ASKING" } }),
      ctx(),
    );

    assert.equal(result.ok, false, "a confirm-tier tool must not run unattended");
    assert.equal(await exists(file), false, "and nothing may be written");
  });

  it("does not queue a confirmation nobody asked for", async () => {
    // Deferring instead of refusing would look kinder and be worse: a task that comes
    // due every tick fills the 32-slot queue, and the queue refuses rather than evicts,
    // so genuine requests start being turned away.
    const { approved, runtime } = await sandboxRuntime();
    const executor = createToolCallExecutor({
      tools: runtime.tools,
      workspaceId: () => runtime.workspaces.current().id,
    });

    await executor(
      fakeTask({ tool: "fs_write", args: { path: join(approved, "x.txt"), content: "X" } }),
      ctx(),
    );

    assert.equal(runtime.confirmations.size, 0, "no confirmation may be left waiting");
  });

  it("refuses a tool that administers device trust", async () => {
    const { runtime } = await sandboxRuntime();
    const executor = createToolCallExecutor({
      tools: runtime.tools,
      workspaceId: () => runtime.workspaces.current().id,
    });

    const result = await executor(
      fakeTask({ tool: "device_trust", args: { deviceId: "somebody", trust: "trusted" } }),
      ctx(),
    );

    assert.equal(result.ok, false, "a timer must never promote a device");
  });

  it("refuses a never-tier tool", async () => {
    const { runtime } = await sandboxRuntime();
    const executor = createToolCallExecutor({
      tools: runtime.tools,
      workspaceId: () => runtime.workspaces.current().id,
    });

    const result = await executor(fakeTask({ tool: "disk_wipe", args: {} }), ctx());

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false, "a refusal is a settled answer, not an outage");
  });

  it("refuses an unknown tool", async () => {
    const { runtime } = await sandboxRuntime();
    const executor = createToolCallExecutor({
      tools: runtime.tools,
      workspaceId: () => runtime.workspaces.current().id,
    });

    const result = await executor(fakeTask({ tool: "not_a_real_tool", args: {} }), ctx());

    assert.equal(result.ok, false);
  });
});

describe("the executor cannot choose its own authority", () => {
  it("ignores an origin planted in the task record", async () => {
    // A task record is persisted, attacker-influenceable state that crosses devices.
    // If it could name its own origin, a queued task could claim to be a human and
    // unlock the confirm tier.
    const { approved, runtime } = await sandboxRuntime();
    const file = join(approved, "planted.txt");
    const executor = createToolCallExecutor({
      tools: runtime.tools,
      workspaceId: () => runtime.workspaces.current().id,
    });

    const result = await executor(
      fakeTask({
        tool: "fs_write",
        args: { path: file, content: "X" },
        origin: { kind: "local" },
        confirmed: true,
      }),
      ctx(),
    );

    assert.equal(result.ok, false, "a planted origin must not unlock the confirm tier");
    assert.equal(await exists(file), false);
  });

  it("drops undeclared arguments rather than forwarding them", async () => {
    // `invoke` drops keys the tool never advertised, so `confirmed` smuggled into the
    // argument bag cannot reach anything. Asserted rather than assumed.
    const { approved, runtime } = await sandboxRuntime();
    const executor = createToolCallExecutor({
      tools: runtime.tools,
      workspaceId: () => runtime.workspaces.current().id,
    });

    const result = await executor(
      fakeTask({
        tool: "fs_write",
        args: { path: join(approved, "smuggled.txt"), content: "X", confirmed: true },
      }),
      ctx(),
    );

    assert.equal(result.ok, false);
    assert.equal(await exists(join(approved, "smuggled.txt")), false);
  });
});

describe("what the executor actually hands the registry", () => {
  /**
   * Asserted against a recording stand-in rather than the real registry, deliberately.
   *
   * Through the real registry these properties are invisible: the scheduled-origin
   * refusal fires first, so an executor that DID set `confirmed: true` still produces a
   * refusal and every end-to-end test still passes. Mutation confirmed exactly that —
   * adding `confirmed: true` to the invoke call failed nothing. Two independent
   * defences is the right design; a defence nothing exercises is not.
   */
  function recordingTools() {
    const calls: Record<string, unknown>[] = [];
    const tools = {
      async invoke(input: Record<string, unknown>) {
        calls.push(input);
        return {
          id: "t",
          toolName: input.name,
          args: input.args,
          at: "2026-01-01T00:00:00Z",
          decision: { allowed: true, level: "safe", requiresConfirmation: false, toolName: input.name, reason: "" },
          result: { ok: true, summary: "done", epistemic: "checked" },
        };
      },
    };
    return { tools, calls };
  }

  it("never claims a person approved the call", async () => {
    const { tools, calls } = recordingTools();
    const executor = createToolCallExecutor({
      tools: tools as never,
      workspaceId: () => "general",
    });

    await executor(fakeTask({ tool: "memory_search", args: { query: "x" } }), ctx());

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.confirmed,
      undefined,
      "`confirmed` means a person approved this; a timer is not a person",
    );
  });

  it("always sends a scheduled origin, never an absent one", async () => {
    // An ABSENT origin is full local authority — `invoke` maps undefined to
    // {kind:"local"}. An executor that merely forgot to pass one would be
    // indistinguishable from the person at the keyboard.
    const { tools, calls } = recordingTools();
    const executor = createToolCallExecutor({
      tools: tools as never,
      workspaceId: () => "general",
    });

    await executor(fakeTask({ tool: "memory_search", args: { query: "x" } }), ctx());

    assert.deepEqual(calls[0]!.origin, { kind: "scheduled" });
  });

  it("passes the task's argument bag through for the registry to validate", async () => {
    // Task args are persisted, cross-device and unvalidated on the way in. The executor
    // must not pre-judge their shape — `invoke` checks them against the tool's own
    // advertised schema, which is the same check the model's arguments get.
    const { tools, calls } = recordingTools();
    const executor = createToolCallExecutor({
      tools: tools as never,
      workspaceId: () => "general",
    });

    await executor(fakeTask({ tool: "memory_search", args: { query: "x", junk: 1 } }), ctx());

    assert.deepEqual(calls[0]!.args, { query: "x", junk: 1 });
    assert.equal(calls[0]!.name, "memory_search");
  });
});

describe("a malformed task fails without retrying forever", () => {
  it("refuses args that name no tool, and does not ask to be retried", async () => {
    const { runtime } = await sandboxRuntime();
    const executor = createToolCallExecutor({
      tools: runtime.tools,
      workspaceId: () => runtime.workspaces.current().id,
    });

    for (const bad of [undefined, {}, { tool: "" }, { tool: 5 }, { tool: "x", args: [] }]) {
      const result = await executor(fakeTask(bad), ctx());
      assert.equal(result.ok, false, `should refuse ${JSON.stringify(bad)}`);
      assert.equal(result.retryable, false, `should not retry ${JSON.stringify(bad)}`);
    }
  });

  it("treats shutdown as transient, so the task is picked up again", async () => {
    const { runtime } = await sandboxRuntime();
    const executor = createToolCallExecutor({
      tools: runtime.tools,
      workspaceId: () => runtime.workspaces.current().id,
    });
    const aborted = new AbortController();
    aborted.abort();

    const result = await executor(
      fakeTask({ tool: "memory_search", args: { query: "x" } }),
      { deviceId: "self", signal: aborted.signal, log: silentLog() },
    );

    assert.equal(result.ok, false);
    assert.notEqual(result.retryable, false, "shutting down is not a settled answer");
  });
});

describe("the scheduled origin is deny-by-default on the kind itself", () => {
  it("refuses trust administration and owner-state tools by name", () => {
    assert.equal(decideScheduledToolRequest("device_trust").allowed, false);
    assert.equal(decideScheduledToolRequest("rollback_apply").allowed, false);
    assert.equal(decideScheduledToolRequest("memory_search").allowed, true);
  });

  it("refuses an origin kind nothing recognises", async () => {
    // The old shape was `if (kind !== "remote") allow`, which reads as "local is fine"
    // and means "anything not remote has the authority of the person at the keyboard".
    // Adding an origin variant without touching it would have granted exactly that.
    const { runtime } = await sandboxRuntime();
    const bogus = { kind: "totally-made-up" } as unknown as RequestOrigin;

    const call = await runtime.tools.invoke({
      name: "memory_search",
      args: { query: "anything" },
      workspaceId: "general",
      origin: bogus,
    });

    assert.equal(call.result?.ok, false, "an unrecognised origin must be refused, not waved through");
  });
});

describe("the executor is wired into the runtime, not merely written", () => {
  it("the runtime registers the tool_call kind", async () => {
    const { runtime } = await sandboxRuntime();
    assert.equal(
      runtime.taskExecutors.has(TOOL_CALL_TASK_KIND),
      true,
      "an unregistered executor makes every tool_call task warn every tick forever",
    );
  });

  it("task_create can queue a tool call, and the scheduler runs it end to end", async () => {
    // The whole loop: a tool queues a task, the scheduler picks it up, the executor
    // invokes a tool through the chain, and the task reaches a terminal state.
    const { runtime } = await sandboxRuntime({ driveTasks: true });

    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: {
        description: "remember the colour",
        tool: "memory_remember",
        toolArgs: { category: "fact", key: "wire", value: "connected" },
      },
      workspaceId: "general",
    });
    assert.equal(queued.result?.ok, true, `queueing failed: ${queued.result?.summary}`);
    const taskId = (queued.result?.data as { taskId?: string }).taskId!;

    await runtime.taskScheduler.tick();
    // The scheduler hands off fire-and-forget; let the executor settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const task = await runtime.taskQueue.get(taskId);
    assert.equal(task?.state, "done", `task did not complete: ${task?.state} / ${task?.error}`);
    const hits = await runtime.memory.search("wire");
    assert.ok(hits.some((entry) => entry.value.includes("connected")), "the tool really ran");
  });

  it("a queued confirm-tier call fails terminally instead of retrying", async () => {
    // Retrying a refusal produces the same refusal three times, three audit entries and
    // three journal events — which reads like a system trying repeatedly to get past a
    // policy.
    const { approved, runtime } = await sandboxRuntime({ driveTasks: true });

    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: {
        description: "write a file unattended",
        tool: "fs_write",
        toolArgs: { path: join(approved, "never.txt"), content: "NOPE" },
      },
      workspaceId: "general",
    });
    const taskId = (queued.result?.data as { taskId?: string }).taskId!;

    await runtime.taskScheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const task = await runtime.taskQueue.get(taskId);
    assert.equal(task?.state, "failed", "a refusal must be terminal, not re-queued");
    assert.equal(await exists(join(approved, "never.txt")), false);
  });

  it("a description-only task still queues without an executor kind", async () => {
    // The previous behaviour must survive: a task with no tool is a reminder.
    const { runtime } = await sandboxRuntime();
    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: { description: "just a reminder" },
      workspaceId: "general",
    });
    const taskId = (queued.result?.data as { taskId?: string }).taskId!;
    const task = await runtime.taskQueue.get(taskId);
    assert.equal(task?.kind, undefined);
  });
});
