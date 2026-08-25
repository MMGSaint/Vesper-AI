# Windows integration

Designed for:

- background operation
- system tray
- startup
- toast notifications
- process inspection
- approved application control
- structured logging
- crash recovery
- cheap idle

**Current status:** `src/vesper/windows/host.ts` is a simulated host. Tray, Win32 notifications, and real process control are **IMPLEMENTED + HARDWARE DEPENDENT** (interface present) / **MOCKED** on non-Windows.

The console does not need a terminal window. A future tray process should host `VesperRuntime` and keep the UI optional.
