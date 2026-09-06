---
name: recon
description: Deep repository reconnaissance and architecture mapping before implementation.
---
# RECON

Use this skill before non-trivial changes. Build a factual map of the repository and the requested subsystem.

## Procedure
1. Inspect repository instructions, package/build/test configuration, branch, working tree, and recent history.
2. Map entry points, major packages, interfaces, state machines, persistence, integrations, security boundaries, and tests.
3. Trace the relevant runtime path end-to-end. For Vesper, preserve the distinction between MODEL → AGENT → PERMISSION → TOOL → RESULT and the existing governance boundaries.
4. Identify what is implemented, partial, simulated, missing, duplicated, or fragile.
5. Find existing tests and note important untested paths.
6. Produce a compact architecture map and confidence labels: VERIFIED / OBSERVED / INFERRED / UNVERIFIED.

## Rules
- Do not modify production code while doing reconnaissance unless explicitly authorized.
- Search for existing abstractions before creating new ones.
- Do not confuse documentation claims with observed behavior.
