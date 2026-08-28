/**
 * Adversarial regression tests for the EventJournal.
 *
 * Every case here reproduces a finding surfaced by the adversarial attack workflow
 * (waez7rmuo, 30 CONFIRMED / 2 PLAUSIBLE / 3 REFUTED). If the underlying defence is
 * ever removed or relaxed, the named test fails — which is the invariant "the fix
 * is load-bearing, not decorative" reduced to code.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "./storage.ts";
import { EventJournal, classifyRetention } from "./event-journal.ts";
import type { VesperEvent } from "./types.ts";

function silentLog() {
  const messages: string[] = [];
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: (_c: string, m: string) => { messages.push(m); },
    error: (_c: string, m: string) => { messages.push(m); },
    child: () => log,
  } as never;
  return { log, messages };
}

function evt(type: string, at: string, extra: Partial<VesperEvent> = {}): VesperEvent {
  return {
    id: extra.id ?? `evt_${type}_${at}`,
    type,
    title: extra.title ?? type,
    at,
    severity: extra.severity ?? "info",
    ...extra,
  };
}

describe("attack #1: bogus event.at cannot plant a ghost partition", () => {
  it("clamps garbage timestamps to now, keeping the partition key well-formed", async () => {
    const { log } = silentLog();
    const storage = new MemoryStorage();
    const clock = () => new Date("2026-06-15T00:00:00Z");
    const journal = new EventJournal({ storage, log, now: clock });
    journal.admit(evt("task.completed", "garbage-not-a-timestamp", { id: "g1" }));
    journal.admit(evt("task.completed", "", { id: "g2" }));
    await journal.flush();
    const keys = (await storage.keys()).filter((k) => k.startsWith("events.journal."));
    // Every key must be a proper YYYY-MM-DD suffix — no `events.journal.garbage-no`
    // or `events.journal.` remain.
    for (const key of keys) {
      assert.match(key, /^events\.journal\.\d{4}-\d{2}-\d{2}$/, `bad key: ${key}`);
    }
    // The events landed under today's partition — query() finds them.
    const found = await journal.query();
    assert.equal(found.length, 2, `expected 2 events, got ${found.length}`);
  });
});

describe("attack #2: future-dated event.at cannot outlive the retention window", () => {
  it("clamps far-future timestamps to now on admit, so nothing is filed under 9999-12-31", async () => {
    const { log } = silentLog();
    const storage = new MemoryStorage();
    const clock = () => new Date("2026-06-15T00:00:00Z");
    const journal = new EventJournal({ storage, log, now: clock });
    journal.admit(evt("task.completed", "9999-12-31T00:00:00Z", { id: "fut" }));
    await journal.flush();
    const keys = (await storage.keys()).filter((k) => k.startsWith("events.journal."));
    assert.ok(!keys.some((k) => k.includes("9999")), `future-dated partition should not exist, got: ${keys}`);
  });

  it("purge deletes any pre-existing future-dated partition as an anomaly", async () => {
    const { log } = silentLog();
    const storage = new MemoryStorage();
    // Plant a hostile partition dated in the future.
    await storage.set("events.journal.9999-12-31", [{ id: "old", at: "9999-12-31T00:00:00Z", type: "task.completed", title: "old", severity: "info" }]);
    const journal = new EventJournal({ storage, log, now: () => new Date("2026-06-15T00:00:00Z") });
    await journal.purgeOldPartitions();
    const keys = await storage.keys();
    assert.ok(!keys.some((k) => k === "events.journal.9999-12-31"), "purge must delete future-dated partitions");
  });
});

describe("attack #3: retentionDays and maxPerDay cannot be silently disabled", () => {
  it("Infinity retentionDays clamps to a sane ceiling", async () => {
    const { log } = silentLog();
    const storage = new MemoryStorage();
    // Plant an old partition well past 1 year:
    await storage.set("events.journal.2020-01-01", [{ id: "old", at: "2020-01-01T00:00:00Z", type: "task.completed", title: "old", severity: "info" }]);
    const journal = new EventJournal({
      storage, log,
      retentionDays: Infinity, // hostile config
      now: () => new Date("2026-06-15T00:00:00Z"),
    });
    const purged = await journal.purgeOldPartitions();
    assert.equal(purged, 1, "Infinity clamped to a ceiling, so old partitions still purge");
  });

  it("Number.MAX_SAFE_INTEGER maxPerDay clamps so partitions still bound", async () => {
    const { log } = silentLog();
    const storage = new MemoryStorage();
    const journal = new EventJournal({
      storage, log,
      maxPerDay: Number.MAX_SAFE_INTEGER, // hostile config
      now: () => new Date("2026-06-15T00:00:00Z"),
    });
    // Admit 60_000 events (above the ceiling of 50_000).
    for (let i = 0; i < 60_000; i++) {
      journal.admit(evt("task.completed", "2026-06-15T12:00:00Z", { id: `e${i}` }));
    }
    await journal.flush();
    const raw = await storage.get("events.journal.2026-06-15");
    assert.ok(Array.isArray(raw));
    assert.ok((raw as unknown as VesperEvent[]).length <= 50_000, "maxPerDay ceiling holds");
  });
});

describe("attack #4: oversized event.data cannot inflate a partition", () => {
  it("truncates a huge data payload to a small sentinel object", async () => {
    const { log } = silentLog();
    const storage = new MemoryStorage();
    const journal = new EventJournal({ storage, log, now: () => new Date("2026-06-15T00:00:00Z") });
    const huge = "x".repeat(1_000_000);
    journal.admit(evt("task.completed", "2026-06-15T00:00:00Z", { data: { blob: huge } as never }));
    await journal.flush();
    const raw = (await storage.get("events.journal.2026-06-15")) as unknown as VesperEvent[];
    const encoded = JSON.stringify(raw);
    assert.ok(encoded.length < 100_000, `truncation should keep serialised size small, got ${encoded.length}`);
    assert.equal((raw[0].data as { truncated?: boolean })?.truncated, true, "truncation marker recorded");
  });
});

describe("attack #7: security.* cannot be demoted to transient by caller retention hint", () => {
  it("security type with retention:'transient' is still classified durable", () => {
    assert.equal(classifyRetention({ type: "security.state_unreadable", retention: "transient" }), "durable");
  });
  it("denylisted transient type with retention:'durable' is still transient", () => {
    assert.equal(classifyRetention({ type: "lifecycle.idle_tick", retention: "durable" }), "transient");
    assert.equal(classifyRetention({ type: "obs.state", retention: "durable" }), "transient");
  });
});

describe("attack #19-22: query filter parameters cannot silently widen results", () => {
  async function makeStore() {
    const { log } = silentLog();
    const storage = new MemoryStorage();
    const clock = () => new Date("2026-06-16T00:00:00Z");
    const journal = new EventJournal({ storage, log, now: clock });
    for (let i = 0; i < 5; i++) {
      journal.admit(evt("task.completed", "2026-06-15T12:00:00Z", { id: `e${i}`, correlationId: "turn-A" }));
    }
    await journal.flush();
    return journal;
  }

  it("throws on limit=0 instead of returning everything", async () => {
    const j = await makeStore();
    await assert.rejects(() => j.query({ limit: 0 }), /positive integer/);
  });

  it("throws on limit=NaN instead of returning everything", async () => {
    const j = await makeStore();
    await assert.rejects(() => j.query({ limit: NaN }), /positive integer/);
  });

  it("throws on negative limit instead of skipping earliest rows", async () => {
    const j = await makeStore();
    await assert.rejects(() => j.query({ limit: -3 }), /positive integer/);
  });

  it("throws on empty-string correlationId instead of matching all events", async () => {
    const j = await makeStore();
    await assert.rejects(() => j.query({ correlationId: "" }), /non-empty string/);
  });

  it("throws on non-ISO since instead of misfiling the filter", async () => {
    const j = await makeStore();
    await assert.rejects(() => j.query({ since: "yesterday" }), /valid ISO timestamp/);
    await assert.rejects(() => j.query({ since: "2026-06-15" }), /valid ISO timestamp/);
  });

  it("throws on non-ISO until", async () => {
    const j = await makeStore();
    await assert.rejects(() => j.query({ until: "junk" }), /valid ISO timestamp/);
  });
});

describe("attack #27: query dedupes events by id even if a partition has duplicates on disk", () => {
  it("returns each event id at most once", async () => {
    const { log } = silentLog();
    const storage = new MemoryStorage();
    // Plant a partition with the same id repeated (simulates a partial-write race).
    const dupe = { id: "dup", at: "2026-06-15T12:00:00Z", type: "task.completed", title: "t", severity: "info" };
    await storage.set("events.journal.2026-06-15", [dupe, dupe, dupe]);
    const journal = new EventJournal({ storage, log, now: () => new Date("2026-06-16T00:00:00Z") });
    const found = await journal.query();
    assert.equal(found.length, 1, "dedup by event.id");
  });
});

describe("attack #6: purge runs periodically, not once per session", () => {
  it("a long-lived session purges after PURGE_EVERY_N_ADMITS admits", async () => {
    const { log } = silentLog();
    const storage = new MemoryStorage();
    // Plant an old partition.
    await storage.set("events.journal.2020-01-01", [{ id: "old", at: "2020-01-01T00:00:00Z", type: "task.completed", title: "old", severity: "info" }]);
    const journal = new EventJournal({
      storage, log,
      retentionDays: 14,
      now: () => new Date("2026-06-16T00:00:00Z"),
    });
    // Admit 501 events (past the periodic-purge threshold).
    for (let i = 0; i < 501; i++) {
      journal.admit(evt("task.completed", "2026-06-15T12:00:00Z", { id: `e${i}` }));
    }
    // The async purge is fire-and-forget from admit; wait a tick for it.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await journal.flush();
    const keys = await storage.keys();
    assert.ok(!keys.some((k) => k === "events.journal.2020-01-01"), "periodic purge should have deleted the ancient partition");
  });
});

describe("attack #11: partition truncation is loud, not silent", () => {
  it("a partition exceeding maxPerDay logs a warning naming the drop count", async () => {
    const { log, messages } = silentLog();
    const storage = new MemoryStorage();
    const journal = new EventJournal({
      storage, log,
      maxPerDay: 50,
      now: () => new Date("2026-06-16T00:00:00Z"),
    });
    for (let i = 0; i < 100; i++) {
      journal.admit(evt("task.completed", "2026-06-15T12:00:00Z", { id: `e${i}` }));
    }
    await journal.flush();
    assert.ok(
      messages.some((m) => /exceeded maxPerDay/.test(m)),
      `expected a truncation-loud log entry, got: ${messages.join(" | ")}`,
    );
  });
});

describe("attack #5: pending array cannot grow unbounded", () => {
  it("when storage hangs indefinitely, pending is bounded and the loss is loud", async () => {
    const { log } = silentLog();
    let failureCount = 0;
    // Storage set() never resolves.
    const storage = {
      async get() { return null; },
      set: () => new Promise<void>(() => {}), // hang forever
      async delete() {},
      async keys() { return []; },
    };
    const journal = new EventJournal({
      storage, log,
      now: () => new Date("2026-06-16T00:00:00Z"),
      onWriteFailure: () => { failureCount += 1; },
    });
    // Push far past MAX_PENDING.
    for (let i = 0; i < 8000; i++) {
      journal.admit(evt("task.completed", "2026-06-15T12:00:00Z", { id: `e${i}` }));
    }
    // The pending queue's overflow calls onWriteFailure — pass because the mission's
    // "loss must be loud" rule applies even to policy-driven drops.
    assert.ok(failureCount > 0, "pending-overflow must call onWriteFailure");
  });
});
