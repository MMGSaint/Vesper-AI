# First-boot hardware bootstrap

`src/vesper/bootstrap.ts` runs automated discovery:

1. Detect OS
2. Detect CPU
3. Detect GPU (live identity is hardware-dependent; currently recorded as not read)
4. Detect VRAM (same)
5. Detect RAM
6. Detect inference backends (Ollama, llama.cpp, Vulkan preference, ROCm opt-in)
7. Discover local models via `/v1/models`
8. Inspect audio devices (not opened)
9. Inspect Windows capabilities
10. Inspect telemetry capabilities
11. Detect optimizer adapter
12. Inspect runtime dependencies
13. Inspect approved application catalog
14. Record that the benchmark harness exists and will not invent numbers
15. Choose safe defaults (no “fastest model” crown)
16. Self-check memory + never-permission gate
17. Persist the profile when storage is available
18. Write a human-readable report

Nothing privileged is done silently. GPU/VRAM/audio/telemetry steps record failure honestly rather than inventing success.

On the real PC: INSTALL → LAUNCH → BOOTSTRAP → CONFIGURE → RUN.

Read `%LOCALAPPDATA%\Vesper\logs\first-boot.txt` after the first host launch.
