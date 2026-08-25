# Project status

Phase: **public repository hardening + software-only host reliability**

Latest commit on `main`: pending this cycle

Latest validation (local, this cycle):

- Vesper tests: run after implementation
- Typecheck: pending
- Hygiene: pending
- Production build: `tsc --noEmit`
- GitHub: public as `MMGSaint/Vesper-AI`

## Completed (software-only)

- Agent loop with deterministic permissions
- Persistent memory with session/persistent split, serialized writes, provenance
- Workspaces including Mortis as a workspace only
- Approved-root knowledge with BM25 + local lexical-hash embeddings, chunking, provenance
- Model-agnostic routing with fallback
- Mock optimizer + HTTP adapter (timeouts, retries, malformed handling)
- Simulated target hardware
- First-boot discovery (including runtime deps, app catalog, benchmark refusal)
- Diagnostics, doctor/self-check, audit logging with secret redaction and JSONL sink
- Pending confirmation persistence across host restarts
- Host CLI (`--diagnostics`, `--status`, `--health`, `--doctor`, `--config-check`)
- Config file load/save (`config/vesper.json`)
- Windows runtime foundation, tray menu, packaging scripts, reset path
- Idle scheduler that skips GPU-heavy ticks
- Voice interfaces, PTT/interrupt session, simulated provider
- Gaming / VRChat / OBS adapters with observed vs inferred conclusions
- Benchmark harness that refuses fake numbers
- Confined filesystem tools
- Hostile security tests
- GitHub Actions CI, CodeQL, Dependabot, secret scanning, push protection, main ruleset, agent docs

## Active

Public-repo hardening and remaining software-only reliability work.

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
3. Run `node --experimental-strip-types src/vesper/host/main.ts --doctor`
4. Read `%LOCALAPPDATA%\Vesper\logs\first-boot.txt`
5. Install Ollama and/or llama.cpp Vulkan
6. Re-run first-boot and the benchmark harness
7. Point the optimizer adapter at the real API when it is published

See `docs/status.md` for the feature classification table and `docs/GITHUB_SECURITY.md` for repository controls.
