# First-boot hardware bootstrap

`src/vesper/bootstrap.ts` + `src/vesper/hardware/discover.ts`

On start, Vesper records:

- current process host (this may be a Linux sandbox or the future Windows PC)
- configured target profile (9950X / 7900 XT / 96 GB)
- backend probes (Ollama, llama.cpp)
- optional-cloud key presence
- feature status flags (telemetry, voice, Windows, optimizer)

It does **not** pick a “fastest model”. It writes notes describing the remaining physical steps.

Live GPU temperatures, AMD ADLX/ADL telemetry, and Windows tray capability are **hardware-dependent** and currently simulated.
