# Feature status

Use only: **IMPLEMENTED + TESTED**, **IMPLEMENTED + HARDWARE DEPENDENT**, **MOCKED / SIMULATED**, **DOCUMENTED BUT NOT IMPLEMENTED**.

| Area | Classification |
| --- | --- |
| Config, logging, permissions, tool registry | IMPLEMENTED + TESTED |
| Agent intents, confirmation, recovery | IMPLEMENTED + TESTED |
| Memory (remember/search/update/forget/summarize, session vs persistent, FileStorage, concurrency) | IMPLEMENTED + TESTED |
| Workspaces | IMPLEMENTED + TESTED |
| Knowledge search (keyword/BM25-lite), source register/remove, path confinement | IMPLEMENTED + TESTED |
| Embedding RAG | DOCUMENTED BUT NOT IMPLEMENTED (provider abstraction + local BM25 fallback) |
| Model router + echo/scripted providers | IMPLEMENTED + TESTED |
| Backend discovery (Ollama, llama.cpp, Vulkan preference, ROCm opt-in) | IMPLEMENTED + TESTED (probes; no benches) |
| Ollama / llama.cpp OpenAI-compatible clients with timeouts | IMPLEMENTED + HARDWARE DEPENDENT |
| Optional xAI provider | IMPLEMENTED + TESTED (preview-only, not required) |
| Hardware simulator (9950X / 7900 XT / 96 GB) | MOCKED / SIMULATED |
| Live CPU/RAM of current host | IMPLEMENTED + TESTED (no GPU/temps) |
| AMD telemetry, clocks, power | DOCUMENTED BUT NOT IMPLEMENTED |
| Optimizer adapter (mock) | MOCKED / SIMULATED |
| Optimizer HTTP adapter (timeouts, retries, malformed handling) | IMPLEMENTED + TESTED (no real optimizer API) |
| Optimizer cooperation (explain GPU/CPU bound, OBS/VRChat context) | IMPLEMENTED + TESTED (simulated context) |
| Windows background runtime, tray menu, pause/resume, startup preference | IMPLEMENTED + TESTED (logic); tray/startup apply is HARDWARE DEPENDENT |
| Windows toast notifications | MOCKED / SIMULATED on this host; HARDWARE DEPENDENT on Windows |
| Windows process listing via tasklist | IMPLEMENTED + TESTED (parser); live spawn is HARDWARE DEPENDENT |
| Voice STT/TTS (faster-whisper / Piper / Kokoro) | DOCUMENTED BUT NOT IMPLEMENTED for live audio; interfaces + simulated provider TESTED |
| First-boot 16-step discovery + report | IMPLEMENTED + TESTED (probes; no benches) |
| Diagnostics report | IMPLEMENTED + TESTED |
| Production host + Windows packaging scripts | IMPLEMENTED + TESTED (host); packaging apply is HARDWARE DEPENDENT |
| Model benchmarks on target PC | DOCUMENTED BUT NOT IMPLEMENTED — machine was off |
