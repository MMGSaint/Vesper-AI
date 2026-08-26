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

  it("names the embedding backend actually in use, including a downgrade", async () => {
    // A silent downgrade from a model-backed embedder to lexical hashing changes
    // retrieval quality; diagnostics must say so rather than hide it.
    const runtime = await testRuntime();
    const report = await runtime.diagnostics();
    assert.ok(report.knowledge.sources >= 1);
    assert.ok(report.knowledge.detail.length > 0);
    assert.match(report.reportText, /Knowledge: \d+ approved source\(s\)/);
  });

  it("no longer calls voice unimplemented now that backends are driven for real", async () => {
    const runtime = await testRuntime();
    const report = await runtime.diagnostics();
    assert.notEqual(report.classification.voice, "documented_not_implemented");
    // The software half is real; audio devices remain unvalidated.
    assert.equal(report.classification.voice, "implemented_hardware_dependent");
  });
});
