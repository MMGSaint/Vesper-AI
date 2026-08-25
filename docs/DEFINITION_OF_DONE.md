# Definition of done

Source code existing is not done.

A feature is complete only when all of the following are true:

1. Implementation exists and is wired into the runtime or a documented optional module.
2. Relevant tests exist.
3. The full Vesper test suite passes.
4. Typecheck passes.
5. Production/build check passes where applicable (`tsc --noEmit` for the standalone host; App Builder `npm run build` for the preview console).
6. Permission/security boundaries are preserved.
7. Documentation matches the real behavior.
8. No secrets were introduced.
9. Feature status is classified honestly.

Hardware-dependent features may be done as **IMPLEMENTED + HARDWARE DEPENDENT** if the abstraction, mock, and tests exist and no fake physical validation is claimed.
