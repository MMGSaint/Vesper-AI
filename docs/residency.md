# Vesper Windows residency

This is what makes Vesper a persistent Windows resident rather than a one-shot CLI:
how it is registered to start at logon, how it comes up, how it comes down, and how a
user asks it any of "am I registered?", "am I ready?", "what happened last time?".

Every mechanism here is CROSS-PLATFORM tested. The Windows-specific writes go through
`WindowsRunner`, which is injectable so tests can drive them from Linux CI without a
real reg.exe. What has NOT been done is validation on the physical target PC — the six
probes in `docs/hardware-validation-checklist.md` and everything under
`docs/first-pc-boot.md` §10 still wait on the machine.

## Startup registration

The mechanism is the per-user HKCU Run key:

```
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run\Vesper = <launcher>
```

Per-user is deliberate — Vesper never asks for administrator rights, and removal
requires no elevation either.

Three CLI commands, exit codes `0` in-sync / `1` changed / `2` refused-or-unable:

- `--startup-status`  Print current preference, launcher path, actual Run value, and
                      whether the two are in sync.
- `--enable-startup`  Register at logon. Refuses when the launcher is not an absolute
                      path to `vesper-host.cmd` or `vesper-host.mjs`, when the launcher
                      cannot be resolved, or when reg.exe could not answer (rather than
                      writing based on a guess).
- `--disable-startup` Remove the Run entry.

The commands run BEFORE `createProductionHost`, so a user with a broken runtime can
still repair their startup entry and no instance lock is held while they do it.
Reconcile happens first, the config preference is written second — so a failure on
either side never leaves the config claiming something the OS disagrees with.

### Reconcile at boot

Every boot, in the background, the host compares the config's `windows.startOnLogin`
against the actual Run value and either does nothing, writes, or removes. Refuses on
"unknown" state and on unsafe launcher targets — a repair path built on a transient
reg.exe failure would rewrite on every boot, and a repair path with no launcher
containment would be a way to plant an arbitrary command at logon.

Case-insensitive comparison on Windows (NTFS is), and unwraps double-quoted registered
values (an older PowerShell installer wrapped the value in literal quotes).

### What the archaeology found

Before this phase the primitives existed and no CLI, tool, tray click, or startup
hook called them. `describeStartupRegistration` was the only wired export, and it is a
pure "what would we do." Docs claimed test coverage that did not exist — no test
injected a runner. The tray toggle flipped an in-memory boolean and never touched the
registry. Those are the specific defects this phase closed.

## Readiness

`src/vesper/host/readiness.ts` is a seven-state monitor:

```
INITIALIZING  → start() has not returned yet
CORE_READY    → start() returned; core assistant is live; optional subsystems catching up
DEGRADED      → settled with something the config asks for unavailable
READY         → settled; everything configured has answered
STOPPING      → shutdown() started
STOPPED       → shutdown() completed
FAILED        → an initialization step threw and cannot recover
```

Never regresses forward-to-backward: a late `markComponent` after settle stays at
READY rather than pulling back to CORE_READY, so a phone reading status while a
reprobe is in flight is not told "we are not ready" when the runtime is. Shutdown
states always win over any subsequent forward push.

The monitor never decides on its own. Callers observe the world (backends probed,
manifest refreshed, knowledge indexed) and hand facts in. A state machine that
computed readiness would need to know about every subsystem, and every new subsystem
would have to teach it a new rule.

The doctor reports the current state as an `ok: true` check for READY, DEGRADED,
CORE_READY — DEGRADED is honest on a machine with no local backend and marking it
`ok: false` would push the exit code to 1 for a state the honesty rules already say
is expected.

## Startup is fast and non-blocking

`runtime.start()` used to `await knowledge.reindex()` on the critical path. On a fresh
install with a full knowledge root that could add tens of seconds to logon time on
the one OS Vesper targets. It runs in a `void (async () => {})` block now and reports
through the readiness monitor when it completes. The property is pinned structurally
in `host/readiness-integration.test.ts` — a regression that adds `await` back fails
the test.

Same pattern for OBS (fire-and-forget) and for the backend discovery path.

## Shutdown is bounded

The lifecycle controller runs shutdown hooks in order and isolates their errors — a
hook that throws must not prevent later hooks from running, and every failure reaches
the caller as a real error rather than being swallowed. New in this phase: each hook
carries a `timeoutMs` (default 5 seconds). A hook that overshoots is left running and
shutdown moves on with an honest timeout error.

We cannot cancel a Promise a hook did not co-operate to make cancellable, but we can
stop waiting on one. The timer is deliberately NOT unref'd — Node's loop would then
drain (the hook itself may have no referenced work) and the process could exit before
the timer fires, reporting success on a shutdown that actually stalled.

## Crash detection and recovery

Two shapes are recorded:

- **Live crash.** An uncaught exception or unhandled rejection writes a crash note on
  the way down through `writeCrashNoteSync` — an `uncaughtException` handler has no
  chance to await.
- **Post-mortem crash.** The next start finds a health file that claims to be running
  under a pid that is gone, or reclaims a stale instance lock. `detectUncleanExit`
  builds the note from what was left behind, and the CLI prints it once.

Health file writes are heartbeated (`HEARTBEAT_INTERVAL_MS = 15s`). Three misses is
treated as not-live: a caller can therefore tell "running", "stopped cleanly", and
"died while claiming to run" apart from the file alone.

## Duplicate instance protection

`host/instance-lock.ts` is a create-if-absent lock file holding the owner's pid.
Validates that the pid belongs to a live process (via `process.kill(pid, 0)` with
`EPERM` interpreted as "process exists but belongs to another user"). A stale lock is
detected, reclaimed, and reported to the caller — that report is what the crash note
uses. The acquire loop is bounded so two processes racing over the same stale lock
cannot spin.

Known limit, stated rather than papered over: an OS can reuse a pid, so a stale lock
whose number has been handed to an unrelated program reads as "still held" and Vesper
refuses to start. That is the safe direction to fail, and `--status` still reports
why.

## What is still hardware-dependent

- The Run key WRITE has not been executed against a real Windows machine. The
  primitives, the reconcile, the CLI, and the tests all work; the actual reg.exe call
  runs the code path only when process.platform is `win32`.
- Every audit-log/health/lock behaviour under a real crash on Windows. The health and
  crash primitives are cross-platform, but the specific interaction with a hard power
  loss on the target PC has not been observed.
- NTFS reparse-point behaviour against the filesystem containment path. Windows has
  no O_NOFOLLOW; that branch takes a structurally different route and has never run
  against a real junction. Recorded in `security/BACKLOG.md` §1.1.

## What is deliberately not built

- No cross-device transport. Session capsules have a shape, a signature and a verify
  path. Nothing carries them.
- No NEXUS re-detection on live-to-mock or mock-to-live transitions. The adapter is
  constructed once at startup from config. The one classifier at
  `classifyOptimizerCapability` is now shared by every surface that reads it, so a
  future re-detection path only has to feed the same function.
- No automatic Windows service installation. HKCU Run is per-user and simpler; a
  Service or Scheduled Task adds elevation, install-time complexity, and a permission
  surface the mission's rules would not benefit from.
