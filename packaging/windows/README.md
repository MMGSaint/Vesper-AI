# Windows packaging

Target sequence on the real PC:

1. Copy this repository (or a release folder) onto the machine.
2. Install Node.js 22 LTS if it is not already present.
3. Run `packaging/windows/install.ps1`.
4. Launch Vesper from `vesper-host.cmd`.
5. First-boot discovery writes `%LOCALAPPDATA%\Vesper\logs\first-boot.txt`.

This environment is Linux. The scripts are **IMPLEMENTED + HARDWARE DEPENDENT**: they were not executed on Windows.

## Directories

| Path | Purpose |
| --- | --- |
| `%LOCALAPPDATA%\Vesper\config` | `vesper.config.json` |
| `%LOCALAPPDATA%\Vesper\data` | persistent memory / health |
| `%LOCALAPPDATA%\Vesper\logs` | audit + first-boot report |
| `%LOCALAPPDATA%\Vesper\models` | optional local model files |
| `%LOCALAPPDATA%\Vesper\bin` | host launcher |

Development runtime uses `data/vesper` in the repo. Production runtime uses the LocalAppData tree when `VESPER_ENV=production`.

## What install does

- Creates the directory tree
- Writes a default config if missing
- Copies a launcher (`vesper-host.cmd`) that runs the TypeScript host with Node 22
- Optionally registers HKCU start-on-login (`-RegisterStartup`)

It does **not** install Ollama, llama.cpp, faster-whisper, or Piper. Those stay optional.

## Uninstall / reset

- `uninstall.ps1` removes the startup entry and launcher
- `uninstall.ps1 -PurgeData` also deletes `%LOCALAPPDATA%\Vesper`
- `reset.ps1` clears local state so first-boot runs again (keeps a `.corrupt` backup of memory if present)

Normal runtime does not need GitHub, a browser, or a developer terminal. The web console is an optional control surface.
