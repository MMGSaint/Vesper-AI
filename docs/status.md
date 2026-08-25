# Feature status

| Area | Classification |
| --- | --- |
| Config, logging, permissions, tool registry | IMPLEMENTED + TESTED |
| Agent intents, confirmation, recovery | IMPLEMENTED + TESTED |
| Memory (remember/search/update/forget/summarize) | IMPLEMENTED + TESTED |
| Workspaces | IMPLEMENTED + TESTED |
| Knowledge search (keyword/BM25-lite) | IMPLEMENTED + TESTED |
| Model router + echo/scripted providers | IMPLEMENTED + TESTED |
| Ollama / llama.cpp OpenAI-compatible clients | IMPLEMENTED + HARDWARE DEPENDENT |
| Optional xAI provider | IMPLEMENTED + TESTED (preview-only, not required) |
| Hardware simulator (9950X / 7900 XT / 96 GB) | MOCKED / SIMULATED |
| Live CPU/RAM of current host | IMPLEMENTED + TESTED (no GPU/temps) |
| AMD telemetry, clocks, power | NOT IMPLEMENTED (hardware-dependent) |
| Optimizer adapter (mock) | MOCKED / SIMULATED |
| Optimizer HTTP adapter | DOCUMENTED BUT NOT IMPLEMENTED (no real API yet) |
| Windows tray / Win32 launch | MOCKED / SIMULATED |
| Voice STT/TTS | DOCUMENTED BUT NOT IMPLEMENTED |
| Embedding RAG | DOCUMENTED BUT NOT IMPLEMENTED |
| First-boot discovery scaffolding | IMPLEMENTED + TESTED (probes; no benches) |
| Model benchmarks on target PC | NOT IMPLEMENTED — machine was off |
