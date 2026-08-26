import assert from "node:assert/strict";
import test from "node:test";
import {
  correlateAround,
  describeCorrelation,
  eventWeight,
  explainCorrelations,
} from "./correlate.ts";
import { EventBus } from "./events.ts";
import { createLogger } from "./logging.ts";
import { MemoryStorage } from "./storage.ts";
import { testRuntime } from "./test-helpers.ts";
import type { VesperEvent } from "./types.ts";

const BASE = Date.parse("2026-08-26T12:00:00.000Z");

function event(type: string, title: string, offsetSeconds: number): VesperEvent {
  return {
    id: `${type}-${offsetSeconds}`,
    type,
    title,
    at: new Date(BASE + offsetSeconds * 1000).toISOString(),
    severity: "info",
  };
}

test("event correlation", async (t) => {
  await t.test("finds what happened shortly before a moment of interest", () => {
    const events = [
      event("obs.state", "OBS started recording", -40),
      event("game.started", "Squad launched", -300),
      event("workspace.switch", "Workspace changed to Streaming", -55),
    ];
    const found = correlateAround(events, new Date(BASE).toISOString());
    const titles = found.map((item) => item.event.title);

    assert.ok(titles.includes("OBS started recording"));
    assert.ok(titles.includes("Workspace changed to Streaming"));
    // Outside the default 120s look-back.
    assert.ok(!titles.includes("Squad launched"));
  });

  await t.test("ranks workload-moving events above background chatter", () => {
    const events = [
      event("lifecycle.start", "Vesper is awake", -5),
      event("obs.state", "OBS started recording", -60),
    ];
    const found = correlateAround(events, new Date(BASE).toISOString());
    assert.equal(found[0].event.title, "OBS started recording");
    assert.ok(eventWeight("obs.state") > eventWeight("lifecycle.start"));
  });

  await t.test("labels events before, after, and at the same moment", () => {
    const events = [
      event("obs.state", "before", -30),
      event("obs.state", "after", 10),
      event("obs.state", "same", 0),
    ];
    const found = correlateAround(events, new Date(BASE).toISOString());
    const byTitle = new Map(found.map((item) => [item.event.title, item.relation]));
    assert.equal(byTitle.get("before"), "preceded");
    assert.equal(byTitle.get("after"), "followed");
    assert.equal(byTitle.get("same"), "concurrent");
  });

  await t.test("never claims causation", () => {
    const found = correlateAround(
      [event("obs.state", "OBS started recording", -40)],
      new Date(BASE).toISOString(),
    );
    const sentence = explainCorrelations("a performance change", found);
    assert.match(sentence, /OBS started recording \(40s before\)/);
    assert.match(sentence, /does not prove one caused another/);
    assert.ok(!/caused by|because of/i.test(sentence));
  });

  await t.test("says plainly when it observed nothing", () => {
    const sentence = explainCorrelations("a performance change", []);
    assert.match(sentence, /found nothing else recorded nearby/);
    // Absence of evidence is reported as exactly that.
    assert.match(sentence, /not proof nothing happened/);
  });

  await t.test("ignores unparseable timestamps rather than throwing", () => {
    const broken: VesperEvent = { ...event("obs.state", "broken", 0), at: "not a date" };
    const found = correlateAround([broken, event("obs.state", "good", -10)], new Date(BASE).toISOString());
    assert.equal(found.length, 1);
    assert.equal(found[0].event.title, "good");
    assert.deepEqual(correlateAround([], "not a date"), []);
  });

  await t.test("describes gaps in units a person would use", () => {
    assert.match(describeCorrelation({ event: event("obs.state", "x", -45), offsetMs: -45_000, relation: "preceded", weight: 5 }), /45s before/);
    assert.match(describeCorrelation({ event: event("obs.state", "x", -600), offsetMs: -600_000, relation: "preceded", weight: 5 }), /10m before/);
  });
});

test("event log persistence", async (t) => {
  await t.test("survives a restart so correlation still works afterwards", async () => {
    const storage = new MemoryStorage();
    const log = createLogger();

    const first = new EventBus(log, 500, storage);
    first.emit({ type: "obs.state", title: "OBS started recording", severity: "info" });
    await first.flush();

    const second = new EventBus(log, 500, storage);
    const restored = await second.hydrate();
    assert.equal(restored, 1);
    assert.equal(second.all()[0].title, "OBS started recording");
  });

  await t.test("a corrupt event log costs history, not availability", async () => {
    const storage = new MemoryStorage();
    await storage.set("events.recent", [{ nonsense: true }, "not an event"] as never);
    const bus = new EventBus(createLogger(), 500, storage);
    assert.equal(await bus.hydrate(), 0);
    // Still fully usable.
    bus.emit({ type: "obs.state", title: "still working", severity: "info" });
    assert.equal(bus.all().length, 1);
  });

  await t.test("a failing store never takes down the assistant", async () => {
    const failing = {
      async get() {
        throw new Error("disk gone");
      },
      async set() {
        throw new Error("disk gone");
      },
      async delete() {},
      async keys() {
        return [];
      },
    };
    const bus = new EventBus(createLogger(), 500, failing);
    assert.equal(await bus.hydrate(), 0);
    bus.emit({ type: "obs.state", title: "emitted anyway", severity: "info" });
    await bus.flush();
    assert.equal(bus.all().length, 1);
  });

  await t.test("the runtime exposes correlation as a tool", async () => {
    const runtime = await testRuntime();
    const now = Date.now();
    runtime.events.emit({
      type: "obs.state",
      title: "OBS started recording",
      severity: "info",
      at: new Date(now - 40_000).toISOString(),
    });
    const record = await runtime.tools.invoke({
      name: "explain_change",
      args: { title: "a performance change", at: new Date(now).toISOString() },
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, true);
    assert.match(record.result?.summary ?? "", /OBS started recording \(40s before\)/);
    assert.match(record.result?.summary ?? "", /does not prove/);
  });

  await t.test("explain_change refuses a timestamp it cannot read", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "explain_change",
      args: { at: "yesterday-ish" },
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, false);
    assert.match(record.result?.summary ?? "", /not a timestamp/);
  });
});
