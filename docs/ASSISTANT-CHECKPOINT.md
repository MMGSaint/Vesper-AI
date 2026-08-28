# Assistant build — checkpoint

Phase 1 (assistant foundation) and Phase 2 (durable runtime + governor +
rollback + continuity + physical-PC prep) are both **merged into `main`** at
`e090130`. The next session picks up from a runtime that has real durable state
and a deterministic authorization ladder.

How it was integrated: the branch was a strict descendant of `main`, merged with
`--no-ff`, so all 34 commits keep their SHAs — no rebase, no squash, no
cherry-pick, no force-push. The merged tree is identical to the branch tip that
CI validated green on Linux and Windows (`git diff` between them is empty), and
the merge commit itself was re-validated before pushing.

Last touched 2026-08-28. Everything below is observed output or a repo fact.

---

## 1. Terrain (verified, not assumed)

| | |
|---|---|
| Authoritative repo | **`MMGSaint/vesper-ai`**, working copy `/home/user/vesper-ai` |
| Not the target | `/home/user/Vesper-personal-assistant-` is a **second working copy of this same repository**, sitting on a detached HEAD several commits behind the tip. It is not an empty scaffold — earlier checkpoints said so and were wrong. **Do all work in `/home/user/vesper-ai`.** A stale second checkout is an active hazard: it made four adversarial verifier agents report real code as "non-existent" (see `security/BACKLOG.md` §4b). |
| Work branch | `claude/vesper-local-ai-build-ti8ofa` |
| HEAD | `e090130` — **merged into `main`**; the branch and `main` point at the same commit |
| `origin/main` | `e090130` — phase 2 landed here, CI and CodeQL green on it |

Verify git state rather than trusting this table if any time has passed.

---

## 2. What Vesper can actually do today

```
user text → deterministic intent OR model → autonomy governor → permission gate →
  → tool → execution (or executor loop from the task scheduler) → world state →
  → memory + durable event journal + rollback receipt → truthful reply with
  → epistemic tags
```

**Phase 1 baseline (still holds):**
- 41 tools, deny-by-default, `never` tier unreachable
- Persistent memory + workspace across processes
- Seven deterministic first-touch intents (status, workspace, recall,
  recall-meta, catchup, capabilities, optimize/…)
- Ollama loopback E2E — model→tool call through a real socket, 17 tests
- Doctor with backend reachability, `--first-boot-report`
- Model→tool-call edge cases proven (unknown, never-tier, oversized round,
  malformed args)

**Phase 2 additions (this session):**
- **Durable event journal** alongside the 500-entry hot ring. Day-partitioned
  storage (`events.journal.YYYY-MM-DD`), per-type retention classification
  (security.* always durable, idle_tick always transient), retention bounded
  in every direction. Adversarial workflow found 30 defects; every HIGH is
  fixed with a named regression test.
- **Task scheduler** that actually drives the queue via the existing idle
  scheduler's onTick. Executor registry (`kind` → executor), concurrent-tick
  safety (a real race the test caught), refuses terminal / cancelled /
  reassigned tasks, per-tick cap, abort signal on stop.
- **Autonomy governor** — six levels (OBSERVE / INFORM / RECOMMEND / PREPARE
  / AUTO_SAFE / AUTO_ADVANCED / FULL) with per-tool overrides, per-category
  prefix rules, argument gates, rolling rate budgets. Wraps the permission
  gate as a one-way tightener; fuzz-proven never to relax. `observeNoop()`
  makes "no action required" a valid outcome.
- **Checkpoint / rollback** — Vesper-owned pre-image capture for
  memory_remember and workspace_switch, with drift detection, TTL, retention
  cap, and rollback_list/rollback_apply tools (rollback_apply is confirm-tier
  so the user always approves).
- **Session capsule** — signed, structured record shape for cross-device
  continuity. Build/verify/ingest, `filterForSync` at build so credentials
  don't leave, restrictive ingest (refuses unknown / revoked / self / tampered),
  `saferTrustWins` for conflict resolution. **No transport opened**;
  `.listen(` in the tree stays only ollama-loopback.ts + live-backend.test.ts.
