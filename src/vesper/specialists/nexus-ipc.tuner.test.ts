import { describe, expect, it } from "vitest";

import { createNexusIpcOptimizerAdapter } from "../../src/vesper/specialists/nexus-ipc.ts";

describe("NEXUS IPC tuner adapter", () => {
  it("maps a completed tuner run without confusing inconclusive with durable change", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const adapter = createNexusIpcOptimizerAdapter({
      endpoint: "\\\\.\\pipe\\nexus-vesper",
      token: "test-token",
      clientFactory: () => ({
        call: async (method: string, params?: Record<string, unknown>) => {
          calls.push({ method, params });
          return {
            ok: true as const,
            fidelity: "live" as const,
            latencyMs: 1,
            result: {
              status: "inconclusive",
              applicationId: "squad",
              detail: "No candidate cleared the practical threshold.",
              fingerprint: { value: "a".repeat(64) },
              trials: [],
              candidates: [],
              winner: null,
              score: { estimate: null, low: null, high: null, samples: 0, resamples: 0, keep: false },
            },
          };
        },
      }),
    });

    const result = await adapter.requestExperiment!({
      applicationId: "squad",
      repetitions: 3,
      maxCandidates: 6,
      practicalThresholdPercent: 1,
    });

    expect(result.accepted).toBe(true);
    expect(result.kept).toBe(false);
    expect(result.summary).toContain("No candidate");
    expect(calls[0]?.method).toBe("runExperiment");
    expect(calls[0]?.params).toEqual({
      applicationId: "squad",
      repetitions: 3,
      maxCandidates: 6,
      practicalThresholdPercent: 1,
    });
  });
});
