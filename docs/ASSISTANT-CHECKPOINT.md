# Assistant build — checkpoint

Phase 1 (assistant foundation), Phase 2 (durable runtime + governor + rollback +
continuity + physical-PC prep), Phase 3 (closing the loops) and Phase 4 (PC-ready
residency) are on this branch. Phases 1, 2 and 3 are merged into `main` at `d0d807d`.

**Phase 3 closed the loops Phase 2 left open.** Several phase-2 subsystems were, in this
project's own classification, *implemented and tested but not wired* — real modules with
no call site asking for the guarantee they offered. See `docs/phase-3-runtime.md`.

**Phase 4 made Vesper ready to live on the PC.** The Windows startup primitives had no
call sites; the runtime awaited `knowledge.reindex()` on the critical path; there was
no readiness state to distinguish "process alive" from "actually ready"; the lifecycle
controller had no per-hook timeout. All four are addressed. See `docs/residency.md`.

Last touched 2026-08-29. Everything below is observed output or a repo fact.

---

## 1. Terrain (verified, not assumed)

| | |
|---|---|
| Authoritative repo | **`MMGSaint/vesper-ai`**, working copy `/home/user/vesper-ai` |
| Not the target | `/home/user/Vesper-personal-assistant-` is a **second working copy of this same repository**, sitting on a detached HEAD several commits behind the tip. It is not an empty scaffold — earlier checkpoints said so and were wrong. **Do all work in `/home/user/vesper-ai`.** A stale second checkout is an active hazard: it made four adversarial verifier agents report real code as "non-existent" (see `security/BACKLOG.md` §4b). |
| Work branch | `claude/vesper-local-ai-build-ti8ofa` |
| HEAD | phase-4 work on the branch, ahead of `main` |
| `origin/main` | `d0d807d` — phases 1–3 landed here, CI and CodeQL green on it |

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

## 2b. Phase 3 additions

Each of these existed as a module before this phase and had no call site.

| Loop | What closed it |
|---|---|
| **fs_write rollback** | pre-image captured before the write, restore back through `writeApproved`, delete through a contained primitive that is deliberately not a tool. Refuses on drift, on a missing file, on an absent post-image, and on a target that has left the approved roots. |
| **Scheduler → tools** | a `tool_call` executor going through `ToolRegistry.invoke` under a new `scheduled` origin that reaches strictly less than a person at the keyboard. Confirm-tier is refused, not deferred. A refusal is terminal rather than retried. |
| **Correction records** | a durable store plus a producer that compares what Vesper expected against what the optimizer observed. Three outcomes, including "the assumption held" and "inconclusive". |
| **Catch-up** | outstanding work read from the queue, autonomy decisions including deliberate no-action, corrections, and an explicit statement of how far back the digest can see. |
| **First boot** | the probe registry is consulted instead of six hard-coded strings; a real Windows probe now outranks the placeholder regardless of registration order. |
| **NEXUS boundary** | one capability classifier shared by the client gateway and the capability manifest, which previously disagreed about the same adapter. |

**Defects found while wiring, each with a regression test:**

- `fs_write` opened with `O_TRUNC`, so a file with more than one hard link was already
  emptied when the hard-link check ran — an `ok: false` that had destroyed the data.
- The probe ids (`gpu.live`) and first-boot step ids (`gpu`) are different vocabularies
  while the module's comment said they matched; a direct lookup returns `undefined` for
  all six and silently keeps the hard-coded text.
- Probe priority was insertion order and the placeholders claim `win32`, so a real
  Windows probe registered afterwards would never have run — on the one machine where it
  was implemented.
- `decideRemoteToolRequest` treated every non-`remote` origin as fully authorized, so
  adding any origin kind would have granted it the authority of the person at the
  keyboard.
- The first-boot optimizer step classified on `mode` alone while its detail also required
  an endpoint: one line disagreeing with itself.
- `preferredBackend` was re-derived knowing only two backends, so a Vulkan-only host got
  two different answers to one question.
- `voiceEnabled` was hard-coded false in the first-boot report.
- `hardware.mode: "live"` is recorded in four places and branched on in none.
- The doctor's `cloud-not-required` check was `x === false || true` — a constant wearing
  the shape of a computation.
- The client gateway and the capability manifest classified the same mock optimizer
  differently (`DEGRADED` vs `NOT_CONFIGURED`).

**One test assertion was a proxy and is now the property.** `injection-wiring.test.ts`
checked that the token `fs_write` never reached the system prompt. The repo's own docs
are inside the knowledge root, so a document *about* fs_write rollback is legitimately
retrievable and tripped the check while the payload was fully contained. It now asserts
on fragments distinctive to the payload; mutation confirms it still catches a real
screening bypass.

---

## 2c. Phase 4 additions

| Loop | What closed it |
|---|---|
| **Startup registration wired** | Reconcile layer above `startup.ts` with honest three-state inspect, refuses on unknown state, refuses launcher targets that are not a Vesper launcher. Three CLI commands (`--startup-status`/`--enable-startup`/`--disable-startup`) dispatched before `createProductionHost`. Boot-time reconcile in the background. Config write-back through a `patchConfigFile` that preserves keys the patch did not name. |
| **Readiness states** | Seven-state `ReadinessMonitor` with a monotonic `advanceTo` and component observations. Never regresses to INITIALIZING from a settled state; shutdown states always win. Wired into `runtime.start()`/`stop()` and reported through the doctor. |
| **Startup no longer blocks on reindex** | `knowledge.reindex()` moved off the critical path into a `void (async () => {})` block. Pinned structurally so a regression that adds `await` back fails a named test. |
| **Bounded shutdown** | Per-hook `timeoutMs` on the lifecycle controller (default 5 s). Hooks that overshoot are left running and shutdown moves on with an honest timeout error. The bound is a REFERENCED timer, deliberately not unref'd — an unref'd timer would let Node exit before it fired and report success on a shutdown that stalled. |
| **Doctor coverage** | New `readiness` and `startup-registration` checks. Readiness passes for READY/DEGRADED/CORE_READY (DEGRADED is honest, not broken). Startup fails when the registry disagrees with the preference. |

