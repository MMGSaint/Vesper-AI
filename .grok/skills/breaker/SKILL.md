---
name: breaker
description: Adversarial testing and failure discovery for implementations and agent workflows.
---
# BREAKER

Use after implementation or when explicitly asked to red-team.

## Attack surfaces
- authorization and permission bypass
- malformed tool arguments
- path traversal and unsafe filesystem inputs
- prompt/tool injection
- corrupted or stale state
- duplicate/replayed operations
- race conditions
- interrupted jobs
- partial sync/reconnect behavior
- poisoned memory/provenance
- resource exhaustion

## Procedure
1. Establish expected invariants.
2. Generate adversarial cases.
3. Reproduce failures deterministically where possible.
4. Separate confirmed vulnerabilities from hypotheses.
5. Provide a minimal reproduction and remediation recommendation.

Do not change security policy merely to make an attack test pass.
