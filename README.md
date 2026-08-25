# Vesper

Local-first personal AI assistant for a Windows PC.

Vesper is **not** Mortis. Mortis remains a separate RP/world/project.  
Vesper is **not** the PC optimizer. The optimizer is a specialist Vesper can call through an adapter.

## What this is

A TypeScript assistant runtime with:

- model-agnostic providers (Ollama, llama.cpp, optional cloud, echo)
- an agent loop that cannot bypass the permission system
- local memory, workspaces, and knowledge search
- a mock PC-optimizer adapter
- a simulated host for the target machine (Ryzen 9 9950X, RX 7900 XT 20 GB, 96 GB RAM)

The physical target PC was **off** during this implementation. Hardware snapshots in the console are simulated unless discovery is live.

## Commands

```bash
npm test
```

Requires Node 22+. Tests do not need a local LLM.

## Docs

See `CLAUDE.md` and `docs/`.
