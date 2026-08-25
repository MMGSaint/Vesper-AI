# Vesper agent instructions

Vesper is a **local-first personal AI assistant** for a Windows PC. This file is the operating contract for development agents working in this repository.

## Identity

- **Vesper** = personal assistant (this repository)
- **Mortis** = a separate RP/world/project ecosystem. Do not rename, migrate, copy, or absorb it.
- **PC Optimizer** = a separate specialist system. Do not rebuild, replace, or absorb it.

Vesper coordinates. Specialists stay specialists.

## Repository boundaries

This is the dedicated Vesper repository. Keep it independently maintainable.

Do **not**:

- modify Mortis production or canon
- invent a production optimizer API
- make cloud AI mandatory at runtime
- index arbitrary filesystem content
- claim physical AMD/Windows/audio validation that did not happen

Vesper may talk to Mortis later through APIs, adapters, curated files, or the Mortis workspace.

## Architecture

```
MODEL → AGENT → PERMISSION SYSTEM → TOOL → RESULT → AGENT → MODEL
```

Permission levels: `read` | `safe` | `confirm` | `never`.

The model cannot relax permissions. High-risk tools stay never-autonomous.

Core lives in `src/vesper/`. The App Builder web console is an optional control surface. Production runtime is `src/vesper/host`.

## Local-first inference

Supported providers:

1. Ollama (`http://127.0.0.1:11434/v1`)
2. llama.cpp (`http://127.0.0.1:8088/v1`) — Vulkan preferred on AMD RDNA3
3. llama.cpp ROCm/HIP — secondary (`VESPER_LLAMA_BACKEND=rocm`)
4. Echo — tests / degraded mode
5. Optional xAI — preview only, never a production dependency

Roles: `fast`, `everyday`, `reasoning`, `coding`, `large`.

The benchmark harness **refuses to invent numbers** when no real local generation occurred.

## Target hardware (not physically validated here)

AMD Ryzen 9 9950X + Radeon RX 7900 XT 20 GB + 96 GB RAM + Windows.

The target PC is currently **off**. Use capability discovery. Do not hard-code Vesper so it can only run on that machine.

## Agent ownership

See `docs/AGENT_OWNERSHIP.md`.

Independent agents must not edit the same subsystem simultaneously. Correctness beats parallelism.

## Development commands

```bash
npm test
npm run typecheck
npm run security
node --experimental-strip-types src/vesper/host/main.ts
```

Core tests do not require a local LLM.

## Security rules

- Never log passwords, API keys, tokens, or credentials.
- Never silently transmit private memory/files to cloud systems.
- Knowledge roots must stay inside `approvedRoots`.
- Subprocess spawn is allowlisted by executable name. No shell strings.
- MCP, if present, stays behind the permission gate and is never required.

## Git rules

- Do not weaken the existing test suite to make new work easier.
- After meaningful subsystem changes: tests, typecheck, production/build check.
- Do not commit secrets.
- Do not deploy to Mortis production.

## Hardware assumptions

Classify every feature as one of:

- IMPLEMENTED + TESTED
- IMPLEMENTED + HARDWARE DEPENDENT
- MOCKED / SIMULATED
- DOCUMENTED BUT NOT IMPLEMENTED

## Autonomous workflow

INSPECT → PLAN → IMPLEMENT → TEST → DIAGNOSE → FIX → RETEST → DOCUMENT → COMMIT → PUSH → CONTINUE

Stop only when remaining work is blocked by the physical PC or the unpublished optimizer API.

## Completion criteria

See `docs/DEFINITION_OF_DONE.md` and `docs/PROJECT_STATUS.md`.
