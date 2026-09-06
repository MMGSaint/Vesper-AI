import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../config.ts";
import { createSimulatedHardware } from "../hardware/simulated.ts";
import type { WindowsCommand, WindowsRunner } from "./exec.ts";
import { createWindowsHost } from "./host.ts";

const noopRunner: WindowsRunner = async (_command: WindowsCommand) => ({
  ok: true,
  code: 0,
  stdout: Buffer.from(""),
  stderr: "",
  timedOut: false,
  aborted: false,
  error: null,
});

describe("createWindowsHost selects the adapter honestly", () => {
  it("uses the simulated adapter off win32", () => {
    const hardware = createSimulatedHardware(defaultConfig());
    const host = createWindowsHost(hardware, { platform: "linux" });
    assert.equal(host.simulated, true);
    assert.equal(host.platform, "linux");
  });

  it("stays simulated when forceSimulated is set on win32", () => {
    const hardware = createSimulatedHardware(defaultConfig());
    const host = createWindowsHost(hardware, { platform: "win32", forceSimulated: true });
    assert.equal(host.simulated, true);
    assert.equal(host.platform, "win32");
    assert.equal(host.trayAvailable, true);
  });

  it("selects the real adapter on win32 without forceSimulated", () => {
    const hardware = createSimulatedHardware(defaultConfig());
    const host = createWindowsHost(hardware, {
      platform: "win32",
      runner: noopRunner,
      launcher: () => ({ ok: true, pid: 1, error: null }),
      nativeNotifications: false,
    });
    assert.equal(host.simulated, false);
    assert.equal(host.platform, "win32");
  });
});

describe("createRuntime Windows host policy", () => {
  it("documents that forceSimulated on createWindowsHost keeps CI off the real adapter", () => {
    const hardware = createSimulatedHardware(defaultConfig());
    const forced = createWindowsHost(hardware, { platform: "win32", forceSimulated: true, runner: noopRunner });
    const real = createWindowsHost(hardware, { platform: "win32", forceSimulated: false, runner: noopRunner, launcher: () => ({ ok: true, pid: 1, error: null }), nativeNotifications: false });
    assert.equal(forced.simulated, true);
    assert.equal(real.simulated, false);
  });
});
