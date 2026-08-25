# Project status

Phase: **public repository hardening complete; remaining work is hardware-dependent**

Latest commit on `main`: `cd99538`

Latest validation:

- Vesper tests: **118/118 passing**
- Typecheck: passing
- Hygiene: passing
- Security tests: 14/14
- Production build: `tsc --noEmit` passing
- GitHub CI: **passing** — [run 32830140415](https://github.com/MMGSaint/Vesper-AI/actions/runs/32830140415)
- CodeQL advanced: **passing** — [run 32830140453](https://github.com/MMGSaint/Vesper-AI/actions/runs/32830140453)
- CodeQL open alerts: **0** (17 fixed)
- Secret scanning alerts: **0**
- Dependabot alerts: **0**

## Completed (software-only)

- Agent loop with deterministic permissions
- Persistent memory with session/persistent split, serialized writes, provenance, export/import
- Workspaces including Mortis as a workspace only
- Approved-root knowledge with BM25 + local lexical-hash embeddings, chunking, provenance
- Model-agnostic routing with fallback
- Mock optimizer + HTTP adapter (timeouts, retries, malformed handling)
- Simulated target hardware
- First-boot discovery (including runtime deps, app catalog, benchmark refusal)
- Diagnostics, doctor/self-check, audit logging with secret redaction and JSONL sink
- Pending confirmation persistence across host restarts
- Host CLI (`--diagnostics`, `--status`, `--health`, `--doctor`, `--config-check`, `--export-memory`)
- Config file load/save (`config/vesper.json`)
- Windows runtime foundation, tray menu, packaging scripts, reset path
- Idle scheduler that skips GPU-heavy ticks
- Voice interfaces, PTT/interrupt session, simulated provider
- Gaming / VRChat / OBS adapters with observed vs inferred conclusions
- Benchmark harness that refuses fake numbers
- Confined filesystem tools (single-handle reads)
- Hostile security tests
- GitHub Actions CI, CodeQL (`security-extended`), Dependabot, secret scanning, push protection, main ruleset, agent docs

## Active

None that can be completed without the physical PC or the real optimizer API.

## Blocked / hardware-dependent

- Live AMD telemetry, clocks, power, temperatures
- Real Vulkan vs ROCm benchmarks on the 7900 XT
- Native Windows tray / HKCU startup / toast validation
- Microphone/speaker validation
- Actual Ollama/llama.cpp model assignment on the target PC
- Real optimizer connectivity

## GitHub-side notes

- Public repo: https://github.com/MMGSaint/Vesper-AI
- Previous name `Vesper-personal-assistant-` redirects here
- Secret scanning non-provider patterns and validity checks remain GitHub-disabled on this account
- Nightly maintenance workflow does not deploy
- `Protect main` blocks force-push/deletion; repository admins may bypass so autonomous work remains possible

## Next on the real PC

1. Install Node 22 and run `packaging/windows/install.ps1`
2. Launch `vesper-host.cmd`
3. Run `--doctor` and read `%LOCALAPPDATA%\Vesper\logs\first-boot.txt`
4. Install Ollama and/or llama.cpp Vulkan
5. Re-run first-boot and the benchmark harness
6. Point the optimizer adapter at the real API when it is published

See `docs/status.md` for the feature classification table and `docs/GITHUB_SECURITY.md` for repository controls.
