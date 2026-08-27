import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "../storage.ts";
import {
  canonicalJson,
  loadDeviceIdentity,
  verifySignature,
  type PublicDeviceIdentity,
} from "./identity.ts";
import { DeviceRegistry } from "./registry.ts";
import {
  decideRemoteRequest,
  discoverCapabilities,
  grantedCapabilities,
  grantsRespectForbiddenPowers,
  isGranted,
  manifestHas,
  type CapabilityManifest,
} from "./capabilities.ts";
import {
  DEFAULT_GRANT_TTL_MS,
  MAX_GRANT_TTL_MS,
  ReplayGuard,
  issueSessionGrant,
  verifySessionGrant,
} from "./session.ts";

async function tempDirs() {
  const root = await mkdtemp(join(tmpdir(), "vesper-dist-"));
  return { data: root };
}

async function identity(name: string, type: "desktop" | "laptop" | "phone" = "desktop") {
  const dirs = await tempDirs();
  const loaded = await loadDeviceIdentity({
    dirs,
    name,
    deviceType: type,
    vesperVersion: "test",
  });
  return { ...loaded, dirs };
}

function manifest(deviceId: string, available: string[]): CapabilityManifest {
  return {
    deviceId,
    generatedAt: new Date().toISOString(),
    findings: available.map((id) => ({
      id: id as never,
      state: "AVAILABLE" as const,
      detail: "probed",
    })),
  };
}

test("device identity", async (t) => {
  await t.test("generates a stable identity and reuses it", async () => {
    const dirs = await tempDirs();
    const first = await loadDeviceIdentity({ dirs, vesperVersion: "test", name: "desk" });
    assert.equal(first.created, true);
    assert.match(first.identity.deviceId, /^dev_/);

    const second = await loadDeviceIdentity({ dirs, vesperVersion: "test", name: "desk" });
    assert.equal(second.created, false, "a second load reuses the identity");
    assert.equal(second.identity.deviceId, first.identity.deviceId);
    assert.equal(second.identity.publicKey, first.identity.publicKey);
  });

  await t.test("the identity is not derived from spoofable hardware facts", async () => {
    const a = await identity("one");
    const b = await identity("two");
    // Same machine, same OS, same everything a hardware probe would see - different ids.
    assert.notEqual(a.identity.deviceId, b.identity.deviceId);
    assert.notEqual(a.identity.publicKey, b.identity.publicKey);
  });

  await t.test("signs and verifies, and rejects a tampered payload", async () => {
    const { identity: id } = await identity("signer");
    const payload = canonicalJson({ action: "sync", count: 3 } as never);
    const signature = id.sign(payload);

    assert.equal(verifySignature(id.publicKey, payload, signature), true);
    const tampered = canonicalJson({ action: "sync", count: 4 } as never);
    assert.equal(verifySignature(id.publicKey, tampered, signature), false);
  });

  await t.test("canonical JSON is stable across key order", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } } as never);
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 } as never);
    assert.equal(a, b, "signatures would be unverifiable if serialization were ambiguous");
  });

  await t.test("the public identity never carries the private key", async () => {
    const { identity: id } = await identity("secret");
    const published = JSON.stringify(id.publicIdentity());
    assert.ok(!published.includes("privateKey"));
    // A real private key is long; assert nothing key-shaped leaked.
    assert.ok(published.length < 600);
  });

  await t.test("a corrupted identity file yields a new identity and says so", async () => {
    const store = new Map<string, string>();
    const io = {
      read: async (path: string) => {
        const value = store.get(path);
        if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return value;
      },
      write: async (path: string, contents: string) => {
        store.set(path, contents);
      },
    };
    const dirs = await tempDirs();
    await loadDeviceIdentity({ dirs, vesperVersion: "test", io });
    // Corrupt it: a valid-looking file whose key does not match its public half.
    const path = [...store.keys()][0];
    const parsed = JSON.parse(store.get(path)!) as Record<string, unknown>;
    const other = await loadDeviceIdentity({ dirs: { data: "/other" }, vesperVersion: "test", io });
    parsed.publicKey = other.identity.publicKey;
    store.set(path, JSON.stringify(parsed));

    const reloaded = await loadDeviceIdentity({ dirs, vesperVersion: "test", io });
    assert.equal(reloaded.created, true, "a key that does not verify is replaced");
    assert.match(reloaded.note ?? "", /did not verify/i);
  });
});

