import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planExecution } from "./route.ts";
import type { Procedure } from "../procedures.ts";

const procedure: Procedure = {
  id: "p1",
  name: "stream setup",
  purpose: "Prepare OBS",
  steps: [{ order: 1, instruction: "status", permission: "read" }],
  requiredTools: ["obs_status"],
  scope: "workspace",
  permissionCeiling: "read",
  successCriteria: "OBS observed",
  provenance: { source: "user", origin: "test" },
  confidence: 1,
  state: "active",
  version: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("deterministic-first routing", () => {
  it("prefers an active procedure over a model", () => {
    const plan = planExecution({
      intent: "do the stream setup",
      catalog: { procedures: [procedure], skills: [], tools: [] },
    });
    assert.equal(plan.step, "procedure");
    assert.equal(plan.executed, false);
  });

  it("falls back to the model when nothing deterministic matches", () => {
    const plan = planExecution({
      intent: "what is the capital of France",
      catalog: { procedures: [procedure], skills: [], tools: [] },
    });
    assert.equal(plan.step, "model");
    assert.equal(plan.executed, false);
  });

  it("ignores a candidate procedure that was never activated", () => {
    const plan = planExecution({
      intent: "stream setup",
      catalog: { procedures: [{ ...procedure, state: "candidate" }], skills: [], tools: [] },
    });
    assert.equal(plan.step, "model");
  });
});
