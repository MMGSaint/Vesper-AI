import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime.ts";
import { MemoryStorage } from "../storage.ts";
import { enrolCompanion, testRuntime } from "../test-helpers.ts";
import { createClientGateway } from "./gateway.ts";
import { isClientError } from "./protocol.ts";
import type { CompletionRequest, ModelToolCall } from "../types.ts";

/**
 * The confirmation queue holds an action between "asked for" and "carried out". That
 * gap is a trust boundary, and it was leaking authority across it: approving is
 * *exercising* authority, not merely acknowledging a prompt, so a device that may never
 * touch the filesystem must not be able to approve a filesystem write into existence.
 *
 * Every test here asserts on what actually happened to the disk or to the queue, not on
 * what the reply said.
 */

/** A model that calls one tool and then stops. Stands in for a fully compromised model. */
function callsTool(name: string, args: Record<string, unknown>) {
  let n = 0;
  return {
    id: "scripted",
    kind: "local" as const,
    isAvailable: () => true,
    async probe() {
      return { available: true, detail: "scripted" };
    },
    async complete(request: CompletionRequest, model: string) {
      n += 1;
      const toolCalls: ModelToolCall[] = n === 1 ? [{ id: "c1", name, arguments: args as never }] : [];
      return { text: n === 1 ? "" : "done", toolCalls, providerId: "scripted", model, role: request.role };
    },
  };
}

/** A local turn that gets a filesystem write held for confirmation. */
async function heldFilesystemWrite(scopes: ("status" | "conversation" | "operator.confirm")[]) {
  const root = await mkdtemp(join(tmpdir(), "vesper-confirm-"));
  const target = join(root, "OWNED.txt");
  const runtime = await testRuntime({
    providers: [callsTool("fs_write", { path: target, content: "pwned" })],
    config: { approvedRoots: [root] },
  });
  const gateway = createClientGateway(runtime);
  await runtime.chat("tidy up my notes");
  const id = [...runtime.confirmations.keys()][0];
  assert.ok(id, "the write should have been held for confirmation");

  const phone = await enrolCompanion(runtime, { name: "phone" });
  const session = await gateway.issueSession({
    deviceId: phone.deviceId,
    deviceLabel: "phone",
    scopes,
  });
  if (isClientError(session)) throw new Error(session.detail);
  return { runtime, gateway, session, id, target, phone };
}

describe("approving a confirmation exercises the approver's own authority", () => {
  it("a remote device cannot write to the host disk by approving a held write", async () => {
    // The device is fully trusted and holds operator.confirm. It is still a different
    // machine, and OS authority does not cross that line — not by asking, and not by
    // approving something already asked for.
    const { runtime, gateway, session, id, target } = await heldFilesystemWrite([
      "status",
      "conversation",
      "operator.confirm",
    ]);

    const turn = await gateway.confirm(session.token, id, true);
    assert.equal(isClientError(turn), false, "the approval call itself is answered, not errored");

    await assert.rejects(
      () => readFile(target, "utf8"),
      "the file was written: a remote approval reached the filesystem",
    );
    if (!isClientError(turn)) {
      // The strongest form of the property: the tool is never reached at all, so there
      // is no handler run and nothing to depend on failing safely inside it.
      assert.equal(turn.toolCalls.length, 0, "the filesystem tool must not be invoked");
      assert.equal(turn.epistemic.includes("could_not_access"), true);
      assert.match(turn.reply, /never reachable from another device/);
    }
    await runtime.stop();
  });

  it("records the remote approval attempt where the owner can see it", async () => {
    const { runtime, gateway, session, id } = await heldFilesystemWrite([
      "status",
      "conversation",
      "operator.confirm",
    ]);
    const turn = await gateway.confirm(session.token, id, true);
    if (isClientError(turn)) throw new Error(turn.detail);
    assert.ok(
      turn.events.some((event) => event.type === "security.remote_confirmation"),
      "a remote device approving a held action must be visible to the owner",
    );
    await runtime.stop();
  });

  it("does not consume the confirmation when it refuses the approver", async () => {
    // Otherwise anyone who can attempt an approval can cancel one, and a phone becomes
    // a way to permanently deny the owner an action they wanted.
    const { runtime, gateway, session, id } = await heldFilesystemWrite([
      "status",
      "conversation",
      "operator.confirm",
    ]);
    await gateway.confirm(session.token, id, true);
    assert.equal(
      runtime.confirmations.has(id),
      true,
      "a refused approval destroyed a confirmation the owner may still want",
    );
    await runtime.stop();
  });

  it("a device without operator.confirm cannot approve at all", async () => {
    const { runtime, gateway, session, id } = await heldFilesystemWrite(["status", "conversation"]);
    const turn = await gateway.confirm(session.token, id, true);
    assert.equal(isClientError(turn), true);
    if (isClientError(turn)) assert.equal(turn.code, "SCOPE_DENIED");
    assert.equal(runtime.confirmations.has(id), true);
    await runtime.stop();
  });

  it("still lets a remote device approve something it is allowed to ask for", async () => {
    // The control must narrow, not sever. Approving from the sofa is the feature; it is
    // only OS authority that may not cross the wire.
    const runtime = await testRuntime({ providers: [callsTool("runtime_pause", {})] });
    const gateway = createClientGateway(runtime);
    await runtime.chat("pause background work");
    const id = [...runtime.confirmations.keys()][0];
    assert.ok(id, "runtime_pause should be held for confirmation");

    const phone = await enrolCompanion(runtime, { name: "phone" });
    const session = await gateway.issueSession({
      deviceId: phone.deviceId,
      deviceLabel: "phone",
      scopes: ["status", "conversation", "operator.confirm"],
    });
    if (isClientError(session)) throw new Error(session.detail);

    const turn = await gateway.confirm(session.token, id, true);
    if (isClientError(turn)) throw new Error(turn.detail);
    // Note `decision.allowed` is false for any confirm-tier tool even when it runs — it
    // means "allowed without confirmation". The evidence that it ran is the result.
    const record = turn.toolCalls.find((call) => call.toolName === "runtime_pause");
    assert.ok(record, "a permitted remote approval was refused before reaching the tool");
    assert.equal(record.result?.ok, true, "the approved action did not actually run");
    assert.equal(runtime.confirmations.has(id), false, "an executed confirmation is consumed");
    await runtime.stop();
  });
});

