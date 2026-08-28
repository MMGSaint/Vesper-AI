# Red team

**Start here: [CHECKPOINT.md](CHECKPOINT.md).**

An adversarial security campaign against Vesper was paused mid-run at a session limit.
Eight of twenty attack classes reported; **23 reproduced findings are outstanding and
unfixed, including one CRITICAL arbitrary file write.**

- `CHECKPOINT.md` — campaign status, every finding, what is fixed, what is not, and the
  exact commands to resume.
- `agent-findings.json` — the raw structured reports from the eight attack agents,
  including verbatim observed output and each agent's proposed fix.
- `probes/` — 99 reproduction scripts, runnable in place:

  ```bash
  node --experimental-strip-types security/red-team/probes/<class>/<script>.ts
  ```

Findings in `agent-findings.json` are **agent-reported and orchestrator-unverified**.
Run the reproduction before acting on one: some may be false positives, and some may
already be closed by later commits on this branch.

These probes are attack tooling for this repository's own defence. They are not part of
the build: `tsconfig.json` includes only `src/vesper/**`, and the test runner globs only
`src/vesper/**/*.test.ts`.
