/**
 * Adversarial regression tests for the Phase 2 subsystems.
 *
 * Every case reproduces a finding from the phase-2 attack workflow
 * (wbv3m7ejv — 28 CONFIRMED / 2 PLAUSIBLE / 13 REFUTED across scheduler,
 * autonomy governor, checkpoint layer, and session capsule). If a defence is
 * removed, the named test fails.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "./storage.ts";
import { EventBus } from "./events.ts";
import { TaskQueue } from "./distributed/tasks.ts";
import { TaskExecutorRegistry, TaskScheduler } from "./task-scheduler.ts";
import {
  AutonomyGovernor,
  BudgetState,
  evaluateAutonomy,
  stricterAutonomy,
  validateAutonomyPolicy,
  type AutonomyLevel,
  type AutonomyPolicy,
} from "./autonomy.ts";
import { CheckpointStore, type Reverser } from "./checkpoint.ts";
import type { DeviceRecord } from "./distributed/registry.ts";
import type { CapabilityManifest } from "./distributed/capabilities.ts";
import type { PermissionDecision, ToolSpec } from "./types.ts";
import type { RequestOrigin } from "./tools/remote.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, loadDeviceIdentity } from "./distributed/identity.ts";
import type { DeviceIdentity } from "./distributed/identity.ts";
import { buildSessionCapsule, ingestCapsule, verifyCapsule } from "./session-capsule.ts";
import type { MemoryEntry } from "./types.ts";

async function makeCapsuleIdentity(name: string): Promise<DeviceIdentity> {
  const dirs = { data: await mkdtemp(join(tmpdir(), `vesper-p2atk-${name}-`)) };
  const { identity } = await loadDeviceIdentity({ dirs, name, deviceType: "desktop", vesperVersion: "test" });
  return identity;
}

function capsuleMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_k",
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

function silentLog() {
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  } as never;
  return log;
}

function device(input: {
  id: string;
  trust?: "trusted" | "restricted" | "revoked" | "pending" | "unknown";
  online?: boolean;
  capabilities?: string[];
}): DeviceRecord {
  const capabilities: CapabilityManifest | null = input.capabilities
    ? {
        deviceId: input.id,
        generatedAt: "2026-01-01T00:00:00Z",
        findings: input.capabilities.map((id) => ({
          id: id as never,
          state: "AVAILABLE" as const,
          detail: "test",
        })),
      }
    : null;
  return {
    identity: {
      deviceId: input.id,
      deviceType: "desktop",
      name: input.id,
      os: "linux",
      publicKey: "k",
      createdAt: "2026-01-01T00:00:00Z",
      vesperVersion: "test",
    },
    trust: input.trust ?? "trusted",
    capabilities,
    presence: {
      lastSeen: "2026-01-01T00:00:00Z",
      activity: input.online === false ? "unknown" : "active",
      reachability: input.online === false ? "offline" : "online",
    },
    enrolledAt: "2026-01-01T00:00:00Z",
    revokedAt: null,
  } as DeviceRecord;
}

function tool(name: string, permission: ToolSpec["permission"] = "safe"): ToolSpec {
  return { name, description: "t", permission, parameters: { type: "object", properties: {}, required: [] } };
}

function decision(overrides: Partial<PermissionDecision> = {}): PermissionDecision {
  return {
    allowed: true,
    level: "safe",
    requiresConfirmation: false,
    toolName: "t",
    reason: "allowed",
    ...overrides,
  };
}

const localOrigin: RequestOrigin = { kind: "local" };

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe("scheduler attack #1: assignment is not authority — trust is re-read at start", () => {
  async function setup(afterAssignTrust: Parameters<typeof device>[0]["trust"], opts: { capabilities?: string[]; online?: boolean } = {}) {
    const storage = new MemoryStorage();
    const events = new EventBus(silentLog());
    const queue = new TaskQueue({ storage });
    const registry = new TaskExecutorRegistry();
    let calls = 0;
    registry.register("noop", async () => {
      calls += 1;
      return { ok: true, summary: "ran" };
    });
    // Assign while fully authorized.
    let roster = [device({ id: "self", trust: "trusted", capabilities: ["task_execute", "local_llm"] })];
    const scheduler = new TaskScheduler({
      taskQueue: queue,
      registry,
      events,
      log: silentLog(),
      deviceId: "self",
      devices: async () => roster,
      enabled: true,
    });
    const created = await queue.create({
      description: "work",
      createdBy: "user",
      requiredCapabilities: ["local_llm"],
      kind: "noop",
    });
    await queue.schedule(roster);
    assert.equal((await queue.get(created.id))?.state, "assigned", "precondition: assigned while authorized");
    // Now degrade the device.
    roster = [device({
      id: "self",
      trust: afterAssignTrust,
      capabilities: opts.capabilities ?? ["task_execute", "local_llm"],
      online: opts.online,
    })];
    return { queue, scheduler, created, events, calls: () => calls };
  }

  it("refuses to execute after the device is revoked", async () => {
    const h = await setup("revoked");
    await h.scheduler.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls(), 0, "a revoked device must not execute an already-assigned task");
    const evts = h.events.recent({ type: "task.authorization_revoked", limit: 5 });
    assert.ok(evts.length >= 1, "the refusal must be visible as an event");
  });

  it("refuses to execute after the device loses the required capability", async () => {
    const h = await setup("trusted", { capabilities: ["task_execute"] });
    await h.scheduler.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls(), 0, "missing capability must block execution");
  });

  it("refuses to execute after the device goes offline", async () => {
    const h = await setup("trusted", { online: false });
    await h.scheduler.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls(), 0, "an offline device must not execute");
  });

  it("releases the assignment so the work can be re-routed elsewhere", async () => {
    const h = await setup("revoked");
    await h.scheduler.tick();
    await new Promise((r) => setImmediate(r));
    const task = await h.queue.get(h.created.id);
    assert.equal(task?.state, "queued", "an unauthorized assignment is released, not stranded");
    assert.equal(task?.assignedTo, null);
  });
});

describe("scheduler attack #2/#3: state guards stop cross-runtime double-execution", () => {
  it("two runtimes sharing storage cannot both drive the same task to done", async () => {
    const storage = new MemoryStorage();
    let calls = 0;
    const mk = () => {
      const queue = new TaskQueue({ storage });
      const registry = new TaskExecutorRegistry();
      registry.register("noop", async () => {
        calls += 1;
        return { ok: true, summary: `run-${calls}` };
      });
      return {
        queue,
        scheduler: new TaskScheduler({
          taskQueue: queue,
          registry,
          events: new EventBus(silentLog()),
          log: silentLog(),
          deviceId: "self",
          devices: async () => [device({ id: "self", capabilities: ["task_execute"] })],
          enabled: true,
        }),
      };
    };
    const a = mk();
    const b = mk();
    await a.queue.create({
      description: "exclusive",
      createdBy: "user",
      requiredCapabilities: ["task_execute"],
      kind: "noop",
    });
    await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
    await new Promise((r) => setTimeout(r, 40));
    // The executor may be entered at most once: start()'s source-state guard plus the
    // mutate() storage refresh means the second runtime sees `running`, not `assigned`.
    assert.equal(calls, 1, `executor ran ${calls} times across two runtimes; must be 1`);
  });

  it("start() refuses a task that is already done", async () => {
    const queue = new TaskQueue({ storage: new MemoryStorage() });
    const t = await queue.create({ description: "x", createdBy: "u", kind: "noop" });
    await queue.start(t.id);
    await queue.complete(t.id, "done");
    const restarted = await queue.start(t.id);
    assert.equal(restarted, undefined, "start() must refuse a terminal task");
    assert.equal((await queue.get(t.id))?.state, "done");
  });

  it("start() refuses a task that is already cancelled", async () => {
    const queue = new TaskQueue({ storage: new MemoryStorage() });
    const t = await queue.create({ description: "x", createdBy: "u", kind: "noop" });
    await queue.cancel(t.id);
    assert.equal(await queue.start(t.id), undefined, "a cancelled task must never restart");
    assert.equal((await queue.get(t.id))?.state, "cancelled");
  });

  it("complete() refuses to overwrite an already-committed result", async () => {
    const queue = new TaskQueue({ storage: new MemoryStorage() });
    const t = await queue.create({ description: "x", createdBy: "u", kind: "noop" });
    await queue.start(t.id);
    await queue.complete(t.id, "first");
    const second = await queue.complete(t.id, "second");
    assert.equal(second, undefined, "a second complete() must be refused");
    assert.equal((await queue.get(t.id))?.result, "first", "the first result stands");
  });

  it("fail() cannot un-cancel a cancelled task", async () => {
    const queue = new TaskQueue({ storage: new MemoryStorage() });
    const t = await queue.create({ description: "x", createdBy: "u", kind: "noop" });
    await queue.cancel(t.id);
    assert.equal(await queue.fail(t.id, "boom"), undefined);
    assert.equal((await queue.get(t.id))?.state, "cancelled");
  });
});

// ---------------------------------------------------------------------------
// Autonomy governor
// ---------------------------------------------------------------------------

describe("governor attack #9 (CRITICAL): unknown level strings cannot defeat tightening", () => {
  it("stricterAutonomy ranks an unknown level as OBSERVE-strict, so it never relaxes", () => {
    // The bug: LEVEL_RANK[unknown] was undefined, `0 < undefined` is false, so the
    // unknown level was returned whenever it appeared on the right — and any level
    // paired with it was discarded. The invariant that matters is that an unknown
    // level can never let a permissive level through.
    const unknown = "NOT_A_LEVEL" as AutonomyLevel;
    // Paired with the most permissive level, the unknown one wins (it ranks 0).
    assert.equal(stricterAutonomy(unknown, "FULL"), unknown);
    assert.equal(stricterAutonomy("FULL", unknown), unknown);
    // Paired with OBSERVE both rank 0 — either answer is equally strict, and neither
    // is permissive. What must NOT happen is a permissive level surviving.
    const withObserve = stricterAutonomy("OBSERVE", unknown);
    assert.ok(withObserve === "OBSERVE" || withObserve === unknown);
    assert.notEqual(stricterAutonomy(unknown, "AUTO_ADVANCED"), "AUTO_ADVANCED");
  });

  it("a policy with an unknown perTool level does not relax the default", () => {
    const policy: AutonomyPolicy = {
      default: "OBSERVE",
      perTool: { fs_write: "FULL_ADMIN" as AutonomyLevel },
    };
    const result = evaluateAutonomy(
      { tool: tool("fs_write"), args: {}, origin: localOrigin, workspaceId: "general", gateDecision: decision() },
      policy,
      new BudgetState(),
    );
    assert.equal(result.decision.allowed, false, "the OBSERVE default must still refuse");
  });

  it("an argument gate with an unknown tightenedTo cannot relax", () => {
    const policy: AutonomyPolicy = {
      default: "OBSERVE",
      argumentGates: [
        { toolPattern: /^fs_write$/, tightenedTo: "SUPER_FULL" as AutonomyLevel, when: () => true, reason: "x" },
      ],
    };
    const result = evaluateAutonomy(
      { tool: tool("fs_write"), args: {}, origin: localOrigin, workspaceId: "general", gateDecision: decision() },
      policy,
      new BudgetState(),
    );
    assert.equal(result.decision.allowed, false);
  });
});

describe("governor attack #10: setPolicy validates and announces", () => {
  it("rejects a policy carrying an invalid level", () => {
    const gov = new AutonomyGovernor({ policy: { default: "FULL" }, events: new EventBus(silentLog()), log: silentLog() });
    assert.throws(
      () => gov.setPolicy({ default: "NONSENSE" as AutonomyLevel }),
      /not a valid AutonomyLevel/,
    );
    assert.throws(
      () => gov.setPolicy({ default: "FULL", perTool: { fs_write: "WIDE_OPEN" as AutonomyLevel } }),
      /not a valid AutonomyLevel/,
    );
  });

  it("emits a durable autonomy.policy_changed event so a swap cannot be quiet", () => {
    const events = new EventBus(silentLog());
    const gov = new AutonomyGovernor({ policy: { default: "OBSERVE" }, events, log: silentLog() });
    gov.setPolicy({ default: "FULL" });
    const changed = events.recent({ type: "autonomy.policy_changed", limit: 5 });
    assert.equal(changed.length, 1, "a policy replacement must be announced");
    assert.equal(changed[0].retention, "durable");
    assert.equal(changed[0].severity, "warn");
  });

  it("validateAutonomyPolicy accepts a well-formed policy", () => {
    assert.doesNotThrow(() =>
      validateAutonomyPolicy({
        default: "AUTO_SAFE",
        perTool: { fs_read: "FULL" },
        perCategory: { "admin.": "PREPARE" },
        argumentGates: [{ toolPattern: /x/, tightenedTo: "PREPARE", when: () => false, reason: "r" }],
      }),
    );
  });
});

describe("governor attack #11: prototype pollution cannot reach perTool lookups", () => {
  it("a polluted Object.prototype key is ignored by the perTool lookup", () => {
    // A bracket lookup on a plain object walks the prototype chain — a classic
    // pollution sink. Object.hasOwn is the fix.
    const polluted = "fs_write_polluted_probe";
    try {
      (Object.prototype as unknown as Record<string, string>)[polluted] = "FULL";
      const policy: AutonomyPolicy = { default: "OBSERVE", perTool: {} };
      const result = evaluateAutonomy(
        { tool: tool(polluted), args: {}, origin: localOrigin, workspaceId: "general", gateDecision: decision() },
        policy,
        new BudgetState(),
      );
      assert.equal(result.decision.allowed, false, "prototype-provided level must not relax the OBSERVE default");
      assert.equal(result.level, "OBSERVE");
    } finally {
      delete (Object.prototype as unknown as Record<string, string>)[polluted];
    }
  });
});

describe("governor attack #12: observeNoop cannot flood the audit trail", () => {
  it("rate-limits to 30 no-ops per rolling minute", () => {
    const events = new EventBus(silentLog());
    let now = 1_000_000;
    const gov = new AutonomyGovernor({
      policy: { default: "FULL" },
      events,
      log: silentLog(),
      now: () => now,
    });
    for (let i = 0; i < 100; i++) {
      gov.observeNoop({ action: `a${i}`, reason: "r" });
    }
    const emitted = events.recent({ type: "autonomy.no_action", limit: 200 });
    assert.ok(emitted.length <= 30, `expected at most 30 emitted, got ${emitted.length}`);
  });

  it("truncates hostile action/reason strings", () => {
    const events = new EventBus(silentLog());
    const gov = new AutonomyGovernor({ policy: { default: "FULL" }, events, log: silentLog() });
    gov.observeNoop({ action: "x".repeat(5000), reason: "y".repeat(50_000) });
    const e = events.recent({ type: "autonomy.no_action", limit: 1 })[0];
    assert.ok(e.title.length < 500, `title should be bounded, got ${e.title.length}`);
    assert.ok((e.detail ?? "").length <= 1000, `detail should be bounded, got ${(e.detail ?? "").length}`);
  });
});

describe("governor attack #14: the tool's own 'never' beats a mismatched gate decision", () => {
  it("refuses when the tool declares never even if the caller passes a permissive gate decision", () => {
    const result = evaluateAutonomy(
      {
        tool: tool("disk_wipe", "never"),
        args: {},
        origin: localOrigin,
        workspaceId: "general",
        // A caller (or a bug) hands in a gate decision that says "allowed at safe".
        gateDecision: decision({ level: "safe", allowed: true }),
      },
      { default: "FULL" },
      new BudgetState(),
    );
    assert.equal(result.decision.allowed, false, "the tool's own never-tier must win");
    assert.equal(result.decision.level, "never");
  });
});

describe("governor attack #16: a gate-required confirmation is never cleared", () => {
  it("an OBSERVE refusal preserves requiresConfirmation:true from the gate", () => {
    const result = evaluateAutonomy(
      {
        tool: tool("app_close"),
        args: {},
        origin: localOrigin,
        workspaceId: "general",
        // Pathological but reachable: allowed AND requiresConfirmation both true.
        gateDecision: decision({ allowed: true, requiresConfirmation: true }),
      },
      { default: "OBSERVE" },
      new BudgetState(),
    );
    assert.equal(result.decision.allowed, false);
    assert.equal(result.decision.requiresConfirmation, true, "the governor must not clear a required confirmation");
  });
});

describe("governor attack #17: a null origin does not lose the audit event", () => {
  it("emits the decision event even when origin is undefined", () => {
    const events = new EventBus(silentLog());
    const gov = new AutonomyGovernor({ policy: { default: "FULL" }, events, log: silentLog() });
    gov.evaluate({
      tool: tool("fs_read", "read"),
      args: {},
      origin: undefined as unknown as RequestOrigin,
      workspaceId: "general",
      gateDecision: decision({ level: "read" }),
    });
    const found = events.recent({ type: "autonomy.decision", limit: 5 });
    assert.equal(found.length, 1, "the audit event must survive a null origin");
    assert.equal(found[0].data?.originKind, "unknown");
  });
});

// ---------------------------------------------------------------------------
// Checkpoint / rollback
// ---------------------------------------------------------------------------

class CountingReverser implements Reverser {
  restoreCalls = 0;
  verifyReturns = true;
  async verify(): Promise<boolean> {
    return this.verifyReturns;
  }
  async restore(): Promise<void> {
    this.restoreCalls += 1;
    // Simulate a non-instant restore so a concurrent caller has a window.
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("checkpoint attack #21: concurrent load does not lose records", () => {
  it("two concurrent snapshots on a fresh store both persist", async () => {
    const storage = new MemoryStorage();
    // Pre-existing record so load() has work to do.
    const seed = new CheckpointStore({ storage, log: silentLog() });
    await seed.snapshot({ tool: "memory_remember", target: "seeded", before: null, absentBefore: true });
    await seed.flush();

    const store = new CheckpointStore({ storage, log: silentLog() });
    await Promise.all([
      store.snapshot({ tool: "memory_remember", target: "a", before: null, absentBefore: true }),
      store.snapshot({ tool: "memory_remember", target: "b", before: null, absentBefore: true }),
    ]);
    await store.flush();
    const list = await store.list({ limit: 50 });
    const targets = list.map((r) => r.target).sort();
    assert.deepEqual(targets, ["a", "b", "seeded"], `concurrent snapshots lost a record: ${targets}`);
  });
});

describe("checkpoint attack #22: concurrent rollback runs the reverser once", () => {
  it("two concurrent rollback(id) calls invoke restore exactly once", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    const reverser = new CountingReverser();
    store.registerReverser("memory_remember", reverser);
    const rec = await store.snapshot({ tool: "memory_remember", target: "x", before: null, absentBefore: true });
    const [a, b] = await Promise.all([store.rollback(rec.id), store.rollback(rec.id)]);
    assert.equal(reverser.restoreCalls, 1, `restore ran ${reverser.restoreCalls} times; must be 1`);
    const applied = [a, b].filter((r) => r.applied).length;
    assert.equal(applied, 1, "exactly one caller may report success");
  });
});

describe("checkpoint attack #20: an un-verified checkpoint refuses rollback", () => {
  it("a checkpoint with no recorded post-image is refused, not silently applied", async () => {
    // The reverser used here mirrors the runtime's: absent `after` means we cannot
    // know whether state drifted, and the safe reading of unknown is REFUSE.
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    store.registerReverser("memory_remember", {
      async verify(record) {
        return record.after !== undefined;
      },
      async restore() {
        throw new Error("must not be reached");
      },
    });
    const rec = await store.snapshot({ tool: "memory_remember", target: "x", before: { value: "old" } });
    // No verify() call — simulates a crash between snapshot and verify.
    const result = await store.rollback(rec.id);
    assert.equal(result.applied, false, "an un-verified checkpoint must refuse");
    assert.match((result as { reason: string }).reason, /drift/i);
  });
});

describe("checkpoint attack #24: hostile TTL and timestamps are clamped on load", () => {
  it("a persisted ttlMs of 9e15 is clamped so the record still expires", async () => {
    const storage = new MemoryStorage();
    await storage.set("rollback.checkpoints", [
      {
        id: "chk_hostile",
        tool: "memory_remember",
        target: "x",
        before: null,
        absentBefore: true,
        at: "2020-01-01T00:00:00Z",
        ttlMs: 9e15,
      },
    ]);
    const store = new CheckpointStore({
      storage,
      log: silentLog(),
      now: () => new Date("2026-06-15T00:00:00Z"),
    });
    const listed = await store.list({ includeRolledBack: true });
    assert.equal(listed.length, 0, "an immortal-TTL record must still expire out of the listing");
  });

  it("a far-future persisted `at` is clamped to now", async () => {
    const storage = new MemoryStorage();
    await storage.set("rollback.checkpoints", [
      {
        id: "chk_future",
        tool: "memory_remember",
        target: "x",
        before: null,
        absentBefore: true,
        at: "9999-12-31T00:00:00Z",
        ttlMs: 60_000,
      },
    ]);
    const store = new CheckpointStore({
      storage,
      log: silentLog(),
      now: () => new Date("2026-06-15T00:00:00Z"),
    });
    const listed = await store.list();
    assert.equal(listed.length, 1, "the record loads");
    assert.ok(listed[0].at.startsWith("2026-"), `at should be clamped to now, got ${listed[0].at}`);
  });
});

// ---------------------------------------------------------------------------
// Session capsule
//
// NOTE ON PROVENANCE: the attack workflow's verifier agents "REFUTED" all 12
// capsule findings on the grounds that session-capsule.ts does not exist. They
// were reading the wrong repository — the session cwd is an empty scaffold, and
// the real tree is elsewhere. Every finding below was re-verified by hand
// against the actual module before being fixed. A refutation is only as good as
// the directory it was run in.
// ---------------------------------------------------------------------------

describe("capsule attack (CRITICAL): a device is a key, not a label", () => {
  it("refuses a capsule whose sender.deviceId names a device the embedded key does not own", async () => {
    // Mallory generates her own keypair, writes Alice's deviceId into the sender,
    // and signs with her own key. Verifying against the EMBEDDED key would accept
    // this — the receiver must verify against the key it has registered for that id.
    const [alice, mallory, receiver] = await Promise.all([
      makeCapsuleIdentity("alice"),
      makeCapsuleIdentity("mallory"),
      makeCapsuleIdentity("receiver"),
    ]);
    const base = buildSessionCapsule({
      sender: mallory,
      sessionId: "s", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "t", activeWorkspace: "general",
      memory: [], tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    const spoofed = { ...base, sender: { ...base.sender, deviceId: alice.deviceId } };
    const { signature: _drop, ...rest } = spoofed;
    const resigned = { ...spoofed, signature: mallory.sign(canonicalJson(rest as never)) };

    // Verifying against ALICE's registered key must fail — the capsule carries
    // Mallory's key.
    const verify = verifyCapsule(resigned, alice.publicIdentity().publicKey);
    assert.equal(verify.ok, false, "impersonation must not verify");
    assert.match(verify.reason ?? "", /does not match the registered key/);

    let merged = 0;
    const result = await ingestCapsule(resigned, {
      self: receiver.publicIdentity(),
      trustOf: async (id) => (id === alice.deviceId ? "trusted" : null),
      publicKeyOf: async (id) => (id === alice.deviceId ? alice.publicIdentity().publicKey : null),
      onPreference: async () => { merged += 1; },
    });
    assert.equal(result.accepted, false, "the spoofed capsule must be refused at ingest");
    assert.equal(merged, 0);
  });
});

describe("capsule attack: replay of a signed capsule is refused", () => {
  it("a second ingest of the same capsule is refused when a seen-set is wired", async () => {
    const [alice, receiver] = await Promise.all([
      makeCapsuleIdentity("alice"),
      makeCapsuleIdentity("receiver"),
    ]);
    const capsule = buildSessionCapsule({
      sender: alice,
      sessionId: "s", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "t", activeWorkspace: "general",
      memory: [capsuleMemoryEntry({ key: "coffee", value: "espresso" })],
      tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    const seen = new Set<string>();
    let merged = 0;
    const opts = {
      self: receiver.publicIdentity(),
      trustOf: async () => "trusted" as const,
      publicKeyOf: async () => alice.publicIdentity().publicKey,
      seenBefore: async (id: string) => seen.has(id),
      markSeen: async (id: string) => { seen.add(id); },
      onPreference: async () => { merged += 1; },
    };
    const first = await ingestCapsule(capsule, opts);
    assert.equal(first.accepted, true);
    assert.equal(merged, 1);

    const second = await ingestCapsule(capsule, opts);
    assert.equal(second.accepted, false, "a replayed capsule must be refused");
    assert.match(second.reason ?? "", /replay/i);
    assert.equal(merged, 1, "the replay must not re-apply the payload");
  });
});

describe("capsule attack: secrets cannot ride in decisions or observations", () => {
  it("refuses a decision whose detail or data looks like a credential", async () => {
    const [alice, receiver] = await Promise.all([
      makeCapsuleIdentity("alice"),
      makeCapsuleIdentity("receiver"),
    ]);
    const capsule = buildSessionCapsule({
      sender: alice,
      sessionId: "s", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "t", activeWorkspace: "general",
      memory: [], tasks: [],
      decisions: [
        { id: "e1", type: "autonomy.decision", title: "clean", at: "2026-01-01T00:00:00Z", severity: "info" } as never,
        { id: "e2", type: "autonomy.decision", title: "leak", detail: "token sk-live-abcdefghij0123456789", at: "2026-01-01T00:00:00Z", severity: "info" } as never,
      ],
      observations: [
        { id: "e3", type: "note", title: "password=hunter2XXXXXXXXXX", at: "2026-01-01T00:00:00Z", severity: "info" } as never,
      ],
      pending: { tasks: 0, confirmations: 0 },
    });
    const decisionsSeen: string[] = [];
    const observationsSeen: string[] = [];
    const result = await ingestCapsule(capsule, {
      self: receiver.publicIdentity(),
      trustOf: async () => "trusted",
      publicKeyOf: async () => alice.publicIdentity().publicKey,
      onPreference: async () => {},
      onDecision: async (e) => { decisionsSeen.push(e.title); },
      onObservation: async (e) => { observationsSeen.push(e.title); },
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(decisionsSeen, ["clean"], "the credential-bearing decision must be refused");
    assert.equal(observationsSeen.length, 0, "the credential-bearing observation must be refused");
    assert.equal(result.partial, true, "a partial merge must be reported as partial");
  });
});

describe("capsule attack: a restricted sender cannot smuggle via decisions", () => {
  it("declines decisions and observations from a restricted sender, not just preferences", async () => {
    const [alice, receiver] = await Promise.all([
      makeCapsuleIdentity("alice"),
      makeCapsuleIdentity("receiver"),
    ]);
    const capsule = buildSessionCapsule({
      sender: alice,
      sessionId: "s", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "t", activeWorkspace: "general",
      memory: [], tasks: [],
      decisions: [{ id: "e1", type: "preference.set", title: "set coffee to decaf", at: "2026-01-01T00:00:00Z", severity: "info" } as never],
      observations: [{ id: "e2", type: "note", title: "note", at: "2026-01-01T00:00:00Z", severity: "info" } as never],
      pending: { tasks: 0, confirmations: 0 },
    });
    let decisions = 0;
    let observations = 0;
    const result = await ingestCapsule(capsule, {
      self: receiver.publicIdentity(),
      trustOf: async () => "restricted",
      publicKeyOf: async () => alice.publicIdentity().publicKey,
      onPreference: async () => {},
      onDecision: async () => { decisions += 1; },
      onObservation: async () => { observations += 1; },
    });
    assert.equal(result.accepted, true);
    assert.equal(decisions, 0, "a restricted sender's decisions must be declined");
    assert.equal(observations, 0, "a restricted sender's observations must be declined");
    assert.ok(result.refusedFor?.some((r) => r.includes("restricted")));
  });
});

describe("capsule attack: schema and size bounds", () => {
  it("refuses an unknown top-level field even when correctly signed", async () => {
    const alice = await makeCapsuleIdentity("alice");
    const base = buildSessionCapsule({
      sender: alice,
      sessionId: "s", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "t", activeWorkspace: "general",
      memory: [], tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    const smuggled = { ...base, exfil: { note: "extra" } };
    const { signature: _d, ...rest } = smuggled;
    const resigned = { ...smuggled, signature: alice.sign(canonicalJson(rest as never)) };
    const verify = verifyCapsule(resigned as never, alice.publicIdentity().publicKey);
    assert.equal(verify.ok, false, "an unknown top-level field must be refused");
    assert.match(verify.reason ?? "", /unknown top-level field/);
  });

  it("refuses a capsule whose collections exceed the receiver's caps", async () => {
    const alice = await makeCapsuleIdentity("alice");
    const base = buildSessionCapsule({
      sender: alice,
      sessionId: "s", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "t", activeWorkspace: "general",
      memory: [], tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    const flood = {
      ...base,
      observations: Array.from({ length: 5000 }, (_, i) => ({
        at: "2026-01-01T00:00:00Z", type: "n", title: `o${i}`,
      })),
    };
    const { signature: _d, ...rest } = flood;
    const resigned = { ...flood, signature: alice.sign(canonicalJson(rest as never)) };
    const verify = verifyCapsule(resigned as never, alice.publicIdentity().publicKey);
    assert.equal(verify.ok, false, "an oversized collection must be refused");
    assert.match(verify.reason ?? "", /cap is/);
  });
});

describe("capsule attack: a partly-failed merge is not reported as complete", () => {
  it("sets partial:true when a handler throws", async () => {
    const [alice, receiver] = await Promise.all([
      makeCapsuleIdentity("alice"),
      makeCapsuleIdentity("receiver"),
    ]);
    const capsule = buildSessionCapsule({
      sender: alice,
      sessionId: "s", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-02T00:00:00Z",
      vesperVersion: "t", activeWorkspace: "general",
      memory: [
        capsuleMemoryEntry({ id: "m1", key: "coffee", value: "espresso" }),
        capsuleMemoryEntry({ id: "m2", key: "language", value: "typescript" }),
      ],
      tasks: [], decisions: [], observations: [],
      pending: { tasks: 0, confirmations: 0 },
    });
    const result = await ingestCapsule(capsule, {
      self: receiver.publicIdentity(),
      trustOf: async () => "trusted",
      publicKeyOf: async () => alice.publicIdentity().publicKey,
      onPreference: async (entry) => {
        if (entry.key === "language") throw new Error("disk full");
      },
    });
    assert.equal(result.accepted, true, "the capsule itself was admissible");
    assert.equal(result.partial, true, "but the merge only partly landed");
    assert.equal(result.ingested.preferences, 1);
    assert.ok(result.refusedFor?.some((r) => r.includes("language")));
  });
});

// ---------------------------------------------------------------------------
// Second-pass fixes: findings #4, #5, #7, #13, #27
// ---------------------------------------------------------------------------

describe("governor attack #13: a forged autonomy.decision is distinguishable", () => {
  it("isAuthentic() rejects an event another emitter placed on the bus", () => {
    const events = new EventBus(silentLog());
    const gov = new AutonomyGovernor({ policy: { default: "FULL" }, events, log: silentLog() });
    gov.evaluate({
      tool: tool("fs_read", "read"),
      args: {},
      origin: localOrigin,
      workspaceId: "general",
      gateDecision: decision({ level: "read" }),
    });
    const genuine = events.recent({ type: "autonomy.decision", limit: 1 })[0];
    assert.ok(gov.isAuthentic(genuine), "the governor's own record must verify");

    // A forger emits a look-alike, copying every visible field including provenance.
    events.emit({
      type: "autonomy.decision",
      title: "fs_write → allowed [FULL]",
      severity: "info",
      retention: "durable",
      provenance: { author: "subsystem", source: "autonomy-governor" },
      data: { tool: "fs_write", governorAllowed: true, governorLevel: "FULL" } as never,
    });
    const forged = events.recent({ type: "autonomy.decision", limit: 1 })[0];
    assert.equal(gov.isAuthentic(forged), false, "a forged record must not verify");
  });
});

describe("scheduler attack #4/#5: a result is only written for a task still ours and still running", () => {
  it("does not un-cancel a task cancelled while the executor was running", async () => {
    const storage = new MemoryStorage();
    const queue = new TaskQueue({ storage });
    const registry = new TaskExecutorRegistry();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    registry.register("noop", async () => {
      await held;
      return { ok: true, summary: "finished anyway" };
    });
    const scheduler = new TaskScheduler({
      taskQueue: queue,
      registry,
      events: new EventBus(silentLog()),
      log: silentLog(),
      deviceId: "self",
      devices: async () => [device({ id: "self", capabilities: ["task_execute"] })],
      enabled: true,
    });
    const t = await queue.create({
      description: "long", createdBy: "u",
      requiredCapabilities: ["task_execute"], kind: "noop",
    });
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 20));
    // Cancel mid-flight, then let the executor finish.
    await queue.cancel(t.id);
    release();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await queue.get(t.id))?.state, "cancelled", "a completed executor must not un-cancel");
  });
});

describe("scheduler attack #7: the retry budget is bounded from both ends", () => {
  it("start() refuses once attempts have reached maxAttempts, even without a fail()", async () => {
    // A hard crash between start() and fail() bumps attempts without reaching the cap
    // check in fail(), so a crash loop would restart forever.
    // The realistic crash loop: start() bumps attempts, the process dies before
    // fail() runs, and the next process's load() requeues the mid-flight task.
    // Repeat. Without a cap in start(), that loop never terminates.
    const storage = new MemoryStorage();
    const t = await new TaskQueue({ storage }).create({
      description: "crashy", createdBy: "u", kind: "noop", maxAttempts: 2,
    });
    // Each "process" is a fresh queue over the same storage — load() requeues the
    // task it finds in `running`, exactly as a crash-restart would.
    assert.ok(await new TaskQueue({ storage }).start(t.id), "attempt 1");
    assert.ok(await new TaskQueue({ storage }).start(t.id), "attempt 2");
    const third = await new TaskQueue({ storage }).start(t.id);
    assert.equal(third, undefined, "the third start must be refused — the budget is spent");
    assert.equal(
      (await new TaskQueue({ storage }).get(t.id))?.state,
      "failed",
      "the task lands in failed, not an endless crash loop",
    );
  });
});

describe("checkpoint attack #27: rollback does not destroy a re-created memory", () => {
  it("drift detection anchors on entry identity, not value equality", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    let forgotten = 0;
    store.registerReverser("memory_remember", {
      async verify(record) {
        const after = record.after as { id?: string } | undefined;
        if (!after?.id) return false;
        // Stand in for the runtime reverser: the CURRENT entry has a different id,
        // because the user forgot and re-created it with the same text.
        const currentId = "mem_recreated";
        return currentId === after.id;
      },
      async restore() { forgotten += 1; },
    });
    const rec = await store.snapshot({
      tool: "memory_remember", target: "coffee", before: null, absentBefore: true,
    });
    await store.verify(rec.id, { id: "mem_original", value: "espresso" });
    const result = await store.rollback(rec.id);
    assert.equal(result.applied, false, "a re-created entry must not be destroyed by rollback");
    assert.equal(forgotten, 0);
  });
});
