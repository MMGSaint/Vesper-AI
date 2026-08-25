import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionHost } from "./host/service.ts";
import { MemoryStorage } from "./storage.ts";

describe("production host", () => {
  it("starts a background host, writes health, and shuts down", async () => {
    const root = join(tmpdir(), `vesper-host-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const host = await createProductionHost({
      dirs: {
        root,
        config: join(root, "config"),
        data: join(root, "data"),
        logs: join(root, "logs"),
        models: join(root, "models"),
      },
      runtime: { skipDiscovery: true, storage: new MemoryStorage() },
    });
    assert.equal(host.runtime.started, true);
    assert.equal(host.runtime.background.state(), "running");
    await host.writeHealth();
    await host.shutdown();
    assert.equal(host.runtime.started, false);
    assert.equal(host.runtime.background.state(), "stopped");
  });
});
