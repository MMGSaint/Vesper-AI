# Local AI stack

Researched against current AMD RDNA3 practice. **No throughput numbers in this file are measurements from the target PC.** The target machine was powered off during development.

## Preferred order on RX 7900 XT (20 GB)

1. **llama.cpp + Vulkan** — currently the most practical, well-supported AMD path; often easier and competitive with ROCm on RDNA3
2. **Ollama** — best operator UX (model pull/list). Prefer its Vulkan backend when both HIP and Vulkan are present; Ollama may otherwise prefer ROCm
3. **llama.cpp + ROCm/HIP** — AMD publishes validated Windows binaries for gfx110X; keep as a probed alternative, not an assumed winner

ROCm 7.x exists as a combined Windows/Linux line. Do not assume it is faster than Vulkan on this card without a local benchmark.

## Endpoints (defaults)

| Provider | Default | Notes |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` | OpenAI-compatible |
| llama.cpp server | `http://127.0.0.1:8088/v1` | Not 8080 — reserved for the console |
| Optional xAI | `https://api.x.ai/v1` | Preview/dev only |

## Candidate models (unbenchmarked)

These are **starting candidates** for 20 GB VRAM + 96 GB RAM, not proven defaults:

- fast: Qwen2.5 3B / Llama 3.2 3B class
- everyday: Qwen2.5 14B Q4/Q5
- reasoning: Qwen2.5 32B Q4 with GPU+CPU split if needed
- coding: Qwen2.5-Coder 14B/32B
- large: 32B–70B quantized with offload

First-boot must discover what is actually installed and only then bind roles.

## First-boot procedure (target PC)

1. Discover CPU, GPU, VRAM, RAM, OS
2. Probe Ollama, llama.cpp Vulkan, llama.cpp ROCm
3. List installed models
4. Run a local bench harness (not implemented against real hardware yet)
5. Assign roles and write a capability profile
6. Fall back to echo/tools if nothing local is reachable
