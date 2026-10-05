---
name: verify
description: Evidence-based validation, regression testing, failure analysis, and completion gates.
---
# VERIFY

## Procedure
1. Run the most targeted tests first.
2. Run subsystem tests and project-wide checks as appropriate.
3. For Vesper, prefer the documented gates: npm test, typecheck, security, hygiene, doctor.
4. Inspect failures rather than suppressing them.
5. Check both positive and negative paths.
6. Confirm build/type/lint/security/migration behavior where relevant.
7. Record exact commands and outcomes.

## Completion rule
A change is complete only when its required gates pass or the remaining gap is explicitly reported.
