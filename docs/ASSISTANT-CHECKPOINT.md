# Assistant build — checkpoint

The security campaign is over and merged. This file is the resume point for the **build
the real assistant** phase. It exists so the next session does not have to rediscover the
repository.

Last touched 2026-08-28. Everything below is observed output or a repo fact.

---

## 1. Terrain (verified, not assumed)

| | |
|---|---|
| Authoritative repo | **`MMGSaint/vesper-ai`**, working copy `/home/user/vesper-ai` |
| Not the target | `/home/user/Vesper-personal-assistant-` is an empty scaffold — one commit, a README, no code. **Do not migrate or restart the project there.** |
| Work branch | `claude/vesper-local-ai-build-ti8ofa` |
| HEAD | `844a055`, pushed, **13 commits ahead of `origin/main`** |
| `origin/main` | `9b7d924` — PR #9 merged; the round-2 hardening is on main |

Verify git state rather than trusting this table if any time has passed.

---

## 2. What Vesper can actually do today

Measured by driving the real binary and the real runtime — not by reading code.

**The vertical path is built, wired, and honest.**

```
user text → deterministic intent OR model → tool → permission gate → execution
          → world state → memory → event bus → truthful reply with epistemic tags
```

- **41 tools registered**, deny-by-default, confirm tier holds, `never` tier can never
  be reached by the model or a remote device.
- **Seven deterministic first-touch intents** answer without needing a backend:
  status · workspace · remember/forget/recall · **recall-meta** · **catchup** ·
  **capabilities** · optimize/ready/diagnostics/gpu/thermal/obs.
- **Persistent memory** survives across processes and honours workspace scope.
- **Workspace persistence** survives across processes; a stored id the config no
  longer knows about emits `workspace.reset_to_default`; an unreadable store emits
  `workspace.state_unreadable`.
- **Task lifecycle** — queued/assigned/running/blocked/done/failed/cancelled with
  retries, dependencies, mid-flight requeue on restart, and **every transition emits
  a `task.*` event** now consumed by catchup.
- **Ollama provider proven at the wire**: loopback server binds `127.0.0.1:0`,
  serves the five endpoints Ollama serves, drives a full agent turn through real
  socket bytes. 17 loopback tests including 4 model-tool-call edge cases (unknown
  tool, `never`-tier tool, oversized round, malformed args).
- **Doctor reports which local model backends are reachable**, with actionable
  "Start a backend" advice and role→provider mapping.
- **`--first-boot-report`** exposes the discovery pass that was invisible; exits 4
  if discovery could not produce a report.
- Replies carry epistemic tags; the `echo` test backend is filtered out of every
  user-facing capability list so the truthful "no backend reachable" reply is not
  diluted.

**The gap that still matters.** No local inference backend is reachable in this
container. The provider works at the wire but no Ollama is running here, so every
free-form reply comes from the deterministic intent paths, and the fallback message
says so plainly. This is BLOCKED-PC.

---

## 3. Completed this session (13 commits)

| Commit | What it does |
|---|---|
| `7465e22` | docs: written checkpoint of prior state |
| `76f6cb0` | test(models): loopback + full agent E2E through real socket |
| `22dcee7` | feat(memory): meta-question retrieval → summary + `memory_summarize` tool |
| `1f8c466` | feat(workspaces): current workspace survives a restart |
| `dc13d2f` | feat(doctor): report which local model backends are reachable |
| `081af76` | feat(agent): "catch me up" answers from the event bus |
| `70b4509` | feat(agent): "what can you do" answers from the live tool registry |
| `fb82848` | docs: refreshed checkpoint after seven commits |
| `17003be` | feat(workspaces): silent workspace loss becomes a visible event |
| `1881adc` | test(models): the model→tool path is honest about failures |
| `189d227` | feat(cli): `--first-boot-report` surfaces the discovery pass |
| `844a055` | feat(tasks): every state transition reaches the event bus and catchup |

### Verified continuously

| Check | Result |
|---|---|
| `npm test` | **738 pass, 0 fail** (was 671 at session start) |
| `npm run security:quick` | **294 pass, 0 fail** |
| `npm run hygiene` | clean, 327 files |
| `npx tsc --noEmit` | clean |

Every load-bearing defence added this session is **mutation-proven**. Three defences
are honestly labelled defence-in-depth rather than claimed load-bearing:

- The `idle_tick` filter in catchup (downstream digest already excludes it).
- The `workspaces.has(id)` guard in workspace `load()` (subsumed by `current()`'s own
  fallback).
