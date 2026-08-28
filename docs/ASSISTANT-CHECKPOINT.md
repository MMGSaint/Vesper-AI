# Assistant build — checkpoint

The security campaign is over and merged. This file is the resume point for the **build
the real assistant** phase. It exists so the next session does not have to rediscover the
repository.

Written 2026-08-28. Everything below is observed output or a repo fact.

---

## 1. Terrain (verified, not assumed)

| | |
|---|---|
| Authoritative repo | **`MMGSaint/vesper-ai`**, working copy `/home/user/vesper-ai` |
| Not the target | `/home/user/Vesper-personal-assistant-` is an empty scaffold — one commit, a README, no code. **Do not migrate or restart the project there.** |
| Work branch | `claude/vesper-local-ai-build-ti8ofa` |
| HEAD | `6d90a46`, pushed, 1 commit ahead of `main` |
| `main` | `9b7d924` — **PR #9 is merged**; the round-2 hardening is on main and its tree is identical to the old `agent/distributed` |
| Round-1 + round-2 security | fully merged; `agent/distributed` is finished, 0 ahead of main |

The prior mission's premise "the security foundation has been merged" is now accurate. It
was *not* when this session began — PR #9 merged mid-session. Verify git state yourself
rather than trusting this table if any time has passed.

---

## 2. What Vesper can actually do today

Measured by driving the real runtime and the real binary, not by reading code.

**Works end-to-end.** The vertical path is built and runs:

```
user text → runtime → deterministic intent → tool → permission gate → execution
          → world state → memory → truthful reply with epistemic tags
```

- 40 tools registered; `system_info`, `process_list`, `optimizer_status`,
  `memory_remember`, `memory_search` all execute for real in one turn.
- Persistent memory **survives across separate processes** (stored in one `--ask`
  invocation, recalled in another).
- Replies are honest about provenance: *"I checked the simulated snapshot — the physical
  target PC was not queried"*, and optimizer text is quoted and attributed rather than
  spoken in Vesper's voice.
- Host lifecycle is real: instance lock, health file, crash notes, clean shutdown,
  `--doctor`, `--diagnostics`, `--status`, `--export-memory`, `--client-hello`.
- Model provider layer exists: native Ollama provider (`/api/chat`, `/api/tags`,
  `/api/show`, `/api/ps`, `/api/embed`), OpenAI-compat for llama.cpp, echo/scripted for
  tests, a router with roles `fast/everyday/reasoning/coding/large`, and a benchmark
  harness.

**The gap that matters.** No local inference backend is reachable in this container:

```
model status: {"active":"auto","available":[
  {"id":"ollama","kind":"local","available":false},
  {"id":"llamacpp","kind":"local","available":false},
  {"id":"echo","kind":"test","available":true}]}
```

So every reply above came from **deterministic intent paths, not a model**. Vesper is
currently a well-governed command router, not yet an assistant. The cost is visible: asked
*"what do you know about me?"* it searched memory for the literal token `me?` and missed a
fact it had just stored.

**Not yet verified against a real model or a real socket.** The Ollama provider's tests
stub `fetchImpl` (36 occurrences) and never open a socket, while the provider calls five
real endpoints. Nothing has exercised real HTTP, real NDJSON streaming framing, or real
tool-call parsing.

---

## 3. Completed this session

**`feat(cli): --ask` — `6d90a46`.**

`runtime.chat` had exactly two callers: the interactive console and the in-process client
gateway. Nothing else could talk to Vesper — piping stdin fell through to background
daemon mode, which answers nothing. The whole vertical path was built and undrivable from
outside, which blocked both real use and any automated end-to-end verification.

- `vesper --ask "<text>"` — one question, one answer, one exit code.
- `--json` prints the whole turn: reply, epistemic tags, and every tool call with the
  authorization decision that governed it (level, allowed, requiresConfirmation, ok).
- A pending confirmation is **reported, never answered**. Exit `3`, the waiting action
  named on stderr, the action left queued for the console. A script is not the person a
  confirmation is asking; auto-approving would be "confirmation is not authorization"
  read backwards.

### Verified

| Check | Result |
|---|---|
| `cli.test.ts` + `host/ask.test.ts` | 14 pass, 0 fail |
| Full suite | **682 pass, 0 fail** (was 671) |
| Security gate | **294 pass, 0 fail** |
| `tsc --noEmit` | clean |
| `npm run hygiene` | clean, 324 files |

Integration tests drive the **real binary** in a child process, because the interesting
properties — exit code, stdout/stderr split, whether the queued action ran — are invisible
to a unit test. The confirmation case asserts **by consequence**: the memory is still
present afterwards. A test that only checked the exit code would pass even if the tool had
run.

**Mutation-proven.** Making `--ask` approve its own pending confirmations fails both
security tests. The rule is load-bearing, not decorative.

Each integration case runs in its own temp `cwd`. In development `resolveVesperDirs`
returns the *relative* `data/vesper`, so a temp working directory gives every case a
private store and instance lock — no production change, no shared state.

