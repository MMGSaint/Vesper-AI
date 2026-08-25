# Feature status

Use only: **IMPLEMENTED + TESTED**, **IMPLEMENTED + HARDWARE DEPENDENT**, **MOCKED / SIMULATED**, **DOCUMENTED BUT NOT IMPLEMENTED**.

| Area | Classification |
| --- | --- |
| Config, logging, permissions, tool registry | IMPLEMENTED + TESTED |
| Agent intents, confirmation, recovery | IMPLEMENTED + TESTED |
| Confirmation persistence across restarts | IMPLEMENTED + TESTED |
| Memory (remember/search/update/forget/summarize, session vs persistent, provenance, FileStorage, concurrency) | IMPLEMENTED + TESTED |
| Workspaces | IMPLEMENTED + TESTED |
| Knowledge search (keyword/BM25-lite + lexical-hash embeddings), chunking, provenance, source register/remove, path confinement | IMPLEMENTED + TESTED |
| Neural/GPU embedding models | DOCUMENTED BUT NOT IMPLEMENTED (provider abstraction exists) |
| Model router + echo/scripted providers | IMPLEMENTED + TESTED |
| Backend discovery (Ollama, llama.cpp, Vulkan preference, ROCm opt-in) | IMPLEMENTED + TESTED (probes; no benches on this host) |
| Ollama / llama.cpp OpenAI-compatible clients with timeouts | IMPLEMENTED + HARDWARE DEPENDENT |
| Optional xAI provider | IMPLEMENTED + TESTED (preview-only, not required) |
| Benchmark harness | IMPLEMENTED + TESTED (refuses fake numbers); live timings HARDWARE DEPENDENT |
| Hardware simulator (9950X / 7900 XT / 96 GB) | MOCKED / SIMULATED |
| Live CPU/RAM of current host | IMPLEMENTED + TESTED (no GPU/temps) |
| AMD telemetry, clocks, power | DOCUMENTED BUT NOT IMPLEMENTED |
| Optimizer adapter (mock) | MOCKED / SIMULATED |
| Optimizer HTTP adapter (timeouts, retries, malformed handling) | IMPLEMENTED + TESTED (no real optimizer API) |
| Optimizer cooperation (explain GPU/CPU bound, OBS/VRChat context) | IMPLEMENTED + TESTED (simulated context) |
| Windows background runtime, tray menu, pause/resume, startup preference | IMPLEMENTED + TESTED (logic); tray/startup apply is HARDWARE DEPENDENT |
| Windows toast notifications | MOCKED / SIMULATED on this host; HARDWARE DEPENDENT on Windows |
| Windows process listing via tasklist | IMPLEMENTED + TESTED (parser); live spawn is HARDWARE DEPENDENT |
| Installer / uninstaller / reset scripts | IMPLEMENTED + HARDWARE DEPENDENT (not executed on Windows here) |
| Voice STT/TTS (faster-whisper / Piper / Kokoro) | DOCUMENTED BUT NOT IMPLEMENTED for live audio; interfaces + PTT session + simulated provider TESTED |
| First-boot discovery + report | IMPLEMENTED + TESTED (probes; no benches) |
| Diagnostics report + doctor CLI | IMPLEMENTED + TESTED |
| Host CLI / config file / JSONL audit log | IMPLEMENTED + TESTED |
| Idle scheduler with gaming throttle | IMPLEMENTED + TESTED |
| Gaming / VRChat / OBS adapters | IMPLEMENTED + TESTED (simulated process list) |
| Confined filesystem tools | IMPLEMENTED + TESTED |
| MCP bridge | IMPLEMENTED + TESTED as disabled optional status; not a runtime dependency |
| GitHub Actions CI / CodeQL / Dependabot / secret scanning / push protection | IMPLEMENTED + TESTED (workflow files and GitHub settings) |
| Model benchmarks on target PC | DOCUMENTED BUT NOT IMPLEMENTED — machine was off |
