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

describe("revocation is terminal, not merely guarded on one edge", () => {
  it("refuses every transition out of revoked, not just the one to trusted", async () => {
    // The direct edge revoked -> trusted was refused, and re-enrolment was refused, but
    // revoked -> restricted -> trusted restored a device the owner had declared lost —
    // sessions, scopes and all — while revokedAt sat on the record proving it had been
    // revoked. A terminal state that can be left through an intermediate is not terminal.
    for (const intermediate of ["restricted", "pending"] as const) {
      const runtime = await testRuntime();
      const phone = await peer("phone");
      await runtime.devices.enrol(phone.publicIdentity());
      await runtime.devices.setTrust(phone.deviceId, "trusted");
      await runtime.devices.setTrust(phone.deviceId, "revoked");

      const hop = await runtime.devices.setTrust(phone.deviceId, intermediate);
      assert.equal(hop.ok, false, `revoked -> ${intermediate} was allowed`);

      const restore = await runtime.devices.setTrust(phone.deviceId, "trusted");
      assert.equal(restore.ok, false, `revoked -> ${intermediate} -> trusted restored the device`);

      const record = await runtime.devices.get(phone.deviceId);
      assert.equal(record?.trust, "revoked", "the device left the revoked state");
      await runtime.stop();
    }
  });

  it("a revoked device cannot open a session by any route", async () => {
    const runtime = await testRuntime();
    const gateway = new VesperClientGateway(runtime);
    const phone = await peer("phone");
    await runtime.devices.enrol(phone.publicIdentity());
    await runtime.devices.setTrust(phone.deviceId, "trusted");
    await runtime.devices.setTrust(phone.deviceId, "revoked");
    await runtime.devices.setTrust(phone.deviceId, "restricted");

    const session = await gateway.issueSession({ deviceId: phone.deviceId, deviceLabel: "phone" });
    assert.ok("ok" in session && session.ok === false, "a revoked device opened a session");
    await runtime.stop();
  });

  it("still allows forgetting a revoked device, the one deliberate way back", async () => {
    // The control must narrow, not sever: revocation has to be undoable by an explicit
    // act at the machine, or a mistyped device id is permanent.
    const runtime = await testRuntime();
    const phone = await peer("phone");
    await runtime.devices.enrol(phone.publicIdentity());
    await runtime.devices.setTrust(phone.deviceId, "revoked");

    assert.equal(await runtime.devices.forget(phone.deviceId), true);
    const reEnrolled = await runtime.devices.enrol(phone.publicIdentity());
    assert.equal(reEnrolled.ok, true, "a forgotten device could not re-enrol");
    assert.equal((await runtime.devices.get(phone.deviceId))?.trust, "pending");
    await runtime.stop();
  });
});

describe("the bearer token is the only authenticator, so it is compared exactly", () => {
  /**
   * A wrong token had no test anywhere.
   *
   * Every existing UNAUTHENTICATED assertion in this file and in gateway.test.ts is
   * satisfied by a *different* mechanism: no token at all (the `if (!token)` guard), an
   * unenrolled device (caught at issue time), a revoked device (caught by the registry
   * re-check). Not one of them presented a wrong or truncated token to a live session,
   * so the comparison itself — `safeEqual(item.token, token)` — was unexercised.
   *
   * Substituting `item.token.startsWith(token)`, which is the shape of any prefix or
   * non-constant-time comparison slip, makes the token brute-forceable one character at
   * a time and leaves the whole suite green. That is what this test is for.
   */
  async function liveSession(name = "phone") {
    const runtime = await testRuntime();
    const gateway = new VesperClientGateway(runtime);
    const device = await peer(name);
    await runtime.devices.enrol(device.publicIdentity());
    await runtime.devices.setTrust(device.deviceId, "trusted");
    const issued = await gateway.issueSession({ deviceId: device.deviceId, deviceLabel: name });
    if ("ok" in issued) throw new Error(issued.detail);
    return { runtime, gateway, token: issued.token };
  }

  it("refuses every near-miss token, including a prefix of the real one", async () => {
    const { runtime, gateway, token } = await liveSession();
    assert.ok(token.length > 8, "the token is too short for this test to mean anything");

    const flipped = `${token.slice(0, -1)}${token.at(-1) === "a" ? "b" : "a"}`;
    const wrong: [string, string][] = [
      ["empty string", ""],
      ["one character", token.slice(0, 1)],
      ["a proper prefix", token.slice(0, token.length - 1)],
      ["the token plus a character", `${token}x`],
      ["one character flipped", flipped],
      ["a prefix with the rest as whitespace", token.slice(0, 4).padEnd(token.length, " ")],
      ["an unrelated token", "NOT-THE-TOKEN"],
    ];
    for (const [label, candidate] of wrong) {
      const result = await gateway.status(candidate);
      assert.ok("ok" in result && result.ok === false, `${label} authenticated`);
      assert.equal(result.code, "UNAUTHENTICATED", `${label} failed for the wrong reason`);
    }

    // Narrowing, not severing: the real token must still work, in this same test, or a
    // comparison that refused everything would pass the loop above.
    const good = await gateway.status(token);
    assert.equal("ok" in good, false, "the correct token stopped working");
    await runtime.stop();
  });

  it("does not accept one device's token on another device's session", async () => {
    const first = await liveSession("phone-a");
    const second = await liveSession("phone-b");
    const crossed = await first.gateway.status(second.token);
    assert.ok("ok" in crossed && crossed.ok === false, "a token from another host authenticated");
    assert.equal(crossed.code, "UNAUTHENTICATED");
    await first.runtime.stop();
    await second.runtime.stop();
  });
});
