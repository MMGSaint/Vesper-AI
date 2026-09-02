---
name: vesper-architect
description: Maintain and reason about Vesper system architecture, boundaries, data flow, authority model, and long-term extensibility. Use for architecture decisions, new subsystems, major refactors, cross-component features, or questions about where behavior belongs.
metadata:
  author: Yeager
  short-description: Vesper architecture authority
  user-invocable: "true"
  pack: vesper-builder-pack
---

# Vesper Architect

Treat the repository as the source of truth for implementation facts. Treat approved project decisions/docs as the source of truth for intended behavior.

## Known conceptual boundaries
Maintain clear separation among:
- agent loop: model -> permissions -> tools -> result
- persistent local memory
- workspaces
- knowledge retrieval over approved sources
- model-agnostic routing
- local inference discovery/backends
- Windows runtime / background / tray / notifications
- security and permission enforcement
- optimizer integration adapters
- NEXUS, which is related to Vesper but remains a distinct component

These are conceptual anchors, not excuses to assume files/classes that may not exist. Verify actual names and implementations in the repo.

## Architectural principles
- Prefer stable interfaces over vendor lock-in.
- Keep provider/model selection behind routing/adapters.
- Keep policy enforcement outside the model's discretion where deterministic enforcement is possible.
- Keep external systems behind explicit adapters and clear trust boundaries.
- Keep persistent state inspectable, versioned when appropriate, and recoverable.
- Minimize coupling between UI/tray behavior and core agent logic.
- Preserve a software-only boundary when hardware, credentials, or private APIs are unavailable.

## Decision format
For meaningful architecture work, identify:
1. Current state evidenced by code.
2. Desired state.
3. Components affected.
4. Data/control flow.
5. Trust/security implications.
6. Migration/compatibility impact.
7. Verification plan.
8. Reversibility and rollback.

Do not redesign the whole project when a local change is sufficient.

## Repository anchors
Verify these existing surfaces before proposing new ones. Do not assume a file exists beyond this list without checking the tree.

- Operating contract — `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`
- Status and seams — `docs/PROJECT_STATUS.md`, `docs/architecture.md`, `docs/architecture-seams.md`, `docs/phase-2-runtime.md`, `docs/phase-3-runtime.md`
- Core loop — `src/vesper/agent.ts`, `src/vesper/runtime.ts`, `src/vesper/permissions.ts`, `src/vesper/tools/`
- Host and companion — `src/vesper/host/`, `src/vesper/client/` (`vesper.client`; in-process only, no inbound listener)
- Memory, knowledge, workspaces — `src/vesper/memory/`, `src/vesper/knowledge/`, `src/vesper/workspaces.ts`
- Inference — `src/vesper/models/` (Ollama, OpenAI-compatible llama.cpp, echo, optional cloud preview)
- Windows runtime — `src/vesper/windows/`, `packaging/windows/`
- Optimizer or NEXUS adapter — `src/vesper/specialists/optimizer.ts` (adapter plus mock; production optimizer API unpublished)
- Distributed layer — `src/vesper/distributed/` (identity, capabilities, tasks, sync engine exist; cross-device transport is not built)
