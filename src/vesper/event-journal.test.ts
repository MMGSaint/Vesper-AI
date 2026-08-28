import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "./storage.ts";
import { EventJournal, classifyRetention } from "./event-journal.ts";
import type { VesperEvent } from "./types.ts";

function makeLog() {
  const messages: Array<{ level: string; message: string }> = [];
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: (_channel: string, message: string) => {
      messages.push({ level: "warn", message });
    },
    error: (_channel: string, message: string) => {
      messages.push({ level: "error", message });
    },
    child: () => log,
  } as never;
  return { log, messages };
}

function evt(type: string, at: string, extra: Partial<VesperEvent> = {}): VesperEvent {
  return {
    id: `evt_${type}_${at}`,
    type,
    title: extra.title ?? type,
    at,
    severity: extra.severity ?? "info",
    ...extra,
  };
}

describe("classifyRetention", () => {
  it("respects an explicit retention field", () => {
    assert.equal(
      classifyRetention({ type: "anything.at_all", retention: "transient" }),
      "transient",
    );
    assert.equal(
      classifyRetention({ type: "lifecycle.idle_tick", retention: "durable" }),
      "durable",
      "an explicit retention beats the transient denylist",
    );
  });

  it("keeps security.* durable no matter what", () => {
    // The mission's rule: losing a security notice is an incident. Nothing in the
    // deny-list overrides that.
    assert.equal(classifyRetention({ type: "security.state_unreadable" }), "durable");
    assert.equal(classifyRetention({ type: "security.grant_table_invalid" }), "durable");
  });

  it("drops lifecycle chatter and state snapshots", () => {
    for (const type of [
      "lifecycle.idle_tick",
      "lifecycle.background_start",
      "lifecycle.background_stop",
      "obs.state",
      "optimizer.state",
      "system.state",
      "task.assigned",
      "task.blocked",
      "task.requeued",
    ]) {
      assert.equal(classifyRetention({ type }), "transient", `${type} should be transient`);
    }
  });

  it("keeps human-visible task transitions durable", () => {
    for (const type of ["task.created", "task.started", "task.completed", "task.failed", "task.cancelled"]) {
      assert.equal(classifyRetention({ type }), "durable", `${type} should be durable`);
    }
  });

  it("defaults unknown types to durable — fail-safe", () => {
    // A future author adds a new event category and forgets to classify it. The
    // journal must not silently forget it — it must keep it.
    assert.equal(classifyRetention({ type: "someone.new_thing" }), "durable");
  });
});