test("device registry: trust and presence", async (t) => {
  async function registry() {
    const self = await identity("self");
    const reg = new DeviceRegistry({
      storage: new MemoryStorage(),
      self: self.identity.publicIdentity(),
    });
    return { reg, self };
  }

  await t.test("a new device enrols as pending, not trusted", async () => {
    const { reg } = await registry();
    const peer = await identity("peer", "phone");
    const result = await reg.enrol(peer.identity.publicIdentity());
    assert.equal(result.ok, true);
    assert.equal(result.record?.trust, "pending", "asking is not the same as being trusted");
    assert.deepEqual(await reg.trusted().then((list) => list.map((r) => r.identity.name)), ["self"]);
  });

  await t.test("revocation is terminal: a revoked device cannot re-enrol", async () => {
    const { reg } = await registry();
    const peer = await identity("lost-usb", "laptop");
    await reg.enrol(peer.identity.publicIdentity());
    await reg.setTrust(peer.identity.deviceId, "trusted");
    await reg.setTrust(peer.identity.deviceId, "revoked");

    const again = await reg.enrol(peer.identity.publicIdentity());
    assert.equal(again.ok, false);
    assert.match(again.reason ?? "", /revoked and cannot re-enrol/i);

    const retrust = await reg.setTrust(peer.identity.deviceId, "trusted");
    assert.equal(retrust.ok, false, "revocation is not undone by re-trusting");
  });

  await t.test("forgetting is the only way back, and is deliberate", async () => {
    const { reg } = await registry();
    const peer = await identity("peer");
    await reg.enrol(peer.identity.publicIdentity());
    await reg.setTrust(peer.identity.deviceId, "revoked");
    assert.equal(await reg.forget(peer.identity.deviceId), true);
    const fresh = await reg.enrol(peer.identity.publicIdentity());
    assert.equal(fresh.ok, true);
    assert.equal(fresh.record?.trust, "pending");
  });

  await t.test("a known device id presenting a different key is refused", async () => {
    const { reg } = await registry();
    const real = await identity("desktop");
    await reg.enrol(real.identity.publicIdentity());

    const impostor = await identity("desktop");
    const spoofed: PublicDeviceIdentity = {
      ...impostor.identity.publicIdentity(),
      deviceId: real.identity.deviceId,
    };
    const result = await reg.enrol(spoofed);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /different key/i);
  });

  await t.test("this device cannot be forgotten out of its own registry", async () => {
    const { reg, self } = await registry();
    assert.equal(await reg.forget(self.identity.deviceId), false);
  });

  await t.test("silence is reported as offline, not as last-known presence", async () => {
    const self = await identity("self");
    let clock = Date.parse("2026-08-26T12:00:00.000Z");
    const reg = new DeviceRegistry({
      storage: new MemoryStorage(),
      self: self.identity.publicIdentity(),
      now: () => new Date(clock).toISOString(),
      presenceTimeoutMs: 60_000,
    });
    const peer = await identity("phone", "phone");
    await reg.enrol(peer.identity.publicIdentity());
    await reg.recordPresence(peer.identity.deviceId, { reachability: "online", activity: "active" });

    let seen = await reg.get(peer.identity.deviceId);
    assert.equal(seen?.presence.reachability, "online");

    clock += 120_000; // two minutes of silence
    seen = await reg.get(peer.identity.deviceId);
    assert.equal(seen?.presence.reachability, "offline");
    assert.equal(seen?.presence.activity, "unknown", "we stop claiming to know what it is doing");
  });

  await t.test("presence never changes trust", async () => {
    const { reg } = await registry();
    const peer = await identity("peer");
    await reg.enrol(peer.identity.publicIdentity());
    await reg.recordPresence(peer.identity.deviceId, { reachability: "online", activity: "active" });
    assert.equal((await reg.get(peer.identity.deviceId))?.trust, "pending");
  });

  await t.test("a corrupt registry costs peer memory, not availability", async () => {
    const self = await identity("self");
    const storage = new MemoryStorage();
    await storage.set("devices.registry", "not an array" as never);
    const reg = new DeviceRegistry({ storage, self: self.identity.publicIdentity() });
    const list = await reg.list();
    assert.equal(list.length, 1, "this device is still present and usable");
  });
});

