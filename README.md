# Vesper

Local-first personal AI assistant for a Windows PC.

[![CI](https://github.com/MMGSaint/Vesper-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/MMGSaint/Vesper-AI/actions/workflows/ci.yml)

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
- diagnostics, doctor/self-check, and recovery
- a mock PC-optimizer adapter with a strict HTTP transport boundary
- Windows host/tray architecture and packaging scripts
- gaming / VRChat / OBS context with observed vs inferred conclusions
- a simulated host for the target machine (Ryzen 9 9950X, RX 7900 XT 20 GB, 96 GB RAM)
- a versioned companion contract (`vesper.client` v1) with scoped sessions and honest capability states

The physical target PC was **off** during this implementation. Hardware snapshots are simulated unless discovery is live on that machine.

## Commands

```bash
npm test
npm run typecheck
npm run security
npm run hygiene
node --experimental-strip-types src/vesper/host/main.ts
node --experimental-strip-types src/vesper/host/main.ts --doctor --skip-discovery
node --experimental-strip-types src/vesper/host/main.ts --client-hello --skip-discovery
```

Windows install (on the real PC): `packaging/windows/install.ps1`

## Docs

Start with `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, and `docs/PROJECT_STATUS.md`.

## License

MIT. See `LICENSE`.
