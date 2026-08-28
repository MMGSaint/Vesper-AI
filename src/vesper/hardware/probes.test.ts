import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HardwareProbeRegistry,
  registerPlaceholderProbes,
  type HardwareProbe,
} from "./probes.ts";

describe("HardwareProbeRegistry", () => {
  it("returns not-implemented for an unknown probe id — never throws", async () => {
    const registry = new HardwareProbeRegistry();
    const result = await registry.run("does_not_exist", { platform: "linux" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /No probe registered/);
    assert.equal(result.classification, "documented_not_implemented");
  });

  it("picks the first probe whose platform matches the current one", async () => {
    const registry = new HardwareProbeRegistry();
    const winProbe: HardwareProbe = {
      id: "gpu.live",
      title: "win",
      platforms: ["win32"],
      probe: async () => ({ ok: true, detail: "Windows probe", classification: "implemented_tested" }),
    };
    const linuxFallback: HardwareProbe = {
      id: "gpu.live",
      title: "linux",
      platforms: ["linux"],
      probe: async () => ({ ok: true, detail: "Linux fallback", classification: "mocked_simulated" }),
    };
    registry.register(winProbe);
    registry.register(linuxFallback);

    const onLinux = await registry.run("gpu.live", { platform: "linux" });
    assert.match(onLinux.detail, /Linux fallback/);

    const onWin = await registry.run("gpu.live", { platform: "win32" });
    assert.match(onWin.detail, /Windows probe/);
  });

  it("returns not-implemented when no probe matches the current platform", async () => {
    const registry = new HardwareProbeRegistry();
    registry.register({
      id: "gpu.live",
      title: "win",
      platforms: ["win32"],
      probe: async () => ({ ok: true, detail: "", classification: "implemented_tested" }),
    });
    const result = await registry.run("gpu.live", { platform: "linux" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /Validate on the target PC/);
  });

  it("a probe that throws becomes a probe failure, never a runtime crash", async () => {
    const registry = new HardwareProbeRegistry();
    registry.register({
      id: "telemetry.amd",
      title: "amd",
      platforms: ["linux", "win32"],
      probe: async () => { throw new Error("ADLX not present"); },
    });
    const result = await registry.run("telemetry.amd", { platform: "linux" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /threw.*ADLX not present/);
  });

  it("runAll runs every registered probe id", async () => {
    const registry = new HardwareProbeRegistry();
    registerPlaceholderProbes(registry);
    const results = await registry.runAll({ platform: "linux" });
    // Six placeholder probes are registered.
    assert.ok(Object.keys(results).length >= 6);
    // Every one is honest about being not-implemented, not fabricated.
    for (const [id, r] of Object.entries(results)) {
      assert.equal(r.ok, false, `${id} must be not-implemented on linux`);
      assert.equal(r.classification, "documented_not_implemented");
    }
  });

  it("placeholder for gpu.live points to the hardware-validation-checklist", async () => {
    const registry = new HardwareProbeRegistry();
    registerPlaceholderProbes(registry);
    const result = await registry.run("gpu.live", { platform: "linux" });
    assert.match(result.detail, /RX 7900 XT/);
    assert.match(result.detail, /hardware-validation-checklist/);
  });

  it("placeholder for benchmark.harness names the mission's no-fabrication rule", async () => {
    const registry = new HardwareProbeRegistry();
    registerPlaceholderProbes(registry);
    const result = await registry.run("benchmark.harness", { platform: "linux" });
    assert.match(result.detail, /refuses to invent/);
  });
});
