# Windows packaging

These scripts are intended for the physical Windows PC. They were not executed on Windows in this environment.

Classification: **IMPLEMENTED + HARDWARE DEPENDENT**

- `install.ps1` copies the tree, writes a launcher, and can register HKCU startup
- `vesper-host.cmd` starts the TypeScript host with Node 22
- `uninstall.ps1` removes the startup entry and launcher
- `uninstall.ps1 -PurgeData` also deletes `%LOCALAPPDATA%\Vesper`
- `reset.ps1` clears local state so first-boot runs again (keeps a `.corrupt` backup of memory if present)

Normal runtime does not need GitHub, a browser, or a developer terminal. There is no web console in this package.
