# Vesper Phase 3 — closing the loops

Phase 2 built the durable runtime: a journal, a scheduler, a governor, a checkpoint
store, a capsule format, a probe registry. Several of those were, in the project's own
classification, *implemented and tested but not wired* — real modules with no call site
asking for the guarantee they offered.

Phase 3 is the wiring, and the wiring is where the interesting problems were.

---

## Data flow, with the Phase 3 additions marked

```
      ┌──────────────┐          ┌──────────────────────┐
      │ user text    │          │ idle tick            │
      └──────┬───────┘          └──────────┬───────────┘
             │                             │
             ▼                             ▼
   ┌───────────────────┐        ┌────────────────────────┐
   │ intent OR model   │        │ TaskScheduler.tick()   │
   └─────────┬─────────┘        └──────────┬─────────────┘
             │                             │  ← NEW: a real executor
             │                             ▼
             │                  ┌────────────────────────┐
             │                  │ tool_call executor     │
             │                  │ origin = "scheduled"   │
             │                  └──────────┬─────────────┘
             │                             │
             └──────────────┬──────────────┘
                            ▼
              ┌──────────────────────────────┐
              │      ToolRegistry.invoke     │   ← the ONLY authorized entry
              │  ├─ validateToolArgs         │
              │  ├─ liveOrigin               │
              │  ├─ gate.evaluate            │
              │  ├─ governor.evaluate        │      (scheduledCeiling ← NEW)
              │  ├─ decideRemoteToolRequest  │      (deny-by-default ← NEW)
              │  ├─ scheduled+confirm refuse │      ← NEW
              │  └─ handler                  │
              └──────────────┬───────────────┘
                             │
        ┌────────────────────┼─────────────────────┐
        ▼                    ▼                     ▼
 ┌──────────────┐   ┌─────────────────┐   ┌──────────────────┐
 │ Checkpoint   │   │ world state     │   │ events + journal │
 │ (fs_write ←  │   │ memory/ws/files │   │                  │
 │  NEW)        │   └─────────────────┘   └────────┬─────────┘
 └──────────────┘                                   │
                                                    ▼
                                    ┌───────────────────────────┐
                                    │ catch-up  ← NEW sources:  │
                                    │  task queue, decisions,   │
                                    │  corrections, horizon     │
                                    └───────────────────────────┘

 ┌─────────────────────┐     ┌──────────────────────┐
 │ optimizer_request   │────▶│ CorrectionProducer   │  ← NEW
 │ (expectation)       │     │ expect() / observe() │
 └─────────────────────┘     └──────────┬───────────┘
                                        ▼
                              ┌──────────────────┐
                              │ CorrectionStore  │  evidence, never authority
                              └──────────────────┘
```

---

## A. fs_write rollback

**Pattern:** plan → authorize → capture pre-image → apply → verify → keep or roll back.

The pre-image is captured **after** containment resolves and **before** the file is
opened for writing. There is no other window: the open empties the file, so a read
afterwards reports zero bytes whether the file was empty, full, or absent.

**Absent and empty stay distinct.** Rolling back a write to a file that did not exist
means deleting it; rolling back a write to an empty file means restoring it empty.
Collapsing them leaves a stray file or removes one the user had.

**Containment is unchanged.** The pre-image is read through `openContained`, not
`readFile` — the guarantee for the final path component *is* the `O_NOFOLLOW` inside
that open, because `realpath` reports a dangling symlink as "does not exist yet", which
is how an arbitrary write once reached `/etc`. Restoring goes back through
`writeApproved`. Deleting uses a contained primitive that is deliberately **not**
registered as a tool.

**Refusals:** a rollback is declined when the file changed since, when it is gone, when
no post-image was recorded, and when the target no longer resolves inside the approved
roots. The absent-before case is the dangerous one — undo means delete — so a file the
user has since rewritten is never removed.

**Two honest limits:**

- A pre-image over **64 KiB** is not captured. Checkpoints live in one JSON blob that is
  rewritten on every snapshot. The write still happens and the result says plainly that
  no undo was recorded. A silently truncated pre-image would make `rollback_apply`
  report success while writing back a fragment.
- The containment re-run inside `restore()` is **defence in depth, not load-bearing**.
  `verify()` runs first and already refuses an out-of-root target as drift; mutation
  confirms that replacing restore's checks with a raw `writeFile` fails no test.

**Fixed on the way past:** the open carried `O_TRUNC`, so a file with more than one hard
link was already emptied when the hard-link check ran — an `ok: false` that had destroyed
the user's data.

---

## B. Scheduler → tool executor

The scheduler had one executor, `noop`. "A scheduled task cannot bypass authorization"
was true the way a statement about an empty set is true.

**The origin is its own kind.** `scheduled` is not a flavour of `local`, because "the
person at this machine asked" and "a timer fired" are different claims and only one of
them can answer a confirmation prompt.

Adding it required changing this:

```ts
if (input.origin.kind !== "remote") return { allowed: true };   // before
```

which reads as "local is fine" and means "anything not remote has the authority of the
person at the keyboard". Each kind now states what it may do; an unrecognised one is
refused.

**Three side doors, each closed and tested:**

| Door | What stops it |
|---|---|
| `registry.get(name).handler` runs with no checks at all | the executor holds a registry and calls `invoke` |
| `confirmed: true` is trusted verbatim | the executor never sets it, **and** the registry refuses confirm-tier for a scheduled origin |
| an absent origin *is* full local authority | the origin is a frozen module constant, never read from the task |

