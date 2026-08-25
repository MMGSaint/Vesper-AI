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

**Current status**

- Background state machine, tray actions, and startup preference: **IMPLEMENTED + TESTED**
- Native tray icon, Win32 toasts, real process spawn, HKCU startup: **IMPLEMENTED + HARDWARE DEPENDENT**
- Host adapter used in tests: **MOCKED / SIMULATED**
- Packaging scripts: **IMPLEMENTED + HARDWARE DEPENDENT**

The production entry is `src/vesper/host/main.ts`. Packaging scripts live in `packaging/windows/`. The web console is an optional control surface, not a runtime requirement.

Tray actions (open, status, diagnostics, pause/resume, startup, exit) do not go through the language model and cannot relax the permission gate.
