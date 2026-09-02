---
name: vesper-roadmap
description: Maintain Vesper's dependency-aware roadmap, distinguish complete work from simulated work and blockers, and select the next highest-value step. Use for planning, sequencing, milestone decisions, what-next prompts, scope control, and identifying blockers.
metadata:
  author: Yeager
  short-description: Vesper roadmap and sequencing
  user-invocable: "true"
  pack: vesper-builder-pack
---

# Vesper Roadmap

Treat the repository, tests, issue/decision docs, and current task state as evidence. Maintain four categories:
DONE, NEXT, BLOCKED, DEFERRED.

## Rules
- Prefer dependency order over feature excitement.
- Do software-complete work before waiting on physical hardware or private APIs.
- Do not count mock integration as completed integration.
- Do not reopen already verified work without evidence of regression.
- When a blocker is external, isolate a stable interface and maximize useful preparation around it.
- Keep the roadmap small enough to remain truthful.

## Planning method
For any substantial task:
1. Current verified state.
2. Goal.
3. Dependencies.
4. What can be completed now.
5. What is externally blocked.
6. Smallest milestone that produces durable value.
7. Verification criteria.

## Canonical project constraints
Vesper is a local-first personal assistant with system integration, persistent memory, optional voice, model-agnostic routing, and a future relationship with NEXUS. NEXUS remains a distinct optimizer/component. Verify exact implementation state in the repo rather than relying on this summary alone.

## Status sources
Read `docs/PROJECT_STATUS.md`, `docs/known-limitations.md`, `docs/DEFINITION_OF_DONE.md`, and `AGENTS.md` before classifying work. Physical AMD/Windows/audio validation and the unpublished production optimizer API remain external blockers. Companion transport is deliberately unimplemented.
