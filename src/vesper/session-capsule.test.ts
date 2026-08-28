import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeviceIdentity } from "./distributed/identity.ts";
import type { DeviceIdentity } from "./distributed/identity.ts";
import {
  buildSessionCapsule,
  decodeCapsule,
  encodeCapsule,
  ingestCapsule,
  saferTrustWins,
  verifyCapsule,
  type CapsuleMemoryEntry,
} from "./session-capsule.ts";
import type { MemoryEntry, VesperEvent } from "./types.ts";
import type { VesperTask } from "./distributed/tasks.ts";

async function makeIdentity(name: string): Promise<DeviceIdentity> {
  const dirs = { data: await mkdtemp(join(tmpdir(), `vesper-capsule-${name}-`)) };
  const { identity } = await loadDeviceIdentity({
    dirs,
    name,
    deviceType: "desktop",
    vesperVersion: "test",
  });
  return identity;
}

function memoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `mem_${overrides.key ?? "k"}`,
    category: "preference",
    key: "coffee",
    value: "espresso",
    workspaceId: "general",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    source: "user",
    scope: "user",
    revision: 1,
    ...overrides,
  };
}

function task(overrides: Partial<VesperTask> = {}): VesperTask {
  return {
    id: "task_1",
    description: "reminder",
    state: "queued",
    priority: "normal",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: "self",
    requiredCapabilities: [],
    dependsOn: [],
    assignedTo: null,
    result: null,
    error: null,
    retry: { maxAttempts: 3, attempts: 0 },
    private: true,
    ...overrides,
  };
}

function evt(overrides: Partial<VesperEvent> = {}): VesperEvent {
  return {
    id: `evt_${overrides.type ?? "x"}`,
    type: "autonomy.decision",
    title: "test",
    at: "2026-01-01T00:00:00Z",
    severity: "info",
    ...overrides,
  };
}

