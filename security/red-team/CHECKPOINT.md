# Red team checkpoint — campaign INCOMPLETE, do not merge

**Status: PAUSED mid-campaign at a session limit. 8 of 20 attack classes reported.
23 reproduced findings are outstanding and UNFIXED, including one CRITICAL arbitrary
file write. `agent/distributed` must NOT be merged into `main` in this state.**

Written 2026-08-27. Everything below is either observed output or a repo fact; nothing
here is a prediction.

---

## 1. Campaign identity and how to resume it

| | |
|---|---|
| Campaign | `vesper-adversarial-campaign` |
| Workflow run id | `wf_735640a9-27a` |
| Task id | `wsu8sjad2` |
| Script | `/root/.claude/projects/.../workflows/scripts/vesper-adversarial-campaign-wf_735640a9-27a.js` |
| Journal (source of §4) | `/root/.claude/projects/.../subagents/workflows/wf_735640a9-27a/journal.jsonl` |
| Raw agent reports | `security/red-team/agent-findings.json` (in this repo — the durable copy) |
| Reproduction scripts | `security/red-team/probes/` (99 scripts, runnable in place) |

The workflow paths above live in the session container and **will not survive it**. The
two repo paths are the durable record. Resuming does not require the workflow.

To re-run any reproduction:

```bash
cd /home/user/vesper-ai
node --experimental-strip-types security/red-team/probes/<class>/<script>.ts
```

Import paths were rewritten from the original out-of-repo location, so they run as-is.
Verified working: `probes/_orchestrator/scope-confusion.ts`.

---

## 2. Attack classes — completed vs remaining

**Reported (8/20).** Counts are from the agents' own structured reports.

| Class | Attacks attempted | Findings | Controls that held |
|---|---|---|---|
| `document-rag-injection` | 18 | 2 | 10 |
| `prompt-injection-conversation` | 47 | 3 | 8 |
| `permission-escalation-chaining` | 20 | 2 | 5 |
| `memory-poisoning` | 10 | 4 | 7 |
| `command-execution` | 6 | **0** | 6 |
| `filesystem-escape` | 40 | 3 | 4 |
| `device-session-capability` | 31 | 6 | 12 |
| `wrapping-nonce-integrity` | 28 | 3 | 7 |

**Started but never reported (probe scripts exist, findings unknown — re-run these
first, the work is partly done):**

- `confused-deputy`
- `serialization-parser-differential`

**Not started (10):**

- `optimizer-trust`
- `false-action-claims`
- `secret-exfiltration`
- `network-ssrf-ipc`
- `storage-workspace-isolation`
- `dos-resource-exhaustion`
- `context-management`
- `concurrency-races`
- `error-paths-fail-open`
- `security-test-quality`

Note: the orchestrator covered parts of `error-paths-fail-open`,
`dos-resource-exhaustion`, `context-management` and `security-test-quality` by hand
(§3). Those hand passes are **not** a substitute for the dedicated agents — they were
opportunistic, not systematic.

---

## 3. Vulnerabilities FIXED this session (orchestrator's own attacks)

All five were reproduced against a running product before any fix, and every mechanism
was mutation-checked afterwards (mechanism removed → named tests go red).

| # | Severity | Finding | Repro | Fixed in | Mutation-checked |
|---|---|---|---|---|---|
| F1 | CRITICAL | Confirmation queue laundered authority: a device forbidden the filesystem wrote to the host disk by approving a held `fs_write` it could not have requested | `probes/_orchestrator/confirm-laundering.ts` | `561528a` | yes (2 mutations) |
| F2 | CRITICAL (narrow reach) | `confirmed: true` acted as a master key — gate said "unrecognised permission level… refusing" and the handler ran and returned success | `probes/_orchestrator/unknown-level.ts` | `48c764a` | yes |
| F3 | HIGH | Client scopes guarded gateway methods only; a `conversation`-only session read a bank PIN, read a file off disk via the knowledge index, and planted a memory | `probes/_orchestrator/scope-confusion.ts`, `context-leak.ts` | `508bb20` | yes (2 mutations) |
| F4 | HIGH | Device name and optimizer status went verbatim into the **system prompt**, with a forged boundary marker and their own directive line | `probes/_orchestrator/system-prompt-injection.ts` | `5581544` | yes (2 mutations) |
| F5 | MEDIUM | Unmapped tools skipped the trust check entirely — a **revoked** device's held request still ran | in `confirmation-authority.test.ts` | `561528a` | yes |

