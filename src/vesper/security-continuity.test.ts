import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "./storage.ts";
import { ProcedureStore } from "./procedures.ts";
import { SkillRegistry } from "./skills.ts";
import { testRuntime } from "./test-helpers.ts";
import { MemoryCloudProvider } from "./continuity/cloud.ts";
import { createKeyring, decryptEnvelope, encryptEnvelope, revokeDevice } from "./continuity/crypto.ts";
import { ContinuityEngine } from "./continuity/engine.ts";
import { mayApplyIncoming, mayEnterCloud } from "./continuity/policy.ts";
import { buildSyncRecord, SyncRecordError } from "./continuity/records.ts";
import { proposeSkillFromProcedure } from "./continuity/bridge.ts";
import { trustAfterSync } from "./continuity/types.ts";
import { MAX_SYNC_PAYLOAD_BYTES } from "./continuity/types.ts";

describe("continuity security", () => {
  it("authentication failure rejects a push", async () => {
    const cloud = new MemoryCloudProvider();
    const ring = createKeyring();
    const envelope = encryptEnvelope({
      recordId: "sync_x",
      entityType: "memory",
      sourceDeviceId: "dev_x",
      plaintext: "{}",
      ring,
    });
    const result = await cloud.push({ deviceId: "dev_x", token: "nope" }, [envelope]);
    assert.equal(result.accepted, 0);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]?.reason ?? "", /auth/i);
  });

  it("authorization: a device cannot push on behalf of another", async () => {
    const cloud = new MemoryCloudProvider();
    const auth = await cloud.authenticate("dev_pc");
    assert.ok("token" in auth);
    const ring = createKeyring();
    const envelope = encryptEnvelope({
      recordId: "sync_x",
      entityType: "memory",
      sourceDeviceId: "dev_other",
      plaintext: "{}",
      ring,
    });
    const result = await cloud.push(auth, [envelope]);
    assert.equal(result.accepted, 0);
    assert.match(result.rejected[0]?.reason ?? "", /another device/);
  });

  it("stale updates do not overwrite newer local state", async () => {
    const engine = new ContinuityEngine({ localDeviceId: "dev_laptop" });
    const cloud = new MemoryCloudProvider();
    const pcAuth = await cloud.authenticate("dev_pc");
    const laptopAuth = await cloud.authenticate("dev_laptop");
    assert.ok("token" in pcAuth && "token" in laptopAuth);
    const ring = createKeyring();
    const pc = new ContinuityEngine({ localDeviceId: "dev_pc" });
    pc.enqueue(
      buildSyncRecord({
        entityType: "memory",
        entityId: "note",
        sourceDeviceId: "dev_pc",
        operation: "update",
        payload: { value: "old" },
        privacy: "shared",
        trust: "user",
        origin: "pc",
        version: 1,
      }),
    );
    await pc.exchange({ provider: cloud, auth: pcAuth, ring, local: [], apply: () => undefined });
    const local = buildSyncRecord({
      entityType: "memory",
      entityId: "note",
      sourceDeviceId: "dev_laptop",
      operation: "update",
      payload: { value: "new" },
      privacy: "shared",
      trust: "user",
      origin: "laptop",
      version: 2,
    });
    const outcome = await engine.exchange({
      provider: cloud,
      auth: laptopAuth,
      ring,
      local: [local],
      apply: () => {
        throw new Error("stale must not apply");
      },
    });
    assert.ok(outcome.conflicts.length >= 1);
  });

  it("tampered envelopes are rejected", () => {
    const ring = createKeyring();
    const envelope = encryptEnvelope({
      recordId: "sync_1",
      entityType: "memory",
      sourceDeviceId: "dev_pc",
      plaintext: "{\"ok\":true}",
      ring,
    });
    envelope.tag = envelope.ciphertext;
    const result = decryptEnvelope(envelope, ring);
    assert.equal(result.ok, false);
  });

  it("revoked devices cannot decrypt", () => {
    const ring = createKeyring();
    const envelope = encryptEnvelope({
      recordId: "sync_1",
      entityType: "memory",
      sourceDeviceId: "dev_pc",
      plaintext: "x",
      ring,
    });
    revokeDevice(ring, "dev_pc");
    const result = decryptEnvelope(envelope, ring);
    assert.equal(result.ok, false);
  });

  it("malformed and oversized records are refused", () => {
    assert.throws(() =>
      buildSyncRecord({
        entityType: "grant",
        entityId: "x",
        sourceDeviceId: "dev_pc",
        operation: "create",
        payload: {},
        privacy: "shared",
        trust: "user",
        origin: "x",
      }),
    );
    const huge = "n".repeat(MAX_SYNC_PAYLOAD_BYTES + 10);
    assert.throws(
      () =>
        buildSyncRecord({
          entityType: "memory",
          entityId: "x",
          sourceDeviceId: "dev_pc",
          operation: "create",
          payload: { value: huge },
          privacy: "shared",
          trust: "user",
          origin: "x",
        }),
      SyncRecordError,
    );
  });

  it("trust is downgraded through sync, never upgraded", () => {
    assert.equal(trustAfterSync("untrusted_external"), "untrusted_external");
    assert.equal(trustAfterSync("user"), "synced_user_data");
    assert.notEqual(trustAfterSync("user"), "trusted_local");
  });

  it("a synced procedure cannot bypass the permission gate", async () => {
    const runtime = await testRuntime();
    const procedures = new ProcedureStore(new MemoryStorage(), {
      permissionOf: (name) => runtime.tools.get(name)?.spec.permission,
    });
    const created = await procedures.propose({
      name: "write notes",
      purpose: "write a file",
      steps: [{ instruction: "write", toolName: "fs_write", permission: "confirm" }],
      provenance: { source: "user", origin: "sync" },
    });
    await procedures.review(created.id);
    await procedures.activate(created.id);
    const skills = new SkillRegistry(new MemoryStorage());
    const procedure = await procedures.get(created.id);
    assert.ok(procedure);
    await proposeSkillFromProcedure(procedure, skills, { knownTools: ["fs_write"] });
    const queued = await runtime.tools.invoke({
      name: "fs_write",
      args: { path: "notes/x.md", content: "from sync" },
      workspaceId: "general",
    });
    assert.equal(queued.decision.requiresConfirmation, true);
    assert.equal(queued.result, undefined);
  });

  it("private and credential-shaped payloads never leave the device", () => {
    const privateRecord = buildSyncRecord({
      entityType: "memory",
      entityId: "diary",
      sourceDeviceId: "dev_pc",
      operation: "create",
      payload: { value: "personal" },
      privacy: "private",
      trust: "user",
      origin: "pc",
    });
    assert.equal(mayEnterCloud(privateRecord).allowed, false);
    const secret = buildSyncRecord({
      entityType: "memory",
      entityId: "token-slot",
      sourceDeviceId: "dev_pc",
      operation: "create",
      payload: { value: "password is hunter2-not-real" },
      privacy: "shared",
      trust: "user",
      origin: "pc",
    });
    assert.equal(mayEnterCloud(secret).allowed, false);
  });

  it("incoming private or revoked records are not applied", () => {
    const incoming = buildSyncRecord({
      entityType: "memory",
      entityId: "x",
      sourceDeviceId: "dev_other",
      operation: "create",
      payload: { value: "nope" },
      privacy: "private",
      trust: "user",
      origin: "other",
    });
    assert.equal(
      mayApplyIncoming({ record: incoming, localDeviceId: "dev_pc", senderRevoked: false }).allowed,
      false,
    );
    const shared = buildSyncRecord({
      entityType: "memory",
      entityId: "y",
      sourceDeviceId: "dev_revoked",
      operation: "create",
      payload: { value: "nope" },
      privacy: "shared",
      trust: "user",
      origin: "revoked",
    });
    assert.equal(
      mayApplyIncoming({ record: shared, localDeviceId: "dev_pc", senderRevoked: true }).allowed,
      false,
    );
  });
});
