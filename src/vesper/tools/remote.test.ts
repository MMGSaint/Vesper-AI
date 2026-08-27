import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capabilityForTool, decideRemoteToolRequest } from "./remote.ts";
import { enrolCompanion, testRuntime } from "../test-helpers.ts";
import { createClientGateway } from "../client/gateway.ts";
import type { CompletionRequest, ModelToolCall } from "../types.ts";
import type { CapabilityManifest } from "../distributed/capabilities.ts";

function manifest(available: string[]): CapabilityManifest {
  return {
    deviceId: "dev_self",
    generatedAt: "2026-01-01T00:00:00.000Z",
    findings: available.map((id) => ({ id: id as never, state: "AVAILABLE" as const, detail: "probed" })),
  };
}

/** A model that calls one tool and then stops. */
function callsTool(name: string, args: Record<string, unknown> = {}) {
  let call = 0;
  return {
    id: "scripted",
    kind: "local" as const,
    isAvailable: () => true,
    async probe() {
      return { available: true, detail: "scripted" };
    },
    async complete(request: CompletionRequest, model: string) {
      call += 1;
      const toolCalls: ModelToolCall[] =
        call === 1 ? [{ id: "c1", name, arguments: args as never }] : [];
      return { text: call === 1 ? "" : "done", toolCalls, providerId: "scripted", model, role: request.role };
    },
  };
}

async function remoteTurn(tool: string, args: Record<string, unknown> = {}, trust: "trusted" | "restricted" = "trusted") {
  const runtime = await testRuntime({ providers: [callsTool(tool, args)] });
  const gateway = createClientGateway(runtime);
  const phone = await enrolCompanion(runtime, { name: "phone", trust });
  const session = await gateway.issueSession({
    deviceId: phone.deviceId,
    deviceLabel: "phone",
    scopes: ["status", "conversation"],
  });
  if ("ok" in session) throw new Error(session.detail);
  const turn = await gateway.converse(session.token, "go");
  if ("ok" in turn) throw new Error(turn.detail);
  const record = turn.toolCalls.find((item) => item.toolName === tool);
  await runtime.stop();
  return record;
}

describe("a remote device cannot reach OS authority through a conversation", () => {
  it("denies filesystem tools even to a fully trusted device", async () => {
    // A trusted *device* is still a different machine. This is the check that has to
    // run before trust is consulted, or "trusted" would mean "may read my disk".
    // Valid arguments on purpose: argument validation runs first, and a request that
    // dies there would never have reached the control being tested.
    const cases: [string, Record<string, unknown>][] = [
      ["fs_read", { path: "notes/a.txt" }],
      ["fs_list", { path: "notes" }],
      ["fs_write", { path: "notes/a.txt", content: "x" }],
    ];
    for (const [tool, args] of cases) {
      const record = await remoteTurn(tool, args);
      assert.equal(record?.decision.allowed, false, `${tool} was allowed remotely`);
      assert.match(record?.result?.summary ?? "", /never reachable from another device/);
    }
  });

  it("denies trust administration from another device", async () => {
    // Otherwise a single stolen phone promotes itself, or another device, permanently.
    const record = await remoteTurn("device_trust", { deviceId: "dev_x", trust: "trusted" });
    assert.equal(record?.decision.allowed, false);
    assert.match(record?.result?.summary ?? "", /only be run at the machine/);
  });

  it("still allows what a trusted device is granted and this device can do", async () => {
    // The control must narrow, not sever: a trusted phone asking for something this
    // machine actually reports is a legitimate request.
    const record = await remoteTurn("process_list");
    assert.equal(record?.decision.allowed, true);
    assert.equal(record?.result?.ok, true);
  });

  it("gives a restricted device less than a trusted one", async () => {
    const restricted = await remoteTurn("process_list", {}, "restricted");
    assert.equal(restricted?.decision.allowed, false, "a restricted device inspected processes");
    assert.match(restricted?.result?.summary ?? "", /restricted' device may not request/);
  });

  it("leaves the local path untouched", async () => {
    // The person at the machine is not a remote device. If this control leaked into
    // local turns it would break Vesper on its own host.
    const runtime = await testRuntime({ providers: [callsTool("process_list")] });
    const turn = await runtime.chat("what is running?");
    const record = turn.toolCalls.find((item) => item.toolName === "process_list");
    assert.equal(record?.decision.allowed, true, "a local turn was denied as though remote");
    assert.equal(record?.result?.ok, true);
    await runtime.stop();
  });
});

describe("the remote tool decision itself", () => {
  it("puts the absolute denials before any trust check", () => {
    const decision = decideRemoteToolRequest({
      toolName: "fs_read",
      origin: { kind: "remote", trust: "trusted", manifest: manifest(["filesystem"]) },
    });
    assert.equal(decision.allowed, false);
  });

  it("denies a revoked device", () => {
    const decision = decideRemoteToolRequest({
      toolName: "process_list",
      origin: { kind: "remote", trust: "revoked", manifest: manifest(["process_inspect"]) },
    });
    assert.equal(decision.allowed, false);
  });

  it("treats an unknown origin as remote-unknown, not as local", () => {
    const decision = decideRemoteToolRequest({
      toolName: "process_list",
      origin: { kind: "remote", manifest: manifest(["process_inspect"]) },
    });
    assert.equal(decision.allowed, false, "a request with no stated trust was allowed");
  });

  it("does not double-govern tools that client scopes already cover", () => {
    // memory and knowledge are governed by scopes; adding them here too would mean two
    // rules with no single owner.
    assert.equal(capabilityForTool("memory_search"), null);
    assert.equal(capabilityForTool("knowledge_search"), null);
    const decision = decideRemoteToolRequest({
      toolName: "memory_search",
      origin: { kind: "remote", trust: "trusted", manifest: manifest([]) },
    });
    assert.equal(decision.allowed, true);
  });
});
