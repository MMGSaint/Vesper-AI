# Security

IMPLEMENTED + TESTED unless noted.

This repository is public. See `SECURITY.md` and `docs/GITHUB_SECURITY.md`.

## Permission gate

Every tool invocation is evaluated by `evaluatePermission`. Levels: read, safe, confirm, never. Overrides may only restrict further. Confirmation does not promote `never` tools.

## Path confinement

`assertWithinRoot`, `containsTraversal`, and `isDangerousRoot` reject `..`, null bytes, `/`, drive roots, and common system directories. Knowledge registration and `fs_*` tools share this boundary.

## Subprocess safety

`isSafeExecutableName` allows `Name.exe` style basenames only. `app_launch` refuses unapproved aliases and shell metacharacters.

## Secrets

Audit logs redact keys matching password/token/api-key patterns and values matching `sk-`, `ghp_`, `xai-`, and Bearer tokens. Production hosts append redacted JSONL to `logs/audit.jsonl`. `npm run hygiene` fails CI if high-confidence secret material is committed.

## Optimizer

HTTP adapter never treats malformed JSON or non-`accepted: true` as a successful optimization.

## Client protocol

Companion access is `vesper.client` v1 in-process. Sessions expire, scopes are allowlisted, tokens are omitted from `list()`, and remote OS / permission-relax powers are never granted. No network listener is bound. Transport, when added later, is not authorization.

## MCP

Disabled by default. Not required. Any future MCP tool is `confirm` at minimum.

## Hostile tests

See `src/vesper/security.test.ts` and `src/vesper/security-hostile.test.ts`.

## Path confinement resolves symlinks

`assertWithinRoot` compares strings, and `path.resolve` is lexical, so a symlink planted
inside an approved directory passed the check and was read through to its real target.
`resolveRealWithinRoot` resolves both sides with `realpath` before comparing; for a path
that does not exist yet, the nearest existing ancestor is resolved, so a link part-way
along a parent chain cannot redirect a write either. `fs_read`, `fs_write`, `fs_list`,
and the knowledge indexer all use it.

## What counts as a dangerous root

Refused at any depth: `/etc`, `/proc`, `/sys`, `/dev`, `/boot`, `/root`, `C:\Windows`,
`C:\Program Files`, `C:\ProgramData`, and `System32` wherever it appears.

Refused as a whole, but usable inside: `/`, a bare drive, `/home`, `/Users`, `C:\Users`,
and a single user profile such as `C:\Users\sam`. Approving an entire profile is too
broad; `C:\Users\sam\Documents\notes` is exactly where a user's notes live and must
stay approvable. Refusing everything under `C:\Users` made the filesystem tools and
knowledge indexing unusable on the only OS Vesper targets.

## Network egress

Model and optimizer transports refuse redirects, so request headers — including any API
key — cannot be replayed to a host the user never approved. A provider declared "local"
must point at a loopback or private address; the optimizer endpoint is validated the
same way, with remote access requiring explicit opt-in. Cloud metadata and link-local
addresses are refused.

## Audit

State-changing optimizer calls log the request with its parameters and the outcome
separately — accepted, declined, or failed — so an action can be reconstructed and a
failure is as visible as a success. Nothing logs a confirmation the optimizer did not
give. An audit-log write failure degrades loudly and can never reach the process as an
unhandled rejection.

