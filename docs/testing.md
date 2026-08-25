# Testing

```bash
npm test
npm run typecheck
```

Core tests: `src/vesper/**/*.test.ts` (Node test runner, TypeScript stripped).

They cover agent intents, permissions, memory, knowledge, model routing, optimizer mock + HTTP failure, recovery, diagnostics, first-boot, backends, Windows runtime, voice stubs, security boundaries, and the production host.

A local LLM is not required.