describe("buildSessionCapsule + verifyCapsule", () => {
  it("produces a capsule whose signature verifies", async () => {
    const identity = await makeIdentity("alice");
    const capsule = buildSessionCapsule({
      sender: identity,
      sessionId: "sess-1",
      windowStart: "2026-01-01T00:00:00Z",
      windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test",
      activeWorkspace: "general",
      memory: [memoryEntry()],
      tasks: [task()],
      decisions: [evt()],
      observations: [evt({ type: "workspace.switch", title: "Workspace Gaming" })],
      pending: { tasks: 1, confirmations: 0 },
      now: () => new Date("2026-01-02T00:00:00Z"),
    });
    assert.ok(capsule.signature.length > 0);
    const verify = verifyCapsule(capsule);
    assert.ok(verify.ok, `verify failed: ${verify.reason}`);
  });

  it("filters credentials out of preferences even if the caller includes them", async () => {
    // The mission's "credential filter by name AND value" — a secret in either the key
    // or the value must be elided at capsule build. This is the "no exfiltration by
    // capsule" invariant.
    const identity = await makeIdentity("alice");
    const capsule = buildSessionCapsule({
      sender: identity,
      sessionId: "sess-1",
      windowStart: "2026-01-01T00:00:00Z",
      windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test",
      activeWorkspace: "general",
      memory: [
        memoryEntry({ key: "coffee", value: "espresso" }),
        memoryEntry({ id: "mem_secret1", key: "api_key", value: "sk-live-abc-def" }),
        memoryEntry({ id: "mem_secret2", key: "any_name", value: "sk-live-should-be-caught" }),
      ],
      tasks: [],
      decisions: [],
      observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    const keys = capsule.preferences.map((p) => p.key);
    assert.ok(keys.includes("coffee"));
    assert.ok(!keys.includes("api_key"), "credential by name must be filtered out");
    assert.ok(!keys.includes("any_name"), "credential by value pattern must be filtered out");
  });

  it("a tampered capsule fails verification", async () => {
    const identity = await makeIdentity("alice");
    const capsule = buildSessionCapsule({
      sender: identity,
      sessionId: "sess",
      windowStart: "2026-01-01T00:00:00Z",
      windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test",
      activeWorkspace: "general",
      memory: [memoryEntry()],
      tasks: [],
      decisions: [],
      observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    // Tamper: change the active workspace after signing.
    const tampered = { ...capsule, activeWorkspace: "attacker-controlled" };
    const verify = verifyCapsule(tampered);
    assert.equal(verify.ok, false, "a tampered capsule must not verify");
    assert.match(verify.reason ?? "", /signature/);
  });

  it("a capsule with a mismatched sender.publicKey fails verification", async () => {
    const [alice, bob] = await Promise.all([makeIdentity("a"), makeIdentity("b")]);
    const capsule = buildSessionCapsule({
      sender: alice,
      sessionId: "sess",
      windowStart: "2026-01-01T00:00:00Z",
      windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test",
      activeWorkspace: "general",
      memory: [],
      tasks: [],
      decisions: [],
      observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    // Swap alice's sender for bob's public identity — signature is still alice's, so
    // verification with bob's key fails.
    const swapped = { ...capsule, sender: bob.publicIdentity() };
    assert.equal(verifyCapsule(swapped).ok, false);
  });

  it("encodeCapsule/decodeCapsule round-trips a valid capsule", async () => {
    const identity = await makeIdentity("a");
    const capsule = buildSessionCapsule({
      sender: identity,
      sessionId: "sess",
      windowStart: "2026-01-01T00:00:00Z",
      windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test",
      activeWorkspace: "general",
      memory: [memoryEntry()],
      tasks: [task()],
      decisions: [evt()],
      observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    const encoded = encodeCapsule(capsule);
    const decoded = decodeCapsule(encoded);
    assert.ok(decoded);
    // Strict deep-equal would fail because JSON.stringify drops `undefined` fields.
    // The semantic contract: what was signed still verifies, and the observable fields
    // round-trip.
    assert.ok(verifyCapsule(decoded!).ok);
    assert.equal(decoded!.sessionId, capsule.sessionId);
    assert.equal(decoded!.activeWorkspace, capsule.activeWorkspace);
    assert.equal(decoded!.preferences.length, capsule.preferences.length);
    assert.equal(decoded!.tasks.length, capsule.tasks.length);
    assert.equal(decoded!.signature, capsule.signature);
  });

  it("decodeCapsule refuses a non-capsule payload", () => {
    assert.equal(decodeCapsule("not json"), null);
    assert.equal(decodeCapsule('{"just":"random"}'), null);
    assert.equal(decodeCapsule('{"version":99,"sender":{},"signature":"s"}'), null);
  });
});

describe("ingestCapsule — deterministic, restrictive merge", () => {
  it("refuses a capsule from an unknown sender", async () => {
    const [alice, self] = await Promise.all([makeIdentity("a"), makeIdentity("s")]);
    const capsule = buildSessionCapsule({
      sender: alice,
      sessionId: "sess", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test", activeWorkspace: "general",
      memory: [memoryEntry()], tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    let called = 0;
    const result = await ingestCapsule(capsule, {
      self: self.publicIdentity(),
      trustOf: async () => null, // unknown
      onPreference: async () => { called += 1; },
    });
    assert.equal(result.accepted, false);
    assert.match(result.reason ?? "", /not enrolled/);
    assert.equal(called, 0, "onPreference must not be called");
  });

  it("refuses a capsule from a revoked sender", async () => {
    const [alice, self] = await Promise.all([makeIdentity("a"), makeIdentity("s")]);
    const capsule = buildSessionCapsule({
      sender: alice,
      sessionId: "sess", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test", activeWorkspace: "general",
      memory: [memoryEntry()], tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    const result = await ingestCapsule(capsule, {
      self: self.publicIdentity(),
      trustOf: async () => "revoked",
      onPreference: async () => {},
    });
    assert.equal(result.accepted, false);
    assert.match(result.reason ?? "", /revoked/);
  });

  it("refuses a capsule signed by this same device (no self-ingest)", async () => {
    const identity = await makeIdentity("self");
    const capsule = buildSessionCapsule({
      sender: identity,
      sessionId: "sess", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test", activeWorkspace: "general",
      memory: [memoryEntry()], tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    const result = await ingestCapsule(capsule, {
      self: identity.publicIdentity(),
      trustOf: async () => "trusted",
      onPreference: async () => { throw new Error("should never be called"); },
    });
    assert.equal(result.accepted, false);
    assert.match(result.reason ?? "", /self-ingest/);
  });

  it("merges preferences from a trusted sender via onPreference", async () => {
    const [alice, self] = await Promise.all([makeIdentity("a"), makeIdentity("s")]);
    const capsule = buildSessionCapsule({
      sender: alice,
      sessionId: "sess", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test", activeWorkspace: "general",
      memory: [
        memoryEntry({ id: "m1", key: "coffee", value: "espresso" }),
        memoryEntry({ id: "m2", key: "language", value: "typescript" }),
      ],
      tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    const seen: CapsuleMemoryEntry[] = [];
    const result = await ingestCapsule(capsule, {
      self: self.publicIdentity(),
      trustOf: async () => "trusted",
      onPreference: async (entry) => { seen.push(entry); },
    });
    assert.equal(result.accepted, true);
    assert.equal(result.ingested.preferences, 2);
    assert.deepEqual(seen.map((s) => s.key).sort(), ["coffee", "language"]);
  });

  it("declines preferences from a restricted sender — informational only", async () => {
    const [alice, self] = await Promise.all([makeIdentity("a"), makeIdentity("s")]);
    const capsule = buildSessionCapsule({
      sender: alice,
      sessionId: "sess", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test", activeWorkspace: "general",
      memory: [memoryEntry({ key: "coffee", value: "espresso" })],
      tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    let calls = 0;
    const result = await ingestCapsule(capsule, {
      self: self.publicIdentity(),
      trustOf: async () => "restricted",
      onPreference: async () => { calls += 1; },
    });
    assert.equal(result.accepted, true, "capsule is accepted");
    assert.equal(result.ingested.preferences, 0, "no preferences merged from a restricted sender");
    assert.equal(calls, 0);
    assert.ok(result.refusedFor?.some((r) => r.includes("restricted")));
  });

  it("device-scoped facts from another device are not merged", async () => {
    // The mission rule: a fact about the sender's machine has no meaning on ours.
    const [alice, self] = await Promise.all([makeIdentity("a"), makeIdentity("s")]);
    const capsule = buildSessionCapsule({
      sender: alice,
      sessionId: "sess", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test", activeWorkspace: "general",
      memory: [
        // A device-scoped fact whose originDeviceId is NOT the sender.
        memoryEntry({ id: "m1", key: "gpu_serial", value: "abc", deviceId: "other-device" }),
      ],
      tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    let calls = 0;
    const result = await ingestCapsule(capsule, {
      self: self.publicIdentity(),
      trustOf: async () => "trusted",
      onPreference: async () => { calls += 1; },
    });
    assert.equal(result.accepted, true);
    assert.equal(calls, 0, "device-scoped mismatch must not reach onPreference");
    assert.ok(result.refusedFor?.some((r) => r.includes("device-scoped")));
  });

  it("a tampered capsule is refused at ingest even from a trusted sender", async () => {
    const [alice, self] = await Promise.all([makeIdentity("a"), makeIdentity("s")]);
    const capsule = buildSessionCapsule({
      sender: alice,
      sessionId: "sess", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "test", activeWorkspace: "general",
      memory: [memoryEntry()], tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    const tampered = { ...capsule, activeWorkspace: "attacker-picked" };
    let calls = 0;
    const result = await ingestCapsule(tampered, {
      self: self.publicIdentity(),
      trustOf: async () => "trusted",
      onPreference: async () => { calls += 1; },
    });
    assert.equal(result.accepted, false);
    assert.equal(calls, 0);
  });
});

describe("saferTrustWins", () => {
  it("always picks the more restrictive trust level", () => {
    assert.equal(saferTrustWins("trusted", "restricted"), "restricted");
    assert.equal(saferTrustWins("restricted", "trusted"), "restricted");
    assert.equal(saferTrustWins("revoked", "trusted"), "revoked", "revoked is absorbing");
    assert.equal(saferTrustWins("unknown", "pending"), "unknown");
    assert.equal(saferTrustWins("trusted", "trusted"), "trusted");
  });
});