test("capabilities and remote grants", async (t) => {
  await t.test("a capability is discovered, never assumed", async () => {
    const found = await discoverCapabilities({
      deviceId: "dev_x",
      probes: [
        { id: "local_llm", probe: () => ({ state: "AVAILABLE", detail: "ollama answered" }) },
        { id: "nexus", probe: () => ({ state: "UNAVAILABLE", detail: "no optimizer endpoint" }) },
      ],
    });
    assert.equal(manifestHas(found, "local_llm"), true);
    assert.equal(manifestHas(found, "nexus"), false);
    // Never probed at all is not the same as probed-and-absent.
    assert.equal(manifestHas(found, "voice_stt"), false);
  });

  await t.test("a failing probe reports unavailable with the reason", async () => {
    const found = await discoverCapabilities({
      deviceId: "dev_x",
      probes: [
        {
          id: "local_llm",
          probe: () => {
            throw new Error("connection refused");
          },
        },
      ],
    });
    assert.equal(found.findings[0].state, "UNAVAILABLE");
    assert.match(found.findings[0].detail, /connection refused/);
  });

  await t.test("a restricted (portable) device gets materially fewer powers", () => {
    const restricted = grantedCapabilities("restricted");
    const trusted = grantedCapabilities("trusted");
    assert.ok(restricted.length < trusted.length);
    for (const denied of ["filesystem", "windows_control", "nexus", "process_inspect", "app_launch", "task_execute"] as const) {
      assert.equal(isGranted("restricted", denied), false, `${denied} must not be portable-reachable`);
    }
    for (const allowed of ["conversation", "presence", "sync", "task_create", "notifications"] as const) {
      assert.equal(isGranted("restricted", allowed), true);
    }
  });

  await t.test("pending, unknown and revoked devices get nothing", () => {
    for (const trust of ["pending", "unknown", "revoked"] as const) {
      assert.deepEqual(grantedCapabilities(trust), []);
    }
  });

  await t.test("OS authority is never remote, even for a trusted device", () => {
    const full = manifest("dev_desktop", ["filesystem", "windows_control", "conversation"]);
    for (const capability of ["filesystem", "windows_control"] as const) {
      const decision = decideRemoteRequest({ trust: "trusted", capability, manifest: full });
      assert.equal(decision.allowed, false, `${capability} must never cross a device boundary`);
      assert.match(decision.reason, /stays on the machine that owns it/i);
    }
  });

  await t.test("a portable device cannot reach NEXUS even where NEXUS exists", () => {
    const desktop = manifest("dev_desktop", ["nexus", "conversation", "sync"]);
    const denied = decideRemoteRequest({ trust: "restricted", capability: "nexus", manifest: desktop });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /may not request 'nexus'/);

    // It can still converse, which is the point of the portable class.
    const allowed = decideRemoteRequest({ trust: "restricted", capability: "conversation", manifest: desktop });
    assert.equal(allowed.allowed, true);
    assert.match(allowed.reason, /permission gate still applies/i);
  });

  await t.test("a grant cannot exceed what the device actually has", () => {
    const bare = manifest("dev_laptop", ["conversation"]);
    const decision = decideRemoteRequest({ trust: "trusted", capability: "local_llm", manifest: bare });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /does not report 'local_llm'/);
  });

  await t.test("no capability name collides with a forbidden remote power", () => {
    assert.equal(grantsRespectForbiddenPowers(), true);
  });
});

