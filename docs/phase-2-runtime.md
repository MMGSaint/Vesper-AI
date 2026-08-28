# Vesper Phase 2 runtime — architecture

Phase 1 built the assistant. Phase 2 built the durable runtime it lives in.
This document describes each of the six new subsystems: what it does, what it
does *not* do, and where it plugs into the rest of the codebase. Every claim
here is either observed behaviour or a cited invariant.

---

## Data flow

```
                          ┌──────────────────────┐
                          │  user text / --ask   │
                          └──────────┬───────────┘
                                     ▼
                          ┌──────────────────────┐
                          │ deterministic intent │  ← Phase 1
                          │  OR model turn       │
                          └──────────┬───────────┘
                                     ▼
                          ┌──────────────────────┐
                          │ tool call proposal   │
                          └──────────┬───────────┘
                                     ▼
                          ┌──────────────────────┐
                          │ ToolRegistry.invoke  │
                          │  ├─ validateArgs     │
                          │  ├─ liveOrigin       │
                          │  ├─ gate.evaluate    │  ← Phase 1
                          │  ├─ governor.evaluate│  ← Phase 2 (only tightens)
                          │  ├─ decideRemoteToolRequest
                          │  ├─ never / confirm  │
                          │  └─ handler          │
                          └──────────┬───────────┘
                                     │
             ┌───────────────────────┼───────────────────────┐
             ▼                       ▼                       ▼
    ┌─────────────────┐   ┌─────────────────────┐   ┌────────────────────┐
    │ CheckpointStore │   │  memory / workspace │   │  events.emit(...)  │
    │  snapshot BEFORE│   │    write            │   │                    │
    │  verify AFTER   │   └─────────────────────┘   └──────────┬─────────┘
    └─────────────────┘                                         │
                                                                ▼
                                                   ┌────────────────────┐
                                                   │  EventBus (ring)   │
                                                   │  + Journal (durable)│
                                                   └──────────┬─────────┘
                                                              ▼
                                                   ┌────────────────────┐
                                                   │  catchup, audit,   │
                                                   │  future capsule,   │
                                                   │  scheduler         │
                                                   └────────────────────┘
```

The idle-scheduler `onTick` (Phase 1) drives both `lifecycle.idle_tick` and,
if enabled, `TaskScheduler.tick()`. The task scheduler routes queued tasks
against the device roster, and invokes registered executors on the assigned
subset — the executor's tool calls flow back through the same
governor→gate→handler chain above, so a scheduled task cannot bypass
authorization.

---

## A. Durable event journal (`src/vesper/event-journal.ts`)

**What it does:** persists a per-event decision (transient / durable) into
day-partitioned storage keys, bounded by both retention days and per-day
event cap. Journaled events survive past the 500-entry hot ring so catchup,
audit, and future continuity subsystems can look back beyond the ring.

**What it does not do:** replace the ring. The ring is still the hot path for
correlate.ts, catchup, and every emit subscription. The journal is a second
sink — a bus with no journal behaves exactly as before.

**Retention classification (deterministic, cannot be overridden):**
- `security.*` — always durable
- `lifecycle.idle_tick`, `lifecycle.background_start/stop`, `task.assigned`,
  `task.blocked`, `task.requeued`, `obs.state`, `optimizer.state`,
  `system.state` — always transient
- Everything else — durable unless caller passes `retention: 'transient'`

The mission's two hard rules ("security notices survive" and "background
noise does not accumulate") are absolute. A caller cannot promote a denylisted
transient type to durable, and cannot demote a security.* event.

**Bounds:**
- retentionDays clamped to [1, 365]. Infinity is rejected — a real defect an
  adversarial workflow found in the first draft.
- maxPerDay clamped to [50, 50_000].
- MAX_DATA_BYTES per event = 16 KiB (oversized payloads become a
  `{ truncated: true, originalSizeBytes: N }` sentinel).
- MAX_PENDING in memory = 4096 (oldest-first drop with a loud onWriteFailure).
- purgeOldPartitions runs on startup AND every 500 admits — a long-lived
  process cannot silently accumulate past the retention window.

**Loss story:**
- Storage write failure → `onWriteFailure` fires **every attempt**, not once
  per session.
- Corrupt partition → onCorruptPartition fires once per unique key; other
  partitions stay readable.
- Future-dated event.at → clamped to now on admit; a pre-existing
  future-dated partition is purged as an anomaly.
