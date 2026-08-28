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
| HEAD | `70b4509`, pushed, **8 commits ahead of `origin/main`** |
| `origin/main` | `9b7d924` — PR #9 merged; the round-2 hardening is on main |

Verify git state rather than trusting this table if any time has passed.

---

## 2. What Vesper can actually do today

Measured by driving the real binary and the real runtime — not by reading code.

**Works end-to-end.** The vertical path is built and runs:

```
user text → runtime → deterministic intent → tool → permission gate → execution
          → world state → memory → truthful reply with epistemic tags
```

- **41 tools registered** (added `memory_summarize` this session).
- The deterministic intent layer answers seven kinds of first-touch questions without
  needing a model:
  - **status** — "what is happening" / "how's the system" — reads live state and reports
    honestly that hardware is simulated.
  - **workspace** — "switch to gaming" — **survives across processes** (this session).
  - **remember / forget / recall** — memory operations, category-aware, punctuation-stripped.
  - **recall meta** — "what do you know about me?" now returns a **summary** rather than
    searching for the literal token `me?` (this session).
  - **catch me up** — composes a categorised digest from `events.recent()`, drops
    `lifecycle.idle_tick` noise (this session).
  - **capabilities** — "what can you do?" / "help" / "list your tools" — reports live tool
    tier counts, reachable backends, workspaces, memory (this session).
  - **optimize / ready / diagnostics / gpu / thermal / obs** — each grounded in real
    state, quoting the optimizer rather than speaking in its voice.
- Persistent memory **survives across separate processes** and honours workspace scope.
- **Doctor now reports model backend reachability** with actionable "Start a backend"
  advice, and maps roles → providers (this session).
- Replies carry epistemic tags: *"I checked the simulated snapshot — the physical target
  PC was not queried"*.
- Host lifecycle is real: instance lock, health file, crash notes, clean shutdown,
  `--doctor`, `--diagnostics`, `--status`, `--export-memory`, `--client-hello`, and
  `--ask` (previous session).

**The Ollama provider is now proven at the wire.** A loopback fixture binds `127.0.0.1:0`,
serves `/api/tags`, `/api/show`, `/api/ps`, `/api/embed`, and streaming `/api/chat`, and
drives a full agent turn — model→tool→permission→execute→result — through real socket
bytes. 13 tests. A mutation that bound `0.0.0.0` slipped past a URL-string assertion once
(recorded), fixed by exposing `boundAddress` and asserting on what the server actually
bound to.

**The gap that still matters.** No local inference backend is reachable in this container:

```
model status: {"active":"auto","available":[
  {"id":"ollama","kind":"local","available":false},
  {"id":"llamacpp","kind":"local","available":false},
  {"id":"echo","kind":"test","available":true}]}
```

