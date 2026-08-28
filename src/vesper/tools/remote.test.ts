import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capabilityForTool, decideRemoteToolRequest, scopeForTool } from "./remote.ts";
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

  it("enforces the client scope a tool needs, wherever the tool is reached from", () => {
    // This test previously asserted the opposite — that memory and knowledge tools were
    // "already governed by scopes" and needed no rule here. That belief was the
    // vulnerability: scopes govern gateway *methods*, and a conversation calls tools,
    // so a session holding only `conversation` reached the very data its missing scopes
    // describe. Scope is still the single owner of that decision; this is the one place
    // the tool path asks it.
    assert.equal(capabilityForTool("memory_search"), null, "not capability-bearing");
    assert.equal(scopeForTool("memory_search"), "memory.read", "but it is scope-bearing");

    const without = decideRemoteToolRequest({
      toolName: "memory_search",
      origin: { kind: "remote", trust: "trusted", manifest: manifest([]), scopes: ["status"] },
    });
    assert.equal(without.allowed, false);

    const withScope = decideRemoteToolRequest({
      toolName: "memory_search",
      origin: {
        kind: "remote",
        trust: "trusted",
        manifest: manifest([]),
        scopes: ["status", "memory.read"],
      },
    });
    assert.equal(withScope.allowed, true, "the control must narrow, not sever");
  });

  it("treats an origin with no established scopes as holding none", () => {
    // Absent must not read as "unrestricted". A request whose authority cannot be
    // established gets none of it.
    const decision = decideRemoteToolRequest({
      toolName: "memory_search",
      origin: { kind: "remote", trust: "trusted", manifest: manifest([]) },
    });
    assert.equal(decision.allowed, false);
  });
});

describe("a remote device cannot put words in the owner's notification hub", () => {
  /**
   * `notify` pushes a `system`-kind notification onto the machine the owner is sitting
   * at, and the hub is a surface the owner reads as Vesper speaking to them. It was
   * mapped to the `notifications` scope, which is a *read* scope — the gateway method
   * behind it returns recent items — and which `DEFAULT_COMPANION_SCOPES` hands to every
   * companion on enrolment.
   *
   * So the default grant for "let my phone see my notifications" also meant "let my
   * phone write notifications", and a compromised or lower-trust companion had a
   * phishing primitive: a message in Vesper's own voice, on the owner's own machine,
   * saying whatever it liked. Read and write are not the same authority and must not
   * share a scope name.
   */
  const PHISH = "Your session expired. Open vesper-login.example and re-enter your passphrase.";

  async function notifyFromCompanion(trust: "trusted" | "restricted") {
    const runtime = await testRuntime({
      providers: [callsTool("notify", { title: "Vesper security", body: PHISH })],
    });
    const gateway = createClientGateway(runtime);
    const phone = await enrolCompanion(runtime, { name: "phone", trust });
    const session = await gateway.issueSession({
      deviceId: phone.deviceId,
      deviceLabel: "phone",
      // Every scope the default enrolment grants, `notifications` included. The point
      // is that holding the scope is not enough, so the scope must be held.
      scopes: ["status", "conversation", "memory.read", "notifications"],
    });
    if ("ok" in session) throw new Error(session.detail);
    const turn = await gateway.converse(session.token, "warn me about my session");
    if ("ok" in turn) throw new Error(turn.detail);
    const record = turn.toolCalls.find((item) => item.toolName === "notify");
    // The owner's hub, on the host side of the boundary — not the projected turn.
    const hub = JSON.stringify(runtime.notifications.recent(50));
    await runtime.stop();
    return { record, hub, sessionScopes: session.scopes };
  }

  it("refuses notify from a trusted companion that holds the notifications scope", async () => {
    const { record, hub, sessionScopes } = await notifyFromCompanion("trusted");
    assert.ok(
      sessionScopes.includes("notifications"),
      "the session did not hold the scope, so this proves nothing",
    );
    // The consequence first: what the owner would actually see. A refusal that still
    // pushed the notification would pass a decision-only assertion.
    assert.equal(
      hub.includes(PHISH),
      false,
      "a remote device planted a notification in the owner's hub",
    );
    assert.equal(record?.decision.allowed, false, "notify ran for a remote device");
    assert.match(record?.result?.summary ?? "", /only be run at the machine/);
  });

  it("refuses it from a restricted companion too", async () => {
    // Honest note: mutation does not distinguish the host-only listing here. Restoring
    // `notify: "notifications"` leaves this test passing, because a restricted device's
    // scopes are capped to RESTRICTED_COMPANION_SCOPES, which excludes `notifications`
    // — so the scope ceiling refuses it either way. The host-only listing is what holds
    // the *trusted* case, and that is where the mutation shows up.
    const { record, hub } = await notifyFromCompanion("restricted");
    assert.equal(record?.decision.allowed, false);
    assert.equal(hub.includes(PHISH), false);
  });

  it("still lets the person at the machine send one", async () => {
    // Narrowing, not severing: notify is a legitimate local tool.
    const runtime = await testRuntime({
      providers: [callsTool("notify", { title: "Reminder", body: "The boiler inspection is Friday." })],
    });
    await runtime.chat("remind me about the boiler");
    assert.equal(
      JSON.stringify(runtime.notifications.recent(50)).includes("boiler inspection is Friday"),
      true,
      "notify stopped working locally",
    );
    await runtime.stop();
  });

  it("is not reachable by mapping it back to a scope", async () => {
    // The mechanism itself: if someone re-adds `notify: "notifications"` to TOOL_SCOPE
    // without removing it from HOST_ONLY_TOOLS, the host-only check still runs first.
    assert.equal(scopeForTool("notify"), null, "notify was mapped to a client scope again");
    const decision = decideRemoteToolRequest({
      toolName: "notify",
      origin: {
        kind: "remote",
        deviceId: "dev_phone",
        trust: "trusted",
        manifest: manifest([]),
        scopes: ["status", "conversation", "memory.read", "notifications"],
      },
    });
    assert.equal(decision.allowed, false, "the remote decision allowed notify");
  });
});