- Malformed event.at → clamped to now on admit; partitionKeyForIso has a
  defensive fallback so a bypass cannot plant a ghost partition.

**Query:**
- Every filter parameter is validated at query() entry (limit is a positive
  integer, correlationId is a non-empty string, since/until parse as full
  ISO with time and zone). A bad parameter throws — never silently widens
  the result set.
- Duplicate event.id on disk is deduped in the read path.

---

## B. Task scheduler (`src/vesper/task-scheduler.ts`)

**What it does:** turns queued tasks into executed tasks. Called from the
existing idle-scheduler `onTick`; runs `taskQueue.schedule(devices)`, picks
up tasks routed to this device, invokes a registered executor keyed by
`task.kind`, and calls `taskQueue.start` → executor → `complete`/`fail`.

**Executor registry:** `TaskExecutorRegistry.register(kind, executor)`. Built-in
`noop` executor exists so a user creating a task without a specialised
executor can still see the lifecycle round-trip.

**Invariants (each has a named test):**
- Terminal-state tasks (done/failed/cancelled) are never re-driven.
- A task cancelled between routing and execution is not started (re-fetch
  right before `start()`).
- Concurrent ticks cannot start the same task twice — the inFlight set claim
  is synchronous, before any await. (A real race the test caught in
  development.)
- Per-tick cap bounds how many tasks start in one pass (default 4).
- Executor throws are translated into `fail()` with a `task.execution_error`
  event — never surface as a runtime crash.

**What it does not do:**
- Reach across devices to execute — this scheduler runs tasks assigned to
  itself; another device's runtime picks up its own share.
- Invent authority. `start()` is a state transition; anything security-sensitive
  the executor does still goes through the tool registry and permission gate.
- Backoff between retries. The queue re-queues immediately. Backoff is a
  policy this class can grow into.

**Config:** `agent.driveTasksOnIdle` (default false — a runtime with no
executors stays silent) and `agent.tasksPerTick` (default 4).

---

## C. Autonomy governor (`src/vesper/autonomy.ts`)

**What it does:** wraps the permission gate as a one-way tightener. The
governor's `evaluate({tool, args, origin, workspaceId, gateDecision})` returns
a `PermissionDecision` that is either the input decision or a strictly
tighter one (`allowed: true → false`, or `requiresConfirmation: false →
true`). Fuzz-tested to never relax.

**Six autonomy levels, in strictness rank:**
- `OBSERVE` (0) — may look, never act
- `INFORM` (1) — may notify a user of a fact
- `RECOMMEND` (2) — may suggest an action
- `PREPARE` (3) — may plan / queue an action, must be confirmed
- `AUTO_SAFE` (4) — may execute within a rate budget
- `AUTO_ADVANCED` (5) — may execute broader actions, still budgeted
- `FULL` (6) — matches the gate's default; no extra tightening

