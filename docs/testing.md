# Testing

```bash
npm test
```

Vesper tests live in `src/vesper/*.test.ts` and run with Node's test runner + `--experimental-strip-types`.

Covered: config, routing, agent, tools, permissions (allow/deny/never), memory, workspaces, events, notifications, optimizer mock, logging redaction, hardware sim vs live discovery, knowledge workspace scoping, recovery from bad config / agent throw / missing optimizer / missing model.

Hardware-dependent paths are mocked. No test claims physical GPU validation.