Two further defects found while *proving* F1, both fixed in `561528a`:

- An authority refusal **consumed** the confirmation, so anyone able to attempt an
  approval could permanently cancel one.
- A restored confirmation carrying no origin was read as `local`, making the queue file
  a way to ask for anything.

### Existing tests found to be falsely passing

1. `now.test.ts` — asserted an "offline" device by enrolling it; enrolment *is* contact,
   so the device was online and the assertion passed for the wrong reason. Fixed earlier
   in `a26b165`.
2. `confirmation-authority.test.ts` (as first written) — asserted
   `decision.allowed === false` as proof a tool was refused. That field means "allowed
   *without* confirmation" and is `false` for every confirm-tier tool **even as it
   successfully runs**. Corrected to assert on the result and on the disk.
3. `tools/remote.test.ts` — asserted that memory and knowledge tools were "already
   governed by scopes and need no rule here". That was not a test of the system; it was
   a statement of vulnerability F3. Corrected to assert enforcement (deliberately
   corrected rather than deleted, so the wrong assumption cannot return quietly).

---

## 4. Vulnerabilities OUTSTANDING — reported by agents, NOT yet verified or fixed

**Only the CRITICAL has been independently verified by the orchestrator** (see below).
The other 22 carry the
agent's own claim that it reproduced it, and each has a repro script. **Verify by
running the script before acting on it** — agents have been wrong before in this project.

Full detail including verbatim observed output and proposed fixes:
`security/red-team/agent-findings.json`.

### CRITICAL

| Class | Finding |
|---|---|
| `filesystem-escape` | **`fs_write` escapes the approved root through a dangling symlink — arbitrary file write. VERIFIED BY THE ORCHESTRATOR, not merely agent-reported.** `realpath` cannot resolve a link whose target does not yet exist, so containment passes and the write follows the link out. Re-running the probe wrote `PWNED-IN-ETC` to `/etc/vesper-pwn-probe.txt` (artifact deleted afterwards) and reproduced end-to-end through the runtime, not only against the helper. Reading back through the same link *is* correctly refused — realpath resolves once the target exists — so the read path is sound and only the write path is broken. This is the single most important item in this document. |

### HIGH

| Class | Finding |
|---|---|
| `filesystem-escape` | A symlinked **directory** registered as a knowledge-source root reads and exfiltrates files outside the approved tree |
| `device-session-capability` | **Revocation is not terminal**: `revoked → restricted → trusted` fully restores a revoked device. Contradicts a stated invariant and `docs/distributed.md`. |
| `wrapping-nonce-integrity` | `neutralisePayload` escapes **before** stripping invisible characters, so a payload can reassemble the sentinel after escaping |
| `wrapping-nonce-integrity` | `sanitiseInline` has the same reassembly bug **and feeds the system prompt with no screening** — this is a defect in the F4 fix made this session |

### MEDIUM

