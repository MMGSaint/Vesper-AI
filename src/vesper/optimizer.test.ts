import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testRuntime } from "./test-helpers.ts";
import { createHttpOptimizerAdapter } from "./specialists/optimizer.ts";

describe("optimizer adapter", () => {
  it("returns mock status and analysis without claiming a live API", async () => {
    const runtime = await testRuntime();
    const status = await runtime.optimizer.getStatus();
    assert.equal(status.mode, "mock");
    assert.match(status.detail, /not connected|mock/i);
    runtime.hardware.setScenario("gpu-bound");
    const analysis = await runtime.optimizer.analyze();
    assert.equal(analysis.bound, "gpu");
    assert.match(analysis.summary, /mock/i);
  });

  it("degrades when the optimizer is unavailable", async () => {
    const runtime = await testRuntime();
    runtime.setOptimizerAvailable(false);
    const status = await runtime.optimizer.getStatus();
    assert.equal(status.available, false);
    const request = await runtime.optimizer.requestOptimization({});
    assert.equal(request.accepted, false);
  });

  it("does not treat malformed HTTP as a confirmed optimization", async () => {
    const adapter = createHttpOptimizerAdapter("http://127.0.0.1:9", {
      timeoutMs: 50,
      retries: 0,
      fetchImpl: (async (input) => {
        const url = String(input);
        if (url.endsWith("/optimize")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/status")) {
          return new Response("not-json", { status: 200 });
        }
        return new Response(JSON.stringify({ available: false }), { status: 500 });
      }) as typeof fetch,
    });
    const status = await adapter.getStatus();
    assert.equal(status.available, false);
    const result = await adapter.requestOptimization({ profile: "performance" });
    assert.equal(result.accepted, false);
    assert.match(result.summary, /did not confirm/i);
  });

  it("retries GET status and never throws on timeout", async () => {
    let calls = 0;
    const adapter = createHttpOptimizerAdapter("http://127.0.0.1:9", {
      timeoutMs: 30,
      retries: 1,
      fetchImpl: (async (_input, init) => {
        calls += 1;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 80);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
        return new Response(JSON.stringify({ available: true, mode: "live", detail: "late" }), {
          status: 200,
        });
      }) as typeof fetch,
    });
    const status = await adapter.getStatus();
    assert.equal(status.available, false);
    assert.ok(calls >= 2);
  });
});
