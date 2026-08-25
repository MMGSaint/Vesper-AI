import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./logging.ts";
import { EventBus } from "./events.ts";
import { createBackgroundRuntime } from "./windows/runtime.ts";
import { createIdleScheduler } from "./scheduler.ts";
import { testRuntime } from "./test-helpers.ts";

describe("idle scheduler", () => {
  it("skips ticks while paused and while GPU-heavy", async () => {
    const log = createLogger();
    const events = new EventBus(log);
    const background = createBackgroundRuntime({ events, log });
    await background.start();
    let gaming = false;
    const scheduler = createIdleScheduler({
      events,
      log,
      intervalMs: 60_000,
      state: () => background.state(),
      isGamingHeavy: () => gaming,
    });
    scheduler.start();
    const first = await scheduler.tick();
    assert.equal(first.ran, true);
    await background.pause();
    const paused = await scheduler.tick();
    assert.equal(paused.ran, false);
    await background.resume();
    gaming = true;
    const heavy = await scheduler.tick();
    assert.equal(heavy.ran, false);
    assert.match(heavy.reason, /gaming|gpu-heavy/i);
    scheduler.stop();
    const stopped = await scheduler.tick();
    assert.equal(stopped.ran, false);
  });

  it("exposes scheduler status through a tool", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "scheduler_status",
      args: {},
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, true);
  });
});