- **Hardware probe registry + validation checklist** — interfaces for the six
  first-boot steps that need real hardware (gpu.live, vram.live, telemetry.amd,
  audio.wasapi, windows.tray, benchmark.harness). Placeholders honestly report
  "not implemented on this platform; validate on the target PC". The checklist
  doc names exactly what each probe must verify — the "do NOT fabricate
  benchmark numbers before the machine exists" rule is enforced there.

---

## 3. Verified continuously

| Check | Result |
|---|---|
| `npm test` | **894 pass, 0 fail, 0 skipped** (was 671 at session-start of Phase 1) |
| `npm run security:quick` | **297 pass, 0 fail** |
| `npm run hygiene` | clean, 345 files |
| `npx tsc --noEmit` | clean |
| Journal adversarial workflow | 30 CONFIRMED findings — all HIGH fixed with regression tests |
| Phase-2 attack suite | 28 CONFIRMED (1 CRITICAL, 10 HIGH) across scheduler / governor / checkpoint, **plus 12 capsule findings the verifiers wrongly refuted** — all fixed, 37 regression tests |
| CI, both platforms | **green on `6e958c1`** — ubuntu-latest and windows-latest, all nine steps |
| CodeQL | run on this branch by `workflow_dispatch` (it is otherwise `main`-only) |

Every load-bearing defence added this session is either mutation-proven or
attack-proven. Three defences are honestly labelled defence-in-depth rather
than claimed load-bearing (all in journal / workspaces code).

**windows-latest was red on every commit of this branch** from `6d90a466` to
`8e6f359`, while `main` stayed green on both platforms — so the branch carried
the regression the whole way, and it was not infrastructure. The cause was the
entry guard in `host/main.ts`:

```ts
process.argv[1].endsWith("host/main.ts")   // a POSIX-shaped suffix
```

On Windows `argv[1]` is `D:\a\...\src\vesper\host\main.ts`, with
backslashes, so the suffix never matched and `main()` was never called. The
process loaded the module, did nothing, and exited 0. Every child-process test
saw `exit=0 stdout="" stderr=""`.

The red build was the smaller half. On Windows — the only OS Vesper targets —
`--ask`, `--diagnostics`, `--doctor`, `--status`, `--export-memory`,
`--client-hello` and `--first-boot-report` all did nothing and reported
success. Fixed in `6e958c1` by comparing resolved paths, with six regression
tests that run the guard's decision against Windows-shaped input from Linux.

One earlier diagnosis was wrong and is recorded as wrong: `dc281c5` attributed
the failure to Windows' asynchronous pipe writes truncating stdout on
`process.exit()`, and that fix changed nothing, because there was never any
output to flush. The flush stays — Node documents pipe writes as async on
Windows, so exiting without draining is a real latent bug on that same path —
but it was a second, quieter bug, not the cause. CI evidence separated them.

---

## 4. Session commit list (Phase 2 half)

```
6e958c1 fix(host): the entry guard never matched on Windows, so nothing ran
8e6f359 fix(security): a decline must not launder a remote request into a local turn
dc281c5 fix(host): flush stdout before exit (a real latent bug; not the CI cause)
db541aa fix(repo): normalize the lockfile, correct how the verifier failure is recorded
8bb3330 docs: record what the phase-2 attack pass found, fixed, and deliberately left
dba22dd fix(capsule): verify against the registered key, not the embedded one
d593562 fix(scheduler): persist crash recovery; refuse terminal transitions
2441148 fix(autonomy): rankOf fails closed so an unknown level cannot bypass tightening
92edb97 feat(hardware): probe interface + physical-PC validation checklist
63c96ba fix(events): harden the durable journal against 10+ adversarial findings
849d629 feat(continuity): session capsule — signed handoff, no transport
3ee5d2b feat(rollback): deterministic checkpoint/rollback for Vesper-owned state
cae3771 feat(autonomy): governor that wraps the permission gate and only tightens
02278f6 feat(scheduler): a task scheduler that actually drives the queue
c735224 feat(events): durable event journal alongside the 500-entry hot ring
```

