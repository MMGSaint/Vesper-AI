# Contributing

Read `AGENTS.md` before changing code. This repository is public.

## Rules

- Do not commit secrets, tokens, private keys, or `.env` files.
- Do not modify Mortis production or absorb Mortis canon.
- Do not rebuild or replace the PC optimizer.
- Do not claim hardware validation that did not happen.
- Do not weaken the existing test suite.

## Validation gate

A change is not done until:

```bash
npm test
npm run typecheck
npm run security
npm run hygiene
npm run build
```

CI must stay green. Hardware-dependent behavior must be labeled as such.

## Ownership

See `docs/AGENT_OWNERSHIP.md`. Do not have multiple agents rewrite the same subsystem at once.

## Security reports

Use a private GitHub security advisory. Do not file public issues for credential leaks.
