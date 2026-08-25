import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../logging.ts";
import { EventBus } from "../events.ts";
import { createBackgroundRuntime, createTrayMenu, invokeTrayAction } from "./runtime.ts";
import { describeStartupRegistration } from "./startup.ts";
import { resolveVesperDirs } from "../paths.ts";
import { testRuntime } from "../test-helpers.ts";

describe("windows background runtime", () => {
  it("starts, pauses, resumes, and stops without polling", async () => {
    const log = createLogger();
    const events = new EventBus(log);
    const runtime = createBackgroundRuntime({ events, log });
    await runtime.start();
    assert.equal(runtime.state(), "running");
    await runtime.pause();
    assert.equal(runtime.state(), "paused");
    await runtime.resume();
    assert.equal(runtime.state(), "running");
    await runtime.stop();
    assert.equal(runtime.state(), "stopped");
  });

  it("exposes a tray menu that cannot skip pause/exit controls", async () => {
    const log = createLogger();
    const events = new EventBus(log);
    const runtime = createBackgroundRuntime({ events, log });
    await runtime.start();
    const items = createTrayMenu(runtime.health());
    assert.ok(items.some((item) => item.role === "open"));
    assert.ok(items.some((item) => item.role === "diagnostics"));
    const paused = await invokeTrayAction("pause", runtime);
    assert.equal(paused.ok, true);
    assert.equal(runtime.state(), "paused");
  });

  it("does not claim Windows startup was applied on Linux", () => {
    const described = describeStartupRegistration({ enabled: true, platform: "linux" });
    assert.equal(described.enabled, true);
    assert.equal(described.applied, false);
  });

  it("uses a Windows production data directory layout", () => {
    const dirs = resolveVesperDirs({
      production: true,
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\\\Users\\\\Saint\\\\AppData\\\\Local" },
    });
    assert.match(dirs.root, /Vesper/);
    assert.match(dirs.logs, /logs/);
  });

  it("pauses through the Vesper runtime", async () => {
    const runtime = await testRuntime();
    assert.equal(runtime.background.state(), "running");
    await runtime.pause();
    assert.equal(runtime.background.state(), "paused");
    await runtime.resume();
    assert.equal(runtime.background.state(), "running");
  });
});
