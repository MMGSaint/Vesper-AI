# Architectural seams — pre-merge sanity check

One short pass over the seams the distributed Vesper design names, done before merging
the round-2 security campaign. **This is a survey, not a plan and not a sprint.** Its
purpose is to record which seams exist as real modules, which are stubs, and which do not
exist at all — so that a later phase starts from a written state rather than from a
guess.

Nothing was built for this document. Two small, isolated, security-neutral gaps were
noted and left alone deliberately, because "small enough to add safely" and "worth adding
without being asked" are different questions.

Checked 2026-08-28 against `agent/distributed`.

> **Superseded in part.** Both gaps named below as "not built" were built afterwards:
> the checkpoint/rollback layer landed in phase 2 and now covers `fs_write` as well as
> memory and workspace, and the autonomy governor landed as a per-call, per-session
> one-way tightener with rolling rate budgets. This survey is kept as the record of what
> was true when it was written — it is a dated snapshot, not current state. For current
> state see `docs/phase-2-runtime.md` and `docs/phase-3-runtime.md`.

| Seam | Module | State |
|---|---|---|
| World state | `hardware/simulated.ts`, `specialists/context.ts` | **Simulated.** The snapshot is generated, not measured. `mode` is honest about this and diagnostics classifies it `mocked_simulated`. Real telemetry needs the physical machine. |
| Intent / task engine | `distributed/intent.ts`, `distributed/tasks.ts` | **Real.** Intent resolves a named device to a hard constraint; the queue stores tasks with capabilities, dependencies, eligibility and attempts. |
| Event bus | `events.ts` | **Real,** in-process, bounded ring. No cross-device delivery. |
| Model router | `models/router.ts` | **Real.** Role-based selection, fallback that asks the fallback provider for *its own* model, cancellation distinguished from failure. |
| Autonomy governor | `permissions.ts` (+ `scheduler.ts`) | **Partial — see below.** |
| Decision journal | `logging.ts`, `audit-file.ts` | **Real.** Redacted JSONL, rotated, records the permission decision and its reason alongside the execution — not just what ran. |
| Rollback / checkpoint | — | **Absent — see below.** |
| Device identity | `distributed/identity.ts` | **Real.** ed25519, its own 0600 file, `revoked` is absorbing and now survives loss of the registry. |
| Capability manifests | `distributed/capabilities.ts`, `discovery.ts` | **Real.** Capabilities are probed, never declared by the asking device; `NEVER_REMOTE` is refused at every trust class. |
| Continuity fabric | `distributed/sync.ts`, `distributed/now.ts` | **Partial.** The *filter* (what may leave a device) and the shared "now" projection exist and are tested. There is no transport to carry them. |
| Internet / LAN / USB transports | `net.ts` (egress classification only) | **Absent by decision.** No inbound listener exists; opening one on a personal machine is the owner's call. `net.ts` governs outbound endpoints (loopback/private/metadata/cloud) and is real. |
| Mobile companion | `client/protocol.ts`, `client/gateway.ts` | **Real contract, in-process only.** Scopes, session tokens, trust ceilings and device binding are enforced and tested. Nothing carries it off-process. |
| NEXUS adapter | `specialists/optimizer.ts` | **Real adapter, unpublished API.** Endpoint validated before any request, redirects refused, every parsed string neutralised, `mode` is Vesper's own answer and not the endpoint's. |
| Self-health | `doctor.ts`, `diagnostics.ts` | **Real.** Honest classification per subsystem; an unreadable config now surfaces at error level. |
| Graceful degradation | `recover.ts` + per-subsystem fallbacks | **Partial.** `withTimeout` / `isolateFailure` are real and widely used; each subsystem degrades on its own terms rather than through one policy. |

---

## The two gaps worth naming

### 1. There is no rollback or checkpoint layer for Vesper's own actions

`recover.ts` is timeout, isolate-failure and sleep — useful, but not this. The only
`rollback` in the codebase is `optimizer.requestRollback()`, which **delegates to NEXUS**
and rolls back *its* changes, not Vesper's.

So a completed `fs_write`, a memory overwrite, or a workspace switch has no undo. The
campaign narrowed the blast radius of each — a write cannot leave its approved root, an
overwrite of an existing memory now needs the confirm tier, a workspace switch is
trusted-only from a remote device — but narrowing is not reversal.

**Not built here, and deliberately.** A real checkpoint layer touches the filesystem
tool, the memory store, the workspace manager and the storage adapter at once, and has to
decide what "undo" means when an action had effects outside Vesper. That is neither small
nor isolated nor security-neutral, which is exactly the case the instruction for this
pass says to document instead.

### 2. The autonomy governor is per-call, not per-session

`permissions.ts` answers "may this tool run now, at this tier, from this origin". Nothing
answers "has this assistant done too much unattended in the last hour". The campaign
added bounds on *size and count* — the confirmation queue, tool calls per round, message
length, memory value size — but those are resource bounds, not an autonomy budget.

For a locally-run assistant driven by its owner this is a smaller gap than it sounds. It
becomes real the moment a schedule or a remote device drives turns nobody is watching.
Also documented rather than built.

---

## Not a finding, but worth recording

The seams that *are* real are real in the way that matters for security: capability is
probed rather than declared, trust is re-read at the chokepoint rather than snapshotted,
the scope ceiling has a single owner, and the permission gate can only be narrowed by
anything downstream of it. Those four properties are what let the campaign fix findings
in one place each instead of chasing them through call sites.

The seams that are absent are absent honestly — there is no stub pretending to be a
transport, and no code claiming a rollback it cannot perform.
