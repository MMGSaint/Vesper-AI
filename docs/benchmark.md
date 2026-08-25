# Model benchmark harness

IMPLEMENTED + TESTED for the refusal path. Live timings are IMPLEMENTED + HARDWARE DEPENDENT.

The harness in `src/vesper/models/benchmark.ts`:

- probes only local providers that report available
- times a tiny completion when one actually returns text
- **refuses to invent** TTFT, throughput, or VRAM numbers when no generation occurred

On this development host, `benchmark_run` returns a refused report. On the target PC, first-boot can invoke it after Ollama or llama.cpp is up.

It will not auto-crown a model as fastest without a real run.
