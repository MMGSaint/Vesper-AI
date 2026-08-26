import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBenchmarkHarness, emptyBenchmarkReport } from "./benchmark.ts";
import { createEchoProvider } from "./echo.ts";
import { testRuntime } from "../test-helpers.ts";
import type { CompletionRequest } from "../types.ts";

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

  it("measures throughput from provider counters when the backend reports them", async () => {
    const provider = {
      id: "ollama",
      kind: "local",
      isAvailable: () => true,
      complete: async (request: CompletionRequest) => {
        // Simulate a genuinely streamed reply so TTFT becomes observable.
        request.onDelta?.("po");
        request.onDelta?.("ng");
        return {
          text: "pong",
          toolCalls: [],
          providerId: "ollama",
          model: "test",
          role: "fast" as const,
          streamed: true,
          usage: {
            promptTokens: 9,
            completionTokens: 20,
            evalDurationMs: 500,
            loadDurationMs: 42,
          },
        };
      },
    };
    const harness = createBenchmarkHarness({ providers: [provider] });
    const report = await harness.run();
    const sample = report.samples[0];

    assert.equal(report.ran, true);
    assert.equal(report.refused, false);
    assert.equal(sample?.loadSuccess, true);
    assert.equal(sample?.streamed, true);
    // 20 tokens in 500ms of reported generation time.
    assert.equal(sample?.tokensPerSecond, 40);
    assert.equal(sample?.tokenSource, "provider-counters");
    assert.equal(sample?.completionTokens, 20);
    assert.equal(sample?.loadDurationMs, 42);
    assert.ok((sample?.timeToFirstTokenMs ?? -1) >= 0, "TTFT is measured when streaming");
  });

  it("refuses to report throughput when the backend reports no token counts", async () => {
    const provider = {
      id: "llamacpp",
      kind: "local",
      isAvailable: () => true,
      complete: async () => ({
        text: "pong",
        toolCalls: [],
        providerId: "llamacpp",
        model: "test",
        role: "fast" as const,
        streamed: false,
      }),
    };
    const harness = createBenchmarkHarness({ providers: [provider] });
    const sample = (await harness.run()).samples[0];

    assert.equal(sample?.loadSuccess, true);
    // The call really happened, but throughput is unknown and stays unknown.
    assert.equal(sample?.tokensPerSecond, null);
    assert.equal(sample?.tokenSource, "unreported");
    assert.equal(sample?.completionTokens, null);
    // Nothing streamed, so TTFT is not back-filled with the total duration.
    assert.equal(sample?.timeToFirstTokenMs, null);
    assert.ok(sample!.totalMs >= 0, "wall-clock duration is still a real measurement");
    assert.equal(sample?.outputChars, 4);
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
