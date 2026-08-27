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

  it("leaves an audit trail for every live state change, including failures", async () => {
    // Anything that can change machine state must be reconstructable afterwards:
    // what was asked, with which parameters, and what actually came back.
    const entries: { level: string; message: string; data?: Record<string, unknown> }[] = [];
    const log = {
      info: (_c: string, message: string, data?: Record<string, unknown>) =>
        entries.push({ level: "info", message, data }),
      warn: (_c: string, message: string, data?: Record<string, unknown>) =>
        entries.push({ level: "warn", message, data }),
      error: (_c: string, message: string, data?: Record<string, unknown>) =>
        entries.push({ level: "error", message, data }),
    } as unknown as NonNullable<Parameters<typeof createHttpOptimizerAdapter>[1]>["log"];

    const accepted = createHttpOptimizerAdapter("http://127.0.0.1:9", {
      timeoutMs: 50,
      retries: 0,
      log,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ accepted: true, summary: "applied performance" }), {
          status: 200,
        })) as typeof fetch,
    });
    await accepted.requestOptimization({ profile: "performance", reason: "user asked" });

    const requested = entries.find((entry) => entry.message === "Optimizer state change requested");
    assert.ok(requested, "the request itself is recorded");
    assert.equal(requested?.data?.action, "request_optimization");
    assert.equal(requested?.data?.profile, "performance");
    assert.equal(requested?.data?.reason, "user asked");

    const confirmed = entries.find((entry) => entry.message === "Optimizer confirmed an optimization");
    assert.ok(confirmed, "the authoritative confirmation is recorded separately");

    // A failure must be just as visible as a success.
    entries.length = 0;
    const failing = createHttpOptimizerAdapter("http://127.0.0.1:9", {
      timeoutMs: 50,
      retries: 0,
      log,
      fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });
    const result = await failing.requestRollback();
    assert.equal(result.accepted, false);
    assert.ok(
      entries.some((entry) => entry.message === "Optimizer state change failed"),
      "the failure is recorded, not silently swallowed",
    );
    assert.ok(
      !entries.some((entry) => /confirmed/i.test(entry.message)),
      "nothing claims a rollback happened",
    );
  });
});

describe("the optimizer does not get to say what Vesper is", () => {
  /**
   * `mode` is the LIVE / SIMULATED / MOCKED distinction the product promises the user.
   * It is a fact about which adapter Vesper is running, which Vesper knows locally —
   * `config.optimizer.mode === "live" && endpoint` is what selected the HTTP adapter —
   * and it was being read out of the response body instead.
   *
   * So an endpoint could answer `mode: "mock"`, with a `detail` saying no live
   * optimization was performed, while `POST /optimize` was genuinely issued to it. Every
   * consumer repeated the claim: the tool result, the health report, and — the one that
   * matters — Vesper's own honesty classification in diagnostics, which said
   * `mocked_simulated` about a subsystem that was really changing the machine.
   *
   * A subsystem's assertion is not attestation about Vesper.
   */
  function lyingEndpoint(claims: "mock" | "live" | "unavailable" | "nonsense") {
    const hits: string[] = [];
    const adapter = createHttpOptimizerAdapter("http://127.0.0.1:9", {
      timeoutMs: 50,
      retries: 0,
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        hits.push(`${init?.method ?? "GET"} ${url.pathname}`);
        if (url.pathname === "/status") {
          return new Response(
            JSON.stringify({
              available: true,
              mode: claims,
              currentProfile: "balanced",
              detail: "Mock optimizer adapter. No live optimization was performed.",
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ accepted: true, summary: "Applied." }), { status: 200 });
      }) as typeof fetch,
    });
    return { adapter, hits };
  }

  it("reports live when it is really issuing live requests, whatever the endpoint claims", async () => {
    for (const claim of ["mock", "unavailable", "nonsense"] as const) {
      const { adapter, hits } = lyingEndpoint(claim);
      const status = await adapter.getStatus();
      assert.equal(status.mode, "live", `an endpoint claiming ${claim} was believed`);
      // And it really is live: the request goes out.
      await adapter.requestOptimization({ profile: "performance" });
      assert.ok(
        hits.some((hit) => hit === "POST /optimize"),
        "no live request was issued, so this proves nothing",
      );
    }
  });

  it("keeps the endpoint's own claim, separately, where no honesty label reads it", async () => {
    const { adapter } = lyingEndpoint("mock");
    const status = await adapter.getStatus();
    assert.equal(status.reportedMode, "mock", "the endpoint's claim was discarded entirely");
    assert.notEqual(status.mode, status.reportedMode, "the two collapsed back into one field");
  });

  it("says live in the health report too", async () => {
    const { adapter } = lyingEndpoint("mock");
    const health = await adapter.getHealth();
    assert.equal(health.mode, "live");
  });

  it("classifies the optimizer as hardware-dependent, not simulated", async () => {
    // The consequence that matters: Vesper's own honesty classification.
    const { buildDiagnostics } = await import("./diagnostics.ts");
    const { adapter } = lyingEndpoint("mock");
    const status = await adapter.getStatus();
    const report = buildDiagnostics({
      instanceId: "test",
      started: true,
      health: { running: false } as never,
      models: { active: "none", available: [] },
      memory: { persistent: 0, session: 0 },
      tools: { count: 0 },
      permissions: { neverAllowAutonomous: [] },
      optimizer: status,
      windows: { simulated: true } as never,
      voice: { enabled: false } as never,
      knowledge: { sources: 0, documents: 0 } as never,
      context: { notes: [] } as never,
      capability: null,
      recentErrors: [],
    });
    assert.equal(
      report.classification.optimizer,
      "implemented_hardware_dependent",
      "Vesper described a live, machine-changing subsystem as a simulation",
    );
  });

  it("still reports unavailable when the endpoint is genuinely down", async () => {
    // Narrowing, not severing: the adapter must not claim live when it reached nothing.
    const adapter = createHttpOptimizerAdapter("http://127.0.0.1:9", {
      timeoutMs: 30,
      retries: 0,
      fetchImpl: (async () => new Response("", { status: 503 })) as typeof fetch,
    });
    const status = await adapter.getStatus();
    assert.equal(status.available, false);
    assert.equal(status.mode, "unavailable");
  });

  it("still lets the mock adapter say it is a mock", async () => {
    // Through the runtime, which is where the mock adapter actually lives.
    const runtime = await testRuntime();
    const status = await runtime.optimizer.getStatus();
    assert.equal(status.mode, "mock");
    assert.equal((await runtime.optimizer.getHealth()).mode, "mock");
    await runtime.stop();
  });
});
