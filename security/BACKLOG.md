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
