import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "../storage.ts";
import { VesperIdentityStore } from "./vesper-identity.ts";

describe("Vesper identity", () => {
  it("is distinct from a device and never holds a private key", async () => {
    const storage = new MemoryStorage();
    const store = new VesperIdentityStore(storage);
    const first = await store.getOrCreate("dev_pc");
    assert.match(first.identityId, /^vesper_/);
    assert.equal(first.syncPolicy.cloudRequired, false);
    assert.equal(first.syncPolicy.defaultPrivacy, "private");
    assert.equal(first.status, "active");
    assert.deepEqual(first.deviceIds, ["dev_pc"]);
    assert.equal("privateKey" in first, false);
    const again = await store.getOrCreate("dev_pc");
    assert.equal(again.identityId, first.identityId);
    const withLaptop = await store.getOrCreate("dev_laptop");
    assert.equal(withLaptop.identityId, first.identityId);
    assert.ok(withLaptop.deviceIds.includes("dev_laptop"));
  });

  it("survives a restart from the same storage", async () => {
    const storage = new MemoryStorage();
    const first = await new VesperIdentityStore(storage).getOrCreate("dev_pc");
    const restored = await new VesperIdentityStore(storage).get();
    assert.equal(restored?.identityId, first.identityId);
    assert.deepEqual(restored?.deviceIds, ["dev_pc"]);
  });

  it("detach does not destroy the identity", async () => {
    const store = new VesperIdentityStore(new MemoryStorage());
    await store.getOrCreate("dev_pc");
    await store.attachDevice("dev_usb");
    const after = await store.detachDevice("dev_usb");
    assert.equal(after.deviceIds.includes("dev_usb"), false);
    assert.ok(after.identityId);
  });
});