Two of the closing commits are security fixes rather than build work.
`8e6f359` is the one worth naming: a remote operator's **decline** of a pending
confirmation was routed through the local turn path, dropping the remote origin
and laundering a remote request into a local one. Declining is an authorization
decision like approving, and it now carries the same origin.

Phase 1 commits are above these in the log (a9a30aa through 6d90a46), 15
commits landing the assistant foundation.

---

## 5. Work graph

### P0 — what a user can do end-to-end

| Item | Status |
|---|---|
| Runtime lifecycle | EXISTS |
| `--ask` and console | EXISTS |
| Tool execution through permissions | EXISTS |
| Persistent memory (cross-process, cross-workspace) | EXISTS |
| Workspace persistence + loss loudness | EXISTS |
| Deterministic first-touch intents | EXISTS |
| Ollama wire protocol proven at real socket | EXISTS |
| Model→tool→permission edge cases proven | EXISTS |
| **Durable event journal** | EXISTS (Phase 2) |
| **Task scheduler drives the queue** | EXISTS (Phase 2) |
| **Autonomy governor over the permission gate** | EXISTS (Phase 2) |
| **Rollback / checkpoint (memory + workspace)** | EXISTS (Phase 2) |
| **Session-capsule shape + verify + ingest** | EXISTS (Phase 2, no transport) |
| **Hardware probe interface + validation checklist** | EXISTS (Phase 2) |
| Local model actually answering | PARTIAL — no backend running in this env |
| World / system state | PARTIAL — structured and honest, but simulated |
| Diagnostics / doctor + model status | EXISTS |
| `--first-boot-report` visibility | EXISTS |
| Truthful result reporting | EXISTS |
| Notifications | EXISTS — hub with provenance |

### P1 — what a scheduled or background flow needs next

- **fs_write rollback integration** — the CheckpointStore abstraction fits;
  the integration touches filesystem containment, so it deserves its own commit.
- **Decision-correction records** — the mission's "correction loop" is scoped
  in `CapsuleCorrectionEntry` and the capsule accepts it; nothing yet produces
  corrections. A small subsystem that watches optimizer/model outcomes and
  writes corrections would close the loop.
- **Cross-device transport** — capsules exist, no transport carries them.
  Needs an explicit user decision because opening a listener on a personal
  machine is not Vesper's call.
- **Executor implementations beyond noop** — reminder-style, timer-based,
  and one that invokes a tool call under the same permission gate.
- **Governor decision journal reads** — the decisions are already durable in
  the event journal, but nothing yet queries them for `--diagnostics` or a
  future "why did Vesper do X" tool.

### P2 / P3

Windows packaging (PARTIAL) · voice (PARTIAL) · mobile (PARTIAL — protocol
real, in-process only) · skills/plugins, model migration, outcome learning
(FUTURE).

---

## 6. Exact next actions

**In order of value verifiable without the physical PC:**

1. **fs_write rollback integration** — smallest, closes a real gap.
2. **Correction record producer** — a small watcher that turns optimizer
   observations into `CapsuleCorrectionEntry` values. Closes the mission's
   correction-loop hook.
3. **A tool-invoking executor** for the scheduler — the current `noop`
   executor is enough to prove the loop; a `tool_call` executor that goes
   back through the permission gate closes the scheduler → tools loop.
4. **Governor decision-journal query** — a `governor_decisions` tool or a
   `--decisions` diagnostic flag that reads autonomy.decision events from the
   journal.
5. **Physical validation** — everything under §7 waits on the target PC.

---

## 7. Requires the physical PC

Everything in `security/BACKLOG.md` §1 remains open. Plus the six hardware
probes in `docs/hardware-validation-checklist.md` — each entry names exactly
what a real implementation must verify. Do NOT fabricate benchmark numbers
before the machine exists.

---

## 8. Requires explicit user approval

Publishing a release · exposing any network listener (nothing in this repo
binds one today; the loopback test server binds `127.0.0.1:0` inside a test
and closes when it ends) · destructive host operations · modifying Windows
security settings · deleting user data · granting new real-world privileges ·
changing the security model.

