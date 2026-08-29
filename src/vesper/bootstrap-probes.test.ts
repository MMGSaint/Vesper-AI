/**
 * First boot consults the probe registry, and the registry answers for the right host.
 *
 * The registry was implemented and tested and imported by nothing: the six
 * hardware-dependent first-boot steps were hard-coded strings, so registering a real
 * Windows probe changed nothing a user would see. These tests exist to make that
 * impossible to reintroduce — each one drives `runFirstBootAutomation` and asserts the
 * report changed, rather than asserting the registry can be called.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { platform } from "node:os";
import { runFirstBootAutomation } from "./bootstrap.ts";
import { HardwareProbeRegistry, registerPlaceholderProbes } from "./hardware/probes.ts";
import { defaultConfig, parseConfig } from "./config.ts";
import { MemoryStorage } from "./storage.ts";
import type { Logger } from "./logging.ts";

function silentLog(): Logger {
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  return log as unknown as Logger;
}

function config(overrides: Record<string, unknown> = {}) {
  // parseConfig returns a ParsedConfig envelope; the config itself is the .config field.
  return parseConfig({ ...defaultConfig(), ...overrides }).config;
}

async function report(probes?: HardwareProbeRegistry, overrides: Record<string, unknown> = {}) {
  return runFirstBootAutomation(config(overrides), silentLog(), {
    storage: new MemoryStorage(),
    probes,
  });
}

function stepOf(r: Awaited<ReturnType<typeof report>>, id: string) {
  return r.steps.find((s) => s.id === id);
}

describe("first boot reads its hardware steps from the probe registry", () => {
  it("uses a registered probe's answer instead of the hard-coded text", async () => {
    // The probe ids and the step ids differ — `gpu.live` vs `gpu` — and the probe
    // module's own comment claimed they matched. A direct lookup returns undefined for
    // all six and silently keeps the hard-coded string, so the wiring failing would
    // have looked exactly like the wiring working.
    const probes = new HardwareProbeRegistry();
    probes.register({
      id: "gpu.live",
      title: "Detect the live GPU identity",
      platforms: [platform()],
      async probe() {
        return {
          ok: true,
          detail: "Radeon RX 7900 XT, 20 GB, driver 24.1.1",
          classification: "implemented_hardware_dependent",
        };
      },
    });

    const gpu = stepOf(await report(probes), "gpu");

    assert.equal(gpu?.ok, true);
    assert.match(gpu!.detail, /driver 24\.1\.1/, "the probe's answer must reach the report");
  });

  it("keeps a probe's NEGATIVE answer rather than flattening it to the default", async () => {
    // "The probe ran and could not read the GPU" is a different fact from "no probe
    // exists". A machine with a broken driver must not look identical to one that was
    // never asked.
    const probes = new HardwareProbeRegistry();
    probes.register({
      id: "gpu.live",
      title: "Detect the live GPU identity",
      platforms: [platform()],
      async probe() {
        return { ok: false, detail: "ADLX returned no adapters", classification: "implemented_hardware_dependent" };
      },
    });

    const gpu = stepOf(await report(probes), "gpu");

    assert.equal(gpu?.ok, false);
    assert.match(gpu!.detail, /no adapters/);
  });

  it("falls back to the built-in text when no registry is supplied", async () => {
    const gpu = stepOf(await report(undefined), "gpu");
    assert.equal(gpu?.ok, false);
    assert.match(gpu!.detail, /RX 7900 XT/);
  });

  it("covers every hardware-dependent step, not just the first", async () => {
    const probes = new HardwareProbeRegistry();
    const ids = ["gpu.live", "vram.live", "telemetry.amd", "audio.wasapi", "windows.tray", "benchmark.harness"];
    for (const id of ids) {
      probes.register({
        id,
        title: id,
        platforms: [platform()],
        async probe() {
          return { ok: true, detail: `PROBED-${id}`, classification: "implemented_tested" };
        },
      });
    }

    const r = await report(probes);

    for (const [stepId, probeId] of Object.entries({
      gpu: "gpu.live",
      vram: "vram.live",
      telemetry: "telemetry.amd",
      audio: "audio.wasapi",
      windows: "windows.tray",
      benchmark: "benchmark.harness",
    })) {
      assert.match(stepOf(r, stepId)!.detail, new RegExp(`PROBED-${probeId.replace(".", "\\.")}`), stepId);
    }
  });

  it("a probe that throws is reported, not swallowed", async () => {
    const probes = new HardwareProbeRegistry();
    probes.register({
      id: "gpu.live",
      title: "gpu",
      platforms: [platform()],
      async probe() {
        throw new Error("ADLX bindings missing");
      },
    });

    const gpu = stepOf(await report(probes), "gpu");

    assert.equal(gpu?.ok, false);
    assert.match(gpu!.detail, /ADLX bindings missing/);
    assert.equal(gpu?.status, "documented_not_implemented");
  });
});

describe("a real probe outranks a placeholder whatever the registration order", () => {
  it("wins even when registered AFTER the placeholders", async () => {
    // This is the trap the target PC would have walked into. The placeholders declare
    // platforms ["linux","darwin","win32"] — win32 included — and the registry took the
    // first platform match by insertion order. A real Windows probe wired in after
    // `registerPlaceholderProbes` would never have run, and first boot would have
    // reported "not implemented" on the one machine where it WAS implemented.
    const probes = new HardwareProbeRegistry();
    registerPlaceholderProbes(probes);
    probes.register({
      id: "gpu.live",
      title: "real",
      platforms: [platform()],
      async probe() {
        return { ok: true, detail: "REAL-PROBE-RAN", classification: "implemented_hardware_dependent" };
      },
    });

    const result = await probes.run("gpu.live", { platform: platform() });

    assert.equal(result.detail, "REAL-PROBE-RAN", "the real probe must outrank the placeholder");
  });

  it("still falls back to the placeholder when no real probe matches the platform", async () => {
    const probes = new HardwareProbeRegistry();
    registerPlaceholderProbes(probes);
    probes.register({
      id: "gpu.live",
      title: "real",
      platforms: ["some-other-os"],
      async probe() {
        return { ok: true, detail: "SHOULD-NOT-RUN", classification: "implemented_tested" };
      },
    });

    const result = await probes.run("gpu.live", { platform: platform() });

    assert.equal(result.ok, false);
    assert.match(result.detail, /hardware-validation-checklist/);
  });
});

describe("the report does not contradict itself about the optimizer", () => {
  it("classifies mode=live with no endpoint as still a mock", async () => {
    // The classification tested `mode === "live"` alone while the detail text also
    // required an endpoint, so this configuration printed "Optimizer adapter is mock"
    // and classified itself implemented_hardware_dependent — one line disagreeing with
    // itself. The runtime requires both before it builds a live adapter.
    const optimizer = stepOf(
      await report(undefined, { optimizer: { mode: "live", endpoint: null } }),
      "optimizer",
    );

    assert.equal(optimizer?.status, "mocked_simulated");
    assert.match(optimizer!.detail, /no endpoint is configured/);
  });

  it("classifies mock mode as simulated", async () => {
    const optimizer = stepOf(await report(undefined), "optimizer");
    assert.equal(optimizer?.status, "mocked_simulated");
  });
});

describe("the report tells the truth about settings that do nothing yet", () => {
  it("says hardware.mode=live has not taken effect", async () => {
    // The setting is recorded in four places and branched on in none. A user who set
    // "live" is otherwise entitled to believe their readings are measurements.
    const step = stepOf(await report(undefined, { hardware: { mode: "live" } }), "hardware-mode");

    assert.ok(step, "a hardware-source step must exist");
    assert.match(step!.detail, /no live hardware source is implemented/i);
    assert.equal(step!.status, "documented_not_implemented");
  });

  it("reports voice honestly instead of always saying off", async () => {
    // `voiceEnabled` was a hard-coded false, so a user with voice enabled read
    // "voice=off" in their own first-boot report.
    const enabled = stepOf(await report(undefined, { voice: { enabled: true } }), "defaults");
    const disabled = stepOf(await report(undefined), "defaults");

    assert.match(enabled!.detail, /voice=on/);
    assert.match(disabled!.detail, /voice=off/);
  });
});