| Class | Finding |
|---|---|
| `document-rag-injection` | Gateway knowledge search ignores workspace scoping, leaking workspace-restricted documents to a restricted companion |
| `prompt-injection-conversation` | Confirmation prompts bind to the wrong action — the agent surfaces the *first* pending confirmation, not the one being answered |
| `prompt-injection-conversation` | Host-session-mutating tools remain unscoped on the conversation surface (a restricted device can mutate host session state) |
| `permission-escalation-chaining` | Remote authorization is default-ALLOW for unmapped tools; a restricted device mutates host state |
| `memory-poisoning` | `memory_remember` (autonomous "safe") is an unconfirmed alias for `memory_forget` ("confirm") — overwrite achieves deletion |
| `memory-poisoning` | A remote device with `memory.write` can silently evict the user's own memories |
| `filesystem-escape` | `isDangerousRoot` defeated by a doubled leading slash; empty `approvedRoots` leaves knowledge indexing unconfined |
| `device-session-capability` | Session grants ignore the restricted trust-class scope ceiling |
| `device-session-capability` | `ReplayGuard` evicts under capacity pressure, re-opening replay of a spent session grant |
| `device-session-capability` | Device targeting resolves on a **self-declared device name**, so an enrolled device can capture another's work |
| `wrapping-nonce-integrity` | U+00AD SOFT HYPHEN is in neither the invisible-character set nor the screening normaliser |

### LOW / INFORMATIONAL

`document-rag-injection` separator-obfuscation gap in screening · `prompt-injection-conversation`
peer device name rendered verbatim (**partly addressed by F4 — re-verify**) ·
`permission-escalation-chaining` `diagnostics_report`/`devices_list`/`system_info` reachable
by a restricted device · `memory-poisoning` gateway records every remote write as
`source:"user"` · `memory-poisoning` retrieval crowding fills the 6-slot slate ·
`device-session-capability` capability manifest is a pure declaration ·
`device-session-capability` `issueSession` requires no proof of possession and `hello()`
discloses the host device id.

### Overlap warning

Several agent findings target code the orchestrator changed *during* the campaign, so
the agents may have been reading a version that has since moved:

- The two `wrapping-nonce-integrity` HIGH findings concern `sanitiseInline`, which was
  **added in `5581544` during this campaign**. Treat them as live defects in new code.
- `permission-escalation-chaining`'s "default-ALLOW for unmapped tools" overlaps F5 and
  the scope work in `508bb20`. **Re-run that repro against HEAD before acting** — it may
  be wholly or partly closed already.
- `prompt-injection-conversation`'s "device name rendered verbatim" is addressed by F4.
  Re-verify rather than assuming.

---

## 5. Security invariants established (all passing at HEAD)

`src/vesper/security-invariants.test.ts` — 22 tests, written as properties:

- an unauthorized tool never executes; an unrecognised permission level is refused
- a client's claims are not authority (declared capabilities, never-remote at every
  trust class, revoked devices perform nothing)
- untrusted text never changes deterministic policy (documents, memory, hostile config)
- filesystem access never leaves the canonical approved roots (representations, symlinks)
- a model's claim is not evidence
- a mock never becomes live
- malformed input never increases authority; corrupt stored state is not permissive state
- a secret never leaves through a side channel
- an offline target is never silently replaced
- a scope governs its data on every route
- the untrusted boundary contains, and does **not** claim integrity (deliberately pinned
  as a non-property, so nobody builds on a guarantee that was never made)

---

## 6. Reusable suite delivered

`npm run security:quick` (and `npm run security`, same target) →
`scripts/run-security-suite.mjs`. **13 files, 153 tests, ~3 seconds.** The file list
lives in one place with the attack class each covers, and the runner **fails** if a
listed file has vanished — a silently shrinking suite is worse than none.

`docs/security-testing.md` records how these tests are written, the three found passing
for the wrong reason, and what the deeper campaign would cover (stated as not built).

---

## 7. Checks executed, and their results at HEAD `52906a4`

| Check | Result |
|---|---|
| `npm test` | **536 pass, 0 fail** |
| `npm run security:quick` | **153 pass, 0 fail** |
| `npx tsc --noEmit` | clean |
| `npm run hygiene` | passed (316 files, includes the preserved probes) |
| CI (ubuntu + windows) | green on every pushed commit through `48c764a` |
| CodeQL `security-extended` | green on `a26b165`; **not yet run on the five security commits** |

### Still required before any merge

