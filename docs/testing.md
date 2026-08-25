# Testing

```bash
npm test
npm run typecheck
npm run security
```

Core tests run with Node 22 `--experimental-strip-types` and do not require a local LLM.

Regression lock: do not remove or weaken existing tests to make new work easier.

Coverage includes config, permissions, tools, memory, workspaces, knowledge/RAG, agent, optimizer HTTP, hardware simulator, recovery, first-boot, diagnostics, Windows runtime/packaging contracts, voice session, scheduler, filesystem confinement, hostile security, gaming/OBS/VRChat scenarios, and the benchmark refusal path.
