import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "../test-helpers.ts";
import {
  detectObs,
  detectVrchat,
  groundedConclusions,
  readyPlan,
  gpuConsumers,
} from "./gaming.ts";

describe("gaming / VRChat / OBS adapters", () => {
  it("observes VRChat and distinguishes inferred OBS capture state", async () => {
    const runtime = await testRuntime();
    runtime.hardware.setScenario("vrchat");
    const vr = detectVrchat(runtime.hardware);
    assert.equal(vr.running, true);
    assert.equal(vr.observed, true);
    runtime.hardware.setScenario("streaming");
    const obs = detectObs(runtime.hardware);
    assert.equal(obs.running, true);
    assert.equal(obs.streaming, true);
  });

  it("labels GPU-heavy conclusions as inferred on the simulator", async () => {
    const runtime = await testRuntime();
    runtime.hardware.setScenario("gpu-bound");
    const conclusions = groundedConclusions(runtime.hardware);
    assert.ok(conclusions.some((item) => item.statement.includes("GPU-heavy") && item.kind === "inferred"));
    assert.ok(conclusions.some((item) => /simulated snapshot/i.test(item.statement)));
  });

  it("builds a VRChat ready plan without touching the optimizer", () => {
    const plan = readyPlan("vrchat");
    assert.deepEqual(plan.apps, ["steam", "discord", "vrchat"]);
    assert.ok(plan.notes.some((note) => /optimizer/i.test(note)));
  });

  it("lists GPU-ish processes without claiming per-process GPU time", async () => {
    const runtime = await testRuntime();
    runtime.hardware.setScenario("vrchat");
    const consumers = gpuConsumers(runtime.hardware);
    assert.ok(consumers.some((item) => /vrchat/i.test(item.name)));
    assert.ok(consumers.every((item) => /not measured/i.test(item.note)));
  });
});