1. Verify and fix every outstanding finding in §4 (CRITICAL first).
2. Finish the 12 unreported attack classes in §2.
3. Re-run the full gate: `npm test`, `npm run security:quick`, `npx tsc --noEmit`,
   `npm run hygiene`, `npm run build`.
4. Confirm CI green and CodeQL green **on the final head**, not on an ancestor.
5. Only then merge `agent/distributed` → `main` by the repo's normal PR flow.

---

## 8. Repository state

- Branch: **`agent/distributed`**, HEAD **`52906a4`**
- Working tree: **clean** before this checkpoint commit; nothing stashed, nothing lost
- **8 commits ahead of `origin/main`, 0 behind**
- No force-push, no history rewrite, no production deployment, no listener opened, no
  test skipped or weakened, no Mortis change

Commits ahead of main:

```
52906a4 test(security): pin what the untrusted boundary guarantees, and what it does not
48c764a fix(security): confirmation is an answer, not a master key
5581544 fix(security): nothing but Vesper speaks in Vesper's own voice
508bb20 fix(security): a client scope governs its data on every route, not just its method
561528a fix(security): approving a held action exercises the approver's own authority
940cc17 fix: three claims that were not quite true
bfcb87c Merge main into agent/distributed after PR #8
341de38 docs: the distributed and portable architecture, and what is not built
```

---

## 9. Exact next actions to resume

Do these in order. Do not skip step 1 — it is a live arbitrary-file-write.

```bash
cd /home/user/vesper-ai && git checkout agent/distributed && git pull

# 1. CRITICAL — verify the dangling-symlink write, then fix it.
#    Root cause per the agent: realpath cannot resolve a link whose target does not
#    exist yet, so containment passes and the write follows the link out.
#    Look at resolveApprovedPath / resolveApprovedPathReal in src/vesper/tools/filesystem.ts.
node --experimental-strip-types security/red-team/probes/filesystem-escape/attack5-dangling-symlink-write.ts

node --experimental-strip-types security/red-team/probes/filesystem-escape/attack2-symlink-source-root.ts

# 2. The two HIGH wrapping findings — defects in code added THIS session.
#    escape-before-strip in neutralisePayload and sanitiseInline (src/vesper/untrusted.ts):
#    strip invisible characters BEFORE escaping, then re-check, or the payload reassembles.
node --experimental-strip-types security/red-team/probes/wrapping-nonce-integrity/attack1-reassembly.ts
node --experimental-strip-types security/red-team/probes/wrapping-nonce-integrity/attack2-e2e-systemprompt.ts

# 3. HIGH — revocation is not terminal (revoked -> restricted -> trusted).
#    src/vesper/distributed/registry.ts setTrust: revoked must be absorbing.
node --experimental-strip-types security/red-team/probes/device-session-capability/attack3-revocation-launder.ts

# 4. Work the remaining MEDIUMs, then re-run the 12 unreported classes.
#    The campaign script is gone with the container; re-launch a fresh Workflow using
#    the class list in §2 and the same rules: read-only on the repo, probes outside it,
#    every finding reproduced with verbatim output.

# 5. Full gate, then CI + CodeQL on the final head, then PR.
npm test && npm run security:quick && npx tsc --noEmit && npm run hygiene && npm run build
```

**For each fix, keep the loop:** reproduce → fix at the trust boundary → re-attack →
attack the fix by a materially different route → add a regression test → mutation-check
that the test goes red without the mechanism → full gate.

---

## 10. Honest limits of this checkpoint

- The 23 findings in §4 are **agent-reported, orchestrator-unverified**. Some may be
  false positives; some may already be closed by this session's commits. Verify before
  fixing.
- 12 of 20 attack classes were never run. Their absence is not evidence of safety.
- Nothing here has been validated on physical hardware; the Windows, tray, audio and
  live-telemetry surfaces remain untested on a real machine.
- No transport exists, so no transport-level attack was possible or attempted.
