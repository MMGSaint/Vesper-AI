import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { availabilityFor, describeAvailability } from "./availability.ts";
import { CloudflareCloudProvider } from "./cloudflare.ts";
import { runIdleConsolidation } from "./consolidation.ts";
import { createDisabledBrowserProvider, createDisabledDesktopProvider } from "./providers.ts";

describe("provider seams and availability", () => {
  it("disabled browser and desktop providers open no device and execute nothing", async () => {
    const browser = createDisabledBrowserProvider();
    const desktop = createDisabledDesktopProvider();
    const page = await browser.currentPage();
    const act = await browser.act("click");
    const observe = await desktop.observe();
    const interact = await desktop.interact("type");
    for (const result of [page, act, observe, interact]) {
      assert.equal(result.ok, false);
      assert.equal(result.openedDevice, false);
      assert.equal(result.executed, false);
      assert.equal(result.trust, "untrusted_external");
    }
  });

  it("Cloudflare stub is not live and requires credentials", async () => {
    const provider = new CloudflareCloudProvider();
    assert.equal(provider.kind, "cloudflare-stub");
    const auth = await provider.authenticate("dev_pc");
    assert.equal("token" in auth, false);
    const status = await provider.getStatus();
    assert.equal(status.live, false);
    assert.equal(status.connected, false);
    assert.equal(status.kind, "cloudflare-stub");
    assert.equal(status.lastError, "requires_credentials");
    const backup = await provider.backup();
    assert.equal(backup.ok, false);
  });

  it("availability vocab never promotes a mock or stub to live", () => {
    assert.equal(availabilityFor({ mock: true }), "mock");
    assert.equal(availabilityFor({ stub: true }), "stub");
    assert.equal(availabilityFor({ credentials: true }), "requires_credentials");
    assert.equal(availabilityFor({ hardware: true }), "requires_hardware");
    assert.equal(availabilityFor({ enabled: false }), "disabled");
    assert.equal(availabilityFor({ live: true }), "live");
    assert.match(describeAvailability("mock"), /Not live/);
    assert.match(describeAvailability("stub"), /No connected backend/);
  });

  it("idle consolidation never rewrites source memory or wakes the model", () => {
    const report = runIdleConsolidation({
      enabled: true,
      candidates: [
        { key: "sarah.employer", value: "Y", source: "memory" },
        { key: "working", value: "scratch", source: "working" },
      ],
    });
    assert.equal(report.ran, true);
    assert.equal(report.wokeModel, false);
    assert.equal(report.rewroteAuthoritative, false);
    assert.equal(report.indexed, 1);
  });
});
