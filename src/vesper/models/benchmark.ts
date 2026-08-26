import type { CompletionRequest, FeatureStatus } from "../types.ts";
import type { AnyProvider } from "./router.ts";

export interface BenchmarkSample {
  model: string;
  provider: string;
  loadSuccess: boolean;
  /**
   * Measured only when the backend genuinely streamed and a first delta was observed.
   * `null` means the transport did not stream, so TTFT was never observable - it is
   * never back-filled with the total completion time.
   */
  timeToFirstTokenMs: number | null;
  /**
   * Derived only from provider-reported token counters. `null` means the backend did
   * not report `eval_count`, so throughput is unknown. Vesper does not estimate tokens
   * from character counts and present the result as a measurement.
   */
  tokensPerSecond: number | null;
  /** Where the token count came from, so a reader can judge the number. */
  tokenSource: "provider-counters" | "unreported";
  /** Provider-reported completion tokens, when available. */
  completionTokens: number | null;
  /** Provider-reported model load time, when available. */
  loadDurationMs: number | null;
  /** Wall-clock duration of the whole call, measured locally. Always real. */
  totalMs: number;
  outputChars: number;
  streamed: boolean;
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
        reason:
          "Real local completions were timed on this host. Throughput is reported only where the backend returned token counters, and time-to-first-token only where the reply genuinely streamed. These numbers are from this host, not from the target PC.",
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let firstDeltaAt: number | null = null;
  const started = Date.now();

  const request: CompletionRequest = {
    messages: [{ role: "user", content: prompt }],
    role: "fast",
    maxTokens: 64,
    temperature: 0,
    signal: controller.signal,
    // Asking for deltas is what makes time-to-first-token measurable at all.
    onDelta: () => {
      if (firstDeltaAt === null) firstDeltaAt = Date.now();
    },
  };

  const failed = (error: string, totalMs: number): BenchmarkSample => ({
    model,
    provider: provider.id,
    loadSuccess: false,
    timeToFirstTokenMs: null,
    tokensPerSecond: null,
    tokenSource: "unreported",
    completionTokens: null,
    loadDurationMs: null,
    totalMs,
    outputChars: 0,
    streamed: false,
    error,
  });

  try {
    const result = await provider.complete(request, model);
    const totalMs = Date.now() - started;
    if (result.unavailable || result.aborted || !result.text.trim()) {
      return failed(result.error ?? "empty or unavailable completion", totalMs);
    }

    const completionTokens = result.usage?.completionTokens ?? null;
    // Prefer the backend's own generation timer; fall back to wall clock, which is
    // still a real measurement, just a slightly pessimistic one.
    const generationMs = result.usage?.evalDurationMs ?? totalMs;
    const tokensPerSecond =
      completionTokens !== null && completionTokens > 0 && generationMs > 0
        ? Number(((completionTokens * 1000) / generationMs).toFixed(2))
        : null;

    return {
      model,
      provider: provider.id,
      loadSuccess: true,
      timeToFirstTokenMs:
        result.streamed && firstDeltaAt !== null ? firstDeltaAt - started : null,
      tokensPerSecond,
      tokenSource: completionTokens === null ? "unreported" : "provider-counters",
      completionTokens,
      loadDurationMs: result.usage?.loadDurationMs ?? null,
      totalMs,
      outputChars: result.text.length,
      streamed: Boolean(result.streamed),
      error: null,
    };
  } catch (error) {
    return failed(
      error instanceof Error ? error.message : String(error),
      Date.now() - started,
    );
  } finally {
    clearTimeout(timer);
  }
}