describe("a confirmation's recorded requester is re-checked when it is approved", () => {
  it("refuses a remote-requested OS action even when a local operator approves it", async () => {
    // Simulates a queue record that outlived its turn — restored from disk, or planted
    // there. The approval is local, so only the recorded requester stands between the
    // record and the disk.
    const root = await mkdtemp(join(tmpdir(), "vesper-planted-"));
    const target = join(root, "PLANTED.txt");
    const runtime = await testRuntime({ config: { approvedRoots: [root] } });
    const phone = await enrolCompanion(runtime, { name: "phone" });

    runtime.confirmations.set("confirm-planted", {
      id: "confirm-planted",
      toolName: "fs_write",
      args: { path: target, content: "planted" },
      reason: "Requires confirmation.",
      createdAt: new Date().toISOString(),
      workspaceId: "general",
      requestedBy: { kind: "remote", deviceId: phone.deviceId },
    });

    const turn = await runtime.chat("yes, go ahead", { confirmId: "confirm-planted", approve: true });
    await assert.rejects(
      () => readFile(target, "utf8"),
      "a remote-requested filesystem write executed because a local operator approved it",
    );
    assert.equal(turn.toolCalls.length, 0, "the tool must not even be invoked");
    assert.equal(
      runtime.confirmations.has("confirm-planted"),
      true,
      "a refusal on authority grounds must leave the record in place",
    );
    await runtime.stop();
  });

  it("treats a restored confirmation with no recorded origin as remote, not local", async () => {
    // Fail closed: a record on disk is attacker-influenceable in a way a live in-process
    // origin is not, so "we cannot tell who asked" must not resolve to full local trust.
    const root = await mkdtemp(join(tmpdir(), "vesper-restored-"));
    const target = join(root, "RESTORED.txt");
    const storage = new MemoryStorage({
      "runtime.confirmations": [
        {
          id: "confirm-restored",
          toolName: "fs_write",
          args: { path: target, content: "restored" },
          reason: "Requires confirmation.",
          createdAt: new Date().toISOString(),
          workspaceId: "general",
        },
      ],
    });
    const runtime = await createRuntime({
      storage,
      skipDiscovery: true,
      config: { approvedRoots: [root] },
    });
    await runtime.start();
    assert.equal(runtime.confirmations.has("confirm-restored"), true, "it should be restored");

    await runtime.chat("approve it", { confirmId: "confirm-restored", approve: true });
    await assert.rejects(
      () => readFile(target, "utf8"),
      "a confirmation restored with no origin was executed with local authority",
    );
    await runtime.stop();
  });

  it("loses the approval when the requesting device is revoked afterwards", async () => {
    // Trust is resolved when it is exercised, never replayed from the record.
    const runtime = await testRuntime({ providers: [callsTool("runtime_pause", {})] });
    const phone = await enrolCompanion(runtime, { name: "phone" });

    runtime.confirmations.set("confirm-live", {
      id: "confirm-live",
      toolName: "runtime_pause",
      args: {},
      reason: "Requires confirmation.",
      createdAt: new Date().toISOString(),
      workspaceId: "general",
      requestedBy: { kind: "remote", deviceId: phone.deviceId },
    });

    await runtime.devices.setTrust(phone.deviceId, "revoked");
    const turn = await runtime.chat("approve it", { confirmId: "confirm-live", approve: true });
    assert.equal(
      turn.toolCalls.length,
      0,
      "a revoked device's held request still ran after approval",
    );
    await runtime.stop();
  });
});
