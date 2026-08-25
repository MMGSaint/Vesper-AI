import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "../test-helpers.ts";
import { explainPerformance, inspectWorkload } from "./context.ts";

describe("workload context", () => {
  it("detects VRChat and OBS from the simulated process list", async () => {
    const runtime = await testRuntime();
    runtime.hardware.setScenario("vrchat");
    const vr = inspectWorkload(runtime.hardware);
    assert.equal(vr.vrchatRunning, true);
    assert.equal(vr.gameRunning, true);
    runtime.hardware.setScenario("streaming");
    const stream = inspectWorkload(runtime.hardware);
    assert.equal(stream.obsRunning, true);
    assert.equal(stream.obsStreaming, true);
  });

  it("explains a GPU-bound optimizer finding with OBS context", async () => {
    const runtime = await testRuntime();
    runtime.hardware.setScenario("gpu-bound");
    const context = inspectWorkload(runtime.hardware);
    const text = explainPerformance({ bound: "gpu", context });
    assert.match(text, /GPU-bound/);
    assert.match(text, /CPU performance probably will not/i);
  });
});
