import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, parseConfig, stricterPermission } from "./config.ts";

describe("config", () => {
  it("loads defaults with workspaces and target hardware", () => {
    const config = defaultConfig();
    assert.equal(config.identity.name, "Vesper");
    assert.equal(config.hardware.target.cpu, "AMD Ryzen 9 9950X");
    assert.equal(config.hardware.target.gpu, "AMD Radeon RX 7900 XT");
    assert.equal(config.hardware.target.vramGB, 20);
    assert.equal(config.hardware.target.ramGB, 96);
    assert.ok(config.workspaces.some((ws) => ws.id === "mortis"));
    assert.equal(config.optimizer.mode, "mock");
    assert.equal(config.models.allowOptionalCloud, false);
    assert.equal(config.context.sources.screen, false);
    assert.equal(config.context.sources.clipboard, false);
    assert.equal(config.context.sources.audio, false);
    assert.equal(config.context.sources.browser, false);
    assert.equal(config.context.sources.process, false);
  });

  it("rejects invalid config and falls back to defaults", () => {
    const parsed = parseConfig({ identity: { name: 1 } });
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.length > 0);
    assert.equal(parsed.config.identity.name, "Vesper");
  });

  it("never relaxes permission via override", () => {
    assert.equal(stricterPermission("never", "read"), "never");
    assert.equal(stricterPermission("safe", "confirm"), "confirm");
    assert.equal(stricterPermission("confirm", "read"), "confirm");
  });
});
