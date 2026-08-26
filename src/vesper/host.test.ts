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
    assert.equal(host.gateway.hello().protocol, "vesper.client");
    assert.equal(host.gateway.hello().version, 1);
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

  it("boots a second time with its workspaces, apps, and knowledge intact", async () => {
    // Regression: the starter config file is a subset of the full config, and parsing
    // it standalone let schema defaults such as `workspaces: []` win. A real install
    // therefore came up with no workspaces, no approved applications, and no knowledge
    // sources on every boot after the first.
    const root = join(tmpdir(), `vesper-host-reboot-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const dirs = {
      root,
      config: join(root, "config"),
      data: join(root, "data"),
      logs: join(root, "logs"),
      models: join(root, "models"),
    };

    const first = await createProductionHost({ dirs, runtime: { skipDiscovery: true } });
    const before = {
      workspaces: first.runtime.config.workspaces.length,
      apps: first.runtime.config.approvedApps.length,
      knowledge: first.runtime.config.knowledgeSources.length,
    };
    await first.shutdown();
    assert.ok(before.workspaces > 0, "the first boot has workspaces");

    // Second boot now reads the config file written by the first.
    const second = await createProductionHost({ dirs, runtime: { skipDiscovery: true } });
    assert.equal(second.runtime.config.workspaces.length, before.workspaces);
    assert.equal(second.runtime.config.approvedApps.length, before.apps);
    assert.equal(second.runtime.config.knowledgeSources.length, before.knowledge);
    assert.ok(
      second.runtime.workspaces.switchTo("gaming"),
      "workspace switching still works after a restart",
    );
    await second.shutdown();
  });
});
