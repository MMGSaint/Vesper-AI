import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./config.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";

describe("doctor", () => {
  it("reports writable dirs and does not claim hardware validation", async () => {
    const root = join(tmpdir(), `vesper-doctor-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const dirs = {
      root,
      config: join(root, "config"),
      data: join(root, "data"),
      logs: join(root, "logs"),
      models: join(root, "models"),
    };
    const report = await runDoctor({
      dirs,
      config: defaultConfig(),
      configOk: true,
      configErrors: [],
      storageReadable: true,
    });
    assert.equal(report.ok, true);
    assert.ok(report.checks.some((check) => check.id === "node" && check.ok));
    assert.ok(report.checks.some((check) => check.id === "client-protocol" && check.ok));
    const text = formatDoctor(report);
    assert.equal(text.includes("AMD telemetry"), true);
    assert.equal(/passed on the target PC/i.test(text), false);
  });
});