**A confirm-tier tool is refused, not deferred.** Queueing the prompt would look kinder
and be worse: a task due every tick fills the 32-slot confirmation queue, and that queue
refuses rather than evicts, so genuine requests would start being turned away.

**A refusal is terminal.** `TaskQueue.fail` takes `retryable: false`. Retrying a
permission refusal produces three identical refusals and three journal events, which
reads like a system trying repeatedly to get past a policy.

**`scheduledCeiling`** caps unattended work through the same one-way tightener as every
other rule. Stated honestly: the shipped default of `AUTO_SAFE` binds nothing today,
because the tools above it are read-only. It is a guard against a future policy that
raises a tool for interactive use and would otherwise raise it for unattended use too.

---

## C. Correction records

A small set of facts — context, assumption, evidence, correction, outcome, source,
timestamps. **No chain-of-thought**, and a 400-character cap per field so a transcript
cannot arrive under another name.

**Three outcomes, not two.** `assumption_held` is recordable because a store that only
admits failures gives a skewed picture of how often Vesper is right. `inconclusive`
covers an unavailable adapter, an undetermined bottleneck, an adapter that threw, and a
request the optimizer never accepted — recording "the change did not help" when the
change never happened would invent both the action and its outcome.

**Evidence, never authority.** A correction cannot grant a permission, relax one, change
trust, un-revoke a device, or move the autonomy ceiling. Asserted through consequences —
what the gate, the registry and the governor decide *after* a hostile correction is
filed. There is deliberately no `corrections_record` tool: a correction is produced by a
subsystem observing an outcome, not asserted by whatever holds the keyboard.

**Text is data.** Every free-text field is flattened and screened for credentials — every
field, not only the external one, because applying it selectively is how one gets missed.

---

## D. Catch-up

Four sources added to what was a single read of the 500-entry ring:

- **Outstanding work from the queue**, not counted from events. A task queued three boots
  ago and still blocked is what someone returning to their machine is asking about, and
  it appears nowhere in the ring.
- **Autonomy decisions**, split between acted-on and deliberately-left-alone. Surfacing
  `autonomy.no_action` is the point of recording it: a digest that only shows action
  makes restraint invisible.
- **Corrections**, leading with an expectation that turned out wrong rather than a tally.
- **The horizon.** "Nothing happened" and "nothing I still have a record of" are
  different claims.

---

## E. First boot and the probe registry

The registry existed, was tested, and was imported by nothing. Wiring it surfaced two
traps that would have fired on the target PC:

1. **Probe ids and step ids are different vocabularies** (`gpu.live` vs `gpu`) while the
   module's comment claimed they matched. A direct lookup returns `undefined` for all six
   and silently keeps the hard-coded text — the wiring failing would have looked exactly
   like the wiring working.
2. **Priority pointed the wrong way.** Placeholders declare `win32` among their platforms
   and the registry took the first match by insertion order, so a real Windows probe
   registered afterwards would never have run. Probes now carry `fallback`, and a real
   probe outranks a stand-in however the two were registered.

A probe's **negative** answer is kept rather than flattened to the default: a machine
with a broken driver must not look identical to one that was never asked.

**Report defects fixed:** the optimizer step classified on `mode` alone while its detail
also required an endpoint (one line disagreeing with itself); `preferredBackend` was
re-derived knowing only two backends, so a Vulkan-only host got two different answers;
`voiceEnabled` was hard-coded false; and `hardware.mode: "live"` changed nothing and said
nothing, which it now admits.

---

## F. The NEXUS boundary

Vesper coordinates. NEXUS is the hardware specialist and stays one.

**One classifier, shared.** `discovery.ts` called a mock optimizer `NOT_CONFIGURED` and
the client gateway called the same adapter in the same state `DEGRADED` — a phone and a
peer told different things about the same machine, uncaught because nothing compared
them. `NOT_CONFIGURED` is correct: `DEGRADED` implies something real is there and
impaired, and a mock is not a degraded NEXUS but the absence of one.

| State | Means |
|---|---|
| `AVAILABLE` | a real optimizer answered and reported itself available |
| `UNAVAILABLE` | a real one is configured and did not answer, or said no |
| `NOT_CONFIGURED` | nothing real is wired up |
| `DEGRADED` | reserved for a real optimizer in a reduced state |

`mode` remains Vesper's own provenance label and is never taken from the response body —
an endpoint that answered `mode: "mock"` once made Vesper describe a live,
machine-changing subsystem as a simulation.

**A scheduled task cannot ask NEXUS to change the machine.** `optimizer_request` is
confirm-tier, and confirm-tier is refused for a scheduled origin.

---

## What is still not built

- **Cross-device transport.** Capsules have a shape, a signature and a verify path.
  Nothing carries them. `.listen(` in the tree is `models/ollama-loopback.ts` (a test
  server on `127.0.0.1:0`, imported only by its own test) and `live-backend.test.ts`.
- **Live hardware.** `hardware.mode: "live"` is accepted and honoured by nothing; the
  report and the doctor now say so.
- **Real Windows probes.** The interface, the checklist and the priority rule are ready.
  The probes are not written, because the machine has been off.
- **The comprehensive pre-1.0 adversarial campaign.** Deliberately reserved.