So every free-form reply above came from **deterministic intent paths, not a model**.
The truthful fallback message says so plainly ("No local inference backend is
available…"), and the capabilities intent now filters `echo` out — advertising a test
provider as reachable would undermine the mission's honesty rule.

---

## 3. Completed this session

Seven commits, in order:

| Commit | What it does |
|---|---|
| `7465e22` | docs: written checkpoint of prior state |
| `76f6cb0` | test(models): loopback server + full agent E2E through real socket |
| `22dcee7` | feat(memory): meta-question retrieval → summary + `memory_summarize` tool |
| `1f8c466` | feat(workspaces): current workspace survives a restart |
| `dc13d2f` | feat(doctor): report which local model backends are reachable |
| `081af76` | feat(agent): "catch me up" answers from the event bus |
| `70b4509` | feat(agent): "what can you do" answers from the live tool registry |

### Verified

| Check | Result |
|---|---|
| `npm test` | **720 pass, 0 fail** (was 671 at session start) |
| `npm run security:quick` | **294 pass, 0 fail** |
| `npm run hygiene` | clean, 327 files |
| `npx tsc --noEmit` | clean |
| Cross-process shell probes | workspace persistence, memory persistence, catchup, capabilities all real |

Every load-bearing defence added this session is **mutation-proven**: the workspace
filter (removing it leaks scoped tools to General), the echo-provider filter (removing
it advertises the test backend), the security-notices branch of catchup (removing it
loses the notice). Two mutations slipped through and were recorded honestly:

- The `idle_tick` filter in catchup is defence-in-depth — the downstream digest already
  only counts start/stop/pause, so removing the filter is a no-op today. Kept and
  labelled for a future author who might count `lifecycle.length` directly.
- The workspace validity guard in `workspaces.load()` is subsumed by `current()`'s own
  fallback for unknown ids. Same treatment.

### A correction from the previous session

The `--ask` "reports honestly that no model is loaded" test used **catch me up** as its
probe. With the new deterministic intent that phrase never reaches the model-unavailable
fallback, so the test would pass even if the truthful branch were deleted. Switched to
a free-form probe no intent captures: "please write a haiku about a cat".

---

## 4. Work graph

Status: **EXISTS** (tested) · **PARTIAL** (code exists, real behaviour unverified) ·
**MISSING** · **BLOCKED-PC** (needs the physical Windows/AMD machine) · **FUTURE**.

### P0 — the real end-to-end path

| Item | Status |
|---|---|
| Runtime lifecycle | EXISTS |
| `--ask` and console | EXISTS |
| Tool execution through permissions | EXISTS (41 tools, deny-by-default, confirm tier holds) |
| Persistent memory (cross-process, cross-workspace) | EXISTS |
| Workspace persistence (cross-process) | **EXISTS** (this session) |
| Deterministic first-touch intents (status/recall-meta/catchup/capabilities/…) | **EXISTS** (this session) |
| World/system state | PARTIAL — structured and honest, but **simulated** hardware; real telemetry is BLOCKED-PC |
| Diagnostics / doctor + model status | **EXISTS** (this session) |
| Truthful result reporting | EXISTS — epistemic tags, subsystem attribution |
| Ollama wire protocol proven at real socket | **EXISTS** (this session) |
| Local model actually answering | **PARTIAL** — provider works at the wire, no backend running here |
| Context management | PARTIAL — bounded system prompt |
| Background operation | PARTIAL — daemon runs; event-driven behaviour thin |
| Notifications | EXISTS — hub with provenance |

### P1

Intent/task engine (PARTIAL — lifecycle states not modelled) · event bus (PARTIAL — no
filter/aggregator; nothing currently subscribes, so the filter would be speculative) ·
autonomy governor (**MISSING** — permissions are per-call; no 0–6 graduated,
per-capability autonomy) · decision journal (PARTIAL — audit log carries decision +
reason) · rollback/checkpoint (**MISSING** — `recover.ts` is timeout/isolate only) ·
self-health (EXISTS) · NEXUS adapter (EXISTS — 10-method interface, mock + HTTP, live
BLOCKED-PC).

### P2 / P3

Windows packaging (PARTIAL) · voice (PARTIAL) · device identity + continuity (EXISTS —
no transport) · mobile (PARTIAL — protocol real, in-process only) · skills/plugins,
model migration, outcome learning (FUTURE).

---

## 5. Exact next actions

**In order of value that is verifiable without the physical PC:**

1. **Task lifecycle** — the §12 states aren't modelled. The task queue stores tasks, but
   `pending → running → succeeded/failed/cancelled` transitions aren't captured with
   attempts, timestamps, or a `retryAfter` policy. This blocks any real background work.
2. **Model-emitted tool-call edge cases** — the loopback E2E proves the happy path.
   What about a model that emits a tool call for a tool that does not exist, or with
   malformed args, or a nested call, or one exceeding `MAX_TOOL_CALLS_PER_ROUND` mid-turn?
   Add fixtures that exercise each, and mutation-prove that the failure story is honest.
3. **Startup safety on unknown workspace id** — `workspaces.load()` handles corruption
   and unknown ids, but silently. A `security.workspace_missing` event would make the
   loss visible in `diagnostics.recentErrors` and in catchup.
4. **First-boot report visibility** — `runFirstBootAutomation` writes a report file, but
   there's no CLI flag to read it back. Add `--first-boot-report` (or fold into
   `--diagnostics --verbose`) so the operator can inspect hardware detection results
   without knowing the file path.
5. **Then**: event bus filter/aggregator becomes useful once background operation grows a
   subscriber — build it when that subscriber lands, not before.

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
a test facility, not a model.

Keep `npm run security:quick` as a permanent regression gate. Do not restart the
red-team campaign as part of the build mission; track platform/security gaps in
`security/BACKLOG.md`.
