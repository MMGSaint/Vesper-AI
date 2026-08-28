# Security testing

Two tiers. The first runs constantly; the second does not exist yet and this page says
so rather than implying otherwise.

## The gate — `npm run security:quick`

Runs in about three seconds and is the suite to run when touching anything near a trust
boundary. `npm run security` runs the same thing: there is one security suite, and a
"quick" alias that is honest about what it costs.

Its file list lives in `scripts/run-security-suite.mjs`, one line per file with the
attack class it covers, so a coverage gap shows up as a missing line rather than as an
absence nobody notices. The script fails if a listed file has disappeared — a suite that
silently shrinks is worse than no suite.

Attack classes covered:

| Class | Where |
|---|---|
| Prompt injection: containment | `injection-redteam.test.ts` |
| Prompt injection: the product actually uses the containment | `injection-wiring.test.ts` |
| Injection through prompt *fields* rather than retrieved content | `prompt-integrity.test.ts` |
| Permission escalation, unknown levels, hostile config | `security-invariants.test.ts` |
| Filesystem escape, symlinks, path representations | `security.test.ts`, `security-invariants.test.ts` |
| Session revocation and demotion | `client/device-binding.test.ts` |
| The confirmation queue as a trust boundary | `client/confirmation-authority.test.ts` |
| Capability spoofing and never-remote authority | `tools/remote.test.ts`, `security-invariants.test.ts` |
| Scope enforcement on every route | `tools/scope-enforcement.test.ts` |
| Optimizer trust, mock-versus-live | `distributed/discovery.test.ts`, `security-invariants.test.ts` |
| Memory poisoning into authority | `security-invariants.test.ts` |
| Secret exposure through side channels | `security-invariants.test.ts`, `security-hostile.test.ts` |
| Malformed input and corrupt stored state | `security-invariants.test.ts`, `security-hostile.test.ts` |

## How these tests are written, and why

Two rules, both learned the hard way in this repository.

**Assert on state, not on prose.** A test that matched the word "disabled" in a status
string passed happily when that string started describing an unbuildable feature as a
user setting. Assert on what reached the disk, the provider, the tool record, or the
queue.

**Check that the test fails.** Before trusting a security test, remove the mechanism it
claims to exercise and confirm it turns red. Several tests in this repository were
passing for the wrong reason:

- one asserted an offline device by enrolling it — but enrolment is itself contact, so
  the device was online;
- one asserted `decision.allowed === false` as proof a tool had been refused, when that
  field means "allowed *without* confirmation" and is false for every confirm-tier tool
  even as it runs;
- one asserted that memory and knowledge tools were "already governed by scopes and need
  no rule here", which was not a test of the system but a statement of the bug.

Every mechanism added by the adversarial pass was mutation-checked this way, and the
commit messages record which mutations were tried.

## The deeper campaign — not built

Deliberately out of scope for the focused gate, and not claimed as done anywhere:

- **Long-running fuzzing** of tool arguments, config, stored JSON, the MCP framing, and
  the injection screener, with a corpus that persists between runs.
- **Property-based generation** of path representations rather than the fixed list the
  gate uses today.
- **Concurrency stress**: the gate has deterministic race probes, not a scheduler-fuzzing
  campaign.
- **Sustained resource-exhaustion testing.** The gate checks that one hostile input
  cannot consume everything; it does not characterise behaviour under sustained load.
- **A transport-level campaign.** There is no transport, so there is nothing to attack
  across a network yet; when one exists it needs its own pass covering TLS, pairing,
  replay, and request smuggling.

## What the gate cannot tell you

It cannot tell you a model behaved well. No test here asserts anything about how a model
responds, because the model is assumed to be fully attacker-influenced — that is the
premise, which is why the tests drive a scripted provider that does whatever an attacker
would want and then check that the deterministic layer refused anyway.

It also cannot cover the hardware-dependent surfaces, which have never been exercised on
a real machine. See `docs/known-limitations.md`.
