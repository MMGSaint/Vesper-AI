import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "./storage.ts";
import {
  AutomationStore,
  digestObservation,
  evaluateAutomation,
  type Automation,
} from "./automation.ts";

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: "auto_1",
    kind: "heartbeat",
    name: "health",
    description: "watch temperatures",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("automation semantics", () => {
  it("fires a schedule when due and skips when it is not", () => {
    const due = evaluateAutomation(auto({ kind: "schedule", intervalMs: 60_000 }), { now: 70_000 });
    assert.equal(due.action, "fire");
    const early = evaluateAutomation(
      auto({ kind: "schedule", intervalMs: 60_000, nextAt: "2026-01-01T01:00:00.000Z" }),
      { now: Date.parse("2026-01-01T00:00:00.000Z") },
    );
    assert.equal(early.action, "skip");
  });

  it("fires a trigger only on the matching event", () => {
    const spec = auto({ kind: "trigger", eventType: "task.failed" });
    assert.equal(evaluateAutomation(spec, { eventType: "task.failed" }).action, "fire");
    assert.equal(evaluateAutomation(spec, { eventType: "task.completed" }).action, "skip");
    assert.equal(evaluateAutomation(spec, {}).action, "skip");
  });

  it("heartbeats stay quiet when the observation did not change", () => {
    const observation = { cpuTemp: 42, gpuTemp: 50 };
    const first = evaluateAutomation(auto({ kind: "heartbeat" }), { observation });
    assert.equal(first.action, "fire");
    const second = evaluateAutomation(
      auto({ kind: "heartbeat", lastDigest: digestObservation(observation) }),
      { observation },
    );
    assert.equal(second.action, "quiet");
    const third = evaluateAutomation(
      auto({ kind: "heartbeat", lastDigest: digestObservation(observation) }),
      { observation: { cpuTemp: 90, gpuTemp: 50 } },
    );
    assert.equal(third.action, "fire");
  });

  it("preserves workspace identity and never invents a confirmation", async () => {
    const store = new AutomationStore(new MemoryStorage());
    const created = await store.create({
      kind: "heartbeat",
      name: "gpu watch",
      description: "notify on thermal change",
      workspaceId: "gaming",
      sessionId: "sess_1",
    });
    assert.equal(created.workspaceId, "gaming");
    assert.equal(created.sessionId, "sess_1");
    const results = await store.evaluateAll({
      observationFor: () => ({ gpu: 40 }),
    });
    assert.equal(results[0].decision.action, "fire");
    const again = await store.evaluateAll({
      observationFor: () => ({ gpu: 40 }),
    });
    assert.equal(again[0].decision.action, "quiet");
    assert.equal(again[0].automation.workspaceId, "gaming");
    assert.equal("confirmed" in again[0].automation, false);
  });

  it("disabled automations do not fire", () => {
    const decision = evaluateAutomation(auto({ enabled: false, kind: "schedule" }), { now: Date.now() });
    assert.equal(decision.action, "skip");
  });
});
