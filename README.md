# Vesper

Local-first personal AI assistant for a Windows PC.

Vesper is **not** Mortis. Mortis remains a separate RP/world/project.  
Vesper is **not** the PC optimizer. The optimizer is a specialist Vesper can call through an adapter.

## What this is

A TypeScript assistant runtime with:

- model-agnostic providers (Ollama, llama.cpp Vulkan/ROCm, optional cloud, echo)
- an agent loop that cannot bypass the permission system
- local memory, workspaces, and approved-source knowledge search
- local lexical-hash embeddings + BM25 with provenance
- first-boot hardware/backend discovery
- a benchmark harness that refuses fake numbers
- diagnostics and recovery
- a mock PC-optimizer adapter with a strict HTTP transport boundary
- Windows host/tray architecture and packaging scripts
- gaming / VRChat / OBS context with observed vs inferred conclusions
- a simulated host for the target machine (Ryzen 9 9950X, RX 7900 XT 20 GB, 96 GB RAM)

The physical target PC was **off** during this implementation. Hardware snapshots in the console are simulated unless discovery is live.

## Commands

```bash
npm test
npm run typecheck
npm run security
node --experimental-strip-types src/vesper/host/main.ts
```

Windows install (on the real PC): `packaging/windows/install.ps1`

## Docs

Start with `AGENTS.md`, `CLAUDE.md`, and `docs/PROJECT_STATUS.md`.
