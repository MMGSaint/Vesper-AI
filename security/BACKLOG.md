# Security backlog

Work that is **known, scoped, and not done**. This file exists so that "not tested" is a
recorded state rather than an absence nobody notices.

Nothing here is a claim that Vesper is or is not vulnerable to these. Each entry says
what has not been examined, and why it could not be settled in the environment where the
campaign ran.

Written 2026-08-27 during the round-2 campaign on `agent/distributed`; revised 2026-08-28
as findings moved from this list into the fixed set.

---

## 1. Requires physical hardware or a real Windows host

The campaign ran on Linux in a container. Windows behaviour is covered only by the
`windows-latest` CI job, which runs the same Node test suite — it does not exercise the
platform's own filesystem or security primitives, and several of Vesper's defences are
POSIX-shaped.

| # | Item | Why it is not covered |
|---|---|---|
| 1.1 | **NTFS reparse points and directory junctions** | `openContained` takes two deliberately different paths. On POSIX `O_NOFOLLOW` is the whole check and the kernel performs it as part of the open, so there is no window. Windows has no `O_NOFOLLOW` and Node exposes no equivalent (`FILE_FLAG_OPEN_REPARSE_POINT` is unreachable), so there an explicit `lstat` is the whole defence — checked on both sides of the open so a swap *during* it is caught, but **a swap-and-swap-back is not, and the TOCTOU window is genuinely open on that platform.** CodeQL's `js/file-system-race` flagged exactly this and was right about Windows. A junction is also not a symlink and `lstat` reports it differently. **Untested on a real Windows filesystem.** |
| 1.2 | **Windows hard links** | The `nlink > 1` refusal is asserted on Linux. `fs.stat().nlink` is populated on NTFS but the campaign has never run the assertion against a real NTFS volume. |
| 1.3 | **Extended-length paths (`\\?\C:\...`)** | `realpathSync.native` returns this form and broke knowledge indexing entirely when it was used (fixed by using plain `realpathSync` and stripping the prefix). Nothing tests that a path *supplied* in extended-length form is contained correctly. |
| 1.4 | **Case-insensitive path comparison** | NTFS is case-insensitive by default; containment comparisons are byte-exact. `C:\Notes\..\NOTES\x.txt` versus an approved root written as `C:\notes` has not been tested. |
| 1.5 | **Drive-relative and UNC paths** | `C:file.txt` (drive-relative), `\\server\share`, and per-drive current directories have no coverage. |
| 1.6 | **Alternate data streams** | `notes.txt:hidden` is a distinct stream on NTFS and is not considered anywhere. |
| 1.7 | **ACLs and security descriptors** | The private-key 0600 assertion is POSIX-only and skipped on Windows (documented in `docs/known-limitations.md`). Nothing asserts the equivalent ACL. |
| 1.8 | **Real toast notifications** | The notification adapter is forced to the simulated path in tests. The real Windows pipeline is unexercised. |
| 1.9 | **Startup registration** | `describeStartupRegistration` is described, never executed against a real registry. |

## 2. Concurrency, races, and TOCTOU

| # | Item | State |
|---|---|---|
| 2.1 | **Filesystem race between `lstat` and `open`** | Closed on POSIX, where there is no longer an `lstat` at all — `O_NOFOLLOW` is the check and it is part of the syscall. **Open on Windows**, per 1.1, narrowed but not closed. No race harness exists on either platform; the suite creates no window, so nothing here is proven against an actual race. |
| 2.2 | **Concurrent turns against one runtime** | Two in-flight turns sharing the confirmation queue, the memory store and the registry have not been fuzzed. The stores use an exclusive queue; that has not been adversarially tested. |
| 2.3 | **Interleaved enrol/revoke** | Revocation is now written before the registry so a crash between the two leaves the device revoked. A concurrent `enrol` racing a `setTrust(revoked)` has not been tested. |
| 2.5 | **One unexplained failure of `invariant: a scope governs its data on every route`** | Observed once, on 2026-08-28, in a `npm run security:quick` run immediately following a full-suite run. **Not reproduced in 71 subsequent runs** — 40 of the full gate, 25 of the file alone, 6 of the gate under concurrent full-suite load. No state hazard identified by inspection: the test builds its own sandbox, runtime and companion, and the assertions it makes are all satisfied by a scope refusal that does not depend on timing. Recorded rather than called a flake, because a security test that fails once and cannot be explained is not evidence of anything except that it failed once. |
| 2.4 | **Storage write interruption** | A crash mid-`persist` is handled by the corrupt-file path, which was reproduced. Partial writes at other layers (audit log rotation, knowledge index) are untested. |

