import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryCloudProvider } from "./cloud.ts";
import { createKeyring, decryptEnvelope } from "./crypto.ts";
import { ContinuityEngine } from "./engine.ts";
import { runQuietSyncTick } from "./heartbeat.ts";
import { mayEnterCloud } from "./policy.ts";
import { buildSyncRecord, SyncRecordError } from "./records.ts";
import { trustAfterSync } from "./types.ts";
import type { SyncRecord } from "./types.ts";

function memoryRecord(over: Partial<Parameters<typeof buildSyncRecord>[0]> = {}): SyncRecord {
  return buildSyncRecord({
    entityType: "memory",
    entityId: "sarah.employer",
    sourceDeviceId: "dev_pc",
    operation: "update",
    payload: { value: "Y" },
    privacy: "shared",
    trust: "user",
    origin: "test",
    ...over,
  });
}

describe("continuity engine", () => {
  it("refuses to build an instruction record", () => {
    assert.throws(
      () =>
        buildSyncRecord({
          entityType: "tool",
          entityId: "fs_write",
          sourceDeviceId: "dev_pc",
          operation: "create",
          payload: { name: "fs_write" },
          privacy: "shared",
          trust: "user",
          origin: "test",
        }),
      SyncRecordError,
    );
  });

  it("private records never enter the outbox", () => {
    const engine = new ContinuityEngine({ localDeviceId: "dev_pc" });
    const record = memoryRecord({ privacy: "private" });
    const queued = engine.enqueue(record);
    assert.equal(queued.queued, false);
    assert.equal(engine.pending, 0);
    assert.equal(mayEnterCloud(record).allowed, false);
  });

  it("offline push keeps the queue", async () => {
    const engine = new ContinuityEngine({ localDeviceId: "dev_pc" });
    engine.enqueue(memoryRecord());
    const cloud = new MemoryCloudProvider();
    const auth = await cloud.authenticate("dev_pc");
    assert.ok("token" in auth);
    await cloud.registerDevice(auth, "pk");
    cloud.setConnected(false);
    const ring = createKeyring();
    const outcome = await engine.exchange({
      provider: cloud,
      auth,
      ring,
      local: [],
      apply: () => undefined,
    });
    assert.ok(outcome.offlineReason);
    assert.equal(engine.pending, 1);
  });

  it("duplicate delivery is not reapplied", async () => {
    const engine = new ContinuityEngine({ localDeviceId: "dev_laptop" });
    const cloud = new MemoryCloudProvider();
    const pcAuth = await cloud.authenticate("dev_pc");
    const laptopAuth = await cloud.authenticate("dev_laptop");
    assert.ok("token" in pcAuth && "token" in laptopAuth);
    await cloud.registerDevice(pcAuth, "pk-pc");
    await cloud.registerDevice(laptopAuth, "pk-laptop");
    const ring = createKeyring();
    const pc = new ContinuityEngine({ localDeviceId: "dev_pc" });
    const record = memoryRecord();
    pc.enqueue(record);
    await pc.exchange({ provider: cloud, auth: pcAuth, ring, local: [], apply: () => undefined });
    const applied: string[] = [];
    const apply = (incoming: SyncRecord) => {
      applied.push(incoming.entityId);
    };
    await engine.exchange({ provider: cloud, auth: laptopAuth, ring, local: [], apply });
    await engine.exchange({ provider: cloud, auth: laptopAuth, ring, local: [], apply });
    assert.equal(applied.length, 1);
  });

  it("cloud blobs are not plaintext", async () => {
    const cloud = new MemoryCloudProvider();
    const auth = await cloud.authenticate("dev_pc");
    assert.ok("token" in auth);
    const ring = createKeyring();
    const engine = new ContinuityEngine({ localDeviceId: "dev_pc" });
    engine.enqueue(memoryRecord({ payload: { value: "unique-plaintext-marker" } }));
    await engine.exchange({ provider: cloud, auth, ring, local: [], apply: () => undefined });
    const blobs = cloud.inspectBlobs();
    assert.equal(blobs.length, 1);
    assert.equal(JSON.stringify(blobs).includes("unique-plaintext-marker"), false);
    const decrypted = decryptEnvelope(blobs[0]!, ring);
    assert.equal(decrypted.ok, true);
  });

  it("quiet sync never claims to wake the model", async () => {
    const engine = new ContinuityEngine({ localDeviceId: "dev_pc" });
    const cloud = new MemoryCloudProvider();
    const auth = await cloud.authenticate("dev_pc");
    assert.ok("token" in auth);
    const tick = await runQuietSyncTick({
      enabled: true,
      engine,
      provider: cloud,
      auth,
      ring: createKeyring(),
      local: [],
      apply: () => undefined,
    });
    assert.equal(tick.wokeModel, false);
    assert.equal(tick.ran, true);
  });

  it("sync does not upgrade untrusted content", () => {
    assert.equal(trustAfterSync("untrusted_external"), "untrusted_external");
    assert.equal(trustAfterSync("user"), "synced_user_data");
    assert.equal(trustAfterSync("trusted_local"), "synced_user_data");
  });

  it("a crash mid-sync resumes from the checkpoint without dropping local writes", async () => {
    const engine = new ContinuityEngine({ localDeviceId: "dev_pc" });
    engine.enqueue(memoryRecord({ entityId: "a" }));
    const snap = engine.snapshot();
    const restored = new ContinuityEngine({ localDeviceId: "dev_pc" });
    restored.restore(snap);
    restored.enqueue(memoryRecord({ entityId: "b", payload: { value: "second" } }));
    assert.equal(restored.pending, 2);
  });
});