test("portable session grants", async (t) => {
  async function world() {
    const desktop = await identity("desktop");
    const usb = await identity("usb", "laptop");
    const reg = new DeviceRegistry({
      storage: new MemoryStorage(),
      self: desktop.identity.publicIdentity(),
    });
    await reg.enrol(usb.identity.publicIdentity());
    await reg.setTrust(usb.identity.deviceId, "restricted");
    return { desktop, usb, reg, replay: new ReplayGuard() };
  }

  await t.test("a trusted device issues a scoped, short-lived grant", async () => {
    const { desktop, usb, reg, replay } = await world();
    const signed = issueSessionGrant({
      issuer: desktop.identity,
      deviceId: usb.identity.deviceId,
      scopes: ["conversation", "memory.read"],
    });
    const verdict = await verifySessionGrant({ signed, registry: reg, replay });
    assert.equal(verdict.ok, true, verdict.detail);
    assert.match(verdict.detail, /restricted device/);

    const life = Date.parse(signed.grant.expiresAt) - Date.parse(signed.grant.issuedAt);
    assert.equal(life, DEFAULT_GRANT_TTL_MS);
  });

  await t.test("an over-long request is clamped down, never up", async () => {
    const { desktop, usb } = await world();
    const signed = issueSessionGrant({
      issuer: desktop.identity,
      deviceId: usb.identity.deviceId,
      scopes: ["conversation"],
      ttlMs: 365 * 24 * 60 * 60_000,
    });
    const life = Date.parse(signed.grant.expiresAt) - Date.parse(signed.grant.issuedAt);
    assert.equal(life, MAX_GRANT_TTL_MS);
  });

  await t.test("an expired grant is refused", async () => {
    const { desktop, usb, reg, replay } = await world();
    const past = Date.now() - 60 * 60_000;
    const signed = issueSessionGrant({
      issuer: desktop.identity,
      deviceId: usb.identity.deviceId,
      scopes: ["conversation"],
      ttlMs: 1_000,
      now: () => past,
    });
    const verdict = await verifySessionGrant({ signed, registry: reg, replay });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "EXPIRED");
  });

  await t.test("a replayed grant is refused the second time", async () => {
    const { desktop, usb, reg, replay } = await world();
    const signed = issueSessionGrant({
      issuer: desktop.identity,
      deviceId: usb.identity.deviceId,
      scopes: ["conversation"],
    });
    assert.equal((await verifySessionGrant({ signed, registry: reg, replay })).ok, true);
    const second = await verifySessionGrant({ signed, registry: reg, replay });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "REPLAYED");
  });

  await t.test("a tampered grant fails signature verification", async () => {
    const { desktop, usb, reg, replay } = await world();
    const signed = issueSessionGrant({
      issuer: desktop.identity,
      deviceId: usb.identity.deviceId,
      scopes: ["conversation"],
    });
    // Widen the scopes after signing - the classic privilege-escalation attempt.
    const forged = {
      signature: signed.signature,
      grant: { ...signed.grant, scopes: [...signed.grant.scopes, "operator.confirm"] as never },
    };
    const verdict = await verifySessionGrant({ signed: forged, registry: reg, replay });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "BAD_SIGNATURE");
  });

  await t.test("revoking the device kills its live session immediately", async () => {
    const { desktop, usb, reg, replay } = await world();
    const signed = issueSessionGrant({
      issuer: desktop.identity,
      deviceId: usb.identity.deviceId,
      scopes: ["conversation"],
    });
    // The stick is lost. Revoke it while the grant is still well within its lifetime.
    await reg.setTrust(usb.identity.deviceId, "revoked");
    const verdict = await verifySessionGrant({ signed, registry: reg, replay });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "DEVICE_UNTRUSTED");
  });

  await t.test("a restricted device cannot mint grants for itself", async () => {
    const { usb, reg, replay } = await world();
    // The portable device signs its own grant, trying to bootstrap more authority.
    const selfIssued = issueSessionGrant({
      issuer: usb.identity,
      deviceId: usb.identity.deviceId,
      scopes: ["conversation", "operator.confirm"],
    });
    const verdict = await verifySessionGrant({ signed: selfIssued, registry: reg, replay });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "ISSUER_UNTRUSTED");
  });

  await t.test("a grant from an unenrolled issuer is refused", async () => {
    const { usb, reg, replay } = await world();
    const stranger = await identity("stranger");
    const signed = issueSessionGrant({
      issuer: stranger.identity,
      deviceId: usb.identity.deviceId,
      scopes: ["conversation"],
    });
    const verdict = await verifySessionGrant({ signed, registry: reg, replay });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "UNKNOWN_ISSUER");
  });

  await t.test("a scope the grant does not carry is denied", async () => {
    const { desktop, usb, reg, replay } = await world();
    const signed = issueSessionGrant({
      issuer: desktop.identity,
      deviceId: usb.identity.deviceId,
      scopes: ["conversation"],
    });
    const verdict = await verifySessionGrant({
      signed,
      registry: reg,
      replay,
      requiredScope: "operator.confirm",
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "SCOPE_DENIED");
  });

  await t.test("the replay guard stays bounded and expires entries", () => {
    const guard = new ReplayGuard(8);
    const now = 1_000;
    for (let i = 0; i < 50; i += 1) {
      guard.admit(`nonce-${i}`, now + 10_000, now);
    }
    assert.ok(guard.size <= 8, "an attacker cannot grow the guard without bound");
    // Once everything has expired, the guard drains.
    guard.admit("late", now + 60_000, now + 50_000);
    assert.ok(guard.size <= 8);
  });
});
