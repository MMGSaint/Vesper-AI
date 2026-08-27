import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "../test-helpers.ts";
import { VesperClientGateway } from "./gateway.ts";
import { loadDeviceIdentity } from "../distributed/identity.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A peer device, keys and all, the same way the distributed layer makes one. */
async function peer(name: string) {
  const dirs = { data: await mkdtemp(join(tmpdir(), "vesper-client-")) };
  const { identity } = await loadDeviceIdentity({
    dirs,
    name,
    deviceType: "phone",
    vesperVersion: "test",
  });
  return identity;
}

/**
 * A client session is authority over a real Vesper. Whatever else the transport turns
 * out to be, the question "is this device still allowed to talk to me?" has exactly one
 * answer, and it lives in the device registry — not in a bearer token's expiry.
 *
 * These tests exist because the client contract was written before the device layer and
 * authenticated a free-text `deviceLabel` instead of a registered identity, which meant
 * revoking a device left its live sessions working.
 */
describe("client sessions are bound to a registered device", () => {
  it("refuses to issue a session to a device that was never enrolled", async () => {
    const runtime = await testRuntime();
    const gateway = new VesperClientGateway(runtime);
    const stranger = await peer("unknown-phone");

    const issued = await gateway.issueSession({
      deviceId: stranger.deviceId,
      deviceLabel: "unknown-phone",
    });
    assert.ok("ok" in issued && issued.ok === false, "an unenrolled device got a session");
    assert.equal(issued.code, "UNAUTHENTICATED");
  });

  it("refuses a device that is enrolled but not yet trusted", async () => {
    const runtime = await testRuntime();
    const gateway = new VesperClientGateway(runtime);
    const phone = await peer("phone");
    // Enrolment alone means pending: the user has not approved it yet.
    await runtime.devices.enrol(phone.publicIdentity());

    const issued = await gateway.issueSession({
      deviceId: phone.deviceId,
      deviceLabel: "phone",
    });
    assert.ok("ok" in issued && issued.ok === false, "a pending device got a session");
  });

  it("revoking a device kills its live session immediately, not at expiry", async () => {
    const runtime = await testRuntime();
    const gateway = new VesperClientGateway(runtime);
    const phone = await peer("phone");
    await runtime.devices.enrol(phone.publicIdentity());
    await runtime.devices.setTrust(phone.deviceId, "trusted");

    const session = await gateway.issueSession({
      deviceId: phone.deviceId,
      deviceLabel: "phone",
      ttlMs: 60 * 60 * 1000,
    });
    assert.ok(!("ok" in session), "a trusted device must get a session");
    const token = "token" in session ? session.token : "";

    // It works while the device is trusted.
    const before = await gateway.status(token);
    assert.ok(!("ok" in before), "a trusted device can read status");

    // The phone is lost. The user revokes it. The token has not expired.
    await runtime.devices.setTrust(phone.deviceId, "revoked");

    const after = await gateway.status(token);
    assert.ok(
      "ok" in after && after.ok === false,
      "a revoked device kept its session until token expiry",
    );
    assert.equal(after.code, "UNAUTHENTICATED");
  });
});

describe("a restricted device is capped by trust, not by a separate protocol", () => {
  it("gives a restricted device conversation but never write or confirm authority", async () => {
    // This is the portable/USB case, and the point is that it needs no new contract:
    // running from a stick on someone else's PC is a trust class on the device model.
    const runtime = await testRuntime();
    const gateway = new VesperClientGateway(runtime);
    const stick = await peer("portable-stick");
    await runtime.devices.enrol(stick.publicIdentity());
    await runtime.devices.setTrust(stick.deviceId, "restricted");

    const session = await gateway.issueSession({
      deviceId: stick.deviceId,
      deviceLabel: "portable-stick",
      scopes: ["status", "conversation", "memory.read", "memory.write", "operator.confirm"],
    });
    assert.ok(!("ok" in session), "a restricted device may still hold a session");
    const granted = "scopes" in session ? session.scopes : [];

    assert.ok(granted.includes("conversation"), "a restricted device can still be talked to");
    assert.equal(granted.includes("memory.write"), false, "it must not write the user's record");
    assert.equal(
      granted.includes("operator.confirm"),
      false,
      "it must not approve an action on the user's behalf",
    );
    assert.equal(granted.includes("memory.read"), false, "it must not read the memory store");
  });

  it("demoting a trusted device re-caps its existing session immediately", async () => {
    // A session opened while trusted must not outlive the trust it was opened under.
    const runtime = await testRuntime();
    const gateway = new VesperClientGateway(runtime);
    const laptop = await peer("laptop");
    await runtime.devices.enrol(laptop.publicIdentity());
    await runtime.devices.setTrust(laptop.deviceId, "trusted");

    const session = await gateway.issueSession({
      deviceId: laptop.deviceId,
      deviceLabel: "laptop",
      scopes: ["status", "conversation", "memory.read", "memory.write"],
      ttlMs: 60 * 60 * 1000,
    });
    assert.ok(!("ok" in session));
    const token = "token" in session ? session.token : "";
    assert.deepEqual(await gateway.scopesOf(token), [
      "status",
      "conversation",
      "memory.read",
      "memory.write",
    ]);

    // The laptop leaves the house. It keeps talking, but loses its authority.
    await runtime.devices.setTrust(laptop.deviceId, "restricted");

    const after = await gateway.scopesOf(token);
    assert.ok(Array.isArray(after), "a restricted device keeps a usable session");
    assert.equal(after.includes("memory.write"), false, "the demotion did not take effect");
    assert.ok(after.includes("conversation"));
  });
});
