# Security

Vesper is a local-first assistant. Cloud AI is optional and never required at runtime.

This repository is **public**. Anything committed is potentially public.

## Reporting

Use GitHub's private vulnerability reporting:

https://github.com/MMGSaint/Vesper-AI/security/advisories/new

Do not file public issues for credential leaks, tokens, or unreleased optimizer details.

Expected response: acknowledgment when practical, then a fix or a documented limitation. There is no separate private security email.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Older published snapshots | Best-effort only |

## Responsible disclosure

- Give a reasonable window before public discussion of a new vulnerability.
- Do not include live secrets in the report body if they can be redacted.
- If a secret was committed, rotate it and treat the commit as public.

## Non-negotiables

- The model cannot bypass the permission gate.
- High-risk tools (`disk_wipe`, credential access, security disablement, dangerous hardware control) are never autonomous, even with confirmation flags from the model.
- Knowledge and filesystem tools are confined to `approvedRoots`.
- Subprocess launch is allowlisted by executable basename. Shell strings are rejected.
- Logs redact secret keys and values that look like tokens.
- MCP integrations, if enabled later, stay behind the same permission system and are not a runtime dependency.

## GitHub controls

Enabled on this public repository where GitHub allows it:

- Dependabot alerts and security updates
- Secret scanning
- Secret scanning push protection
- CodeQL / code scanning
- CI with least-privilege `GITHUB_TOKEN` permissions

Not currently available on this account/repo (GitHub-side limitation, not a Vesper disablement):

- Secret scanning non-provider patterns
- Secret scanning validity checks

See `docs/GITHUB_SECURITY.md`.

## What this repo does not claim

Physical Windows, AMD telemetry, microphone, and optimizer API validation still require the target PC and the unpublished specialist API.
