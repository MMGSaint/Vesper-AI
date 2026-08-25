import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runFirstBootAutomation } from "./bootstrap.ts";
import { defaultConfig } from "./config.ts";
import { createLogger } from "./logging.ts";
import { MemoryStorage } from "./storage.ts";

describe("first-boot", () => {
  it("runs the bootstrap steps and persists a profile without claiming GPU validation", async () => {
    const storage = new MemoryStorage();
    const report = await runFirstBootAutomation(defaultConfig(), createLogger(), { storage });
    const ids = report.steps.map((step) => step.id);
    for (const required of [
      "os",
      "cpu",
      "gpu",
      "vram",
      "ram",
      "backends",
      "models",
      "audio",
      "windows",
      "telemetry",
      "optimizer",
      "defaults",
      "self-check",
      "persist",
      "report",
    ]) {
      assert.ok(ids.includes(required), `missing step ${required}`);
    }
    assert.equal(report.persisted, true);
    assert.equal(report.profile.telemetry, "mocked_simulated");
    assert.equal(report.steps.find((step) => step.id === "gpu")?.ok, false);
    assert.match(report.reportText, /Vesper first-boot report/);
    assert.ok(await storage.get("capability.profile"));
    assert.equal(report.defaults.voiceEnabled, false);
  });
});
