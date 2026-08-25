# Known limitations

- The target Windows PC (9950X / 7900 XT / 96 GB) was powered off during development.
- No live AMD telemetry, clocks, power, or temperatures.
- No local-model throughput numbers on the target PC. The harness refuses to fake them.
- Native Windows tray, toasts, startup registry, and `tasklist` were not executed on Windows.
- Voice binaries were not opened against a real microphone/speaker.
- Lexical-hash embeddings are local and deterministic, not a neural embedding model.
- The real PC optimizer API does not exist in this repo; only the adapter contract does.
- Mortis remains a separate project. Only the approved Mortis knowledge source is in-scope.
- Companion transport (pairing, LAN TLS) is not implemented. `vesper.client` v1 is in-process only.

When the PC is on, run the host, read the first-boot report, and treat any hardware-dependent step that did not succeed as unfinished.
