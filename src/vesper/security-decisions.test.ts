/**
 * Decision-journal and task-attribution boundaries.
 *
 * Two properties, each a defect that shipped:
 *
 *   4c.1  `task_create` recorded the HOST device as `createdBy` for a task a remote
 *         device queued. Attribution is not authority, but it is the provenance a
 *         correction, a catch-up, and a session capsule would read — so erasing the
 *         asking device is a lie in the audit trail.
 *
 *   governor_decisions is evidence. A restricted device must not read the owner's
 *         decision journal (same bar as `task_list`), and reading it must never
 *         change what the gate would decide about a later call.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClientGateway } from "./client/gateway.ts";
import { enrolCompanion, testRuntime } from "./test-helpers.ts";
import type { ChatMessage, CompletionRequest, ModelToolCall } from "./types.ts";

function scripted(toolName: string, args: Record<string, unknown> = {}) {
  const seen: ChatMessage[][] = [];
  let n = 0;
  return {
    seen,
    provider: {
      id: "scripted",
      kind: "local" as const,
      isAvailable: () => true,
      async probe() {
        return { available: true, detail: "scripted" };
      },
      async complete(request: CompletionRequest, model: string) {
        seen.push(request.messages);
        n += 1;
        const toolCalls: ModelToolCall[] =
          toolName && n === 1 ? [{ id: "c1", name: toolName, arguments: args as never }] : [];
        return {
          text: toolCalls.length ? "" : "done",
          toolCalls,
          providerId: "scripted",
          model,
          role: request.role,
        };
      },
    },
  };
}

describe("task_create records the asking device, not the host", () => {
  it("attributes a remote-created task to the remote device", async () => {
    const runtime = await testRuntime({
      providers: [scripted("task_create", { description: "prepare the desktop" }).provider],
    });
    const phone = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });
    const record = await runtime.tools.invoke({
      name: "task_create",
      args: { description: "prepare the desktop" },
      workspaceId: "general",
      origin: {
        kind: "remote",
        deviceId: phone.deviceId,
        trust: "trusted",
        scopes: ["status", "conversation"],
      },
    });
    assert.equal(record.result?.ok, true, record.result?.summary);

    const queued = (await runtime.taskQueue.list()).find((task) =>
      task.description.includes("prepare the desktop"),
    );
    await runtime.stop();

    assert.ok(queued, "the task was not queued");
    assert.equal(
      queued.createdBy,
      phone.deviceId,
      `createdBy was '${queued.createdBy}', host is '${runtime.deviceIdentity.deviceId}'`,
    );
    assert.notEqual(queued.createdBy, runtime.deviceIdentity.deviceId);
  });

  it("still attributes a local task to this machine", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "task_create",
      args: { description: "ordinary local work" },
      workspaceId: "general",
    });
    const queued = (await runtime.taskQueue.list()).find((task) =>
      task.description.includes("ordinary local work"),
    );
    await runtime.stop();
    assert.equal(record.result?.ok, true, record.result?.summary);
    assert.equal(queued?.createdBy, runtime.deviceIdentity.deviceId);
  });
});

describe("governor_decisions is trusted-only and is not authority", () => {
  async function listFrom(trust: "trusted" | "restricted") {
    const runtime = await testRuntime({
      providers: [scripted("governor_decisions", {}).provider],
    });
    await runtime.chat("remember that the spare key is in the planter");
    const gateway = createClientGateway(runtime);
    const phone = await enrolCompanion(runtime, { name: "phone", trust });
    const session = await gateway.issueSession({
      deviceId: phone.deviceId,
      deviceLabel: "phone",
      scopes: ["status", "conversation"],
    });
    if ("ok" in session) throw new Error(session.detail);
    const turn = await gateway.converse(session.token, "why did you remember that?");
    if ("ok" in turn) throw new Error(turn.detail);
    const record = turn.toolCalls.find((call) => call.toolName === "governor_decisions");
    const everything = JSON.stringify(turn);
    await runtime.stop();
    return { record, everything };
  }

  it("refuses governor_decisions for a restricted device", async () => {
    const { record, everything } = await listFrom("restricted");
    assert.equal(record?.decision.allowed, false, "a restricted device read the decision journal");
    assert.equal(record?.result?.ok, false);
    assert.equal(
      everything.includes("spare key is in the planter"),
      false,
      "a restricted device saw owner activity in the decision journal",
    );
  });

  it("still allows it for a trusted device, which is the feature", async () => {
    const { record } = await listFrom("trusted");
    assert.equal(record?.decision.allowed, true, "a trusted device lost the decision journal");
    assert.equal(record?.result?.ok, true, record?.result?.summary);
  });

  it("reading decisions does not relax a later permission", async () => {
    const runtime = await testRuntime();
    await runtime.chat("remember that the spare key is in the planter");
    await runtime.tools.invoke({
      name: "governor_decisions",
      args: {},
      workspaceId: "general",
    });
    const later = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: "C:\\\\Windows\\\\System32\\\\x.txt", content: "no" },
      workspaceId: "general",
    });
    await runtime.stop();
    assert.equal(later.decision.allowed, false, "reading the journal relaxed a later write");
    assert.equal(later.result?.ok ?? false, false);
  });
});
