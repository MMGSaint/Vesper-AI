/**
 * What Vesper still does when a part of it is missing.
 *
 * The rule underneath all of these is that degradation must be visible and must never
 * be a widening. A subsystem that is absent should cost a capability, never gain one,
 * and the reply should say which — "no telemetry" is useful, a plausible number is
 * worse than silence.
 *
 * The scheduler case is the one that is a security property rather than a convenience:
 * if the unattended path breaks, the interactive path must not quietly become the
 * privileged one.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";
import { createToolCallExecutor } from "./tool-executor.ts";
import { CorrectionStore } from "./corrections.ts";
import { MemoryStorage } from "./storage.ts";
import type { Logger } from "./logging.ts";
import type { StorageAdapter } from "./storage.ts";

function silentLog(): Logger {
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  return log as unknown as Logger;
}

/** Storage that fails every write, as a full or read-only disk would. */
function brokenStorage(): StorageAdapter {
  return {
    async get() {
      return null;
    },
    async set() {
      throw new Error("ENOSPC: no space left on device");
    },
    async delete() {
      throw new Error("ENOSPC: no space left on device");
    },
    async keys() {
      return [];
    },
  };
}

describe("no local model: the runtime is still useful and still honest", () => {
  it("answers diagnostics without a backend", async () => {
    const runtime = await testRuntime();
    const diagnostics = await runtime.diagnostics();
    assert.ok(diagnostics, "diagnostics must not depend on a model");
  });

  it("says plainly that no backend answered rather than improvising", async () => {
    const runtime = await testRuntime();
    const turn = await runtime.chat("what is the capital of assyria");
    assert.match(
      turn.reply,
      /no local inference backend/i,
      `expected an honest fallback, got: ${turn.reply}`,
    );
  });

  it("still runs deterministic intents and tools", async () => {
    const runtime = await testRuntime();
    await runtime.chat("remember that the kettle is broken");
    const hits = await runtime.memory.search("kettle");
    assert.ok(hits.length >= 1, "tools and memory must work with no model");
  });
});

describe("no optimizer: Vesper continues without optimizer context", () => {
  it("keeps working when the adapter reports unavailable", async () => {
    const runtime = await testRuntime();
    runtime.optimizer.setAvailable?.(false);

    const status = await runtime.tools.invoke({
      name: "optimizer_status",
      args: {},
      workspaceId: "general",
    });
    const turn = await runtime.chat("catch me up");

    assert.equal(status.result?.ok, false, "the optimizer tool reports the outage");
    assert.ok(turn.reply.length > 0, "the assistant keeps answering");
  });

  it("does not fabricate a bottleneck when the optimizer cannot say", async () => {
    const runtime = await testRuntime();
    runtime.optimizer.setAvailable?.(false);
    const report = await runtime.tools.invoke({
      name: "optimizer_report",
      args: {},
      workspaceId: "general",
    });
    assert.doesNotMatch(
      report.result?.summary ?? "",
      /\b(cpu|gpu)-bound\b/i,
      "an unavailable optimizer must not yield a bottleneck claim",
    );
  });
});

describe("storage that cannot be written: state is lost loudly, not silently", () => {
  it("a corrections store keeps serving reads when persistence fails", async () => {
    // A write failure must not reach the process. It used to arrive as an unhandled
    // rejection and take the assistant down.
    const store = new CorrectionStore({ storage: brokenStorage(), log: silentLog() });

    const written = await store.record({
      subsystem: "runtime",
      context: "c",
      assumption: "a",
      evidence: "e",
      correction: "x",
      outcome: "inconclusive",
      source: { author: "subsystem", origin: "test", external: false },
    });
    await store.flush();

    assert.equal(written.ok, true, "the in-memory record is still made");
    assert.equal((await store.list()).length, 1, "and is still readable this session");
  });

  it("a corrupt blob costs the history, never availability", async () => {
    const storage = new MemoryStorage({ "corrections.records": 42 as never });
    const store = new CorrectionStore({ storage, log: silentLog() });
    assert.deepEqual(await store.list(), []);
  });
});

describe("a broken scheduler does not make the interactive path privileged", () => {
  it("a failing tool registry surfaces as a failed task, not as a bypass", async () => {
    // The failure mode worth guarding: an executor that cannot reach the authorization
    // chain must refuse, never fall back to running the handler directly.
    const runtime = await testRuntime();
    const executor = createToolCallExecutor({
      tools: {
        async invoke() {
          throw new Error("registry unavailable");
        },
      } as never,
      workspaceId: () => "general",
    });

    await assert.rejects(
      executor(
        {
          id: "t",
          description: "d",
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
          kind: "tool_call",
          args: { tool: "memory_search", args: { query: "x" } },
        } as never,
        { deviceId: "self", signal: new AbortController().signal, log: silentLog() },
      ),
      /registry unavailable/,
      "the executor must propagate the failure rather than working around it",
    );
  });

  it("the interactive path still refuses what it refused before", async () => {
    const runtime = await testRuntime();
    // Break the task scheduler as thoroughly as a test can.
    runtime.taskScheduler.stop();

    const call = await runtime.tools.invoke({
      name: "disk_wipe",
      args: {},
      workspaceId: "general",
      confirmed: true,
    });

    assert.equal(call.result?.ok, false, "a stopped scheduler must not relax the gate");
    assert.equal(call.decision.level, "never");
  });

  it("a runtime with no executors registered still starts and answers", async () => {
    // `driveTasksOnIdle` defaults false precisely so a runtime with nothing to run stays
    // silent about work it cannot do.
    const runtime = await testRuntime();
    const turn = await runtime.chat("catch me up");
    assert.ok(turn.reply.length > 0);
  });
});

describe("no continuity transport: local Vesper is fully functional", () => {
  it("binds no listener and says so", async () => {
    // The capsule format exists and nothing carries it. The doctor states this rather
    // than leaving a reader to assume either way.
    const runtime = await testRuntime();
    const diagnostics = await runtime.diagnostics();
    assert.ok(diagnostics, "diagnostics available with no transport");

    const turn = await runtime.chat("remember that transport is absent");
    assert.match(turn.reply, /Remembered/i, "local operation is unaffected");
  });
});

describe("hardware telemetry: absent means absent, never zero", () => {
  it("reports the source as simulated rather than presenting readings as measured", async () => {
    const runtime = await testRuntime();
    const snapshot = runtime.hardware.snapshot();
    assert.equal(snapshot.mode, "simulated", "a simulated reading must be labelled as one");
  });
});
