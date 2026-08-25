# Troubleshooting

## Assistant starts but models are down

Expected on a machine without Ollama or llama.cpp. Vesper stays on grounded tools and echo fallback. Install a local backend, then re-run first-boot.

## Optimizer always says mock

The production optimizer API is not published. Mock mode is correct. Do not invent a live endpoint.

## Windows tray / startup did nothing

Those writes are hardware-dependent and were not applied from Linux. Use `packaging/windows/install.ps1 -RegisterStartup` on the target PC.

## Memory looks empty after a crash

`FileStorage` keeps a `.corrupt` backup and continues with empty state. Reset with `packaging/windows/reset.ps1`.

## Voice does nothing

Voice is optional and disabled by default. Physical capture was not opened here. Faster-whisper / Piper / Kokoro remain local optional binaries.

## High CPU while gaming

Idle scheduler skips ticks when the simulated/live snapshot is GPU-heavy or the scenario is gaming/VRChat. Pause background activity from the tray or `runtime_pause`.
