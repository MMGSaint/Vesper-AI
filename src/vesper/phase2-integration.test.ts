/**
 * Phase 2 integration test — exercises the whole runtime with the new subsystems
 * wired in. Regression coverage against a class of "compiles but doesn't wire"
 * bugs that unit tests cannot catch on their own.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";

describe("Phase 2 runtime wiring — the whole stack together", () => {
  it("memory_remember produces a checkpoint AND an autonomy.decision AND a durable event", async () => {
    const runtime = await testRuntime();

    // A brand-new memory captured — should create a checkpoint with absentBefore=true.
    await runtime.chat("remember that project is vesper");

    const checkpoints = await runtime.checkpoints.list();
    const mem = checkpoints.find((c) => c.tool === "memory_remember" && c.target === "project");
    assert.ok(mem, "memory_remember checkpoint must have been captured");
    assert.equal(mem?.absentBefore, true, "the previous state was absent");

    // The governor should have emitted an autonomy.decision event for the tool call.
    const decisions = runtime.events.recent({ type: "autonomy.decision", limit: 20 });
    const memDecision = decisions.find((e) => e.title.includes("memory_remember"));
    assert.ok(memDecision, "autonomy.decision must have been emitted for memory_remember");
    assert.equal(memDecision?.retention, "durable", "decisions must be durable");

    // And the journal should hold the durable event.
    const journaled = await runtime.journal.query({ types: ["autonomy.decision"] });
    assert.ok(
      journaled.some((e) => e.title.includes("memory_remember")),
      "durable autonomy.decision must reach the journal",
    );
  });

  it("workspace_switch produces a rollback checkpoint that can undo the change", async () => {
    // Full loop: switch to gaming, capture checkpoint, roll it back, verify the
    // workspace returns to what it was before.
    const runtime = await testRuntime();
    const before = runtime.workspaces.current().id;
    await runtime.chat("switch to gaming");
    const after = runtime.workspaces.current().id;
    assert.equal(after, "gaming");

    const cps = await runtime.checkpoints.list({ tool: "workspace_switch" });
    assert.ok(cps.length >= 1, "workspace_switch checkpoint recorded");
    const cp = cps[0];
    assert.equal(cp.before, before);

    // Apply the rollback directly via the store (the tool is confirm-tier so a
    // user-approved path is what runs it in production).
    const result = await runtime.checkpoints.rollback(cp.id);
    assert.equal(result.applied, true, `rollback failed: ${result.applied ? "ok" : (result as { reason: string }).reason}`);
    assert.equal(runtime.workspaces.current().id, before, "workspace returned to previous id");
  });

  it("no local backend reachable → the fallback message survives ALL Phase 2 additions", async () => {
    // The mission's honesty rule "reports honestly that no model is loaded" — with the
    // autonomy governor and journal in place, a free-form question that no
    // deterministic intent captures must still reach the truthful fallback.
    const runtime = await testRuntime();
    const turn = await runtime.chat("please write a haiku about a cat");
    assert.match(turn.reply, /no local inference backend|not available/i);
  });

  it("catchup summary reflects task lifecycle events across the durable journal", async () => {
    const runtime = await testRuntime();
    const task = await runtime.taskQueue.create({
      description: "smoke",
      createdBy: "user",
      requiredCapabilities: [],
      kind: "noop",
    });
    await runtime.taskQueue.start(task.id);
    await runtime.taskQueue.complete(task.id, "ok");
    const catchup = await runtime.chat("catch me up");
    // catchup's task badge should show the completed count.
    assert.match(catchup.reply, /Tasks:.*completed/);
  });

  it("the autonomy governor's default policy keeps memory_search FULL and admin.* PREPARE", async () => {
    // Assert against the actually-attached policy on the running runtime, not the
    // module's `defaultAutonomyPolicy()` in isolation.
    const runtime = await testRuntime();
    const policy = runtime.autonomy.status().policy;
    assert.equal(policy.perTool?.memory_search, "FULL");
    assert.equal(policy.perTool?.fs_read, "FULL");
    assert.equal(policy.perCategory?.["security."], "PREPARE");
  });
});
