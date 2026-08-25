import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";

describe("optimizer adapter", () => {
  it("returns mock status and analysis without claiming a live API", async () => {
    const runtime = await testRuntime();
    const status = await runtime.optimizer.getStatus();
    assert.equal(status.mode, "mock");
    assert.match(status.detail, /not connected|mock/i);
    runtime.hardware.setScenario("gpu-bound");
    const analysis = await runtime.optimizer.analyze();
    assert.equal(analysis.bound, "gpu");
    assert.match(analysis.summary, /mock/i);
  });

  it("degrades when the optimizer is unavailable", async () => {
    const runtime = await testRuntime();
    runtime.setOptimizerAvailable(false);
    const status = await runtime.optimizer.getStatus();
    assert.equal(status.available, false);
    const request = await runtime.optimizer.requestOptimization({});
    assert.equal(request.accepted, false);
  });
});
