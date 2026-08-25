# Known limitations

- Physical Ryzen 9 9950X + RX 7900 XT machine was **off**. No live AMD telemetry, clocks, power, or model benches.
- Optimizer is a **mock**. Real API not published here.
- Mortis is **not** in this repo. Only a boundary + workspace.
- Voice, tray, Windows startup, and live filesystem indexing of the user PC are not implemented.
- Optional cloud inference may appear in the web preview when an environment key exists. Production default is local-only (`allowOptionalCloud: false`).
- Knowledge search is keyword/BM25-lite, not embedding RAG.
- Application launch/close mutates the simulator, not real Win32 processes.
- The web console is a control surface, not the eventual tray app.
