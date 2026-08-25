import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";
import { liveHardwareSnapshot, discoverCurrentMachine } from "./hardware/discover.ts";

describe("hardware", () => {
  it("simulated snapshots match the target profile and are labeled simulated", async () => {
    const runtime = await testRuntime();
    const snap = runtime.hardware.snapshot();
    assert.equal(snap.mode, "simulated");
    assert.equal(snap.cpu.name, "AMD Ryzen 9 9950X");
    assert.equal(snap.gpu?.name, "AMD Radeon RX 7900 XT");
    assert.equal(snap.gpu?.vramGB, 20);
    assert.equal(snap.ram.totalGB, 96);
    assert.ok(snap.notes.some((note) => /simulated/i.test(note)));
  });

  it("live discovery reports this host without inventing GPU telemetry", () => {
    const live = liveHardwareSnapshot();
    assert.equal(live.mode, "live");
    assert.equal(live.gpu, null);
    assert.ok(live.notes.some((note) => /not read/i.test(note)));
    const machine = discoverCurrentMachine();
    assert.ok(machine.os.length > 0);
  });

  it("scenario changes affect utilization", async () => {
    const runtime = await testRuntime();
    runtime.hardware.setScenario("idle");
    const idle = runtime.hardware.snapshot().gpu?.utilizationPct ?? 0;
    runtime.hardware.setScenario("gpu-bound");
    const busy = runtime.hardware.snapshot().gpu?.utilizationPct ?? 0;
    assert.ok(busy > idle);
  });
});
