import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";
import { classifyIntent } from "./agent.ts";

describe("integration scenarios", () => {
  it("answers GPU, fan, and OBS questions from grounded observations", async () => {
    assert.equal(classifyIntent("What's using my GPU?")?.kind, "gpu");
    assert.equal(classifyIntent("Why are my fans ramping?")?.kind, "thermal");
    assert.equal(classifyIntent("Is OBS affecting this?")?.kind, "obs");
    const runtime = await testRuntime();
    runtime.hardware.setScenario("gpu-bound");
    const gpu = await runtime.chat("What's using my GPU?");
    assert.match(gpu.reply, /simulated|GPU/i);
    assert.ok(gpu.epistemic.includes("checked"));
    runtime.hardware.setScenario("thermal");
    const fans = await runtime.chat("Why are my fans ramping?");
    assert.match(fans.reply, /simulated|thermal|°C/i);
    runtime.hardware.setScenario("streaming");
    const obs = await runtime.chat("Is OBS affecting this?");
    assert.match(obs.reply, /OBS/i);
  });

  it("Get me ready for VRChat stays simulated and does not claim optimizer success", async () => {
    const runtime = await testRuntime();
    const turn = await runtime.chat("get me ready for VRChat");
    assert.equal(runtime.workspaces.current().id, "vrchat");
    assert.match(turn.reply, /simulated/i);
    const optimizer = await runtime.optimizer.getStatus();
    assert.equal(optimizer.mode, "mock");
  });

  it("filesystem, memory, and permission failures stay isolated", async () => {
    const runtime = await testRuntime();
    await runtime.chat("remember that snack is pretzels");
    const denied = await runtime.tools.invoke({
      name: "disk_wipe",
      args: {},
      workspaceId: "general",
      confirmed: true,
    });
    assert.equal(denied.result?.ok, false);
    const hits = await runtime.memory.search("pretzels");
    assert.ok(hits.length >= 1);
  });
});
