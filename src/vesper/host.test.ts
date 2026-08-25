import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionHost } from "./host/service.ts";
import { parseCli } from "./cli.ts";
import { VESPER_VERSION } from "./version.ts";

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
      runtime: { skipDiscovery: true },
    });
    assert.equal(host.runtime.started, true);
    assert.equal(host.runtime.background.state(), "running");
    const healthPath = await host.writeHealth();
    const health = JSON.parse(await readFile(healthPath, "utf8")) as { version?: string };
    assert.equal(health.version, VESPER_VERSION);
    const doctor = await host.doctor();
    assert.equal(doctor.ok, true);
    const exportPath = await host.exportMemory();
    const exported = JSON.parse(await readFile(exportPath, "utf8")) as { count: number };
    assert.equal(typeof exported.count, "number");
    await host.shutdown();
    assert.equal(host.runtime.started, false);
    assert.equal(host.runtime.background.state(), "stopped");
  });

  it("exposes a non-interactive CLI", () => {
    assert.equal(parseCli(["--doctor", "--skip-discovery"]).kind, "doctor");
    assert.equal(parseCli(["--version"]).kind, "version");
  });
});
