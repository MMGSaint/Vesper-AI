---
name: vesper-integration
description: Design and implement Vesper integrations with local inference, Windows, external services, hardware, and the separate PC optimizer or NEXUS adapter using explicit adapters and verification boundaries. Use for Ollama, llama.cpp, Windows runtime, tray or background services, notifications, cloud services, external APIs, devices, hardware, or NEXUS integration.
metadata:
  author: Yeager
  short-description: Vesper integration engineering
  user-invocable: "true"
  pack: vesper-builder-pack
---

# Vesper Integration

Every integration has four states:
1. INTERFACE DESIGNED
2. ADAPTER IMPLEMENTED
3. MOCK/SIMULATION VERIFIED
4. REAL INTEGRATION VERIFIED

Never skip from 2 or 3 to 4 without evidence.

## Local inference
Support model-agnostic routing and discover local backends such as Ollama or llama.cpp according to the actual repo. Preserve vendor-neutral interfaces where practical. ROCm/Vulkan/backend specifics must be treated as environment-dependent and verified on the target machine.

## Windows
Separate core logic from Windows-only runtime concerns. Tray, notifications, startup/background state, process control, and installation should have testable boundaries.

## NEXUS
NEXUS is related to Vesper but remains a distinct component. Prefer a versioned adapter/protocol boundary. Do not invent a private NEXUS API. Use a mock/stub when the real API is unavailable, and label it clearly.

## External/cloud memory
Separate synchronization, authentication, storage, retrieval, and conflict resolution. Design for offline-first behavior and graceful failure. Do not make cloud availability a hidden dependency of core local functionality.

## Integration report
Return: interface -> adapter -> configuration -> failure behavior -> tests -> real-world verification status -> blockers.

## Repository anchors
- Local inference adapters live under `src/vesper/models/` (Ollama, OpenAI-compatible llama.cpp including Vulkan-preferred and ROCm-opt-in configuration, echo, optional xAI preview).
- Windows tray, notifications, startup, packaging, and host adapters live under `src/vesper/windows/` and `packaging/windows/`.
- The PC optimizer is a separate specialist reached through `src/vesper/specialists/optimizer.ts`. Treat NEXUS and the optimizer as distinct from Vesper core. The mock adapter is not a live NEXUS capability.
- Companion contract is `src/vesper/client/` and is in-process only. Do not add a raw network listener that exposes OS tools.
- Hardware snapshots on development hosts are simulated unless live discovery ran on the target PC.
