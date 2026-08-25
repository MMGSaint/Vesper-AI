# Project status

Phase: **software-only completion boundary**

Latest local validation: Vesper unit/integration suite passing; typecheck and production build run in this environment.

## Completed (software-only)

- Agent loop with deterministic permissions
- Persistent memory with session/persistent split, serialized writes, provenance
- Workspaces including Mortis as a workspace only
- Approved-root knowledge with BM25 + local lexical-hash embeddings, chunking, provenance
- Model-agnostic routing with fallback
- Mock optimizer + HTTP adapter (timeouts, retries, malformed handling)
- Simulated target hardware
- First-boot discovery (including runtime deps, app catalog, benchmark refusal)
- Diagnostics, audit logging with secret redaction
- Windows runtime foundation, tray menu, packaging scripts, reset path
- Idle scheduler that skips GPU-heavy ticks
- Voice interfaces, PTT/interrupt session, simulated provider
- Gaming / VRChat / OBS adapters with observed vs inferred conclusions
- Benchmark harness that refuses fake numbers
- Confined filesystem tools
- Hostile security tests
- GitHub Actions CI, Dependabot, agent docs

## Active

None that can be completed without the physical PC or the real optimizer API.

## Blocked / hardware-dependent

- Live AMD telemetry, clocks, power, temperatures
- Real Vulkan vs ROCm benchmarks on the 7900 XT
- Native Windows tray / HKCU startup / toast validation
- Microphone/speaker validation
- Actual Ollama/llama.cpp model assignment on the target PC
- Real optimizer connectivity

## Next on the real PC

1. Install Node 22 and run `packaging/windows/install.ps1`
2. Launch `vesper-host.cmd`
3. Read `%LOCALAPPDATA%\Vesper\logs\first-boot.txt`
4. Install Ollama and/or llama.cpp Vulkan
5. Re-run first-boot and the benchmark harness
6. Point the optimizer adapter at the real API when it is published

See `docs/status.md` for the feature classification table.
