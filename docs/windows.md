# Windows runtime

Classification:

- Background runtime / tray menu logic: **IMPLEMENTED + TESTED** (logic)
- Native tray / HKCU startup / toasts: **IMPLEMENTED + HARDWARE DEPENDENT**
- Host adapter used in tests: **MOCKED / SIMULATED**
- Packaging scripts: **IMPLEMENTED + HARDWARE DEPENDENT**

The production entry is `src/vesper/host/main.ts`. Packaging scripts live in `packaging/windows/`. There is no web console in this repository. Companion access is the in-process `vesper.client` gateway.

Tray actions (open, status, diagnostics, pause/resume, startup, exit) do not go through the language model and cannot relax the permission gate.
