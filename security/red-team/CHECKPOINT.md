# Red team checkpoint — round 2 complete

**Status: both rounds reported. 19 attack classes attacked; every CRITICAL and HIGH
finding reproduced independently, fixed, and mutation-proven. What is *not* covered is
recorded in `security/BACKLOG.md` rather than left implicit.**

Written 2026-08-27, replaced 2026-08-28. Everything below is observed output or a repo
fact.

This supersedes the "campaign INCOMPLETE, do not merge" checkpoint written when round 1
paused at a session limit. That document's §4 listed 23 outstanding findings and its §9
listed the exact next actions; both are now done, and the record of how is in the commit
messages rather than repeated here.

---

## 1. Campaign identity

| | |
|---|---|
| Branch | `agent/distributed` |
| Round 1 | workflow `wf_735640a9-27a` — 8 classes, 23 findings |
| Round 2 | workflow `wf_803f2aa7-18f` — 11 classes, 389 attacks, 57 findings |
| Raw agent reports | `security/red-team/agent-findings.json` (durable, in-repo) |
| Round 1 probes | `security/red-team/probes/` — 99 scripts, runnable in place |
| Round 2 probes | `/home/user/vesper-probes-r2/` — **session-local, will not survive** |
| Known-unfixed, untested, and unproven | `security/BACKLOG.md` |

To re-run a round-1 reproduction:

```bash
cd /home/user/vesper-ai
node --experimental-strip-types security/red-team/probes/<class>/<script>.ts
```

Round 2's probes live outside the repository and go with the container. Their findings
are in `agent-findings.json`, and every fix carries a regression test in the suite — the
tests are the durable reproduction, and each was mutation-proven so it cannot quietly
stop testing anything.

---

## 2. Attack classes

**Round 1 — 8 classes, 23 findings.** Counts from the agents' own reports.

| Class | Attempted | Findings | Controls that held |
|---|---|---|---|
| `document-rag-injection` | 18 | 2 | 10 |
| `prompt-injection-conversation` | 47 | 3 | 8 |
| `permission-escalation-chaining` | 20 | 2 | 5 |
| `memory-poisoning` | 10 | 4 | 7 |
| `command-execution` | 6 | **0** | 6 |
| `filesystem-escape` | 40 | 3 | 4 |
| `device-session-capability` | 31 | 6 | 12 |
| `wrapping-nonce-integrity` | 28 | 3 | 7 |

**Round 2 — 11 classes, 389 attacks, 57 findings.**

| Class | Findings |
|---|---|
| `security-test-quality` | 8 |
| `serialization-parser-differential` | 8 |
| `error-paths-fail-open` | 6 |
| `false-action-claims` | 6 |
| `secret-exfiltration` | 5 |
| `storage-workspace-isolation` | 5 |
| `optimizer-trust` | 5 |
| `context-management` | 4 |
| `network-ssrf-ipc` | 4 |
| `dos-resource-exhaustion` | 4 |
| `concurrency-races` | 2 |

Severity across round 2: **5 HIGH, 28 MEDIUM, 18 LOW, 6 INFORMATIONAL**, no CRITICAL.
The campaign's one CRITICAL — arbitrary file write through a dangling symlink — is from
round 1 and was fixed in `9e9ffb0`.

**`confused-deputy` was started in round 1 and never reported.** Its probe scripts exist
under `security/red-team/probes/`; the class is not counted above and is not covered.

**Never attacked.** Recorded in `BACKLOG.md` §3 with reasons. The largest gaps are the
updater and package integrity, model and plugin supply chain, USB continuity on a foreign
host, and campaign-scale (as opposed to single-write) memory and RAG poisoning.

---

## 3. How every fix in this campaign was made

The same five steps, in this order, without exception:

1. **Reproduce independently** against the running product — never fix from a report
   alone. Agents in this project have been wrong before.
2. **Fix the underlying property**, not the reported payload.
3. **Regression test** asserting on the observable consequence — what reached the disk,
   the model, the notification hub, the confirmation queue — never on a returned summary.
