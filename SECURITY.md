# Security

Vesper is a local-first assistant. Cloud AI is optional and never required at runtime.

## Reporting

Open a private GitHub security advisory on this repository. Do not file public issues for credential leaks.

## Non-negotiables

- The model cannot bypass the permission gate.
- High-risk tools (`disk_wipe`, credential access, security disablement, dangerous hardware control) are never autonomous, even with confirmation flags from the model.
- Knowledge and filesystem tools are confined to `approvedRoots`.
- Subprocess launch is allowlisted by executable basename. Shell strings are rejected.
- Logs redact secret keys and values that look like tokens.
- MCP integrations, if enabled later, stay behind the same permission system and are not a runtime dependency.

## What this repo does not claim

Physical Windows, AMD telemetry, microphone, and optimizer API validation still require the target PC and the unpublished specialist API.

## GitHub code scanning

This repository is private. GitHub CodeQL upload requires code scanning / GitHub Advanced Security to be enabled on the repo. Until that is turned on in GitHub settings, security regression is enforced by `npm run security` and the CI test job, not by CodeQL upload.
