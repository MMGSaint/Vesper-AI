# First boot on the physical PC

The next milestone is not another architecture change. It is the first time Vesper runs
on the machine it was built for.

This document is the ordered workflow for that day. Every step says what evidence looks
like and what must **not** be claimed without it, because the standing rule for this
project is that Vesper never reports a measurement it did not take.

Target hardware, **never physically validated** as of this writing:

| | |
|---|---|
| CPU | AMD Ryzen 9 9950X |
| GPU | AMD Radeon RX 7900 XT (20 GB) |
| RAM | 96 GB |
| OS | Windows |

---

## The rule that governs the whole day

**Establish evidence before granting authority.** Vesper starts in its most restricted
posture and is opened up one step at a time, each step justified by something that was
observed on the machine. Nothing on this page authorises itself by having been written
down here.

Concretely: do not set `agent.driveTasksOnIdle: true` on step 1, and do not raise the
autonomy policy until steps 1–9 have produced real answers.

---

## 1. Bootstrap Vesper

```powershell
# from the repo root
npm install
node --experimental-strip-types src/vesper/host/main.ts --doctor
```

**Evidence:** the doctor prints `Result: OK` and every fixed check passes.

**Watch for:** `config-dir` / `data-dir` failures mean the installer and the runtime
disagree about paths — a defect that has shipped before and has a regression test, so a
failure here is a real one.

**Do not** proceed to autonomy steps if the doctor reports an error-level check.

---

## 2. Detect hardware

```powershell
node --experimental-strip-types src/vesper/host/main.ts --first-boot-report
```

**Evidence:** the `os`, `cpu`, `ram` steps report real values from this machine.

**Expect to be honest, not green:** `gpu`, `vram`, `telemetry`, `audio`, `windows` and
`benchmark` come from the probe registry, and until Windows probes are implemented they
report *not implemented on this platform*. That is the correct output, not a failure.

`hardware-mode` will say that `hardware.mode: "live"` has not taken effect. It cannot,
until a live hardware source exists — see step 12.

**Do not** hand-edit the report or the config to make these look answered.

---

## 3. Implement and register the Windows probes

The six probes in `docs/hardware-validation-checklist.md` are the work item here. Each
entry in that document names exactly what a real implementation must verify and which
results must be rejected.

Register them with `platforms: ["win32"]` and **without** `fallback: true`. A real probe
outranks the placeholder regardless of registration order — that is what the `fallback`
flag is for, and the ordering trap it replaced would have made a correctly implemented
Windows probe silently never run.

**Evidence:** re-run `--first-boot-report`; the six steps now carry real values and a
classification of `implemented_hardware_dependent`.

---

## 4. Detect the inference backend

Install one local backend and confirm Vesper finds it:

```powershell
ollama serve
node --experimental-strip-types src/vesper/host/main.ts --doctor
```

**Evidence:** `provider-ollama` reports the provider answered, and `local-model` stops
saying no backend is reachable.

**Note on the AMD path:** llama.cpp with **Vulkan** is the preferred RDNA3 route and
ROCm/HIP is the secondary one. Both are discoverable. Which is faster on this machine is
a question for step 5, not an assumption to carry in.

---

## 5. Benchmark local models

```powershell
# through the tool surface, so the result goes through the same honesty rules
--ask "run the model benchmark"
```

**Evidence:** a `BenchmarkReport` with `ran: true` and samples whose `tokenSource` is
`provider-counters`.

**The hard rule:** throughput comes only from provider-reported token counters, and
time-to-first-token only from a genuinely streamed reply. Both are `null` otherwise, and
`null` is the correct answer — a wall-clock estimate presented as a measurement is the
specific dishonesty this harness exists to refuse.

**Do not** record a number for the 9950X or the 7900 XT anywhere until it came out of
this step on this machine.

---

## 6. Establish a baseline

Record, from the machine and not from expectation:

- idle CPU / GPU / VRAM
- which models fit in 20 GB alongside a game or a VR session
- what the machine does under the loads it actually sees — this PC games, streams and
  runs VR, and Vesper's idle behaviour has to stay cheap in all three

**Evidence:** a written baseline committed to the repo, with the date and the conditions.

---

## 7. Enable observation only

Set the autonomy policy to `OBSERVE` or `INFORM`. Let Vesper watch and report, and
change nothing.

**Evidence:** `autonomy.decision` events in the journal, and — importantly —
`autonomy.no_action` events. A record that shows only action is a record of a system
that was never asked to hold back.

Run for long enough to see a normal day.

---

## 8. Detect NEXUS

NEXUS is a separate specialist. Vesper does not rebuild it, replace it, or absorb it.

Point `optimizer.endpoint` at the real API and set `optimizer.mode: "live"`.

**Evidence:** `optimizer_status` reports `mode: "live"`, and the capability manifest and
the client gateway both report `AVAILABLE`. Those two surfaces read one classifier, so
disagreement between them is a bug rather than a nuance.

**Until both are true, the honest state is `NOT_CONFIGURED`** — not `DEGRADED`. A mock
is not a degraded NEXUS; it is the absence of one.

---

## 9. Connect Vesper to NEXUS, still observing

Let Vesper form expectations and record corrections without acting on them:

- Vesper reads a bottleneck and records what it expects
- NEXUS reports what it measures
- a correction record captures the comparison

**Evidence:** `corrections_list` shows real records with
`source.author: "specialist"`, and a mix of outcomes. If every record is
`assumption_held`, suspect the comparison rather than celebrate.

**Do not** let a correction change a policy. It cannot — that is enforced — but do not
build a habit of reading them as instructions either.

---

## 10. Validate the Windows integrations

Tray, startup registration, toast notifications, WASAPI audio enumeration.

**Evidence:** each one observed working on the machine, and
`docs/known-limitations.md` updated for whatever did not.

**Specifically unproven today:** NTFS reparse-point behaviour against the filesystem
containment path. Windows has no `O_NOFOLLOW`, so that branch takes a structurally
different route and has never run against a real junction. See
`security/BACKLOG.md` §1.1.

---

## 11. Validate memory and continuity

Restart across sessions and confirm memory, workspace and task state survive. Confirm
the journal spans the restart.

**Evidence:** `catch me up` after a restart reports work that predates it.

---

## 12. Progressively enable autonomy

In this order, with a period of observation between each:

1. `AUTO_SAFE` for read-only tools
2. `agent.driveTasksOnIdle: true`, with the scheduled ceiling left at `AUTO_SAFE`
3. wider tool coverage, one tool at a time

**Evidence at each step:** the journal shows the decisions taken, and the corrections
store shows Vesper's expectations were mostly right.

**Never:** grant `FULL`, disable the confirmation tier, or let a scheduled task run a
confirm-tier tool. A scheduled request reaches strictly less than a person at the
keyboard, and that is a property to preserve rather than an inconvenience to route
around.

---

## What is still not built when all twelve steps pass

- **No cross-device transport.** Session capsules have a shape, a signature and a verify
  path; nothing carries them between machines. Opening a listener on a personal machine
  is the owner's decision and has not been made.
- **No live hardware source.** `hardware.mode: "live"` is accepted by config and honoured
  by nothing; step 3 is what makes it meaningful.
- **The comprehensive pre-1.0 adversarial campaign has not been run.** It is deliberately
  reserved for a feature-complete build on this machine, where the Windows paths, the
  real NEXUS API and the real backends can all be attacked as they actually are.
