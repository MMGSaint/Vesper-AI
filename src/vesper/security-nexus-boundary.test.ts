/**
 * The NEXUS boundary: what the optimizer may tell Vesper, and what it may not decide.
 *
 * NEXUS is a separate specialist that changes real machine state. Two rules govern the
 * seam and both are asserted here as consequences:
 *
 *   - NEXUS output must not grant Vesper permissions. Everything that arrives from the
 *     endpoint is data — including its own claims about what it is.
 *   - Vesper must never say an optimization happened without `accepted: true` from the
 *     adapter, and must never present a mock as the capability.
 *
 * The four states are four different claims, and collapsing any two is how a user ends
 * up trusting a simulation. AVAILABLE means a real optimizer answered. UNAVAILABLE
 * means a real one is configured and did not. NOT_CONFIGURED means nothing real is
 * wired up. DEGRADED is reserved for a real optimizer in a reduced state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyOptimizerCapability } from "./specialists/optimizer.ts";
import { testRuntime, enrolCompanion } from "./test-helpers.ts";
import { createClientGateway } from "./client/gateway.ts";
import { isClientError } from "./client/protocol.ts";

describe("a mock optimizer is not the capability", () => {
  it("classifies a mock as NOT_CONFIGURED, never DEGRADED", async () => {
    // DEGRADED implies something real is there and impaired. A mock is not a degraded
    // NEXUS; it is the absence of one.
    assert.equal(classifyOptimizerCapability({ mode: "mock", available: true }), "NOT_CONFIGURED");
    assert.equal(classifyOptimizerCapability({ mode: "mock", available: false }), "NOT_CONFIGURED");
  });

  it("distinguishes a live optimizer that answered from one that did not", () => {
    assert.equal(classifyOptimizerCapability({ mode: "live", available: true }), "AVAILABLE");
    assert.equal(classifyOptimizerCapability({ mode: "live", available: false }), "UNAVAILABLE");
  });

  it("treats an unavailable adapter as UNAVAILABLE", () => {
    assert.equal(classifyOptimizerCapability({ mode: "unavailable", available: false }), "UNAVAILABLE");
  });

  it("the client gateway and the capability manifest give the SAME answer", async () => {
    // These were two independent copies of the rule and they disagreed: the manifest
    // said NOT_CONFIGURED for a mock and the gateway said DEGRADED, so a phone and a
    // peer were told different things about the same machine. Nothing caught it,
    // because nothing compared them.
    const runtime = await testRuntime();
    const gateway = createClientGateway(runtime);
    const device = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
    const session = await gateway.issueSession({ deviceId: device.deviceId });
    if (isClientError(session)) throw new Error(session.detail);

    const status = await gateway.status(session.token);
    const manifest = await runtime.refreshCapabilities();

    if (isClientError(status)) throw new Error(status.detail);
    const fromGateway = status.capabilities.find((entry) => entry.id === "optimizer")?.state;
    const fromManifest = manifest?.findings.find((finding) => finding.id === "nexus")?.state;

    assert.equal(
      fromGateway,
      fromManifest,
      `the two surfaces disagree: gateway=${fromGateway} manifest=${fromManifest}`,
    );
    assert.equal(fromGateway, "NOT_CONFIGURED", "with a mock adapter, nothing real is wired up");
  });
});

describe("NEXUS output cannot grant Vesper authority", () => {
  it("an optimizer report does not unlock a never-tier tool", async () => {
    const runtime = await testRuntime();
    await runtime.tools.invoke({ name: "optimizer_report", args: {}, workspaceId: "general" });

    const call = await runtime.tools.invoke({
      name: "disk_wipe",
      args: {},
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(call.result?.ok, false);
    assert.equal(call.decision.level, "never");
  });

  it("optimizer_request stays confirm-tier", async () => {
    // Asking a separate system to change machine state is not something Vesper does on
    // its own recognisance, however confident the specialist sounds.
    const runtime = await testRuntime();
    const call = await runtime.tools.invoke({
      name: "optimizer_request",
      args: { action: "optimize", profile: "performance" },
      workspaceId: "general",
    });
    assert.ok(call.confirmationId, "the request must be held for confirmation");
    assert.equal(call.result, undefined);
  });

  it("a scheduled task cannot ask NEXUS to change the machine", async () => {
    // The unattended path must not become the way an optimization gets requested
    // without anyone approving it.
    const runtime = await testRuntime({ config: { agent: { driveTasksOnIdle: true } } });
    const queued = await runtime.tools.invoke({
      name: "task_create",
      args: {
        description: "optimize overnight",
        tool: "optimizer_request",
        toolArgs: { action: "optimize" },
      },
      workspaceId: "general",
    });
    const taskId = (queued.result?.data as { taskId?: string }).taskId!;

    await runtime.taskScheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const task = await runtime.taskQueue.get(taskId);
    assert.equal(task?.state, "failed", "a confirm-tier optimizer request must not run unattended");
  });
});

describe("Vesper does not claim an optimization it cannot evidence", () => {
  it("the mock's summary says the real optimizer was not contacted", async () => {
    // The mock returns accepted:true for a state change it did not make. That is why
    // callers must read `mode`, not `accepted`, to know whether anything real happened
    // — and why the summary has to say so in words.
    const runtime = await testRuntime();
    const call = await runtime.tools.invoke({
      name: "optimizer_request",
      args: { action: "optimize", profile: "performance" },
      workspaceId: "general",
      confirmed: true,
    });

    assert.match(
      call.result?.summary ?? "",
      /not contacted|mock/i,
      `the reply must not read as a real optimization: ${call.result?.summary}`,
    );
  });

  it("diagnostics classifies the optimizer as simulated, not as working", async () => {
    const runtime = await testRuntime();
    const diagnostics = await runtime.diagnostics();
    assert.equal(diagnostics.optimizer.mode, "mock");
  });
});
