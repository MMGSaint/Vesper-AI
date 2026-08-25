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
| Ollama | `http://127.0.0.1:11434/v1` | OpenAI-compatible |
| llama.cpp server | `http://127.0.0.1:8088/v1` | Not 8080 — reserved for the console |
| Optional xAI | `https://api.x.ai/v1` | Preview/dev only |

Discovery lists `/v1/models` with short timeouts. Completions abort after 60s so a hung backend cannot freeze the assistant.

## Candidate models (unbenchmarked)

These are **starting candidates** for 20 GB VRAM + 96 GB RAM, not proven defaults:

- fast: Qwen2.5 3B / Llama 3.2 3B class
- everyday: Qwen2.5 14B Q4/Q5
- reasoning: Qwen2.5 32B Q4 with GPU+CPU split if needed
- coding: Qwen2.5-Coder 14B/32B
- large: 32B–70B quantized with offload

First-boot must discover what is actually installed and only then bind roles.