describe("EventJournal — durable events survive past the ring", () => {
  it("admits a durable event and returns it via query()", async () => {
    const { log } = makeLog();
    const journal = new EventJournal({
      storage: new MemoryStorage(),
      log,
      now: () => new Date("2026-08-28T12:00:00Z"),
    });
    journal.admit(evt("security.state_unreadable", "2026-08-28T10:00:00Z"));
    await journal.flush();
    const found = await journal.query();
    assert.equal(found.length, 1);
    assert.equal(found[0].type, "security.state_unreadable");
  });

  it("drops transient events on admit, never touching storage", async () => {
    const { log } = makeLog();
    let writes = 0;
    const storage = {
      async get() { return null; },
      async set() { writes += 1; },
      async delete() {},
      async keys() { return []; },
    };
    const journal = new EventJournal({ storage, log, now: () => new Date("2026-08-28T12:00:00Z") });
    for (let i = 0; i < 10; i++) {
      const decision = journal.admit(evt("lifecycle.idle_tick", "2026-08-28T10:00:00Z"));
      assert.equal(decision, "transient");
    }
    await journal.flush();
    assert.equal(writes, 0, `no writes expected for transient events, got ${writes}`);
  });

  it("partitions events by day and reads them all back", async () => {
    const { log } = makeLog();
    const storage = new MemoryStorage();
    const journal = new EventJournal({ storage, log, now: () => new Date("2026-08-28T00:00:00Z") });
    journal.admit(evt("task.completed", "2026-08-26T12:00:00Z"));
    journal.admit(evt("task.completed", "2026-08-27T12:00:00Z"));
    journal.admit(evt("task.completed", "2026-08-28T12:00:00Z"));
    await journal.flush();
    const keys = await storage.keys();
    const partitions = keys.filter((k) => k.startsWith("events.journal."));
    assert.equal(partitions.length, 3, `expected 3 day-partitions, got ${partitions.length}: ${partitions}`);
    const all = await journal.query();
    assert.equal(all.length, 3);
    assert.equal(all[0].at, "2026-08-26T12:00:00Z", "results returned in ascending time order");
  });

  it("purges partitions older than retentionDays on startup", async () => {
    const { log } = makeLog();
    const storage = new MemoryStorage();
    // Plant three ancient partitions and one recent one.
    await storage.set("events.journal.2020-01-01", [{ id: "old1", at: "2020-01-01T00:00:00Z", type: "task.completed", title: "old", severity: "info" }]);
    await storage.set("events.journal.2020-01-02", [{ id: "old2", at: "2020-01-02T00:00:00Z", type: "task.completed", title: "old", severity: "info" }]);
    await storage.set("events.journal.2026-08-27", [{ id: "keep", at: "2026-08-27T00:00:00Z", type: "task.completed", title: "keep", severity: "info" }]);
    const journal = new EventJournal({
      storage,
      log,
      retentionDays: 14,
      now: () => new Date("2026-08-28T00:00:00Z"),
    });
    const purged = await journal.purgeOldPartitions();
    assert.equal(purged, 2, "the two 2020 partitions should have been purged");
    const remaining = await journal.query();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "keep");
  });

  it("purge is idempotent — a second call does nothing", async () => {
    const { log } = makeLog();
    const storage = new MemoryStorage();
    await storage.set("events.journal.2020-01-01", [{ id: "old", at: "2020-01-01T00:00:00Z", type: "task.completed", title: "old", severity: "info" }]);
    const journal = new EventJournal({ storage, log, retentionDays: 14, now: () => new Date("2026-08-28T00:00:00Z") });
    assert.equal(await journal.purgeOldPartitions(), 1);
    assert.equal(await journal.purgeOldPartitions(), 0, "second call must not double-purge or throw");
  });

  it("caps events per day-partition — a floody subsystem cannot grow unbounded", async () => {
    // The maxPerDay bound is the "not an unbounded log" rule from the mission.
    const { log } = makeLog();
    const storage = new MemoryStorage();
    const journal = new EventJournal({
      storage,
      log,
      maxPerDay: 50,
      now: () => new Date("2026-08-28T00:00:00Z"),
    });
    for (let i = 0; i < 200; i++) {
      journal.admit(evt(`task.completed`, `2026-08-28T00:00:${(i % 60).toString().padStart(2, "0")}Z`, { id: `e${i}` }));
    }
    await journal.flush();
    const raw = await storage.get("events.journal.2026-08-28");
    assert.ok(Array.isArray(raw));
    assert.equal((raw as VesperEvent[]).length, 50, "partition capped at 50");
  });

  it("filters by type, correlationId, and time window", async () => {
    const { log } = makeLog();
    const journal = new EventJournal({ storage: new MemoryStorage(), log, now: () => new Date("2026-08-28T00:00:00Z") });
    journal.admit(evt("task.completed", "2026-08-27T12:00:00Z", { correlationId: "turn-A" }));
    journal.admit(evt("task.completed", "2026-08-28T09:00:00Z", { correlationId: "turn-B" }));
    journal.admit(evt("security.state_unreadable", "2026-08-28T10:00:00Z", { correlationId: "turn-B" }));
    await journal.flush();

    const byType = await journal.query({ types: ["security.state_unreadable"] });
    assert.equal(byType.length, 1);

    const byCorrelation = await journal.query({ correlationId: "turn-B" });
    assert.equal(byCorrelation.length, 2);

    const byWindow = await journal.query({ since: "2026-08-28T00:00:00Z" });
    assert.equal(byWindow.length, 2, `expected 2 in window, got ${byWindow.length}`);
  });

  it("a corrupt partition costs its own day, never access to the others", async () => {
    // The failure story from EventBus.hydrate applies to the journal too.
    const { log } = makeLog();
    const storage = new MemoryStorage();
    // Plant good data on 08-27 and garbage on 08-26.
    await storage.set("events.journal.2026-08-26", "not-an-array" as unknown as never);
    await storage.set("events.journal.2026-08-27", [{ id: "keep", at: "2026-08-27T00:00:00Z", type: "task.completed", title: "keep", severity: "info" }]);
    const journal = new EventJournal({ storage, log, now: () => new Date("2026-08-28T00:00:00Z") });
    const found = await journal.query();
    assert.equal(found.length, 1, "the 08-27 partition is still readable despite 08-26 being corrupt");
    assert.equal(found[0].id, "keep");
  });

  it("fires onWriteFailure exactly once per session, not per failed event", async () => {
    // A storage subsystem that stays broken for the whole session must not spam the
    // bus with N notifications. Debounce is per-JournalInstance.
    const { log } = makeLog();
    let failureCount = 0;
    const storage = {
      async get() { return null; },
      async set() { throw new Error("disk"); },
      async delete() {},
      async keys() { return []; },
    };
    const journal = new EventJournal({
      storage, log,
      now: () => new Date("2026-08-28T00:00:00Z"),
      onWriteFailure: () => { failureCount += 1; },
    });
    for (let i = 0; i < 5; i++) {
      journal.admit(evt("task.completed", "2026-08-28T00:00:00Z", { id: `e${i}` }));
      await journal.flush();
    }
    assert.equal(failureCount, 1, `onWriteFailure debounced, got ${failureCount}`);
  });

  it("fires onCorruptPartition only once per corrupt partition", async () => {
    const { log } = makeLog();
    let corruptCallCount = 0;
    const storage = new MemoryStorage();
    await storage.set("events.journal.2026-08-27", "corrupt" as unknown as never);
    const journal = new EventJournal({
      storage,
      log,
      now: () => new Date("2026-08-28T00:00:00Z"),
      onCorruptPartition: () => { corruptCallCount += 1; },
    });
    await journal.query();
    await journal.query();
    await journal.query();
    assert.equal(corruptCallCount, 1, "callback fires once per unique corrupt partition");
  });
});
