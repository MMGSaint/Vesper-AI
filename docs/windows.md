# Windows integration

Designed for:

- background operation (`src/vesper/windows/runtime.ts`)
- system tray menu model (`createTrayMenu` / `invokeTrayAction` / native tray adapter)
- start-on-login preference (HKCU Run is not written from Linux)
- toast notifications (adapter present; native toasts not sent here)
- process inspection (CSV parser + optional `tasklist`)
- approved application detection/control
- installer / uninstaller / reset plans
- structured logging
- crash recovery and graceful shutdown hooks
- cheap idle (event-driven scheduler, no aggressive polling)

## Host lifecycle

- **Background mode.** With no TTY the host stays alive, keeps its scheduler running,
  and exits cleanly on SIGTERM/SIGINT. It previously printed a line and returned.
- **Single-instance lock.** A second host refuses to start rather than corrupting shared
  state, naming the pid that holds the lock. A lock left behind by a dead process is
  detected as stale and reclaimed, so a crash cannot permanently block startup.
- **Honest health.** The health file records pid and a heartbeat, so a reader can tell a
  live instance from a dead one. On the next start an unexpected exit is reported as a
  post-mortem rather than left claiming "running".

## Packaging

`npm run package` builds `dist/vesper-<version>.zip`: runtime source, the PowerShell
installer, the lockfile, docs, and a manifest naming the commit. It is deterministic —
fixed timestamps and sorted entries, so the same commit yields a byte-identical
archive — and it excludes tests. The manifest records whether the working tree was
clean, because an artifact built from a dirty tree cannot be reproduced from its commit.

The installer and the runtime agree on `config\vesper.json`. They did not before, so a
real install's config was silently ignored; a test now parses the script and asserts it.

## Current status

- Background mode, instance lock, health, crash post-mortem: **IMPLEMENTED + TESTED**
- Background state machine, tray actions, startup preference: **IMPLEMENTED + TESTED**
- Windows adapter command construction and output parsing: **IMPLEMENTED + TESTED**
  against a fake runner
- Native tray icon, Win32 toasts, real process spawn, HKCU startup:
  **IMPLEMENTED + HARDWARE DEPENDENT** — no Windows command has ever been executed
- Packaging artifact: **IMPLEMENTED + TESTED**; installer execution on Windows:
  **HARDWARE DEPENDENT**

CI runs the full suite on **windows-latest** as well as ubuntu-latest. That exercises the
Windows *code paths*; it is not hardware validation, and it found a real bug the first
time it ran.

## Tray

The chosen mechanism is a long-lived PowerShell helper
(`packaging/windows/tray-host.ps1`) owning a `System.Windows.Forms.NotifyIcon`, talking
to Vesper over stdin/stdout with one JSON object per line. It was chosen because Vesper
ships no native modules and no Electron: WinForms is present on every Windows install,
needs no compiler, and keeps the GUI message pump out of Node. The protocol is
implemented and tested; **no icon has ever been displayed.**

The production entry is `src/vesper/host/main.ts`. Packaging scripts live in `packaging/windows/`. There is no web console in this repository. Companion access is the in-process `vesper.client` gateway.

Tray actions (open, status, diagnostics, pause/resume, startup, exit) do not go through the language model and cannot relax the permission gate.
