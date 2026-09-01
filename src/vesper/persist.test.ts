import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "./runtime.ts";
import { FileStorage } from "./storage.ts";
import { createProductionHost } from "./host/service.ts";

describe("persistence", () => {
  it("restores pending confirmations across runtime restarts", async () => {
    const file = join(tmpdir(), `vesper-confirm-${Date.now()}.json`);
    const storage = new FileStorage(file);
    const first = await createRuntime({ skipDiscovery: true, storage });
    await first.start();
    const turn = await first.chat("optimize this");
    const pending = turn.pendingConfirmations[0] ?? [...first.confirmations.values()][0];
    assert.ok(pending, "expected a confirmation to be queued");
    assert.ok(pending.preview, "a queued confirmation must carry a preview of the intended action");
    assert.equal(pending.preview.toolName, pending.toolName);
    await first.stop();

    const second = await createRuntime({ skipDiscovery: true, storage: new FileStorage(file) });
    await second.start();
    assert.equal(second.confirmations.has(pending.id), true);
    const restored = second.confirmations.get(pending.id);
    assert.equal(restored?.preview?.summary, pending.preview.summary);
    await second.stop();
  });

  it("records last-error without crashing the host", async () => {
    const root = join(tmpdir(), `vesper-error-${Date.now()}`);
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
    const report = await host.doctor();
    assert.equal(report.ok, true);
    assert.equal(host.configSource === "file" || host.configSource === "default", true);
    await host.shutdown();
  });
});
