import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";
import { classifyIntent } from "./agent.ts";

describe("diagnostics", () => {
  it("classifies a diagnostics request", () => {
    assert.equal(classifyIntent("Vesper diagnostics")?.kind, "diagnostics");
    assert.equal(classifyIntent("what's happening")?.kind, "status");
  });

  it("returns a structured and human-readable report", async () => {
    const runtime = await testRuntime();
    const report = await runtime.diagnostics();
    assert.equal(report.runtime.started, true);
    assert.equal(report.runtime.health, "running");
    assert.ok(report.tools.count >= 7);
    assert.match(report.reportText, /Vesper diagnostics/);
    assert.equal(report.classification.runtime, "implemented_tested");
    assert.equal(report.optimizer.mode, "mock");
  });

  it("answers a diagnostics chat turn through the tool", async () => {
    const runtime = await testRuntime();
    const turn = await runtime.chat("Vesper diagnostics");
    assert.ok(turn.toolCalls.some((call) => call.toolName === "diagnostics_report"));
    assert.match(turn.reply, /Runtime:/);
    assert.match(turn.reply, /Optimizer:/);
  });
});
