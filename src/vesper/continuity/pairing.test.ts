import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "../storage.ts";
import { loadDeviceIdentity } from "../distributed/identity.ts";
import { DeviceRegistry } from "../distributed/registry.ts";
import { acceptPairing, createPairingOffer } from "./pairing.ts";

async function device(name: string, type: "desktop" | "laptop" | "portable" = "desktop") {
  const dirs = { data: await mkdtemp(join(tmpdir(), "vesper-pair-")) };
  const loaded = await loadDeviceIdentity({ dirs, name, deviceType: type, vesperVersion: "test" });
  return loaded.identity;
}

describe("pairing", () => {
  it("enrols as pending, not trusted", async () => {
    const pc = await device("pc");
    const usb = await device("usb", "portable");
    const registry = new DeviceRegistry({ storage: new MemoryStorage(), self: pc.publicIdentity() });
    const { offer, code } = createPairingOffer({ from: usb.publicIdentity() });
    const accepted = await acceptPairing({ offer, code, registry });
    assert.equal(accepted.ok, true);
    const record = await registry.get(usb.deviceId);
    assert.equal(record?.trust, "pending");
  });

  it("rejects a wrong code and an expired offer", async () => {
    const pc = await device("pc");
    const usb = await device("usb", "portable");
    const registry = new DeviceRegistry({ storage: new MemoryStorage(), self: pc.publicIdentity() });
    const { offer } = createPairingOffer({ from: usb.publicIdentity() });
    const wrong = await acceptPairing({ offer, code: "XXXXXX", registry });
    assert.equal(wrong.ok, false);
    const expiredOffer = createPairingOffer({
      from: usb.publicIdentity(),
      ttlMs: 1,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const expired = await acceptPairing({
      offer: expiredOffer.offer,
      code: expiredOffer.code,
      registry,
      now: () => new Date("2026-01-01T00:01:00.000Z"),
    });
    assert.equal(expired.ok, false);
  });
});