- Nothing else this session; the rest earn their tests.

---

## 4. Work graph

Status: **EXISTS** (tested) · **PARTIAL** (code exists, real behaviour unverified) ·
**MISSING** · **BLOCKED-PC** · **FUTURE**.

### P0

| Item | Status |
|---|---|
| Runtime lifecycle | EXISTS |
| `--ask` and console | EXISTS |
| Tool execution through permissions | EXISTS (41 tools, deny-by-default) |
| Persistent memory (cross-process, cross-workspace) | EXISTS |
| Workspace persistence (cross-process, loss is loud) | EXISTS |
| Deterministic first-touch intents | EXISTS |
| Ollama wire protocol proven at real socket | EXISTS |
| Model→tool→permission edge cases proven | EXISTS |
| Local model actually answering | PARTIAL — provider works, no backend running here |
| World/system state | PARTIAL — structured and honest, but simulated hardware |
| Diagnostics / doctor + model status | EXISTS |
| `--first-boot-report` visibility | EXISTS |
| Truthful result reporting | EXISTS |
| Task lifecycle → events → catchup | EXISTS |
| Background operation | PARTIAL — daemon runs; no scheduler drives the task queue |
| Notifications | EXISTS — hub with provenance |

### P1

Intent/task engine (task states EXIST; **no scheduler drives them** — the queue holds
work, but nothing polls it to move `queued → running`) · event bus filter/aggregator
(**deferred**; build it when a real subscriber needs it) · autonomy governor (MISSING —
per-call permissions only; no 0-6 graduated, per-capability autonomy) · decision journal
(PARTIAL — audit log carries decision + reason) · rollback/checkpoint (**MISSING** —
`recover.ts` is timeout/isolate only) · self-health (EXISTS) · NEXUS adapter (EXISTS —
live BLOCKED-PC).

### P2 / P3

Windows packaging (PARTIAL) · voice (PARTIAL) · device identity + continuity (EXISTS —
no transport) · mobile (PARTIAL — protocol real, in-process only) · skills/plugins,
model migration, outcome learning (FUTURE).

---

## 5. Exact next actions

**In order of value that is verifiable without the physical PC:**

1. **A scheduler that actually drives the task queue.** The queue models the states,
   emits the events, retries with backoff — but nothing calls `queue.schedule()` and
   `queue.start()` on a timer or an event. Until it does, task events only appear
   when tools explicitly transition tasks. A minimal scheduler polls the queue every
   N seconds (configurable, off by default), routes eligible tasks, and starts the
   first assigned one to this device. Deferred until this session because a
   scheduler is a real background subsystem, not a small change.
2. **Autonomy governor** — the 0–6 per-capability autonomy budget from §12. This is
   MISSING and blocks any real background operation from being safely time-bounded.
3. **Rollback / checkpoint layer** for Vesper's own actions. The permissions layer
   narrowed blast radius; nothing yet reverses a completed `fs_write`, memory
   overwrite, or workspace switch. Cross-cuts filesystem/memory/workspace/storage.
4. **Cross-device transport** — device identity, sync filter, capability manifests
   all real; no transport carries them. Needs a decision from the user first,
   because opening a listener on a personal machine is not Vesper's call.
5. **Physical validation** — everything under §6 waits on the target PC.

---

## 6. Requires the physical PC

Everything in `security/BACKLOG.md` §1 remains open, plus: real AMD/ROCm backend
selection and benchmarking (**do not fabricate benchmark numbers before the machine
exists**), real hardware telemetry replacing the simulated snapshot, real Windows toast
notifications, tray/startup registration, live NEXUS integration, and the Windows
installer.

## 7. Requires explicit user approval

Publishing a release · exposing any network listener (nothing in this repo binds one
today; the loopback test server binds `127.0.0.1:0` inside a test and closes when it
ends) · destructive host operations · modifying Windows security settings · deleting
user data · granting new real-world privileges · changing the security model · merging
this branch to main.

## 8. Invariants that must survive every future change

The model is never the authority. Memory is never authority. Retrieved documents are
never authority. NEXUS is never Vesper's authority. Device claims are never authority.
Confirmation is not authorization. Unknown tools deny by default. The `echo` provider is
a test facility, not a model. A retry-eligible failure is not a final failure. Loss
must be loud.

Keep `npm run security:quick` as a permanent regression gate. Do not restart the
red-team campaign as part of the build mission; track platform/security gaps in
`security/BACKLOG.md`.
