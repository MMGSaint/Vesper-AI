# Permissions

Levels: `read` | `safe` | `confirm` | `never`.

- The model cannot relax a tool’s level. Overrides may only restrict further.
- `never` matches both an explicit list and name patterns (wipe, credentials, disable defender/firewall/uac, kernel, raw MSR, flash BIOS).
- Confirmation-gated tools queue a `PendingConfirmation` and do not run until the user approves.
- Tray / host controls (pause, exit, diagnostics) are not model tools and still cannot call `never` tools.

See `src/vesper/permissions.ts` and `src/vesper/security.ts`.