**Policy shape (`AutonomyPolicy`):**
- `default` — fallback level for any tool
- `perTool` — per-name override (strictest wins vs default and category)
- `perCategory` — prefix-based override (e.g. `admin.` → PREPARE)
- `argumentGates` — predicate over args tightens per-call (e.g. `fs_write` to
  `/etc/*` requires PREPARE even though the tool's default is AUTO_SAFE)
- `budgets` — rolling rate windows (e.g. max 10 launches per minute)

**Non-goals:**
- Not an authentication layer. Origin trust is settled by the gate and
  `decideRemoteToolRequest`.
- Not an execution observer. Records the decision; result recording is
  audit/decision-journal responsibility.
- Not a confirmation queue. Only says "this needs confirmation"; the
  ToolRegistry's confirmation queue does the queuing.

**Decision journal:** every evaluate emits an `autonomy.decision` event with
`retention: "durable"` and structured `data` (gate level/allowed/confirm,
governor level/allowed/confirm, origin kind, tightened flag). A `refusal
does not consume the budget it just exceeded`.

**Explicit "no action required":** `observeNoop({action, reason,
correlationId})` records a durable `autonomy.no_action` event. The mission's
rule "do-nothing must be valid" is the assertion this method makes true.

**Load-bearing invariants:**
- Fuzz: no code path produces `allowed:false → true`.
- Fuzz: no code path un-sets a confirmation the gate demanded.
- Argument-gate predicate that THROWS fails closed (tightens), not open.
- security.* per-category default is PREPARE (never AUTO).

---

## D. Rollback / checkpoint (`src/vesper/checkpoint.ts`)

**What it does:** captures a JSON-serialisable pre-image before a Vesper-owned
write, records the post-image via `verify()`, and reverses via `rollback(id)`
which VERIFIES the current state matches the recorded post-image before
restoring. If the state has drifted (a later user action changed the value),
rollback refuses — no silent overwrite of a later change.

**Reversers registered this session:**
- `memory_remember` — captures previous entry (or absentBefore=true),
  restores via `memory.remember()` or `memory.forget()`.
- `workspace_switch` — captures previous workspace id, restores via
  `switchTo`.

**Not this session:** `fs_write` rollback integration. The abstraction fits
but the integration touches filesystem containment, which deserves its own
commit.

**Tools:**
- `rollback_list` (read tier) — enumerate recent checkpoints.
- `rollback_apply` (confirm tier) — reverse one by id. Confirm tier means the
  user ALWAYS approves a rollback; the governor cannot autonomously undo
  autonomous work.

**Retention:**
- Max 100 records in the blob (`rollback.checkpoints`), oldest dropped.
- Per-record TTL (default 7 days). An expired record refuses rollback and
  disappears from `list()`.

**Not built (deliberately):**
- Universal rollback for every Windows operation (mission is explicit).
- A separate BACKUP layer (longer-lived) — the mission distinguishes
  checkpoint (short-lived recovery) from backup (longer-lived recovery). This
  is checkpoint retention.

---

## E. Session capsule (`src/vesper/session-capsule.ts`)

**What it does:** defines a signed record shape for cross-device continuity.
`buildSessionCapsule` produces one; `verifyCapsule` checks the signature;
`ingestCapsule` merges into local state via caller-supplied callbacks. Nothing
here opens a socket — the transport is deliberately absent.

**Signature:** covers `canonicalJson({...capsule, signature: undefined})` via
`DeviceIdentity.sign` (ed25519 in identity.ts).

**Build-time filtering:**
- Preferences pass through `filterForSync` — the credential filter by NAME
  and by VALUE. A caller cannot exfiltrate an api_key by capsule.
- Task args are elided (`argsPresent: boolean` only) — sensitive detail does
  not leave the device.
- No chain-of-thought; only observable state.

**Ingest is deterministic and strictly narrowing:**
- Refuses unknown senders (not enrolled locally).
- Refuses revoked senders.
- Refuses self-ingest (capsule signed by the receiving device).
- Declines preferences from a restricted sender — informational only.
- Drops device-scoped facts whose originDeviceId is not the sender.
- NEVER modifies trust, capabilities, permissions, or revocation.

**Conflict resolution:** `saferTrustWins(a, b)` picks the more restrictive
trust level (revoked absorbing). Applied to every security-touching field
during merge.

**Invariant:** `.listen(` in the tree is still only `ollama-loopback.ts` (a
test fixture on 127.0.0.1:0) and `live-backend.test.ts`. No production
listener exists.

---

## F. Physical-PC bootstrap prep (`src/vesper/hardware/probes.ts`,
`docs/hardware-validation-checklist.md`)

**What it does:** defines a `HardwareProbe` interface that a Windows-specific
module will implement on the target PC (Ryzen 9 9950X / RX 7900 XT / 96 GB /
Windows). Registers honest placeholders for the six first-boot steps that
need real hardware (`gpu.live`, `vram.live`, `telemetry.amd`, `audio.wasapi`,
`windows.tray`, `benchmark.harness`) — every placeholder returns "not
implemented on this platform; validate on the target PC".

**Registry semantics:** multiple probes can share an id; the first whose
`platforms` includes the current one wins. A Windows probe and a Linux
fallback coexist — the fallback stays quiet where a real probe would answer.

**Docs:** `docs/hardware-validation-checklist.md` names EXACTLY what each
probe must verify on the physical machine. Every entry carries "must verify"
and "rejection cases" so a future implementation cannot mark a probe green
with a soft assertion. The mission's absolute rule — **do NOT fabricate
benchmark numbers before the machine exists** — is enforced in the
`benchmark.harness` rejection case.

**Nothing in this subsystem reads real hardware yet.** The prep is the
interface + the checklist + the honest fallbacks; the real probes land
when the target PC does.
