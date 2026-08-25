# Vesper

Local-first Mortis-themed personal AI assistant for a Windows PC.

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
npm run typecheck
npm run dev
```

## Docs

See `CLAUDE.md` and `docs/`.