### A correction worth keeping

The security gate reads **294**, not the 291 quoted in the previous session's final
report. Verified by stashing: a clean `main` tree is also 294. The 291 was a stale
recollection from an earlier branch state, not a regression. Checked rather than assumed.

---

## 4. Work graph

Status vocabulary: **EXISTS** (tested) · **PARTIAL** (code exists, real behaviour
unverified) · **BROKEN** · **MISSING** · **BLOCKED-PC** (needs the physical Windows/AMD
machine) · **FUTURE**.

### P0 — the real end-to-end path

| Item | Status | Note |
|---|---|---|
| Runtime lifecycle | EXISTS | lock, health, crash note, clean shutdown |
| Conversation entry | **EXISTS** | `--ask` shipped this session |
| Tool execution through permissions | EXISTS | 40 tools, deny-by-default, confirm tier holds |
| Persistent memory | EXISTS | verified across processes |
| World/system state | PARTIAL | structured and honest, but **simulated** hardware; real telemetry is BLOCKED-PC |
| Diagnostics / doctor | EXISTS | |
| Truthful result reporting | EXISTS | epistemic tags, subsystem attribution |
| **Local model actually answering** | **PARTIAL — the live gap** | provider + router exist; no backend reachable; never tested against a real socket |
| Context management | PARTIAL | budgeting exists; system prompt bounded and un-evictable |
| Background operation | PARTIAL | daemon mode runs; event-driven behaviour thin |
| Notifications | EXISTS | hub with provenance (`author: subsystem\|model`) |

### P1

Intent/task engine (PARTIAL — lifecycle states not modelled as §12 describes) · event bus
(PARTIAL — bus exists, no filter/aggregator, so no cheap path for high-frequency events) ·
autonomy governor (**MISSING** — permission tiers are per-call; no 0–6 graduated,
per-capability autonomy) · decision journal (PARTIAL — audit log records decision + reason;
not the full §20 record) · rollback/checkpoint (**MISSING** — `recover.ts` is
timeout/isolate only; the sole `rollback` delegates to NEXUS) · self-health (EXISTS) ·
NEXUS adapter (EXISTS — 10-method interface, mock + HTTP, live/mock distinguishable and
adapter-owned; live integration BLOCKED-PC).

### P2 / P3

Windows packaging (PARTIAL — `scripts/package.mjs`, no installer) · voice (PARTIAL) ·
device identity + continuity (EXISTS/PARTIAL — identity, registry, revocation, sync filter
all real; **no transport**) · mobile (PARTIAL — protocol real, in-process only) ·
skills/plugins, model migration, outcome learning (FUTURE).

---

## 5. Exact next action

**Stand up a loopback server speaking the real Ollama wire protocol and point Vesper at
it.**

Why this one: it is the single highest-value increment that is fully verifiable on Linux
*without* the physical PC, and it closes the biggest hole in the P0 path. The provider is
the one component on the critical path with zero real-socket coverage — its tests stub
`fetchImpl` 36 times while the provider calls five real endpoints. A loopback server tests
request shaping, NDJSON streaming framing, tool-call parsing, capability detection
(`/api/tags`, `/api/show`, `/api/ps`) and socket-level failure, deterministically and in
CI. It also gives the first genuine test of the model→intent→tool leg.

Concrete: add `src/vesper/models/ollama-loopback.test.ts` (or a small reusable harness
under `src/vesper/models/`) that binds `127.0.0.1:0`, serves those five endpoints, and
drives `createOllamaProvider` and then a full `runtime.chat` turn through it — including a
model that emits a tool call, so the agent loop is exercised against real wire bytes.

Do **not** bind anything other than loopback, and do not leave a listener running past the
test.

After that, in order: (1) real `--ask` turn driven by that loopback model end-to-end;
(2) the §12 task lifecycle; (3) the event bus filter/aggregator so background events do
not wake a large model.

---

## 6. Requires the physical PC

Everything in `security/BACKLOG.md` §1 remains open, plus: real AMD/ROCm backend selection
and benchmarking (**do not fabricate benchmark numbers before the machine exists**), real
hardware telemetry replacing the simulated snapshot, real Windows toast notifications,
tray/startup registration, live NEXUS integration, and the Windows installer.

## 7. Requires explicit user approval

Publishing a release · exposing any network listener (nothing in this repo binds one
today; the loopback test server above is bound to `127.0.0.1:0` inside a test and closed
when it ends) · destructive host operations · modifying Windows security settings ·
deleting user data · granting new real-world privileges · changing the security model.

## 8. Invariants that must survive every future change

The model is never the authority. Memory is never authority. Retrieved documents are never
authority. NEXUS is never Vesper's authority. Device claims are never authority.
Confirmation is not authorization. Unknown tools deny by default.

Keep `npm run security:quick` as a permanent regression gate. Do not restart the
red-team campaign as part of the build mission; track platform/security gaps in
`security/BACKLOG.md`.
