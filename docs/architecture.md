# Vesper architecture

Vesper is a local-first personal assistant with a TypeScript core and an optional web control surface.

## Layers

1. **Providers** — Ollama, llama.cpp (Vulkan preferred / ROCm opt-in), optional cloud, echo/scripted tests
2. **Model router** — maps task roles (`fast` / `everyday` / `reasoning` / `coding` / `large`) onto providers with fallback
3. **Agent** — conversation, high-confidence intents, tool iteration, confirmation handling
4. **Permission gate** — deterministic `read | safe | confirm | never`
5. **Tools** — the only path to host/optimizer/filesystem effects
6. **Memory / knowledge / workspaces** — persistent local context
7. **Specialists** — optimizer adapter; workload context (OBS, VRChat, games)
8. **Windows runtime** — background state, tray menu, notifications, startup preference
9. **Host** — `src/vesper/host` runs without a browser
10. **Runtime** — composes the above, isolates subsystem failure

The web console talks to the runtime through server functions. On a Windows install the same runtime sits behind the host process.

## Honesty

Replies distinguish:

- I checked
- I think
- I recommend
- I requested
- I changed
- I could not access

Simulated snapshots are labeled. The assistant must not invent temperatures, clocks, or optimizer results.

## Crash recovery

- Invalid config → defaults + warning
- Corrupt JSON persistence → empty store + `corrupted` flag
- Missing model → grounded tools + echo
- Missing optimizer → assistant continues
- Malformed optimizer JSON → no claimed optimization
- Tool throw → captured result, not process death
- Agent throw → recovered turn
- Notification throw → tool failure, assistant continues
