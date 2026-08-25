# Testing

```bash
npm test
npm run typecheck
npm run security
npm run hygiene
npm run build
```

Core tests run with Node 22 `--experimental-strip-types` and do not require a local LLM.

Regression lock: do not remove or weaken existing tests to make new work easier.

Coverage includes config, permissions, tools, memory, workspaces, knowledge/RAG, agent, optimizer HTTP, hardware simulator, recovery, first-boot, diagnostics, doctor, host CLI, confirmation persistence, Windows runtime/packaging contracts, voice session, scheduler, filesystem confinement, hostile security, gaming/OBS/VRChat scenarios, and the benchmark refusal path.

CI on `main` and pull requests runs the same gate. Nightly repeats tests plus `npm audit` and writes a maintenance report artifact. Nightly does not deploy.
