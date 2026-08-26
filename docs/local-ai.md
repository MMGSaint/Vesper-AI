# Local AI stack

Researched against current AMD RDNA3 practice. **No throughput numbers in this file are measurements from the target PC.** The target machine was powered off during development.

## Preferred order on RX 7900 XT (20 GB)

1. **llama.cpp + Vulkan** — currently the most practical, well-supported AMD path; often easier and competitive with ROCm on RDNA3
2. **Ollama** — best operator UX (model pull/list). Prefer its Vulkan backend when both HIP and Vulkan are present; Ollama may otherwise prefer ROCm
3. **llama.cpp + ROCm/HIP** — secondary AMD path; probed only when `VESPER_LLAMA_BACKEND=rocm`
4. **CPU offload** — fallback for models that do not fit in 20 GB VRAM; not auto-selected without a benchmark

ROCm is never assumed faster than Vulkan.

## Endpoints (defaults)

| Provider | Default | Notes |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` | Reached through its **native** API; a `/v1` suffix is stripped |
| llama.cpp server | `http://127.0.0.1:8088/v1` | Not 8080 — reserved for the console |
| Optional xAI | `https://api.x.ai/v1` | Preview/dev only |

Discovery uses short timeouts. Completions abort on a timeout, and on a caller's
cancellation, so neither a hung backend nor a long reply can freeze the assistant.

## Why Ollama is native, not OpenAI-compatible

The compat shim works, but it hides everything Vesper needs to make local-first
decisions:

| Endpoint | What it gives Vesper |
| --- | --- |
| `/api/tags` | installed models with parameter size and quantization |
| `/api/show` | the real context length per model |
| `/api/ps` | which models are resident, and how much VRAM they hold |
| `/api/chat` | native tool calling, NDJSON streaming, and token counters |
| `/api/embed` | local embeddings without running a second service |

The token counters matter for honesty: they are the only way Vesper can report
throughput as a measurement instead of an estimate. Ollama issues no tool-call ids, so
stable local ones are synthesized.

llama.cpp's server and anything else OpenAI-compatible are reached through
`openai-compat.ts`, which streams over SSE and reassembles tool-call argument fragments
by index.

## Streaming and cancellation

`CompletionRequest` carries an `AbortSignal` and an `onDelta` callback. Providers that
can stream do; those that cannot call `onDelta` once with the full text, so callers have
one code path. Cancelling is reported as `aborted`, never as a backend outage, and a
cancelled turn is never retried against a different provider.

Providers are re-probed lazily when no local backend appears available, rate limited so
an idle assistant never polls. A backend started *after* Vesper — the normal order when
Vesper launches at login — is picked up on the next turn without a restart.

## Benchmark harness

`src/vesper/models/benchmark.ts` times a real completion when a local backend is up. If none is reachable, it **refuses to invent** TTFT or tokens/sec.

## Candidate models (unbenchmarked)

These are **starting candidates** for 20 GB VRAM + 96 GB RAM, not proven defaults:

- fast: Qwen2.5 3B / Llama 3.2 3B class
- everyday: Qwen2.5 14B Q4/Q5
- reasoning: Qwen2.5 32B Q4 with GPU+CPU split if needed
- coding: Qwen2.5-Coder 14B/32B
- large: 32B–70B quantized with offload

First-boot must discover what is actually installed and only then bind roles.
