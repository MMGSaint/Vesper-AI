# Model benchmark harness

IMPLEMENTED + TESTED. Live timings on the target PC are HARDWARE DEPENDENT and have
never been produced.

The harness in `src/vesper/models/benchmark.ts` probes only local providers that report
available, then times one small completion against each.

## What it reports, and what it refuses

| Field | Source |
| --- | --- |
| `tokensPerSecond` | Provider-reported completion tokens over provider-reported generation time. `null` when the backend reports no counters. |
| `timeToFirstTokenMs` | Measured from the first streamed delta. `null` when the reply did not stream, because TTFT is then unobservable. |
| `completionTokens`, `loadDurationMs` | Straight from the backend. `null` when absent. |
| `totalMs`, `outputChars` | Measured locally. Always real. |
| `tokenSource` | `provider-counters` or `unreported`, so a reader can judge the number. |

This file previously reported total latency under the name `timeToFirstTokenMs` and
derived throughput from `characters / 4`. Both were estimates presented as
measurements, in the one file whose purpose is refusing fake numbers. Vesper now
reports a measurement or `null`, never an estimate.

Ollama's `/api/chat` returns `eval_count` and `eval_duration`, which is what makes real
throughput reporting possible at all.

On a host with no backend, `benchmark_run` returns a refused report and records nothing.
It will never crown a model fastest without a real run.
