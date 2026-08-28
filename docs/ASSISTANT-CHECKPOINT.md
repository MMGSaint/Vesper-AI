# Assistant build — checkpoint

Phase 1 (assistant foundation) and Phase 2 (durable runtime + governor +
rollback + continuity + physical-PC prep) are both on this branch. The next
session picks up from a runtime that has real durable state and a
deterministic authorization ladder.

Last touched 2026-08-28. Everything below is observed output or a repo fact.

---

## 1. Terrain (verified, not assumed)

| | |
|---|---|
| Authoritative repo | **`MMGSaint/vesper-ai`**, working copy `/home/user/vesper-ai` |
| Not the target | `/home/user/Vesper-personal-assistant-` is an empty scaffold — one commit, a README, no code. **Do not migrate or restart the project there.** |
| Work branch | `claude/vesper-local-ai-build-ti8ofa` |
| HEAD | `dba22dd`, pushed, **29 commits ahead of `origin/main`** |
| `origin/main` | `9b7d924` — the round-2 security campaign is merged there |

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
| `npm test` | **880 pass, 0 fail** (was 671 at session-start of Phase 1) |
| `npm run security:quick` | **294 pass, 0 fail** |
| `npm run hygiene` | clean, 341 files |
| `npx tsc --noEmit` | clean |
| Journal adversarial workflow | 30 CONFIRMED findings — all HIGH fixed with regression tests |
| Phase-2 attack suite | 28 CONFIRMED (1 CRITICAL, 10 HIGH) across scheduler / governor / checkpoint, **plus 12 capsule findings the verifiers wrongly refuted** — all fixed, 37 regression tests |

Every load-bearing defence added this session is either mutation-proven or
attack-proven. Three defences are honestly labelled defence-in-depth rather
than claimed load-bearing (all in journal / workspaces code).

---

## 4. Session commit list (Phase 2 half)

```
92edb97 feat(hardware): probe interface + physical-PC validation checklist
63c96ba fix(events): harden the durable journal against 10+ adversarial findings
849d629 feat(continuity): session capsule — signed handoff, no transport
3ee5d2b feat(rollback): deterministic checkpoint/rollback for Vesper-owned state
cae3771 feat(autonomy): governor that wraps the permission gate and only tightens
02278f6 feat(scheduler): a task scheduler that actually drives the queue
c735224 feat(events): durable event journal alongside the 500-entry hot ring
```

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
changing the security model · merging this branch to main.

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
all 12 capsule findings because they read the wrong repository — the session cwd
is an empty scaffold, not the source tree. A CRITICAL identity-spoofing bug was
nearly dismissed on that basis. Any future adversarial pass should have its
agents state which repository root they read, and a refutation of the form "the
file does not exist" should be read as a signal about the harness, not the code.
Recorded in `security/BACKLOG.md` §4b.

Keep `npm run security:quick` as a permanent regression gate. Do not restart
the red-team campaign as part of the build mission; track platform/security
gaps in `security/BACKLOG.md`. Phase-2 attack findings and their fixes are in
commits 63c96ba, 2441148, d593562, and dba22dd; what was deliberately not
fixed is in `security/BACKLOG.md` §4b.
