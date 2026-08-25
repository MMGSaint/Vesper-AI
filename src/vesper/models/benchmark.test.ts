import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBenchmarkHarness, emptyBenchmarkReport } from "./benchmark.ts";
import { createEchoProvider } from "./echo.ts";
import { testRuntime } from "../test-helpers.ts";

describe("benchmark harness", () => {
  it("refuses to invent numbers when no local backend is available", async () => {
    const harness = createBenchmarkHarness({
      providers: [createEchoProvider()],
    });
    const report = await harness.run();
    assert.equal(report.ran, false);
    assert.equal(report.refused, true);
    assert.equal(report.samples.length, 0);
    assert.match(report.reason, /refusing|not run|no reachable local/i);
  });

  it("records a real sample when a local provider completes", async () => {
    const provider = {
      id: "ollama",
      kind: "local",
      isAvailable: () => true,
      complete: async () => ({
        text: "pong",
        toolCalls: [],
        providerId: "ollama",
        model: "test",
        role: "fast" as const,
      }),
    };
    const harness = createBenchmarkHarness({ providers: [provider] });
    const report = await harness.run();
    assert.equal(report.ran, true);
    assert.equal(report.refused, false);
    assert.equal(report.samples[0]?.loadSuccess, true);
    assert.ok((report.samples[0]?.timeToFirstTokenMs ?? -1) >= 0);
  });

  it("empty report never contains fake throughput", () => {
    const report = emptyBenchmarkReport();
    assert.equal(report.samples.every((sample) => sample.tokensPerSecond == null), true);
  });

  it("runtime benchmark tool refuses fake results on this host", async () => {
    const runtime = await testRuntime();
    const record = await runtime.tools.invoke({
      name: "benchmark_run",
      args: {},
      workspaceId: "general",
    });
    assert.equal(record.result?.ok, true);
    assert.match(record.result?.summary ?? "", /refusing|not run|no reachable local/i);
  });
});
