import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runIntelligenceEval } from "./eval.ts";

describe("intelligence eval harness", () => {
  it("passes the personalization fixtures", async () => {
    const report = await runIntelligenceEval();
    assert.equal(report.failed, 0, report.cases.filter((item) => !item.ok).map((item) => item.id).join(", "));
    assert.ok(report.passed >= 8);
  });
});
