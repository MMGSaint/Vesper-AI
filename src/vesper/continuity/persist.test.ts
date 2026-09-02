import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "../storage.ts";
import { createKeyring, encryptEnvelope, decryptEnvelope, rotateKeyring } from "./crypto.ts";
import { ContinuityEngine } from "./engine.ts";
import { testRuntime } from "../test-helpers.ts";
import { persistContinuity, restoreContinuity } from "./persist.ts";
import { buildSyncRecord } from "./records.ts";

describe("continuity persist", () => {
  it("restores the outbox and keyring across a restart", async () => {
    const storage = new MemoryStorage();
    const engine = new ContinuityEngine({ localDeviceId: "dev_pc" });
    engine.enqueue(
      buildSyncRecord({
        entityType: "memory",
        entityId: "note",
        sourceDeviceId: "dev_pc",
        operation: "update",
        payload: { value: "queued-offline" },
        privacy: "shared",
        trust: "user",
        origin: "pc",
      }),
    );
    const ring = createKeyring();
    await persistContinuity(storage, engine, ring);

    const restoredEngine = new ContinuityEngine({ localDeviceId: "dev_pc" });
    const restoredRing = await restoreContinuity(storage, restoredEngine);
    assert.equal(restoredEngine.pending, 1);
    assert.ok(restoredRing);
    assert.equal(restoredRing.keyVersion, ring.keyVersion);
    const envelope = encryptEnvelope({
      recordId: "sync_old",
      entityType: "memory",
      sourceDeviceId: "dev_pc",
      plaintext: "still-decrypts",
      ring,
    });
    const result = decryptEnvelope(envelope, restoredRing);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.plaintext.toString("utf8"), "still-decrypts");
  });

  it("rotation does not orphan envelopes sealed with the previous version", () => {
    const first = createKeyring();
    const envelope = encryptEnvelope({
      recordId: "sync_v1",
      entityType: "memory",
      sourceDeviceId: "dev_pc",
      plaintext: "sealed-with-v1",
      ring: first,
    });
    const rotated = rotateKeyring(first);
    const result = decryptEnvelope(envelope, rotated);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.plaintext.toString("utf8"), "sealed-with-v1");
    assert.equal(rotated.keyVersion, first.keyVersion + 1);
  });

  it("runtime restores one Vesper identity and a pairing ledger", async () => {
    const runtime = await testRuntime();
    assert.match(runtime.continuity.identity.identityId, /^vesper_/);
    assert.equal(runtime.continuity.identity.syncPolicy.cloudRequired, false);
    assert.ok(runtime.continuity.identity.deviceIds.includes(runtime.deviceIdentity.deviceId));
    await runtime.continuity.pairing.markPending("dev_other");
    await runtime.continuity.pairing.approve("dev_other");
    await runtime.continuity.pairing.suspend("dev_other");
    assert.equal(await runtime.continuity.pairing.maySync("dev_other"), false);
    assert.equal((await runtime.devices.get("dev_other"))?.trust, undefined);
    await runtime.stop();
  });
});
