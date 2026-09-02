---
name: vesper-security
description: Review and enforce Vesper permission, filesystem, process, tool, memory, secret, and integration security boundaries. Use whenever a change touches tools, commands, files, executables, network access, secrets, memory privacy, permissions, installers, or external integrations.
metadata:
  author: Yeager
  short-description: Vesper security gate
  user-invocable: "true"
  pack: vesper-builder-pack
---

# Vesper Security

Security decisions must be deterministic where possible and must not depend on the model behaving perfectly.

## Core permission model
Preserve the project's established action classes:
- read: non-mutating observation
- safe: low-risk permitted mutation
- confirm: requires explicit user approval
- never: prohibited action

Verify the actual implementation and configuration before changing these semantics.

## Filesystem/process controls
Maintain or strengthen:
- path confinement
- dangerous-root rejection
- executable allowlists
- least privilege
- explicit confirmation for consequential actions
- safe handling of symlinks/junctions/path traversal
- bounded resource usage where relevant

## Secrets and data
- Never print or commit secrets.
- Treat persistent memory and user content as private by default.
- Keep credentials outside source and logs.
- Separate trusted local data from untrusted retrieved content.
- Prevent prompt content from becoming an authorization mechanism.

## Integration security
Treat external services and NEXUS as separate trust domains. Use explicit adapters and authentication. Do not broaden permissions just to simplify integration.

## Review output
For security-sensitive changes report:
Risk -> Attack surface -> Existing control -> Gap -> Minimal fix -> Verification.

If a requested feature conflicts with a safety boundary, explain the conflict and implement the safest compatible design rather than silently disabling the control.

## Repository anchors
Existing controls to inspect before changing semantics include `src/vesper/permissions.ts`, `src/vesper/security.ts`, `src/vesper/tools/filesystem.ts`, `src/vesper/untrusted.ts`, `src/vesper/net.ts`, `src/vesper/tools/registry.ts`, and `security/red-team/`.
Knowledge roots must stay inside approved roots. Subprocess spawn is allowlisted by executable name with no shell strings. Remote devices do not receive filesystem, Windows control, or trust-administration tools.
