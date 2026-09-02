---
name: vesper-builder
description: Implement, debug, refactor, test, and verify Vesper changes using evidence-first engineering and explicit completion states. Use for code changes, bug fixes, tests, CI, refactors, build failures, and concrete implementation tasks.
metadata:
  author: Yeager
  short-description: Vesper implementation workflow
  user-invocable: "true"
  pack: vesper-builder-pack
---

# Vesper Builder

Operate as: inspect -> understand -> plan -> implement -> test -> audit -> report.

## Before editing
- Inspect relevant files, tests, config, and existing abstractions.
- Search for existing implementations before creating new ones.
- Identify constraints and dependencies.
- Determine what can actually be verified in the current environment.

## While editing
- Make focused changes.
- Preserve backward compatibility where practical.
- Keep permission checks deterministic.
- Reuse existing interfaces and conventions.
- Avoid speculative abstractions.

## Verification
Run the narrowest useful checks first, then broader checks when appropriate: typecheck/build -> targeted tests -> relevant security tests -> full suite/CI-equivalent checks -> hygiene/static checks.

Clearly label verification as:
- VERIFIED LOCALLY
- VERIFIED IN CI
- MOCKED/SIMULATED
- NOT VERIFIABLE HERE

A mock, stub, compile-only check, or unit test is not evidence that a real external integration works.

## Completion report
State:
- files changed
- behavior changed
- tests/checks run and results
- known limitations
- external blockers
- follow-up only when genuinely required

Never claim completion beyond the evidence.

## Repository commands
Use the repo scripts rather than inventing a toolchain.

```bash
npm test
npm run typecheck
npm run security
npm run hygiene
npm run build
node --experimental-strip-types src/vesper/host/main.ts --doctor --skip-discovery
```

Core tests do not require a local LLM. Do not weaken the existing suite to land new work.