## 3. Not attacked in this campaign

Recorded because they were named as high-value and were not reached, not because they are
believed safe.

| # | Area |
|---|---|
| 3.1 | IPC security — the single-instance lock fails open on an unparseable body (reported, MEDIUM, **not fixed**) |
| 3.2 | Updater and package integrity — no signature verification exists to attack |
| 3.3 | Model and plugin supply chain — a poisoned local model file, a hostile MCP server binary |
| 3.4 | Device pairing and revocation attacks beyond the durability work done here |
| 3.5 | Offline synchronisation attacks — stale state, replayed sync payloads, clock manipulation |
| 3.6 | USB continuity attacks — the portable path on a foreign host |
| 3.7 | Memory poisoning as a campaign (single writes are covered; the long game is not) |
| 3.8 | RAG poisoning across many documents and many turns |
| 3.9 | Skill/plugin privilege escalation |
| 3.10 | NEXUS confused-deputy attacks beyond the adapter boundary |
| 3.11 | Cross-device capability escalation with three or more devices |
| 3.12 | Model migration and canary attacks |
| 3.13 | Resource exhaustion beyond the four bounds fixed in this campaign — see 4.2 |

## 4. Known-unfixed, from round 2

Reproduced findings that were triaged and deliberately not fixed in this pass. Each is
recorded with what it costs.

Numbering is stable, so 4.6, 4.7 and 4.9 are absent rather than renumbered: those three
prototype-resolution findings were fixed in `7b8d746` after this list was first written.

| # | Finding | Why deferred |
|---|---|---|
| 4.1 | **Stored memories are lost when state.json is corrupt** | The loss is now loud — a `security.state_unreadable` event, an error-kind notification, and a `diagnostics.recentErrors` entry — and the corrupt file is preserved as `state.json.corrupt`. Recovering the entries needs a merge story that does not exist yet, and inventing one under time pressure risks losing more than it saves. Not a security boundary: no authority is granted by the loss. |
| 4.2 | **Client session table is unbounded** | Authentication is a linear scan doing two SHA-256 hashes per stored session. Bounded in practice by the fact that a session requires an enrolled, trusted device — so it is not reachable by an unauthenticated party — but the table itself has no cap. |
| 4.3 | **Single-instance guard fails open on an unparseable lock body** | Including the window created by its own non-atomic write. Consequence is two hosts running, not an authority change. |
| 4.4 | **`fitContext` can evict the user's own turn** | A compromised model that emits very large tool results can crowd the user's message out of the window. The system prompt is bounded (tested); the conversation is not. |
| 4.5 | **The context budget cannot see `toolCalls`** | Only message content is measured, so a model can put a large payload in the tool-call arguments that the budget does not count. Bounded now by `MAX_TOOL_CALLS_PER_ROUND` and the confirmation argument cap, but not by the budget itself. |
| 4.8 | **MCP `protocolVersion` is never validated** | LOW. A downgraded or absent version is accepted. |
| 4.10 | **`*.localhost` is treated as loopback with no opt-in** | LOW. A resolver-controlled name. |
| 4.11 | **MCP stdio transport has no frame size limit** | LOW. A hostile server can buffer unbounded newline-free output. |
| 4.12 | **Unvalidated client-protocol payloads throw out of the gateway** | LOW. `ttlMs: NaN`, non-string key/value/token. An exception, not an authorization change. |
| 4.13 | **`optimizer_analyze` reports `ok: true` when the optimizer was unreachable** | LOW, and partly mitigated by the attribution work: the reply now quotes the optimizer rather than asserting on its behalf. The epistemic marker is still wrong. |
| 4.14 | **`setOptimizerAvailable(false)` is a no-op against a live HTTP optimizer** | INFORMATIONAL. The off switch only affects the mock adapter. |

## 4b. Phase-2 adversarial findings, deliberately not fixed

Two attack workflows ran against the Phase 2 runtime (durable journal, task
scheduler, autonomy governor, checkpoint/rollback, session capsule). 58 findings
were confirmed and fixed across four commits. These are what remains, with what
each costs.

