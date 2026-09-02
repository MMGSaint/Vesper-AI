---
name: vesper-continuity
description: Detect drift and contradictions between Vesper current code, architecture, prior decisions, roadmap, security model, and intended user experience. Use for major changes, refactors, architecture reviews, naming changes, behavioral changes, or whenever a prompt appears to conflict with previous project decisions.
metadata:
  author: Yeager
  short-description: Vesper continuity guard
  user-invocable: "true"
  pack: vesper-builder-pack
---

# Vesper Continuity

Continuity is a review function, not a license to rewrite history.

## Compare against
- current source code
- tests and CI
- AGENTS.md / project instruction files
- architecture/decision docs
- roadmap state
- security model
- integration contracts
- established naming and UX conventions

## Classify findings
CONSISTENT
DRIFT RISK
CONFLICT
UNKNOWN
DEPRECATED

## Key checks
- Is a previously established interface being bypassed?
- Is a mock being treated as production functionality?
- Is a component boundary collapsing?
- Is NEXUS accidentally being merged conceptually into Vesper?
- Is a security rule being weakened?
- Is a previously verified feature being unnecessarily rebuilt?
- Does the new behavior contradict documented user expectations?

Do not silently resolve a conflict by choosing a new direction. State the conflict and recommend the smallest decision needed.

## Authority files
Compare against `AGENTS.md`, `CLAUDE.md`, `docs/PROJECT_STATUS.md`, `docs/architecture.md`, `docs/architecture-seams.md`, and the tests that encode prior defects. Do not treat dated survey docs as current state when a later phase document supersedes them.
