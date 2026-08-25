# Vesper — agent instructions

Vesper is a **local-first personal AI assistant** for a Windows PC. Prefer `AGENTS.md` as the operating contract. This file is retained as project memory.

## Identity

- **Vesper** = personal assistant (this repository)
- **Mortis** = a separate RP/world/project ecosystem. Do not rename, migrate, copy, or absorb it.
- **PC Optimizer** = a separate specialist system. Do not rebuild, replace, or absorb it.

Vesper coordinates. Specialists stay specialists.

## Repository boundary

Public source of truth: https://github.com/MMGSaint/Vesper-AI

Keep this tree independently maintainable. Production runtime is `src/vesper/host`.

Vesper may talk to Mortis later through APIs, adapters, curated files, or the Mortis workspace. It must not depend on hidden chat history from another project.

## Architecture rules

```
MODEL → AGENT → PERMISSION SYSTEM → TOOL → RESULT → AGENT → MODEL
```

- The language model never has unrestricted OS authority.
- Every action goes through the tool registry and a deterministic permission gate.
- Permission levels: `read` | `safe` | `confirm` | `never`.
- The model cannot relax permissions. Overrides may only restrict further.
- High-risk tools (`disk_wipe`, credential access, security bypass, dangerous hardware control) are **never autonomous**.
- Tray/host controls cannot bypass that gate to run OS tools.

Core lives in `src/vesper/` (framework-agnostic TypeScript).

## Local-first

After setup, Vesper must operate without cloud AI.

Supported providers (model-agnostic):

1. **Ollama** (`http://127.0.0.1:11434/v1`) — local, preferred for model management
2. **llama.cpp** (`http://127.0.0.1:8088/v1`) — local; **Vulkan is the preferred AMD RDNA3 path**
3. **llama.cpp ROCm/HIP** — secondary AMD path (`VESPER_LLAMA_BACKEND=rocm`); discoverable, not assumed faster
4. **Echo** — tests / degraded mode when nothing local is up
5. **Optional cloud (xAI)** — development/preview only, never a production dependency

Do not hard-bind Vesper to one model. Roles: `fast`, `everyday`, `reasoning`, `coding`, `large`.

Do **not** fabricate benchmark numbers. First-boot on the physical PC must discover backends and models, then configure.

## Target hardware (not yet physically validated)

- CPU: AMD Ryzen 9 9950X
- GPU: AMD Radeon RX 7900 XT (20 GB)
- RAM: 96 GB
- OS: Windows

The target machine has been **off** during development. Hardware features are simulated unless `hardware.mode` is live. Never claim physical validation that did not happen.

Use hardware discovery + capability detection. Do not hard-code so Vesper can only run on that PC.

## Optimizer relationship

Adapter interface (`src/vesper/specialists/optimizer.ts`):

- `getStatus` `getTelemetry` `getCurrentProfile` `getPerformanceState`
- `analyze` `requestOptimization` `requestRollback`
- `getLastAction` `getOptimizationResult` `getHealth`

Current implementation: **mock**. A live HTTP adapter exists with timeouts/retries/schema checks for when the real optimizer API is published. Do not invent a fictional production API and mark it complete.

Vesper must never claim an optimization happened unless the adapter returns `accepted: true`.

If the optimizer is down, Vesper still works as an assistant.

## Mortis relationship

Workspace `mortis` exists. Knowledge source `mortis-approved` is opt-in and workspace-scoped. No canon dump.

## Development commands

```bash
npm test
npm run typecheck
npm run security
npm run hygiene
npm run build
node --experimental-strip-types src/vesper/host/main.ts --doctor --skip-discovery
```

Core tests do not require a local LLM.

Windows packaging: `packaging/windows/install.ps1` (not executed in this Linux environment).

## Important constraints

- Never log passwords, API keys, tokens, or credentials.
- Never silently transmit private memory/files to cloud systems.
- Voice is modular and optional (faster-whisper / Piper / Kokoro).
- Windows tray, startup, and live AMD telemetry are hardware-dependent.
- Idle behavior must stay event-driven and cheap — this PC also games, streams, and runs VR.
- Do not blindly index the whole disk. Knowledge roots must stay inside `approvedRoots`.
- This repository is public. Treat every commit as world-readable.

## Status classification required in reports

Use only: **IMPLEMENTED + TESTED**, **IMPLEMENTED + HARDWARE DEPENDENT**, **MOCKED / SIMULATED**, **DOCUMENTED BUT NOT IMPLEMENTED**.
