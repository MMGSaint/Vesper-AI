# Feature status

Use only: **IMPLEMENTED + TESTED**, **IMPLEMENTED + HARDWARE DEPENDENT**, **MOCKED / SIMULATED**, **DOCUMENTED BUT NOT IMPLEMENTED**.

"IMPLEMENTED + TESTED" means the behaviour is exercised by an automated test on a
development host. It never means anything ran on the target Windows PC.

## Core runtime

| Area | Classification |
| --- | --- |
| Config load/merge, logging, tool registry | IMPLEMENTED + TESTED |
| Deterministic permissions (default-deny on an unknown level) | IMPLEMENTED + TESTED |
| Tool argument validation against the advertised schema | IMPLEMENTED + TESTED |
| Agent loop, tool iteration, conversation history integrity | IMPLEMENTED + TESTED |
| Turn cancellation and serialized turns | IMPLEMENTED + TESTED |
| Context budgeting and tool-result truncation | IMPLEMENTED + TESTED |
| Confirmation flow, including persistence across restarts | IMPLEMENTED + TESTED |
| Interactive console (streaming, confirmations, memory/workspace commands) | IMPLEMENTED + TESTED |
| Diagnostics report + doctor CLI | IMPLEMENTED + TESTED |
| Idle scheduler with gaming throttle | IMPLEMENTED + TESTED |
| Structured audit log with redaction; write failure never kills the process | IMPLEMENTED + TESTED |

## Local AI

| Area | Classification |
| --- | --- |
| Model router, role routing, fallback, lazy re-probe | IMPLEMENTED + TESTED |
| Native Ollama provider (`/api/chat`, `/api/tags`, `/api/show`, `/api/ps`, `/api/embed`) | IMPLEMENTED + TESTED against a fake server; live inference HARDWARE DEPENDENT |
| OpenAI-compatible provider (llama.cpp server and similar) | IMPLEMENTED + TESTED against a fake server; live inference HARDWARE DEPENDENT |
| Token streaming and caller cancellation | IMPLEMENTED + TESTED |
| Whole stack over a real socket (streaming, native tool calls, permission gate) | IMPLEMENTED + TESTED |
| Backend discovery (Ollama, llama.cpp, Vulkan preference, ROCm opt-in) | IMPLEMENTED + TESTED (probes only) |
| Benchmark harness | IMPLEMENTED + TESTED — reports throughput only from provider token counters and TTFT only when a reply genuinely streamed; **no number in this repository came from the target PC** |
| Optional xAI provider | IMPLEMENTED + TESTED (preview only, never required) |
| Model benchmarks on the target PC | DOCUMENTED BUT NOT IMPLEMENTED — the machine was off |

## Memory and knowledge

| Area | Classification |
| --- | --- |
| Memory lifecycle (remember/search/update/forget/summarize/export/import) | IMPLEMENTED + TESTED |
| Scored memory retrieval over natural sentences | IMPLEMENTED + TESTED |
| Corrupt-entry resilience | IMPLEMENTED + TESTED |
| BM25 retrieval with IDF and length normalisation | IMPLEMENTED + TESTED |
| Incremental reindex, include/exclude globs, deletion handling | IMPLEMENTED + TESTED |
| Model-backed embeddings via a local backend, with lexical fallback | IMPLEMENTED + TESTED against a fake backend; live embedding model HARDWARE DEPENDENT |
| Approved-root confinement, including symlink resolution | IMPLEMENTED + TESTED |
| Workspaces | IMPLEMENTED + TESTED |

## Windows and host lifecycle

| Area | Classification |
| --- | --- |
| Background mode (no TTY), clean SIGTERM/SIGINT shutdown | IMPLEMENTED + TESTED |
| Single-instance lock with stale-lock reclaim | IMPLEMENTED + TESTED |
| Health file with pid and heartbeat; crash post-mortem on next start | IMPLEMENTED + TESTED |
| Windows adapter command construction and output parsing | IMPLEMENTED + TESTED against a fake runner |
| Windows process listing, app launch/close, HKCU startup, toasts | IMPLEMENTED + HARDWARE DEPENDENT — no Windows command has been executed |
| System tray (PowerShell WinForms NotifyIcon helper, documented line protocol) | IMPLEMENTED + HARDWARE DEPENDENT — **no icon has ever been displayed** |
| Installer / uninstaller / reset scripts | IMPLEMENTED + HARDWARE DEPENDENT — not executed on Windows |
| Installer and runtime agree on the config path | IMPLEMENTED + TESTED |
| Reproducible package artifact (`npm run package`) | IMPLEMENTED + TESTED — deterministic zip, verified by an independent parser |
| CI on ubuntu-latest **and** windows-latest | IMPLEMENTED + TESTED |

## Specialists

| Area | Classification |
| --- | --- |
| Hardware simulator (9950X / 7900 XT / 96 GB) | MOCKED / SIMULATED |
| Live CPU/RAM of the current host | IMPLEMENTED + TESTED (no GPU, no temperatures) |
| AMD telemetry, clocks, power | DOCUMENTED BUT NOT IMPLEMENTED |
| Optimizer adapter (mock) | MOCKED / SIMULATED |
| Optimizer HTTP adapter (timeouts, retries, malformed handling, SSRF refusal) | IMPLEMENTED + TESTED — **no real optimizer API exists to talk to** |
| Optimizer audit trail for state-changing calls | IMPLEMENTED + TESTED |
| Optimizer cooperation (bound explanation, OBS/VRChat context) | IMPLEMENTED + TESTED against simulated context |
| Event log persistence and time correlation | IMPLEMENTED + TESTED |
| Gaming / VRChat / OBS adapters | IMPLEMENTED + TESTED against a simulated process list |
| OBS WebSocket integration | DOCUMENTED BUT NOT IMPLEMENTED |
| MCP client | DOCUMENTED BUT NOT IMPLEMENTED — `integrations/mcp.ts` reports status only; it is not an MCP client and no server is contacted |

## Voice

| Area | Classification |
| --- | --- |
| STT/TTS provider abstraction, push-to-talk session, interrupt | IMPLEMENTED + TESTED |
| Local backends driven as subprocesses (whisper CLI, Piper) | IMPLEMENTED + TESTED against a fake binary, including argv safety |
| Audio buffer → text, text → audio buffer | IMPLEMENTED + TESTED |
| Microphone capture and speaker playback | DOCUMENTED BUT NOT IMPLEMENTED — Vesper opens no audio device |
| Wake word | DOCUMENTED BUT NOT IMPLEMENTED (deliberately out of scope for the MVP) |

## Repository and companions

| Area | Classification |
| --- | --- |
| GitHub Actions CI / CodeQL / Dependabot / secret scanning / push protection | IMPLEMENTED + TESTED |
| Client protocol v1 (scopes, sessions, in-process gateway) | IMPLEMENTED + TESTED |
| Client network transport / pairing / LAN TLS | DOCUMENTED BUT NOT IMPLEMENTED |
