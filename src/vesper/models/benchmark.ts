import type { CompletionRequest, FeatureStatus } from "../types.ts";
import type { AnyProvider } from "./router.ts";

export interface BenchmarkSample {
  model: string;
  provider: string;
  loadSuccess: boolean;
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;
  outputChars: number;
  error: string | null;
}

export interface BenchmarkReport {
  ran: boolean;
  refused: boolean;
  reason: string;
  startedAt: string | null;
  finishedAt: string | null;
  samples: BenchmarkSample[];
  status: FeatureStatus;
}

export interface BenchmarkHarness {
  run(input?: { prompt?: string; timeoutMs?: number }): Promise<BenchmarkReport>;
}

const REFUSED: BenchmarkReport = {
  ran: false,
  refused: true,
  reason:
    "No local inference backend completed a real generation. Refusing to invent load, TTFT, or throughput numbers.",
  startedAt: null,
  finishedAt: null,
  samples: [],
  status: "documented_not_implemented",
};

export function emptyBenchmarkReport(reason = REFUSED.reason): BenchmarkReport {
  return { ...REFUSED, reason, samples: [] };
}

export function createBenchmarkHarness(input: {
  providers: AnyProvider[];
  models?: { provider: string; model: string }[];
}): BenchmarkHarness {
  return {
    async run(options) {
      const prompt = options?.prompt ?? "Reply with the single word: pong.";
      const timeoutMs = options?.timeoutMs ?? 4000;
      const startedAt = new Date().toISOString();
      const candidates = input.providers.filter(
        (provider) => provider.kind === "local" && provider.isAvailable() && provider.id !== "echo",
      );
      if (candidates.length === 0) {
        return emptyBenchmarkReport(
          "No reachable local inference backend was available. Benchmark was not run. No fake numbers were recorded.",
        );
      }

      const samples: BenchmarkSample[] = [];
      for (const provider of candidates) {
        const model =
          input.models?.find((item) => item.provider === provider.id)?.model ?? provider.id;
        const sample = await timeCompletion(provider, model, prompt, timeoutMs);
        samples.push(sample);
      }

      const anySuccess = samples.some((sample) => sample.loadSuccess);
      if (!anySuccess) {
        return {
          ran: false,
          refused: true,
          reason:
            "Local backends were probed but none completed a generation. Refusing to report fabricated throughput.",
          startedAt,
          finishedAt: new Date().toISOString(),
          samples,
          status: "implemented_hardware_dependent",
        };
      }

      return {
        ran: true,
        refused: false,
        reason: "Real local completions were timed. These numbers are from this host, not the target PC.",
        startedAt,
        finishedAt: new Date().toISOString(),
        samples,
        status: "implemented_hardware_dependent",
      };
    },
  };
}

async function timeCompletion(
  provider: AnyProvider,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<BenchmarkSample> {
  const request: CompletionRequest = {
    messages: [{ role: "user", content: prompt }],
    role: "fast",
    maxTokens: 16,
    temperature: 0,
  };
  const started = Date.now();
  try {
    const result = await Promise.race([
      provider.complete(request, model),
      sleepReject(timeoutMs, "benchmark timed out"),
    ]);
    const elapsed = Date.now() - started;
    if (result.unavailable || !result.text.trim()) {
      return {
        model,
        provider: provider.id,
        loadSuccess: false,
        timeToFirstTokenMs: null,
        tokensPerSecond: null,
        outputChars: 0,
        error: result.error ?? "empty or unavailable completion",
      };
    }
    const chars = result.text.length;
    const approxTokens = Math.max(1, Math.round(chars / 4));
    return {
      model,
      provider: provider.id,
      loadSuccess: true,
      timeToFirstTokenMs: elapsed,
      tokensPerSecond: elapsed > 0 ? Number(((approxTokens * 1000) / elapsed).toFixed(2)) : null,
      outputChars: chars,
      error: null,
    };
  } catch (error) {
    return {
      model,
      provider: provider.id,
      loadSuccess: false,
      timeToFirstTokenMs: null,
      tokensPerSecond: null,
      outputChars: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sleepReject(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