| # | Finding | Why deferred |
|---|---|---|
| 4b.1 | **`maxPerTick` is a per-call cap, not a rate limit.** Rapid or concurrent ticks can each start up to the cap. | LOW. The idle scheduler fires on a configured interval (30 s default) and `driveTasksOnIdle` is off by default, so there is no path today that ticks fast enough for this to matter. A real rate limiter belongs with the autonomy governor's budget machinery rather than duplicated in the scheduler. |
| 4b.2 | **`stop()` does not fence an in-progress tick.** A `stop()` during the microtask window between the in-flight claim and the executor launch hands the executor a signal from a *new* AbortController if `enable()` is called before it reads one. | LOW, and only reachable from a stop/enable cycle inside one tick — which no call site performs. The executor's own `ctx.signal` is captured at launch, so the practical exposure is a task that ignores a stop it should have seen, not one that runs unauthorized. |
| 4b.3 | **`BudgetState.record` is exported and callable from outside the governor.** Anyone holding the instance could inflate a budget's usage. | LOW. It is a poisoning primitive for *tightening* only — recording usage can refuse actions, never permit them, so it cannot escalate. Exported because `evaluateAutonomy` is a pure function tested independently of the class. |
| 4b.4 | **`canonicalJson` mangles `Date` values and objects with no own keys.** A capsule field holding a Date serialises inconsistently between build and verify. | PLAUSIBLE, and unreachable from the capsule path: every capsule field is a string, number, boolean, array, or plain JsonObject, and `buildSessionCapsule` constructs each one explicitly. Recorded because a future field of a richer type would hit it. |
| 4b.5 | **`decodeCapsule` does not verify the signature.** A caller who decodes and then forgets to call `verifyCapsule` gets an unauthenticated object. | LOW, a footgun rather than a defect — decode and verify are deliberately separate so a caller can inspect a malformed capsule for diagnostics. `ingestCapsule` always verifies, and it is the only path that acts on a capsule. |
| 4b.6 | **Cross-process task claims are optimistic, not atomic.** `StorageAdapter` is get/set/delete/keys with no compare-and-swap, so two runtimes sharing one store can both write before either re-reads. `start()` writes a unique claim and re-reads to confirm it won, which yields one winner — but the window is narrowed, not closed. | Closing it needs a CAS or a lease primitive on the storage layer, which is a change to an interface every subsystem depends on. The current shape is honest about what it guarantees; the field's doc comment says so. |

### A note on adversarial verification itself

The phase-2 workflow's verifier agents "REFUTED" all 12 session-capsule findings
on the grounds that `session-capsule.ts` does not exist. They were reading the
wrong repository — the session's working directory is an empty scaffold and the
real tree is elsewhere. Every one of those findings was re-verified by hand and
most were real, including a CRITICAL identity-spoofing bug that let any party
impersonate any enrolled device.

**A refutation is only as good as the directory it was run in.** Any future
adversarial pass should have its agents state which repository root they read,
and a refutation citing "the file does not exist" should be treated as a signal
about the harness rather than about the code.

## 5. Defences that exist but are not mutation-proven

Recorded per the load-bearing rule: a mechanism that mutation does not distinguish is
defence-in-depth, and must not be described as protecting anything.

| Mechanism | Status |
|---|---|
| The write-path parent re-check after `mkdir` (`filesystem.ts`) | Unexercised. `openContained` and the pre-`mkdir` check already refuse every case tested. |
| The neutralisation fixed-point loop's second and later passes (`untrusted.ts`) | Unexercised. One strip-then-escape pass reaches the fixed point for every payload tried. |
| `setTrust`'s consultation of the revocation list (`registry.ts`) | Unexercised. `load` has already corrected every record it holds. |
| `notify` as host-only, for a **restricted** device | Unexercised. The scope ceiling refuses it either way. Load-bearing for a **trusted** device, which is where the mutation shows. |
| The two named `never`-tier branches (`permissions.ts`, `registry.ts`) | Unexercised individually. The permission gate's final default-deny is what actually holds the never tier; all three must be removed together before a never-tier handler runs. |
| The symlink half of the post-`open` check on the explicit branch (`filesystem.ts`) | Unexercised on Linux, and deliberately kept. The handle-identity comparison beside it subsumes it wherever inodes are reported, and mutation confirms that: removing the symlink test fails nothing, removing the identity comparison fails the swap-and-swap-back test. It stays because it is all that remains on a filesystem reporting no inode, where the comparison compares nothing. |
| The Windows `openContained` branch as a whole | Exercised only by forcing it on Linux. The pre-`open` check cannot be removed (`O_CREAT` through a dangling link creates the out-of-root file before anything could inspect the result) and cannot be made atomic — Node exposes no `FILE_FLAG_OPEN_REPARSE_POINT`. **CodeQL's `js/file-system-race` alert on this branch is a true positive and is expected to persist.** Real Windows reparse-point and junction behaviour remains untested. |
