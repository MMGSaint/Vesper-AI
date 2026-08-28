import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "./storage.ts";
import { EventBus } from "./events.ts";
import { CheckpointStore, type Reverser } from "./checkpoint.ts";

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

class FakeReverser implements Reverser {
  verifyReturns = true;
  verifyThrows = false;
  restoreThrows = false;
  restoreCalls = 0;
  verifyCalls = 0;

  async verify(): Promise<boolean> {
    this.verifyCalls += 1;
    if (this.verifyThrows) throw new Error("verify boom");
    return this.verifyReturns;
  }
  async restore(): Promise<void> {
    this.restoreCalls += 1;
    if (this.restoreThrows) throw new Error("restore boom");
  }
}

describe("CheckpointStore — snapshot / verify / rollback", () => {
  it("captures a pre-image and returns a stable id", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    const record = await store.snapshot({ tool: "memory_remember", target: "coffee", before: { value: "espresso" } });
    assert.ok(record.id.startsWith("chk_"));
    assert.equal(record.tool, "memory_remember");
    assert.equal(record.target, "coffee");
    assert.deepEqual(record.before, { value: "espresso" });
    assert.equal(record.absentBefore, false);
  });

  it("records absentBefore=true when the target had no previous value", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    const record = await store.snapshot({ tool: "memory_remember", target: "new-key", before: null, absentBefore: true });
    assert.equal(record.absentBefore, true);
    assert.equal(record.before, null);
  });

  it("refuses rollback for an unknown checkpoint id", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    const result = await store.rollback("chk_does_not_exist");
    assert.equal(result.applied, false);
    assert.match((result as { reason: string }).reason, /No checkpoint/);
  });

  it("refuses rollback when no reverser is registered", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    const record = await store.snapshot({ tool: "novel_kind", target: "x", before: null, absentBefore: true });
    const result = await store.rollback(record.id);
    assert.equal(result.applied, false);
    assert.match((result as { reason: string }).reason, /No reverser/);
  });

  it("applies a rollback when the reverser verifies and restores cleanly", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    const reverser = new FakeReverser();
    store.registerReverser("memory_remember", reverser);
    const record = await store.snapshot({ tool: "memory_remember", target: "coffee", before: { value: "espresso" } });
    await store.verify(record.id, { value: "americano" });
    const result = await store.rollback(record.id);
    assert.equal(result.applied, true);
    assert.equal(reverser.verifyCalls, 1);
    assert.equal(reverser.restoreCalls, 1);
    assert.ok((result as { record: { rolledBackAt?: string } }).record.rolledBackAt);
  });

  it("refuses drift: verify returns false → no restore, no state change", async () => {
    // The mission's "keep or rollback" pattern requires verifying before reversing.
    // A caller must not silently overwrite a later change the user made.
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    const reverser = new FakeReverser();
    reverser.verifyReturns = false;
    store.registerReverser("memory_remember", reverser);
    const record = await store.snapshot({ tool: "memory_remember", target: "coffee", before: { value: "espresso" } });
    const result = await store.rollback(record.id);
    assert.equal(result.applied, false);
    assert.match((result as { reason: string }).reason, /drift/i);
    assert.equal(reverser.restoreCalls, 0, "restore must not run on drift");
  });

  it("verify that throws is treated as a refusal, not a pass", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    const reverser = new FakeReverser();
    reverser.verifyThrows = true;
    store.registerReverser("memory_remember", reverser);
    const record = await store.snapshot({ tool: "memory_remember", target: "coffee", before: { value: "espresso" } });
    const result = await store.rollback(record.id);
    assert.equal(result.applied, false);
    assert.match((result as { reason: string }).reason, /threw/);
    assert.equal(reverser.restoreCalls, 0);
  });

  it("restore that throws leaves the record NOT marked as rolledBack", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    const reverser = new FakeReverser();
    reverser.restoreThrows = true;
    store.registerReverser("memory_remember", reverser);
    const record = await store.snapshot({ tool: "memory_remember", target: "coffee", before: { value: "espresso" } });
    const result = await store.rollback(record.id);
    assert.equal(result.applied, false);
    // Still available — a failed restore did not lock the record out.
    const remaining = await store.list();
    assert.ok(remaining.some((r) => r.id === record.id));
  });

  it("cannot roll back twice — a second attempt refuses", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    store.registerReverser("memory_remember", new FakeReverser());
    const record = await store.snapshot({ tool: "memory_remember", target: "x", before: null, absentBefore: true });
    const first = await store.rollback(record.id);
    assert.equal(first.applied, true);
    const second = await store.rollback(record.id);
    assert.equal(second.applied, false);
    assert.match((second as { reason: string }).reason, /already/);
  });

  it("survives a restart — checkpoints reload from storage", async () => {
    const storage = new MemoryStorage();
    const first = new CheckpointStore({ storage, log: silentLog() });
    const record = await first.snapshot({ tool: "workspace_switch", target: "gaming", before: "general" });
    await first.flush();
    const second = new CheckpointStore({ storage, log: silentLog() });
    const list = await second.list();
    assert.ok(list.some((r) => r.id === record.id));
  });

  it("caps retention — max entries drops the oldest first", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog(), maxRetained: 10 });
    for (let i = 0; i < 25; i++) {
      await store.snapshot({ tool: "memory_remember", target: `key${i}`, before: null, absentBefore: true });
    }
    const list = await store.list({ limit: 100 });
    assert.equal(list.length, 10, "10 retained");
    assert.ok(list.every((r) => !r.target.startsWith("key0") || r.target === "key0"), "old ones dropped");
    // Specifically: the FIRST 15 should be gone, so key0 through key14 should be absent.
    for (let i = 0; i < 15; i++) {
      assert.ok(!list.some((r) => r.target === `key${i}`), `key${i} should have been dropped`);
    }
  });

  it("TTL: an expired record refuses rollback and disappears from list()", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog(), now: () => now });
    store.registerReverser("workspace_switch", new FakeReverser());
    const record = await store.snapshot({
      tool: "workspace_switch", target: "gaming", before: "general",
      ttlMs: 60_000,
    });
    // Fast-forward past TTL
    now = new Date(now.getTime() + 120_000);
    const result = await store.rollback(record.id);
    assert.equal(result.applied, false);
    assert.match((result as { reason: string }).reason, /expired/);
    const listed = await store.list();
    assert.ok(!listed.some((r) => r.id === record.id), "expired records drop out of list()");
  });

  it("emits rollback.applied on success and rollback.refused on refusal", async () => {
    const events = new EventBus(silentLog());
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog(), events });
    store.registerReverser("memory_remember", new FakeReverser());
    const rec = await store.snapshot({ tool: "memory_remember", target: "coffee", before: { value: "e" } });
    await store.rollback(rec.id);
    const applied = events.recent({ type: "rollback.applied", limit: 5 });
    assert.equal(applied.length, 1);
    assert.equal(applied[0].retention, "durable");
    // Second call refuses.
    await store.rollback(rec.id);
    const refused = events.recent({ type: "rollback.refused", limit: 5 });
    assert.equal(refused.length, 1);
  });

  it("filters list() by tool and workspace", async () => {
    const store = new CheckpointStore({ storage: new MemoryStorage(), log: silentLog() });
    await store.snapshot({ tool: "memory_remember", target: "k1", before: null, absentBefore: true, workspaceId: "general" });
    await store.snapshot({ tool: "memory_remember", target: "k2", before: null, absentBefore: true, workspaceId: "gaming" });
    await store.snapshot({ tool: "workspace_switch", target: "gaming", before: "general" });
    const memGaming = await store.list({ tool: "memory_remember", workspaceId: "gaming" });
    assert.equal(memGaming.length, 1);
    assert.equal(memGaming[0].target, "k2");
  });

  it("a corrupt persisted blob does not lose availability", async () => {
    const storage = new MemoryStorage();
    // Plant garbage at the storage key.
    await storage.set("rollback.checkpoints", { not: "an array" } as never);
    const store = new CheckpointStore({ storage, log: silentLog() });
    // list() must succeed with an empty result, not throw.
    const list = await store.list();
    assert.equal(list.length, 0);
    // Fresh writes still work.
    const rec = await store.snapshot({ tool: "memory_remember", target: "k", before: null, absentBefore: true });
    assert.ok(rec.id);
  });
});
