---
name: build
description: Safe implementation workflow for features, fixes, refactors, and integrations.
---
# BUILD

## Procedure
1. Confirm the current branch/worktree and protect unrelated user changes.
2. Re-read the relevant architecture and plan.
3. Make the smallest coherent implementation.
4. Reuse existing abstractions and conventions.
5. Add/update tests for meaningful behavior and failure paths.
6. Run targeted validation, then broader gates as practical.
7. Review the diff for accidental scope expansion.

## Rules
- Never silently weaken security, permissions, or validation.
- Never overwrite unrelated work.
- Never claim completion without verification evidence.
