# Security

IMPLEMENTED + TESTED unless noted.

## Permission gate

Every tool invocation is evaluated by `evaluatePermission`. Levels: read, safe, confirm, never. Overrides may only restrict further. Confirmation does not promote `never` tools.

## Path confinement

`assertWithinRoot`, `containsTraversal`, and `isDangerousRoot` reject `..`, null bytes, `/`, drive roots, and common system directories. Knowledge registration and `fs_*` tools share this boundary.

## Subprocess safety

`isSafeExecutableName` allows `Name.exe` style basenames only. `app_launch` refuses unapproved aliases and shell metacharacters.

## Secrets

Audit logs redact keys matching password/token/api-key patterns and values matching `sk-`, `ghp_`, `xai-`, and Bearer tokens.

## Optimizer

HTTP adapter never treats malformed JSON or non-`accepted: true` as a successful optimization.

## MCP

Disabled by default. Not required. Any future MCP tool is `confirm` at minimum.

## Hostile tests

See `src/vesper/security.test.ts` and `src/vesper/security-hostile.test.ts`.