**Defects found while wiring — every one had an existing test that missed it:**

- The startup primitives' reader `readStartupRegistration` collapsed "no entry" and
  "we could not look" into `registered: false`. A repair path built on that would
  rewrite on every boot after a transient reg.exe failure — exactly what a repair path
  exists to prevent.
- The launcher target was validated only against control characters. reg.exe runs the
  string at every logon; anything short of a Vesper-launcher containment check would
  let a caller register `cmd.exe /c calc`.
- The PowerShell installer wrapped the Run value in literal double quotes; the reader
  captures them verbatim. A reconcile that compared the two would rewrite on every
  boot.
- `writeConfigIfMissing` refuses when the file exists AND drops entire sections in
  its `publicConfig` projection. Reusing it as a saver would delete permissions
  overrides and approved roots. `patchConfigFile` deep-merges and preserves.
- docs/known-limitations.md and docs/status.md said the startup primitives were
  "implemented and unit-tested against a fake runner". False: no test injected a
  runner, and no startup.test.ts existed. Now they exist and use the seam
  `windows/exec.ts` explicitly documents.
- `runtime.start()` awaited `knowledge.reindex()` on the critical path — silently
  adding seconds to logon on a fresh install with a full knowledge root.
- A pre-existing test-order flake in `security-invariants.test.ts` surfaced under the
  new timing: two tests read a memory whose key is also pre-seeded, and picked the
  wrong entry with `.find` when the seed and the write landed in the same millisecond.
  Fixed by picking by `source: "user"` rather than by insertion order.

---

## 3. Verified continuously

| Check | Result |
|---|---|
| `npm test` | **1084 pass, 0 fail, 0 skipped** (671 at Phase 1 start, 894 at Phase 2 end, 1023 at Phase 3) |
| `npm run security:quick` | **373 pass, 0 fail** (361 at Phase 3 end; the gate grew by one file, none dropped) |
| `npm run hygiene` | clean, 368 files |
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

- ~~fs_write rollback integration~~ — **done in Phase 3.**
- ~~Decision-correction records~~ — **done in Phase 3.** A store plus an optimizer
  producer; the capsule slot now has something to carry.
- **Cross-device transport** — capsules exist, no transport carries them.
  Needs an explicit user decision because opening a listener on a personal
  machine is not Vesper's call.
- ~~An executor that invokes a tool under the same permission gate~~ — **done in
  Phase 3.** Timer-based and reminder-style executors are still open.
- ~~Governor decision reads~~ — **done.** Catch-up still counts them; `governor_decisions`
  (read-tier, trusted-only) and `--decisions` now query the journal by optional
  correlation id. Forged bus events are labelled unauthenticated and never summarised
  as something Vesper authorised. Session-nonce vouched vs previous-session recorded
  stay distinct claims.
- Timer-based and reminder-style executors are still open.

### P2 / P3

Windows packaging (PARTIAL) · voice (PARTIAL) · mobile (PARTIAL — protocol
real, in-process only) · skills/plugins, model migration, outcome learning
(FUTURE).

---

## 6. Exact next actions

**The next milestone is the FIRST REAL PC BOOT, not another architecture change.**
The ordered workflow is `docs/first-pc-boot.md`, updated for the residency work in
`docs/residency.md`. Everything below is what remains verifiable without that machine.

1. **Real Windows hardware probes** — the interface, the checklist and the priority rule
   are ready; the six probes are not written because they need the physical PC.
2. **NEXUS re-detection** — the adapter is constructed once at startup from config, so a
   `mock → live` transition requires a restart. The shared `classifyOptimizerCapability`
   is the seam a future re-detection path would feed. Not built yet because a real NEXUS
   endpoint is a physical-PC prerequisite.
3. **Timer / reminder executors** — `tool_call` is wired; a due-at executor that is not
   a tool call is still open.
4. **Physical validation** — everything under §7 waits on the target PC.

~~Governor decision-journal query~~ — **done at b292d97.** `governor_decisions` + `--decisions`.
The first PC boot ran an older tree and rejected `--decisions`. Pull `b292d97`; `--help`
must then list the flag. The Windows launcher now forwards `%*` so
`vesper-host.cmd --decisions` reaches parseCli.

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
weakened, and tests must not be removed to make it pass. Phase 3 added four files to it
(`tools/filesystem-rollback`, `tool-executor`, `security-corrections`,
`security-nexus-boundary`) and widened the auto-detect pattern so the rollback tests
cannot be dropped silently. 297 → 361.

**Phase 3 did not run a red-team campaign, by instruction.** It added targeted security
regression tests alongside each new seam, which is a different thing and is stated as
such: the coverage is "these specific bypasses are closed and mutation-proven", not
"this subsystem has been attacked.

**Transport is still not wired.** Session capsules have a shape, a signature,
and a verify/ingest path; nothing carries them between machines. `.listen(` in
the tree is `models/ollama-loopback.ts` (a test server, imported only by its
own test, bound to `127.0.0.1:0`) and `live-backend.test.ts`. Opening a
listener on a personal machine needs an explicit user decision that has not
been made.
