# Permissions

Levels: `read` | `safe` | `confirm` | `never`.

- The model cannot relax a tool’s level. Overrides may only restrict further.
- `never` matches both an explicit list and name patterns (wipe, credentials, disable defender/firewall/uac, kernel, raw MSR, flash BIOS).
- Confirmation-gated tools queue a `PendingConfirmation` and do not run until the user approves.
- Tray / host controls (pause, exit, diagnostics) are not model tools and still cannot call `never` tools.

See `src/vesper/permissions.ts` and `src/vesper/security.ts`.

## Default deny

`evaluatePermission` allows **only** `read` and `safe`. Anything else — including an
unrecognised, future, or config-corrupted level — is refused with a reason. It used to
return `allowed: true` for any level that was not `never` or `confirm`, which is a
permission layer that fails open.

## Arguments are validated before the gate

Tool arguments are checked against the schema the tool advertises to the model, before
the permission decision and before any confirmation is queued:

- missing `required` arguments, and `enum` or type violations, are refused with a
  message the model can correct from
- undeclared keys and `__proto__` / `constructor` / `prototype` are dropped rather than
  forwarded to a handler
- quoted numbers and `"true"` / `"false"` are coerced, because small local models emit
  them routinely and that is not a real error

A queued confirmation stores the **validated** arguments, so approving an action
approves exactly what was checked.

## Reaching the confirm tier

The console surfaces every pending confirmation with the tool, the reason, and the
arguments, then approves or declines. Anything other than yes declines; silence is never
approval. Before this existed, the CONFIRM tier was unreachable from the only interface
a user has.

