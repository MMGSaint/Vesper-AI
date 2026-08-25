# Known limitations

- The target Windows PC (9950X / 7900 XT / 96 GB) was powered off during development.
- No live AMD telemetry, clocks, power, or temperatures.
- No local-model throughput numbers. Do not treat role defaults as benchmark winners.
- Native Windows tray, toasts, startup registry, and `tasklist` were not executed on Windows.
- Voice binaries were not opened against a real microphone/speaker.
- Embedding RAG is an interface plus BM25 fallback, not a vector index.
- The real PC optimizer API does not exist in this repo; only the adapter contract does.
- Mortis remains a separate project. Only the approved Mortis knowledge source is in-scope.

When the PC is on, run the host, read the first-boot report, and treat any hardware-dependent step that did not succeed as unfinished.