4. **Mutation test**: remove the defence, confirm the *named* test fails, restore it,
   confirm it passes.
5. When mutation does **not** distinguish the defence, say so in the source and in
   `BACKLOG.md` §5 rather than describe it as protecting something.

35 mutations were run in round 2. Five defences turned out not to be load-bearing and are
labelled defence-in-depth rather than removed or overstated.

Two mutations changed the campaign's conclusions rather than confirming them:

- Deleting **both** named never-tier branches left all 609 tests green. The tier is
  actually held by the permission gate's final **default-deny**; the two explicit
  branches supply a better reason string. All three must be removed together before a
  never-tier handler runs. Written into the test rather than smoothed over.
- Replacing the client session token's constant-time comparison with a prefix match also
  left the whole suite green — the token, the client protocol's only authenticator, had
  no test at all.

---

## 4. Tests this campaign found lying

Nine tests were named for a property they did not test. Each is corrected in the commit
that found it:

- Three never-tier tests exercised only `disk_wipe` and `credential_extract`, whose
  handlers unconditionally return `ok: false` — so both enforcement layers could be
  deleted with all three still green.
- `keeps the device private key out of everything that is shared or stored` asserted on
  field *names*, not on the key's bytes.
- `never reports an optimization the adapter did not accept` omitted a required argument,
  making its whole body unreachable.
- `refuses every representation of a path outside the roots` checked one sentinel string
  that two of its seven targets never contained.
- `does not log secrets from a remember turn` asserted on a log that never carries user
  text.
- `grantsRespectForbiddenPowers` compared two disjoint namespaces and was constant-true.
- A confirmation-queue-cap test drove a turn, so a *different* bound stopped the flood
  before the cap was ever consulted.
- A retrieval-bound test asserted on wall clock and passed with the bound removed,
  because a test-sized corpus is not slow.

Add to those the ones round 1 found (`now.test.ts` asserting an offline device by
enrolling it; `confirmation-authority.test.ts` reading `decision.allowed === false` as
proof of refusal when it is false for every confirm-tier tool *even as it runs*).

The pattern is worth stating plainly: **this campaign kept finding faults in its own
output** — a constant-true startup guard, nine vacuous tests, a Windows-breaking
regression, a stray file committed into the working tree, and an own-paths registration
that covered one directory of five. That is the argument for mutation-testing every
defence rather than trusting that a passing test means anything.

---

## 5. The security gate

`npm run security:quick` → `scripts/run-security-suite.mjs`. **19 files**, each labelled
with the attack class it covers.

Two guards on the suite itself:

- it **fails** if a listed file has vanished — a silently shrinking suite is worse than
  none;
- it **fails** if a security-relevant test file exists that the suite does not list. That
  gap was real: `permissions.test.ts` held the only coverage of the never-tier
  *escalation* — the rule governing tools Vesper did not write, such as an MCP server's —
  and was never listed, so deleting the escalation left the gate green.

---

## 6. Standing limits on any claim made from this work

- Vesper is **not** universally secure and nothing here supports that claim. What this
  campaign supports is narrower: these specific attacks, against these specific commits,
  on Linux, with the results recorded in the final report.
- Windows is a **separate security environment**. `openContained` relies on `O_NOFOLLOW`,
  which does not exist there — the code guards it with `?? 0`, so on Windows the flag is
  absent and the syscall does not carry the symlink check. **The TOCTOU window is open on
  that platform.** Reparse points, junctions, hard links, case folding, extended-length
  paths, alternate data streams and ACLs are all untested. See `BACKLOG.md` §1.
- A green `windows-latest` CI job means the Node test suite passed on a Windows runner.
  It does **not** mean the platform's filesystem or security semantics were exercised.
- Nothing has been validated on physical hardware. The tray, audio, live telemetry and
  real optimizer surfaces remain untested on a real machine.
- No transport exists, so no transport-level attack was possible or attempted. No
  inbound listener was opened at any point in either round.
