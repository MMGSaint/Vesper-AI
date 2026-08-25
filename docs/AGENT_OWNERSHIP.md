# Agent ownership

Specialist agents may work in parallel only on non-overlapping surfaces. The orchestrator integrates.

| Agent | Owns | Does not own |
| --- | --- | --- |
| Orchestrator | Architecture, integration, regression, GitHub health, stopping criteria | Implementation of specialist internals once assigned |
| Windows | Runtime, tray, notifications, startup, installer, uninstall, packaging, recovery | Optimizer internals, Mortis |
| Local AI | Ollama, llama.cpp, Vulkan/ROCm probes, routing, health, benchmark harness, first-boot model setup | Fake benchmark numbers, cloud-mandatory paths |
| Memory / Knowledge | Persistence, recovery, RAG, embeddings, provenance, approved sources | Arbitrary disk indexing |
| Optimizer integration | Adapter, transport, schema, retries, timeouts, audit, unavailable behavior | The optimizer implementation itself |
| Voice | STT/TTS abstractions, PTT, interruption, diagnostics, fallback to text | Claiming microphone validation on this host |
| QA / Security | Regression, hostile tests, permission bypass attempts, secret scanning, CI | Shipping known regressions |

## Integration rules

1. Shared types live in `src/vesper/types.ts` and `src/vesper/config.ts`. Changes there are orchestrator-owned.
2. Tools register only through `ToolRegistry` and the permission gate.
3. If two agents need the same file, serialize. Do not merge competing schemas.
4. Hardware-dependent code must keep a mock/simulated path so tests run on Linux CI.