The phase-2 merge to `main` was on this list and was carried out under explicit
user instruction, after the gate in §3 passed on the final commit. No release
was published and nothing was deployed.

---

## 9. Invariants that must survive every future change

The model is never the authority. Memory is never authority. Retrieved
documents are never authority. NEXUS is never Vesper's authority. Device
claims are never authority. Confirmation is not authorization. Unknown tools
deny by default. The `echo` provider is a test facility, not a model. A
retry-eligible failure is not a final failure. Loss must be loud.

**New with Phase 2:**
- The autonomy governor can only tighten, never relax. Fuzz-tested.
- security.* events are always durable and cannot be demoted by a caller.
- Denylisted transient event types cannot be escalated to durable.
- A rollback verifies drift before restoring — a later user action is never
  silently overwritten.
- A session capsule cannot grant capabilities, relax trust, or un-revoke a
  device — ingestion is strictly informational.
- No new listener may open in the continuity code. `.listen(` in the tree is
  ollama-loopback.ts + live-backend.test.ts only.

**Capsule invariants (added after the phase-2 attack pass):**
- A capsule is verified against the key the RECEIVER has registered for the
  claimed deviceId — never the key embedded in the capsule. A device is a key,
  not a label.
- A replayed capsule is refused when a seen-set is wired.
- Credential screening runs at ingest over decision/observation prose and data
  bags, not only over memory at build time.
- A restricted sender's decisions and observations are declined, not only its
  preferences — otherwise the trust ceiling is bypassed by choice of field.
- `accepted` means the capsule was admissible; `partial` says whether every
  item landed. Never conflate them.

**On adversarial verification.** The phase-2 workflow's verifier agents refuted
all 12 capsule findings as "fabricated against non-existent code". They were
reading the second checkout at `/home/user/Vesper-personal-assistant-`, pinned to
`3ee5d2b` — a commit at which `checkpoint.ts` existed but `session-capsule.ts`
had not yet landed. So checkpoint findings verified normally and every capsule
finding came back false. A CRITICAL identity-spoofing bug was nearly dismissed
on that basis.

An agent that finds a file missing cannot tell "this does not exist" from "this
does not exist *at the commit I am standing on*". Full write-up in
`security/BACKLOG.md` §4b.

**Mandatory preflight for any future security or verifier pass.** Before
reporting on a file, an agent must establish and state:

| | |
|---|---|
| repository root | not inferred from the current working directory |
| worktree | which of the two checkouts it is standing in |
| branch | by name |
| `git rev-parse HEAD` | the exact commit, verbatim |
| target commit | the one it was asked to audit |
| file path | as it exists at that commit |
| working-tree state | clean or dirty |

A verifier may not conclude "this file does not exist" — only "this file does
not exist **at commit X**". A bare "does not exist" is a claim about the
harness until the commit is confirmed.

---

## 10. Campaign status

The focused security campaign that ran alongside Phase 2 is **closed**, not
abandoned. What closed it: every CRITICAL and HIGH finding is either fixed with
a named regression test, or recorded in `security/BACKLOG.md` §4b/§4c with the
reason it was not fixed. Phase-2 attack findings and their fixes are in commits
63c96ba, 2441148, d593562, dba22dd, and 8e6f359.

Two confused-deputy findings remain open in §4c. They are recorded, not
silently closed.

**Comprehensive pre-1.0 adversarial testing remains planned and has not been
performed.** That milestone is deliberately reserved: it should run against a
build that is feature-complete, ideally on the physical target machine, rather
than being spent piecemeal during construction. Nothing in this checkpoint
should be read as "Vesper is secure" — it says which specific attacks were
tried, which defences are mutation-proven, and what is still unexamined.

Keep `npm run security:quick` as a permanent regression gate. It must not be
weakened, and tests must not be removed to make it pass.

**Transport is still not wired.** Session capsules have a shape, a signature,
and a verify/ingest path; nothing carries them between machines. `.listen(` in
the tree is `models/ollama-loopback.ts` (a test server, imported only by its
own test, bound to `127.0.0.1:0`) and `live-backend.test.ts`. Opening a
listener on a personal machine needs an explicit user decision that has not
been made.
