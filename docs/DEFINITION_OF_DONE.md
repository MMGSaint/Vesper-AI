# Definition of done

Source code existing is not done.

A feature is complete only when all of the following are true:

1. Implementation exists and is wired into the runtime or a documented optional module.
2. Relevant tests exist.
3. The full Vesper test suite passes.
4. Typecheck passes.
5. Production/build check passes (`tsc --noEmit` for the standalone host).
6. `npm run security` and `npm run hygiene` pass.
7. Permission/security boundaries are preserved.
8. No secrets were introduced.
9. Documentation matches the real behavior.
10. Feature status is classified honestly.
11. The change is committed.
12. CI is green, or the failure is diagnosed and fixed before stopping.

Hardware-dependent features may be done as **IMPLEMENTED + HARDWARE DEPENDENT** if the abstraction, mock, and tests exist and no fake physical validation is claimed.
