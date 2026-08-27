import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrolCompanion, testRuntime } from "../test-helpers.ts";
import { createClientGateway } from "./gateway.ts";
import { CLIENT_PROTOCOL_ID, CLIENT_PROTOCOL_VERSION, isClientError } from "./protocol.ts";
import type { VesperRuntime } from "../runtime.ts";
import type { VesperClientGateway } from "./gateway.ts";
import type { IssueSessionInput } from "./session.ts";

/** An enrolled, approved companion holding a live session. */
async function companion(
  runtime: VesperRuntime,
  gateway: VesperClientGateway,
  input: Omit<IssueSessionInput, "deviceId"> = {},
) {
  const device = await enrolCompanion(runtime, { name: input.deviceLabel ?? "phone" });
  const session = await gateway.issueSession({ ...input, deviceId: device.deviceId });
  if (isClientError(session)) throw new Error(session.detail);
  return session;
}

describe("client protocol gateway", () => {
  it("issues a versioned hello without exposing a network listener", async () => {
    const runtime = await testRuntime();
    const gateway = createClientGateway(runtime);
    const hello = gateway.hello();
    assert.equal(hello.protocol, CLIENT_PROTOCOL_ID);
    assert.equal(hello.version, CLIENT_PROTOCOL_VERSION);
    assert.equal(hello.started, true);
    assert.ok(gateway.forbiddenPowers().includes("os.shell"));
    await runtime.stop();
  });

  it("rejects unauthenticated and expired sessions", async () => {
    const runtime = await testRuntime();
    const gateway = createClientGateway(runtime);
    const missing = await gateway.status();
    assert.equal(isClientError(missing), true);
    if (isClientError(missing)) assert.equal(missing.code, "UNAUTHENTICATED");

    const session = await companion(runtime, gateway, { deviceLabel: "phone", ttlMs: 30_000 });
    const expired = await gateway.sessions.authenticate(session.token, Date.now() + 60_000);
    assert.equal(isClientError(expired), true);
    if (isClientError(expired)) assert.equal(expired.code, "EXPIRED");
    await runtime.stop();
  });

  it("reports honest capability states instead of fake live specialists", async () => {
    const runtime = await testRuntime();
    const gateway = createClientGateway(runtime);
    const session = await companion(runtime, gateway, { deviceLabel: "phone" });
    const status = await gateway.status(session.token);
    assert.equal(isClientError(status), false);
    if (isClientError(status)) throw new Error(status.detail);
    const byId = Object.fromEntries(status.capabilities.map((item) => [item.id, item]));
    assert.equal(byId.assistant.state, "AVAILABLE");
    assert.equal(byId["local-model"].state, "NOT_CONFIGURED");
    assert.notEqual(byId.optimizer.state, "AVAILABLE");
    assert.equal(byId.voice.state, "UNAVAILABLE");
    assert.equal(byId["remote-os"].state, "UNAVAILABLE");
    await runtime.stop();
  });

  it("does not allow conversation or memory writes without the matching scope", async () => {
    const runtime = await testRuntime();
    const gateway = createClientGateway(runtime);
    const session = await companion(runtime, gateway, {
      deviceLabel: "watch",
      scopes: ["status"],
    });
    const chat = await gateway.converse(session.token, "hello");
    assert.equal(isClientError(chat), true);
    if (isClientError(chat)) assert.equal(chat.code, "SCOPE_DENIED");
    const write = await gateway.remember(session.token, { key: "theme", value: "dark" });
    assert.equal(isClientError(write), true);
    if (isClientError(write)) assert.equal(write.code, "SCOPE_DENIED");
    await runtime.stop();
  });

  it("routes conversation through the agent instead of exposing OS tools", async () => {
    const runtime = await testRuntime({
      script: [{ text: "Understood. I will not invent live hardware." }],
    });
    const gateway = createClientGateway(runtime);
    const session = await companion(runtime, gateway, {
      deviceLabel: "android",
      scopes: ["status", "conversation", "memory.read", "memory.write"],
    });
    const turn = await gateway.converse(session.token, "What is your name?");
    assert.equal(isClientError(turn), false);
    if (isClientError(turn)) throw new Error(turn.detail);
    assert.match(turn.reply, /Understood|Vesper|name/i);
    const remembered = await gateway.remember(session.token, {
      key: "companion",
      value: "android",
    });
    assert.equal(isClientError(remembered), false);
    const listed = await gateway.listMemory(session.token);
    assert.equal(isClientError(listed), false);
    if (!isClientError(listed)) {
      assert.ok(listed.entries.some((entry) => entry.key === "companion"));
    }
    await runtime.stop();
  });

  it("keeps confirmation authority on the permission gate", async () => {
    const runtime = await testRuntime();
    const gateway = createClientGateway(runtime);
    const session = await companion(runtime, gateway, {
      deviceLabel: "android",
      scopes: ["status", "conversation", "operator.confirm"],
    });
    runtime.confirmations.set("confirm-test", {
      id: "confirm-test",
      toolName: "optimizer.requestOptimization",
      args: { profile: "gaming" },
      reason: "Requires confirmation.",
      createdAt: new Date().toISOString(),
      workspaceId: "general",
    });
    const limited = await companion(runtime, gateway, {
      deviceLabel: "limited",
      scopes: ["status"],
    });
    const deniedWithoutScope = await createClientGateway(runtime).confirm(
      limited.token,
      "confirm-test",
      true,
    );
    assert.equal(isClientError(deniedWithoutScope), true);
    const rejected = await gateway.confirm(session.token, "missing", true);
    assert.equal(isClientError(rejected), true);
    if (isClientError(rejected)) assert.equal(rejected.code, "NOT_FOUND");
    await runtime.stop();
  });
});
